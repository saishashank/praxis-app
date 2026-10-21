// Sentinel hand-off, Worker side (M5 T5; D-100 draft; docs/M5_design.md section 4.2, decisions 36
// and 37). HIGH-RISK: part of the only Worker path that contacts asx.com.au.
//
// What lives here (the fetch itself stays in slots.ts, behind the rate token and every switch):
//  - the SHA-256 of a fetched feed body (decision 36: the Worker hashes, a Vercel route parses);
//  - the signed POST of a changed body to `POST /api/internal/sentinel-ingest` (HMAC + timestamp +
//    single-use nonce, the universe-import pattern; the secret never leaves the Worker);
//  - the NFR-002 poll counters (`sentinel_poll_day`, one upsert in the same batch as the token
//    outcome, PLT-075);
//  - Sentinel-blind detection (PLT-018): during MAP hours (07:00-19:30 on trading days, decision
//    17) no successful poll for `BLIND_ALERT_MIN` minutes opens ONE S2 `sentinel_blind` incident
//    (the incident path; the Worker never emails). The reference instant is the later of the last
//    successful poll and today's 07:00 local, computed from the local minute of the day, so it is
//    exact across the DST changes (no transition falls between 07:00 and 19:30, D-059/D-060).
//  - delivery retries (design 4.2 step 3): the same body is offered again on later polls (its ETag is
//    withheld until it was accepted); after 3 failed attempts the body is dropped with an S3
//    `sentinel_ingest_failed` incident.
// Logs carry fixed words and numbers only: never a URL, a header, a secret or feed content.
import type { Stmt } from "../db";
import { randomHex, signHeaders } from "../selfcheck";
import type { Outcome } from "./policy";
import { ASX_SOURCE } from "./policy";

export const SENTINEL_ROUTE = "/api/internal/sentinel-ingest";
export const SENTINEL_PURPOSE = "sentinel-ingest";
/** Design 4.11 `sentinel_body_max_kb` (256 KB). A larger body is not handed over. */
export const SENTINEL_BODY_MAX_BYTES = 256 * 1024;
/** Design 4.11 `sentinel_blind_alert_min` (15), the registry default. */
export const BLIND_ALERT_MIN = 15;
export const MAP_START_MIN = 7 * 60;
export const MAP_END_MIN = 19 * 60 + 30;
export const MAX_DELIVERY_ATTEMPTS = 3;
export const POST_TIMEOUT_MS = 25_000;
export const LAST_SHA_KEY = "sentinel:last_sha";
export const FAIL_KEY = "sentinel:fail";
export const MARKET = "AU";

const MIN_MS = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const q = (v: string): string => JSON.stringify(v);

/** Lower-case hex SHA-256 of the UTF-8 text (WebCrypto; I/O-like, not CPU-heavy). */
export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** The signed route URL from `APP_BASE_URL` (https only), or null. */
export function sentinelUrl(base: string | undefined): string | null {
  if (typeof base !== "string" || base.trim() === "") return null;
  try {
    const u = new URL(base.trim());
    if (u.protocol !== "https:") return null;
    return new URL(SENTINEL_ROUTE, u.origin).toString();
  } catch {
    return null;
  }
}

export const INCIDENT_ROUTE = "/api/internal/incident";
export const INCIDENT_PURPOSE = "incident";

/** The signed incident route URL from `APP_BASE_URL` (https only), or null. */
export function incidentUrl(base: string | undefined): string | null {
  const u = sentinelUrl(base);
  return u === null ? null : new URL(INCIDENT_ROUTE, u).toString();
}

// ---- blind detection ----------------------------------------------------------------------------

/** Minutes since local midnight inside MAP hours (inclusive). */
export const inMapHours = (minute: number): boolean =>
  minute >= MAP_START_MIN && minute <= MAP_END_MIN;

/**
 * Pure: is the Sentinel blind at `nowMs`? `localMinute` is the Sydney minute of the day of `nowMs`,
 * `lastOkMs` the last successful poll (null: none ever). Outside MAP hours never blind. The
 * reference is the later of the last success and today's 07:00 local, so overnight silence does not
 * count and the first poll of a day gets the full window.
 */
export function isBlind(
  nowMs: number,
  localMinute: number,
  lastOkMs: number | null,
  alertMin: number = BLIND_ALERT_MIN,
): boolean {
  if (!inMapHours(localMinute)) return false;
  const mapStartMs = nowMs - (localMinute - MAP_START_MIN) * MIN_MS;
  const ref = lastOkMs !== null && lastOkMs > mapStartMs ? lastOkMs : mapStartMs;
  return nowMs - ref >= alertMin * MIN_MS;
}

/** Opens at most one S2 `sentinel_blind` incident (an open one suppresses a second). */
export function blindIncidentStmt(nowMs: number, alertMin: number = BLIND_ALERT_MIN): Stmt {
  return {
    sql:
      "INSERT INTO incident (at, severity, kind, detail_json) SELECT ?, 'S2', 'sentinel_blind', ? " +
      "WHERE NOT EXISTS (SELECT 1 FROM incident WHERE kind = 'sentinel_blind' AND resolved_at IS NULL)",
    args: [iso(nowMs), JSON.stringify({ source: ASX_SOURCE, window_min: alertMin })],
  };
}

