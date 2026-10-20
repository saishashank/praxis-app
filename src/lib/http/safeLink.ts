// Safe outbound links (SEC-016, UX-008): a stored URL is shown as a link only when it is `https:`,
// carries no credentials or odd port, and its host is one of the registered source hosts (DAT-120).
// Anything else comes back as null, and the page shows the text without a link.
// `.test` is a reserved top-level domain (RFC 2606): it never resolves on the public internet, so it
// is accepted for the synthetic data of the test and staging worlds and can never point at a real site.
const SOURCE_HOSTS: readonly string[] = ["asx.com.au"];
const MAX_URL_LENGTH = 2000;

/** True when `host` is a registered source host or a subdomain of one. */
export function isRegisteredSourceHost(host: string, extra: readonly string[] = []): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "test" || h.endsWith(".test")) return true;
  return [...SOURCE_HOSTS, ...extra].some((s) => h === s || h.endsWith(`.${s}`));
}

/** The normalised URL when it is safe to render as a link; otherwise null. Never throws. */
export function safeSourceUrl(raw: unknown, extraHosts: readonly string[] = []): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  // The URL parser silently drops tabs and newlines; refuse them instead of "fixing" them.
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username !== "" || u.password !== "") return null;
  if (u.port !== "") return null; // https default (443) is normalised to ""
  if (!isRegisteredSourceHost(u.hostname, extraHosts)) return null;
  return u.toString();
}
