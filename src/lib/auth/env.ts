// Environment names used by auth (D-019). Values are read only here and never logged.
export type AuthEnv = {
  OWNER_EMAIL?: string;
  OWNER_RECOVERY_EMAIL?: string;
  OWNER_RECOVERY_ENABLED?: string;
  PII_HASH_KEY?: string;
  RESEND_API_KEY?: string;
  APP_BASE_URL?: string;
  [k: string]: string | undefined;
};

export const norm = (v: string | undefined | null): string => (v ?? "").trim().toLowerCase();

// ROL-101a: the Owner is the address pinned in the environment, nothing else.
export function isOwnerEmail(env: AuthEnv, email: string): boolean {
  const owner = norm(env.OWNER_EMAIL);
  return owner !== "" && norm(email) === owner;
}

// ROL-101a: break-glass address is honoured only while explicitly enabled.
export function isRecoveryEmail(env: AuthEnv, email: string): boolean {
  const rec = norm(env.OWNER_RECOVERY_EMAIL);
  return env.OWNER_RECOVERY_ENABLED === "true" && rec !== "" && norm(email) === rec;
}
