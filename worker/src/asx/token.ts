// ASX rate token (M2 T4): one database-backed compare-and-set decides who may call asx.com.au.
// HIGH-RISK (external-source politeness rules, kill switch): Opus reviews every line.
//
// Spec text this file implements (verbatim excerpts; file:line in the private spec v1, found
// with grep -n; docs/M2_design.md is in this repo):
//  - 06_data_layer.md:68 DAT-122: "All asx.com.au requests from every component are made **only
//    on Worker cron ticks**, through one database-backed rate token (last_request_at with
//    compare-and-set, minimum spacing 65 s)."
//  - 06_data_layer.md:68 DAT-122: "Because ticks are 60 s apart, **ASX slots occur on alternate
//    ticks (every 2 minutes)**"
//  - 06_data_layer.md:68 DAT-122: "Slot priorities: (1) announcement poll — every **4 minutes**
//    (every second ASX slot) during announcement hours, so at least one ASX slot in every 4
//    minutes remains for priorities (2)–(5)"
//  - 06_data_layer.md:68 DAT-122: "(2) the 09:55 pre-open re-check; (3) batch needs
//    (directory/status refresh after close); (4) PDF queue — held and watch-listed codes first,
//    then Appendix 3Y / 603–605 for U1–U2 codes; (5) history backfill (DAT-125)."
//  - 06_data_layer.md:68 DAT-122: "a sustained 403/challenge rate > 5% over an hour trips
//    DAT-123 automatically. **Staging never contacts asx.com.au or Yahoo.** **(s13)** By
//    construction ASX requests ≤ 720 per day (one slot per 2 minutes); the Worker logs the daily
//    count to System Health."
//  - 06_data_layer.md:69 DAT-123: "**DAT-123 Kill switch** per source: off within one cycle; the Evening
//    Review lists feeds that are off."
//  - 06_data_layer.md:70 DAT-124 (s9): "Content from any personal-use-only source (ASX, Yahoo)
//    shown to Editors/Viewers is limited to derived numbers, headlines, links and our own
//    summaries" (DAT-124 sets no request headers; conditional requests are the design's choice,
//    docs/M2_design.md section 4: "One conditional GET of the latest-announcements list per poll
//    slot")
//  - 06_data_layer.md:74 DAT-127 (s9): "*ASX off:* no new announcement events, halts inferred
//    only from zero-volume sessions (flagged), F2/F3/F5/F6 make no new entries, F1/F4 continue
//    with halt proxy; exits continue." (a source that is off or tripped is not fetched: policy.ts
//    `mayFetchMode` equals `mayFetch` in src/lib/data/sources/status.ts)
//  - 06_data_layer.md:134 acceptance: "**Given** two components requesting asx.com.au within
//    65 s, **then** the second waits for the rate token (DAT-122)."
//  - 15_configuration_reference.md:135 "| asx_min_spacing | 65 s | — | DAT-122 |"
//  - 15_configuration_reference.md:136 "| asx_poll_interval | 4 min (announcement hours; every
//    second ASX slot) | O | DAT-122 |"
//  - 15_configuration_reference.md:140 "| asx_block_trip | > 5% 403/challenge over 1 h | O |
//    DAT-122 |"
//  - docs/M2_design.md section 7, row T4: "ASX rate token and slot scheduler (CAS, 65 s, 720/day
//    counter, priorities 1..5), poll adapter | `worker/src/asx/*`, `src/lib/data/asxToken.ts` |
//    AT-05 spacing and cap; race test; priority order; kill switch | None"
//
// How the rules apply here:
//  - ONE UPDATE on the single `asx_rate_token` row is the whole grant decision. It succeeds only
//    if (a) `asx_enabled` is on in worker_state (default off), (b) `source_status` for
//    `asx_announcements` is on or degraded (off and tripped are not fetched, DAT-123/127),
//    (c) no Retry-After wait is pending, (d) last_request_at is at least 65 s ago, (e) today's
//    count (Sydney date, reset when the date changes) is below the priority's limit
//    (policy.ts PRIORITY_LIMITS, hard cap 720). Whoever sees one changed row owns the slot;
//    racing isolates therefore get exactly one grant per 65 s window.
//  - The same pipeline carries a SELECT of the state so that a refusal can be explained
//    (`denyReason`, pure). One subrequest either way.
//  - Outcomes (ok / blocked / rate_limited / error) are written as `asxout:<ISO>` rows in
//    worker_state (insert-only, pruned after 2 h; no schema change). A 429 pushes
//    `asx:next_allowed_at` (never earlier than a value already stored). In the SAME pipeline
//    `source_status` for `asx_announcements` becomes `tripped` when, over the last hour, at
//    least TRIP_MIN_SAMPLE requests exist and blocked * 100 > 5 * total (exactly 5 % does not
//    trip). `tripped` is never cleared here: only `resetAsxTrip` (Owner, src/lib/data/asxToken.ts)
//    does.
//  - Second trip rule: 3 consecutive `blocked` outcomes (the latest three outcome rows) trip
//    regardless of sample size (Opus review round 1).
//  - Known limit: migration 0004 allows source_status.mode on/off/tripped only, so `degraded`
//    cannot be stored yet; the SQL already treats it like `on`. A later migration adds it if needed.
//  - Errors are named, never described: no URL, header or value reaches a log line.
import { sydneyLocal } from "../localtime";
import { pipeline, type DbEnv, type Stmt } from "../db";
import {
  ASX_ENABLED_KEY,
  ASX_SOURCE,
  denyReason,
  DAILY_CAP,
  clampRetryAfter,
  ETAG_KEY,
  MIN_SPACING_MS,
  NEXT_ALLOWED_KEY,
  OUTCOME_KEEP_MS,
  OUTCOME_PREFIX,
  PRIORITY_LIMITS,
  TRIP_CONSECUTIVE,
  TRIP_MIN_SAMPLE,
  TRIP_PERCENT,
  TRIP_WINDOW_MS,
  parseOn,
  type DenyReason,
  type Outcome,
  type Priority,
  type TokenFacts,
} from "./policy";

