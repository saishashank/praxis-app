// Log masking of the clock (INFRA T3; REQ\infra\INFRA_REQUIREMENT.md §5.3). GitHub Actions masks the VALUE of
// every secret in a log; the clock does the same: every value of a secret-named variable of its own
// environment (and any URL that carries credentials, and any bearer token) becomes `***` before a line
// reaches `docker logs` or a log file. Masking is by value, so it also catches a secret printed by a script
// that read it from its own env. Values shorter than 6 characters are never masked (a flag like "1" or
// "true" would wreck the log; no secret of this system is that short).

/** Names (exact) that are secret or private although the name does not say so. */
export const SECRET_NAMES: readonly string[] = [
  "TURSO_MAIN_URL",
  "TURSO_AUTH_URL",
  "DATA_REPO",
  "OWNER_EMAIL",
  "OWNER_RECOVERY_EMAIL",
  "BACKUP_BUCKET_URL",
  "BACKUP_BUCKET_KEY_ID",
  "ASX_USER_AGENT",
];
const SECRET_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|HMAC|PRIVATE|CREDENTIAL)/i;
export const MIN_MASK_LENGTH = 6;
export const MASK = "***";

export type Masker = (line: string) => string;

/** Names of the variables whose values are masked (never the values). */
export function secretNames(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((k) => SECRET_NAMES.includes(k) || SECRET_PATTERN.test(k))
    .filter((k) => (env[k] ?? "").length >= MIN_MASK_LENGTH)
    .sort();
}

export function makeMasker(env: Readonly<Record<string, string | undefined>>): Masker {
  const values = new Set<string>();
  for (const k of secretNames(env)) {
    const v = env[k]!.trim();
    if (v.length >= MIN_MASK_LENGTH) values.add(v);
    // A URL secret is often printed without its scheme or query; mask the host part too.
    const host = /^[a-z]+:\/\/([^/\s?#]+)/i.exec(v)?.[1];
    if (host && host.length >= MIN_MASK_LENGTH) values.add(host);
  }
  // Longest first, so a secret that contains another one is replaced as a whole.
  const ordered = [...values].sort((a, b) => b.length - a.length);
  return (line: string): string => {
    let out = line;
    for (const v of ordered) if (out.includes(v)) out = out.split(v).join(MASK);
    out = out.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`);
    out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${MASK}@`);
    return out;
  };
}
