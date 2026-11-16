// Broker link templates (M21 A1, UXN-317, D-1218). No broker ships with the app: the Owner types up to five templates
// (a name and an https address with `{code}` and optionally `{market}` in it) and the Owner-tool surfaces build a link
// from a pick or a holding. A template carries no credential, the server never calls a broker host, and the substitution
// adds nothing but the encoded code and the market. This module is pure; B1 reads it, never re-implements it.

export const BROKER_LINKS_MAX = 5;
export const BROKER_NAME_MAX = 40; // threshold-ok: display length of a broker name
export const BROKER_TEMPLATE_MAX = 300; // threshold-ok: length bound of an address typed by the Owner

export type BrokerLink = { name: string; url_template: string };
export type TemplateCheck = { ok: true } | { ok: false; reason: string };

const PLACEHOLDER = /\{([^{}]*)\}/g;
const ALLOWED_PLACEHOLDERS: readonly string[] = ["code", "market"];
// Words that mark a query key as a credential (an API key, token, session or signature in a link is refused).
const CREDENTIAL_KEY =
  /(^|[^a-z])(key|apikey|api[-_]?key|token|access[-_]?token|secret|password|passwd|pwd|auth|authorization|bearer|session|sessionid|sid|jwt|sig|signature|credential|credentials)([^a-z]|$)/i;
const CONTROL = /[\u0000-\u001f\u007f\s]/;

const bad = (reason: string): TemplateCheck => ({ ok: false, reason });

/** Whether `host` is an IP literal (v4 dotted quad, or v6 in brackets / with a colon). */
const isIpLiteral = (host: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");

/** Checks one template. Pure: no network, no lookup. */
export function validBrokerTemplate(template: unknown): TemplateCheck {
  if (typeof template !== "string" || !template.startsWith("https://")) {
    return bad("The address must start with https://");
  }
  if (template.length > BROKER_TEMPLATE_MAX) return bad("The address is too long");
  if (CONTROL.test(template)) return bad("The address has a space or control character");
  if (template.includes("#")) return bad("The address must not have a fragment (#)");
  const authority = /^https:\/\/([^/?#]*)/.exec(template)![1]!;
  if (authority.includes("@")) return bad("The address must not contain a user name or password");
  if (authority.includes("{") || authority.includes("}")) {
    return bad("A placeholder cannot be part of the host name");
  }
  const names = [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  if (names.some((n) => !ALLOWED_PLACEHOLDERS.includes(n))) {
    return bad("Only the placeholders {code} and {market} can be used");
  }
  if (template.replace(PLACEHOLDER, "").match(/[{}]/)) {
    return bad("Unmatched brace: use {code} and {market} only");
  }
  if (!names.includes("code")) return bad("The address must contain {code}");
  let url: URL;
  try {
    url = new URL(template.replace(PLACEHOLDER, "x"));
  } catch {
    return bad("The address is not a valid web address");
  }
  if (url.protocol !== "https:") return bad("The address must start with https://");
  if (url.username !== "" || url.password !== "") {
    return bad("The address must not contain a user name or password");
  }
  const host = url.hostname;
  if (!host.includes(".") || isIpLiteral(host) || url.port !== "") {
    return bad("Use a host name such as broker.example.com (no IP address or port)");
  }
  for (const k of url.searchParams.keys()) {
    if (CREDENTIAL_KEY.test(k)) return bad("The address must not carry a credential or key");
  }
  return { ok: true };
}

/** A name of 1 to 40 characters with no control character. */
export const validBrokerName = (v: unknown): v is string =>
  typeof v === "string" &&
  v.trim() === v &&
  v.length >= 1 &&
  v.length <= BROKER_NAME_MAX &&
  !/[\u0000-\u001f\u007f]/.test(v);

/**
 * The list of a write: an array of up to five exact `{ name, url_template }` objects whose templates pass
 * `validBrokerTemplate`; null when anything is wrong (the whole write is refused).
 */
export function parseBrokerLinks(v: unknown): BrokerLink[] | null {
  if (!Array.isArray(v) || v.length > BROKER_LINKS_MAX) return null;
  const out: BrokerLink[] = [];
  for (const x of v) {
    if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
    const keys = Object.keys(x).sort().join();
    if (keys !== "name,url_template") return null;
    const { name, url_template } = x as Record<string, unknown>;
    if (!validBrokerName(name) || !validBrokerTemplate(url_template).ok) return null;
    out.push({ name, url_template: url_template as string });
  }
  return out;
}

/** The stored list on a read: the valid entries only, at most five (a bad stored entry is dropped, never thrown). */
export function readBrokerLinks(v: unknown): BrokerLink[] {
  if (!Array.isArray(v)) return [];
  const out: BrokerLink[] = [];
  for (const x of v) {
    const one = parseBrokerLinks([x]);
    if (one !== null) out.push(one[0]!);
    if (out.length === BROKER_LINKS_MAX) break;
  }
  return out;
}

/** The link for a code: `{code}` is URL-encoded, `{market}` filled, nothing else added. Null for an invalid template. */
export function fillBrokerTemplate(template: string, code: string, market: string): string | null {
  if (!validBrokerTemplate(template).ok) return null;
  return template.replace(PLACEHOLDER, (_m, name: string) =>
    name === "code" ? encodeURIComponent(code) : encodeURIComponent(market),
  );
}