const iso = (ms: number) => new Date(ms).toISOString();
const q = (s: string) => JSON.stringify(s);

export type AcquireResult =
  { granted: true; count: number } | { granted: false; reason: DenyReason | "db_error" };

/** The grant statement. `limit` is the priority's limit on today's count BEFORE this grant. */
export function acquireStmt(nowMs: number, priority: Priority): Stmt {
  const now = iso(nowMs);
  const today = sydneyLocal(nowMs).date;
  return {
    sql:
      "UPDATE asx_rate_token SET last_request_at = ?, " +
      "day_count = CASE WHEN day_count_date = ? THEN day_count + 1 ELSE 1 END, " +
      "day_count_date = ? " +
      "WHERE id = 1 " +
      "AND (last_request_at IS NULL OR last_request_at <= ?) " +
      "AND (CASE WHEN day_count_date = ? THEN day_count ELSE 0 END) < ? " +
      "AND EXISTS (SELECT 1 FROM worker_state WHERE key = ? AND value_json IN ('\"1\"', '1', 'true')) " +
      "AND EXISTS (SELECT 1 FROM source_status WHERE source = ? AND mode IN ('on', 'degraded')) " +
      "AND NOT EXISTS (SELECT 1 FROM worker_state WHERE key = ? AND value_json > ?)",
    args: [
      now,
      today,
      today,
      iso(nowMs - MIN_SPACING_MS),
      today,
      Math.min(PRIORITY_LIMITS[priority], DAILY_CAP),
      ASX_ENABLED_KEY,
      ASX_SOURCE,
      NEXT_ALLOWED_KEY,
      q(now),
    ],
  };
}

const factsStmt = (): Stmt => ({
  sql:
    "SELECT t.last_request_at, t.day_count_date, t.day_count, " +
    "(SELECT value_json FROM worker_state WHERE key = ?) AS enabled_raw, " +
    "(SELECT mode FROM source_status WHERE source = ?) AS mode, " +
    "(SELECT value_json FROM worker_state WHERE key = ?) AS next_raw " +
    "FROM asx_rate_token t WHERE t.id = 1",
  args: [ASX_ENABLED_KEY, ASX_SOURCE, NEXT_ALLOWED_KEY],
});

function unquote(v: string | number | null | undefined): string | null {
  if (typeof v !== "string") return null;
  try {
    const x: unknown = JSON.parse(v);
    return typeof x === "string" ? x : null;
  } catch {
    return null;
  }
}

/**
 * Ask for the next ASX request slot. Never throws: any database failure is a refusal
 * ("db_error"), because an unknown state must never allow a request.
 */
export async function acquire(
  env: DbEnv,
  nowMs: number,
  priority: Priority,
  f: typeof fetch,
): Promise<AcquireResult> {
  try {
    const [upd, st] = await pipeline(env, [acquireStmt(nowMs, priority), factsStmt()], f);
    if (upd.affected === 1) {
      const c = st.rows[0]?.[2];
      return { granted: true, count: typeof c === "number" ? c : 0 };
    }
    const r = st.rows[0];
    if (!r) return { granted: false, reason: "db_error" };
    const facts: TokenFacts = {
      lastRequestAt: typeof r[0] === "string" ? r[0] : null,
      dayCountDate: typeof r[1] === "string" ? r[1] : null,
      dayCount: typeof r[2] === "number" ? r[2] : 0,
      enabled: parseOn(typeof r[3] === "string" ? r[3] : null),
      mode: typeof r[4] === "string" ? r[4] : null,
      nextAllowedAt: unquote(r[5]),
    };
    return {
      granted: false,
      reason: denyReason(facts, iso(nowMs), sydneyLocal(nowMs).date, priority),
    };
  } catch {
    return { granted: false, reason: "db_error" };
  }
}

