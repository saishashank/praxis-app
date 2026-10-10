// ASX announcements request for the Worker (M2 T4). Mirrors `buildAnnouncementsRequest` in
// src/lib/data/sources/asx.ts (the Worker never imports from src/; tests/data/asxToken.test.ts
// compares the two). Differences, on purpose: no `credentials` or `cache` fields, because the
// Workers runtime does not implement them (fetch would throw); a Worker fetch sends no cookies
// and the Cloudflare cache is not used for a no-store GET with conditional headers.
//
// TODO(fixtures): the endpoint URL is unconfirmed (same constant as the app adapter).
export const ASX_ANNOUNCEMENTS_URL = "https://www.asx.com.au/asx/v2/statistics/todayAnns.do";

export type AsxFetchInit = {
  method: "GET";
  headers: Record<string, string>;
  redirect: "manual";
  signal: AbortSignal;
};
export type AsxFetch = { url: string; init: AsxFetchInit };

const UA_MAX = 200;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const BROWSER_UA_RE = /^Mozilla\/5\.0/i;
export const ASX_TIMEOUT_MS = 10_000;

/** An identifying User-Agent (printable, not a browser string) or null. */
export function validUserAgent(ua: unknown): string | null {
  if (typeof ua !== "string") return null;
  const t = ua.trim();
  if (t === "" || t.length > UA_MAX || CONTROL_RE.test(t) || BROWSER_UA_RE.test(t)) return null;
  return t;
}

/** Null when the User-Agent is missing or not identifying: no request is made then. */
export function buildAsxRequest(userAgent: unknown, etag: string | null): AsxFetch | null {
  const ua = validUserAgent(userAgent);
  if (ua === null) return null;
  const headers: Record<string, string> = {
    "User-Agent": ua,
    Accept: "application/json, text/html;q=0.5",
  };
  if (etag !== null && etag !== "" && !CONTROL_RE.test(etag)) headers["If-None-Match"] = etag;
  return {
    url: ASX_ANNOUNCEMENTS_URL,
    init: {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(ASX_TIMEOUT_MS),
    },
  };
}
