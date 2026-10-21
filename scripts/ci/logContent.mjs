// Shared scanner for the log-content tests (M8 T6; SEC-110, AT-05a "logs contain no secret values,
// emails, prices, ... or third-party text"). Not a test file (the node:test glob takes *.test.mjs).
// `leaks(text, secrets)` returns one fixed-form label per kind of leak found, never the leaked text,
// so a failing assertion cannot itself put the value into a CI log.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/i;
const HOST_RE =
  /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(vercel\.app|workers\.dev|turso\.io|github\.com|resend\.com|com|org|net|io|app|dev)\b/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// Long opaque strings and well-known token prefixes.
const TOKEN_RE =
  /\b(?:[A-Za-z0-9_-]{32,}|(?:ghp_|github_pat_|re_|sk-|gsk_|AIza|age1|eyJ)[A-Za-z0-9_-]{8,})\b/;

/** @param {string} text @param {string[]} secrets literal values that must never appear */
export function leaks(text, secrets = []) {
  const found = [];
  if (URL_RE.test(text)) found.push("url");
  if (HOST_RE.test(text)) found.push("hostname");
  if (EMAIL_RE.test(text)) found.push("email");
  if (TOKEN_RE.test(text)) found.push("token-like string");
  secrets.forEach((s, i) => {
    if (typeof s === "string" && s.length >= 4 && text.includes(s))
      found.push(`seeded value #${i + 1}`);
  });
  return found;
}