export type OutcomeInfo = {
  /** Seconds from a 429's Retry-After header (null: absent or not a number). */
  retryAfterS?: number | null;
  /** ETag of a 200, kept for the next conditional request. */
  etag?: string | null;
};

export type RecordResult = { recorded: boolean; tripped: boolean };

/** All statements that record one outcome and evaluate the trip, in order. */
export function outcomeStmts(nowMs: number, outcome: Outcome, info: OutcomeInfo = {}): Stmt[] {
  const now = iso(nowMs);
  const out: Stmt[] = [
    {
      sql:
        "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (key) DO NOTHING",
      args: [OUTCOME_PREFIX + now, q(outcome), now],
    },
  ];
  if (outcome === "rate_limited") {
    const until = iso(nowMs + clampRetryAfter(info.retryAfterS ?? null) * 1000);
    out.push({
      sql:
        "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET " +
        "value_json = CASE WHEN worker_state.value_json < excluded.value_json " +
        "THEN excluded.value_json ELSE worker_state.value_json END, " +
        "updated_at = excluded.updated_at",
      args: [NEXT_ALLOWED_KEY, q(until), now],
    });
  }
  if (outcome === "ok" && typeof info.etag === "string" && info.etag !== "") {
    out.push({
      sql:
        "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, " +
        "updated_at = excluded.updated_at",
      args: [ETAG_KEY, q(info.etag.slice(0, 200)), now],
    });
  }
  out.push({
    sql: "DELETE FROM worker_state WHERE key >= ? AND key < ? AND key < ?",
    args: [
      OUTCOME_PREFIX,
      OUTCOME_PREFIX.slice(0, -1) + ";",
      OUTCOME_PREFIX + iso(nowMs - OUTCOME_KEEP_MS),
    ],
  });
  const since = OUTCOME_PREFIX + iso(nowMs - TRIP_WINDOW_MS);
  const range = "key > ? AND key < ?";
  const rangeArgs = [since, OUTCOME_PREFIX.slice(0, -1) + ";"];
  const lastThree =
    "(SELECT COUNT(*) FROM (SELECT value_json FROM worker_state WHERE key >= ? AND key < ? " +
    "ORDER BY key DESC LIMIT 3) WHERE value_json = '\"blocked\"')";
  const total = `(SELECT COUNT(*) FROM worker_state WHERE ${range})`;
  const blocked = `(SELECT COUNT(*) FROM worker_state WHERE ${range} AND value_json = '"blocked"')`;
  out.push({
    sql:
      "UPDATE source_status SET mode = 'tripped', since = ?, reason = ?, tripped_by = 'asx_block_trip' " +
      "WHERE source = ? AND mode IN ('on', 'degraded') " +
      `AND ((${total} >= ? AND ${blocked} * 100 > ? * ${total}) OR ${lastThree} = ?)`,
    args: [
      now,
      "asx_block_trip: 403/challenge over 5% in the last hour",
      ASX_SOURCE,
      ...rangeArgs,
      TRIP_MIN_SAMPLE,
      ...rangeArgs,
      TRIP_PERCENT,
      ...rangeArgs,
      OUTCOME_PREFIX,
      OUTCOME_PREFIX.slice(0, -1) + ";",
      TRIP_CONSECUTIVE,
    ],
  });
  return out;
}

/**
 * Record the outcome of a request that held a token. Never throws. When the trip fires, an S2
 * incident is added in a second request (only then). One request in the normal case.
 */
export async function recordOutcome(
  env: DbEnv,
  nowMs: number,
  outcome: Outcome,
  f: typeof fetch,
  info: OutcomeInfo = {},
): Promise<RecordResult> {
  const stmts = outcomeStmts(nowMs, outcome, info);
  let tripped = false;
  try {
    const res = await pipeline(env, stmts, f);
    tripped = res[res.length - 1].affected === 1;
  } catch {
    return { recorded: false, tripped: false };
  }
  if (tripped) {
    console.log("asx: TRIPPED (403/challenge over 5% in 1 h); all ASX requests stopped");
    try {
      await pipeline(
        env,
        [
          {
            sql: "INSERT INTO incident (at, severity, kind, detail_json) VALUES (?, 'S2', 'asx_block_trip', ?)",
            args: [iso(nowMs), JSON.stringify({ source: ASX_SOURCE, rule: "asx_block_trip" })],
          },
        ],
        f,
      );
    } catch {
      console.log("asx: incident write failed");
    }
  }
  return { recorded: true, tripped };
}
