// ASX announcements adapter (M2 T5). Pure: builds requests and classifies/parses responses; it
// never performs a request. Callers (Worker poll, Vercel route) send the request only on a Worker
// slot that holds the shared rate token (DAT-122: >= 65 s spacing, <= 720/day, no parallel
// crawling); the token and slot logic belong to T4, not here.
//
// Spec facts used:
//  - DAT-122 (spec 06 line 68, 13 line 148): single polite client, conditional requests, metadata +
//    PDF link only, no redistribution.
//  - DAT-123 (06 line 69): a sustained 403/challenge rate > 5 % over 1 h trips the source off
//    (`asx_block_trip`); `isBlockSignal` marks the responses that count towards that rate.
//  - DAT-125 / PLT-075: items carry code, time, type, price-sensitive flag, title, PDF link.
//
// The ASX response format is NOT pinned by the spec. TODO(fixtures): confirm the endpoint URL and
// the response shape below against real recorded fixtures in CI (private fixtures repo, TST-105).
// Until then the parser accepts one documented synthetic JSON shape:
//   { "data": [ { "id": string, "code": string, "time": ISO-8601 with offset or Z,
//                 "type": string, "price_sensitive": boolean, "title": string, "url": string } ] }
import { createHash } from "node:crypto";

// TODO(fixtures): unconfirmed. Callers may override with `baseUrl`.
export const ASX_ANNOUNCEMENTS_URL = "https://www.asx.com.au/asx/v2/statistics/todayAnns.do";

export type AsxRequestInit = {
  method: "GET";
  headers: Record<string, string>;
  redirect: "manual";
  credentials: "omit";
  cache: "no-store";
};

export type AsxRequest = { url: string; init: AsxRequestInit };

export type AsxRequestOptions = {
  userAgent: string; // identifying, from config/env (never a browser impersonation)
  baseUrl?: string;
  etag?: string | null; // from the previous 200, for If-None-Match
  lastModified?: string | null; // for If-Modified-Since
};

export class AsxRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsxRequestError";
  }
}

const UA_MAX = 200;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const BROWSER_UA_RE = /^Mozilla\/5\.0/i;

/** An identifying User-Agent: non-empty, printable, not a browser string. */
export function validateUserAgent(ua: unknown): string {
  if (typeof ua !== "string" || ua.trim() === "") {
    throw new AsxRequestError("an identifying User-Agent is required");
  }
  if (ua.length > UA_MAX || CONTROL_RE.test(ua)) {
    throw new AsxRequestError("User-Agent is too long or has control characters");
  }
  if (BROWSER_UA_RE.test(ua.trim())) {
    throw new AsxRequestError("User-Agent must identify this client, not imitate a browser");
  }
  return ua.trim();
}

function headerValue(v: string, name: string): string {
  if (CONTROL_RE.test(v)) throw new AsxRequestError(`${name} has control characters`);
  return v;
}

/** DAT-122 request: GET, identifying User-Agent, conditional headers, no cookies, no redirects. */
export function buildAnnouncementsRequest(opts: AsxRequestOptions): AsxRequest {
  const ua = validateUserAgent(opts.userAgent);
  const url = opts.baseUrl ?? ASX_ANNOUNCEMENTS_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AsxRequestError("baseUrl is not a valid URL");
  }
  if (parsed.protocol !== "https:") throw new AsxRequestError("baseUrl must be https");
  const headers: Record<string, string> = {
    "User-Agent": ua,
    Accept: "application/json, text/html;q=0.5",
  };
  if (opts.etag) headers["If-None-Match"] = headerValue(opts.etag, "etag");
  if (opts.lastModified) {
    headers["If-Modified-Since"] = headerValue(opts.lastModified, "lastModified");
  }
  return {
    url: parsed.toString(),
    init: { method: "GET", headers, redirect: "manual", credentials: "omit", cache: "no-store" },
  };
}

// ---- typed errors ---------------------------------------------------------------------------

export type AsxErrorKind = "rate_limited" | "blocked" | "challenge" | "http_error" | "malformed";

