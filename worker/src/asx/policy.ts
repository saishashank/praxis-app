// ASX politeness policy: constants and pure functions (M2 T4). No I/O, no imports, so the app can
// compare it with `src/lib/data/sources/{asx,status}.ts` in a test (the Worker never imports from
// `src/`, and `src/lib/data/asxToken.ts` imports nothing from here; tests/data/asxToken.test.ts
// proves the copies agree). HIGH-RISK: these numbers are the external-source politeness rules.
//
// Thresholds chosen where the spec gives none (docs/M2_design.md section 6, D-061):
//  - TRIP_MIN_SAMPLE = 10 requests in the window before the ratio can trip (one 403 out of 3 must
//    not switch the source off for good; with 10+ requests 1 block is already 10 % > 5 %).
//  - PRIORITY_LIMITS: highest day_count (after the grant) a priority may reach. Priorities 1 and 2
//    may use the whole cap; 3, 4, 5 stop 20, 40, 80 slots early, so a greedy backfill can never
//    starve the announcement poll or the pre-open re-check later in the day.
//  - RETRY_AFTER: seconds from a 429, clamped to [65, 3600]; missing header means 300 s.

export const ASX_SOURCE = "asx_announcements";
export const ASX_ENABLED_KEY = "asx_enabled";
export const NEXT_ALLOWED_KEY = "asx:next_allowed_at";
export const ETAG_KEY = "asx:etag";
/** Outcome rows live in worker_state under `asxout:<ISO ms>`; the value is a JSON string. */
export const OUTCOME_PREFIX = "asxout:";

export const MIN_SPACING_MS = 65_000;
export const DAILY_CAP = 720;
export const TRIP_PERCENT = 5;
export const TRIP_WINDOW_MS = 3_600_000;
export const TRIP_MIN_SAMPLE = 10;
/** Consecutive blocked outcomes that trip regardless of sample size. */
export const TRIP_CONSECUTIVE = 3;
/** Outcome rows older than this are deleted (the window is 1 h; the rest is slack). */
export const OUTCOME_KEEP_MS = 2 * 3_600_000;
export const RETRY_AFTER_MIN_S = 65;
export const RETRY_AFTER_MAX_S = 3600;
export const RETRY_AFTER_DEFAULT_S = 300;

export type Priority = 1 | 2 | 3 | 4 | 5;
export const PRIORITIES: readonly Priority[] = [1, 2, 3, 4, 5];
export const PRIORITY_LIMITS: Readonly<Record<Priority, number>> = {
  1: 720,
  2: 720,
  3: 700,
  4: 680,
  5: 640,
};

export type Outcome = "ok" | "blocked" | "rate_limited" | "error";

/** DAT-123 / DAT-127: a source that is off or tripped is not fetched; unknown means not fetched. */
export function mayFetchMode(mode: string | null): boolean {
  return mode === "on" || mode === "degraded";
}

/** `worker_state` kill-switch value: JSON "1", 1 or true turns it on; anything else is off. */
export function parseOn(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  try {
    const v: unknown = JSON.parse(raw);
    return v === "1" || v === 1 || v === true;
  } catch {
    return false;
  }
}

/** Strictly more than TRIP_PERCENT blocked, with at least TRIP_MIN_SAMPLE requests. */
export function shouldTrip(total: number, blocked: number): boolean {
  return total >= TRIP_MIN_SAMPLE && blocked * 100 > TRIP_PERCENT * total;
}

export function clampRetryAfter(s: number | null): number {
  if (s === null || !Number.isFinite(s) || s < 0) return RETRY_AFTER_DEFAULT_S;
  return Math.min(RETRY_AFTER_MAX_S, Math.max(RETRY_AFTER_MIN_S, Math.ceil(s)));
}

/** Parses a Retry-After header in whole seconds; an HTTP date or junk gives null. */
export function parseRetryAfter(v: string | null): number | null {
  if (v === null || !/^\d{1,9}$/.test(v.trim())) return null;
  return Number(v.trim());
}

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

/** Same test as `looksLikeChallenge` in src/lib/data/sources/asx.ts (HTML page with a marker). */
export function looksLikeChallenge(contentType: string | null, body: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  const head = body.slice(0, 4000).toLowerCase();
  const html = ct.includes("text/html") || /^\s*<(!doctype|html)/i.test(body);
  if (!html) return false;
  return CHALLENGE_MARKERS.some((m) => head.includes(m));
}

/**
 * Same order as `handleAnnouncementsResponse` (src/lib/data/sources/asx.ts): 304 ok; 429
 * rate_limited; 403 blocked; challenge page (any status) blocked; other non-2xx error; 2xx ok.
 */
export function classifyResponse(
  status: number,
  contentType: string | null,
  body: string,
): Outcome {
  if (status === 304) return "ok";
  if (status === 429) return "rate_limited";
  if (status === 403) return "blocked";
  if (looksLikeChallenge(contentType, body)) return "blocked";
  if (status < 200 || status >= 300) return "error";
  return "ok";
}

export type TokenFacts = {
  enabled: boolean;
  mode: string | null;
  nextAllowedAt: string | null;
  lastRequestAt: string | null;
  dayCountDate: string | null;
  dayCount: number;
};

export type DenyReason =
  "disabled" | "source_off" | "retry_after" | "spacing" | "daily_cap" | "reserved";

/** Why a grant was refused, from the state read after the compare-and-set lost. Pure. */
export function denyReason(
  f: TokenFacts,
  nowIso: string,
  today: string,
  priority: Priority,
): DenyReason {
  if (!f.enabled) return "disabled";
  if (!mayFetchMode(f.mode)) return "source_off";
  if (f.nextAllowedAt !== null && f.nextAllowedAt > nowIso) return "retry_after";
  const count = f.dayCountDate === today ? f.dayCount : 0;
  if (count >= DAILY_CAP) return "daily_cap";
  if (count >= PRIORITY_LIMITS[priority]) return "reserved";
  return "spacing"; // also the fallback when another isolate won the same window
}