/**
 * Asks the app, signed, to open the Sentinel-blind incident (M5 T6, D-101): the app opens ONE S2
 * incident and sends the incident e-mail; the Worker never emails. Never throws; `status` null
 * means no answer. A non-200 answer makes the caller fall back to the in-app insert below.
 */
export async function reportBlind(
  f: typeof fetch,
  o: { url: string; secret: string; env: string; date: string; nowMs: number; windowMin?: number },
): Promise<DeliverResult> {
  try {
    const body = JSON.stringify({
      purpose: INCIDENT_PURPOSE,
      env: o.env,
      d: o.date,
      kind: "sentinel_blind",
      window_min: o.windowMin ?? BLIND_ALERT_MIN,
    });
    const headers = await signHeaders(o.secret, body, Math.floor(o.nowMs / 1000), randomHex(16));
    const res = await f(o.url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return { status: res.status };
  } catch {
    return { status: null };
  }
}

// ---- NFR-002 counters ---------------------------------------------------------------------------

export type PollKind = "ok" | "not_modified" | "failed" | "blocked" | "denied";

/** Maps a request outcome to its counter. A 304 is `not_modified`; a denied token is only scheduled. */
export function pollKind(outcome: Outcome | null, status: number | null): PollKind {
  if (outcome === null) return "denied";
  if (outcome === "blocked") return "blocked";
  if (outcome === "ok") return status === 304 ? "not_modified" : "ok";
  return "failed"; // rate_limited, error
}

/**
 * One upsert per poll: `scheduled` always grows; the matching counter grows; a success moves
 * `last_ok_at` forward and widens `max_gap_s` (seconds since the previous success that day).
 * The table's trigger forbids any decrease.
 */
export function pollDayStmt(nowMs: number, date: string, kind: PollKind): Stmt {
  const success = kind === "ok" || kind === "not_modified";
  const n = (k: PollKind): number => (kind === k ? 1 : 0);
  return {
    sql:
      "INSERT INTO sentinel_poll_day (market, source, d, scheduled, ok, not_modified, failed, blocked, max_gap_s, last_ok_at) " +
      "VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0, ?) " +
      "ON CONFLICT (market, source, d) DO UPDATE SET " +
      "scheduled = scheduled + 1, ok = ok + excluded.ok, not_modified = not_modified + excluded.not_modified, " +
      "failed = failed + excluded.failed, blocked = blocked + excluded.blocked, " +
      "max_gap_s = CASE WHEN excluded.last_ok_at IS NOT NULL AND sentinel_poll_day.last_ok_at IS NOT NULL " +
      "THEN MAX(max_gap_s, CAST(ROUND((julianday(excluded.last_ok_at) - julianday(sentinel_poll_day.last_ok_at)) * 86400) AS INTEGER)) " +
      "ELSE max_gap_s END, " +
      "last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at)",
    args: [
      MARKET,
      ASX_SOURCE,
      date,
      n("ok"),
      n("not_modified"),
      n("failed"),
      n("blocked"),
      success ? iso(nowMs) : null,
    ],
  };
}

// ---- last hash and delivery failures (worker_state) ---------------------------------------------

export type FailState = { sha: string; n: number };

export function parseFail(raw: string | null | undefined): FailState | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as { sha?: unknown; n?: unknown };
    return typeof v.sha === "string" && typeof v.n === "number" && Number.isInteger(v.n)
      ? { sha: v.sha, n: v.n }
      : null;
  } catch {
    return null;
  }
}

const upsertState = (key: string, value: string, nowMs: number): Stmt => ({
  sql:
    "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
  args: [key, value, iso(nowMs)],
});

export const acceptedStmts = (sha: string, nowMs: number): Stmt[] => [
  upsertState(LAST_SHA_KEY, q(sha), nowMs),
  { sql: "DELETE FROM worker_state WHERE key = ?", args: [FAIL_KEY] },
];

/** After a failed attempt number `n`: remember it; at the 3rd the body is dropped (S3 incident). */
export function failedStmts(sha: string, n: number, nowMs: number): Stmt[] {
  if (n < MAX_DELIVERY_ATTEMPTS) {
    return [upsertState(FAIL_KEY, JSON.stringify({ sha, n }), nowMs)];
  }
  return [
    ...acceptedStmts(sha, nowMs), // the dropped body counts as seen, so it is not offered again
    {
      sql: "INSERT INTO incident (at, severity, kind, detail_json) VALUES (?, 'S3', 'sentinel_ingest_failed', ?)",
      args: [iso(nowMs), JSON.stringify({ source: ASX_SOURCE, attempts: n })],
    },
  ];
}

// ---- delivery ------------------------------------------------------------------------------------

export type DeliverResult = { status: number | null };

/** POSTs one feed body, signed. Never throws; `status` null means no answer. */
export async function deliverFeed(
  f: typeof fetch,
  o: {
    url: string;
    secret: string;
    env: string;
    date: string;
    sha: string;
    feed: string;
    nowMs: number;
  },
): Promise<DeliverResult> {
  try {
    const body = JSON.stringify({
      purpose: SENTINEL_PURPOSE,
      env: o.env,
      d: o.date,
      sha: o.sha,
      feed: o.feed,
    });
    const headers = await signHeaders(o.secret, body, Math.floor(o.nowMs / 1000), randomHex(16));
    const res = await f(o.url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
      redirect: "manual", // a redirect must never carry the signed request elsewhere
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return { status: res.status };
  } catch {
    return { status: null };
  }
}