export class AsxSourceError extends Error {
  readonly kind: AsxErrorKind;
  readonly status: number | null;
  readonly retryAfterS: number | null;
  constructor(
    kind: AsxErrorKind,
    message: string,
    status: number | null,
    retryAfterS: number | null = null,
  ) {
    super(message);
    this.name = "AsxSourceError";
    this.kind = kind;
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
}

/** Counts towards the `asx_block_trip` 403/challenge rate (DAT-122, DAT-123). */
export function isBlockSignal(e: unknown): boolean {
  return e instanceof AsxSourceError && (e.kind === "blocked" || e.kind === "challenge");
}

// ---- response handling ----------------------------------------------------------------------

export type AsxResponse = {
  status: number;
  headers: Record<string, string>; // names matched case-insensitively
  body: string;
};

export type AnnouncementItem = {
  annId: string; // stable hash for de-duplication (PLT-075)
  code: string;
  publishedAt: string; // ISO-8601 UTC with Z
  type: string;
  priceSensitive: boolean;
  title: string;
  pdfUrl: string | null;
};

export type AsxResult =
  | { kind: "not_modified" }
  | {
      kind: "ok";
      items: AnnouncementItem[];
      skipped: number;
      etag: string | null;
      lastModified: string | null;
    };

const CHALLENGE_MARKERS = [
  "just a moment",
  "cf-chl",
  "captcha",
  "_incapsula_",
  "access denied",
  "request unsuccessful",
  "attention required",
  "unusual traffic",
];

const header = (h: Record<string, string>, name: string): string | null => {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === want) return v;
  return null;
};

export function looksLikeChallenge(r: AsxResponse): boolean {
  const ct = (header(r.headers, "content-type") ?? "").toLowerCase();
  const head = r.body.slice(0, 4000).toLowerCase();
  const html = ct.includes("text/html") || /^\s*<(!doctype|html)/i.test(r.body);
  if (!html) return false;
  return CHALLENGE_MARKERS.some((m) => head.includes(m));
}

function retryAfter(h: Record<string, string>): number | null {
  const v = header(h, "retry-after");
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.ceil(n), 86_400) : null;
}

export function annIdOf(
  code: string,
  publishedAt: string,
  sourceId: string,
  title: string,
): string {
  return createHash("sha256")
    .update([code, publishedAt, sourceId, title].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

function toUtc(s: unknown): string | null {
  if (typeof s !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Parse the synthetic list shape (see header). Malformed or duplicate items are skipped and
 * counted; a wrong top-level shape throws `malformed`.
 */
export function parseAnnouncementList(body: string): {
  items: AnnouncementItem[];
  skipped: number;
} {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new AsxSourceError("malformed", "announcement list is not valid JSON", null);
  }
  const list = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) {
    throw new AsxSourceError("malformed", "announcement list has no data array", null);
  }
  const items: AnnouncementItem[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const raw of list) {
    const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const publishedAt = toUtc(o.time);
    if (
      typeof o.code !== "string" ||
      !/^[A-Z0-9]{2,6}$/.test(o.code) ||
      publishedAt === null ||
      typeof o.title !== "string" ||
      o.title.trim() === "" ||
      typeof o.type !== "string" ||
      typeof o.price_sensitive !== "boolean"
    ) {
      skipped++;
      continue;
    }
    let pdfUrl: string | null = null;
    if (typeof o.url === "string") {
      try {
        const u = new URL(o.url);
        if (u.protocol === "https:") pdfUrl = u.toString();
      } catch {
        /* link dropped, metadata kept */
      }
    }
    const annId = annIdOf(o.code, publishedAt, typeof o.id === "string" ? o.id : "", o.title);
    if (seen.has(annId)) {
      skipped++;
      continue;
    }
    seen.add(annId);
    items.push({
      annId,
      code: o.code,
      publishedAt,
      type: o.type,
      priceSensitive: o.price_sensitive,
      title: o.title.trim(),
      pdfUrl,
    });
  }
  return { items, skipped };
}

/** Classify a response: 304, a list, or a typed `AsxSourceError` (429, 403, challenge, other). */
export function handleAnnouncementsResponse(r: AsxResponse): AsxResult {
  if (r.status === 304) return { kind: "not_modified" };
  if (r.status === 429) {
    throw new AsxSourceError("rate_limited", "ASX returned 429", 429, retryAfter(r.headers));
  }
  if (r.status === 403) throw new AsxSourceError("blocked", "ASX returned 403", 403);
  if (looksLikeChallenge(r)) {
    throw new AsxSourceError("challenge", "ASX returned a challenge page", r.status);
  }
  if (r.status < 200 || r.status >= 300) {
    throw new AsxSourceError("http_error", `ASX returned HTTP ${r.status}`, r.status);
  }
  const { items, skipped } = parseAnnouncementList(r.body);
  return {
    kind: "ok",
    items,
    skipped,
    etag: header(r.headers, "etag"),
    lastModified: header(r.headers, "last-modified"),
  };
}
