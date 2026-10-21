// ASX slot scheduler and poll adapter (M2 T4). HIGH-RISK: the only code in the Worker that can
// contact asx.com.au. Spec text: see the header of token.ts (DAT-122 slots and priorities, DAT-123,
// docs/M2_design.md section 3 "ASX slot supply").
//
// Rules applied here:
//  - ASX slots are the EVEN Sydney minutes (every 2 minutes, DAT-122). The announcement poll
//    (priority 1) is due every 4 minutes from 07:00 to 19:30 on weekdays (minutes divisible by 4),
//    i.e. every second slot, so the other slot in 4 minutes is left for priorities 2..5. Those have
//    no consumer in M2 (stubs in later tasks); `chooseJob` already picks the lowest number first.
//  - Order of checks, cheapest first, and NO database work until all of them pass:
//      1. a job is due this minute (pure arithmetic on the local minute);
//      2. `ASX_LIVE` is "1" (env var, default unset: log "asx: poll skipped (ASX_LIVE off)");
//      3. `PRAXIS_ENV` is production (DAT-122: "Staging never contacts asx.com.au or Yahoo.");
//      4. the Worker has an identifying `ASX_USER_AGENT` (never a browser string).
//    Then ONE read (kill switch `asx_enabled`, stored ETag, market mode, calendar), then the token
//    `acquire` (which re-checks the kill switch and the source status atomically), then the fetch,
//    then ONE write of the outcome (trip logic in token.ts). Worst case 4 of 50 subrequests.
//  - The Worker does not parse the list. M5 T5 (sentinel.ts, D-100 draft): a changed 200 body (at
//    most 256 KB) is hashed and handed to the signed route /api/internal/sentinel-ingest, the
//    NFR-002 counters go into the same batched write as the token outcome, and no successful poll
//    for 15 minutes in MAP hours opens an S2 `sentinel_blind` incident. The new ETag is kept only
//    once the body was accepted (or dropped after 3 failed attempts), so a failed hand-off is
//    retried with a full fetch. Logs carry fixed words and status classes, nothing else.
import { dbConfigured, pipeline, type DbEnv, type Row, type Stmt } from "../db";
import { isWeekend, sydneyLocal, type Local } from "../localtime";
import {
  ASX_SOURCE,
  ETAG_KEY,
  ASX_ENABLED_KEY,
  classifyResponse,
  parseOn,
  parseRetryAfter,
  type Outcome,
  type Priority,
} from "./policy";
import { buildAsxRequest } from "./request";
import {
  FAIL_KEY,
  LAST_SHA_KEY,
  MAP_END_MIN,
  MAP_START_MIN,
  MAX_DELIVERY_ATTEMPTS,
  SENTINEL_BODY_MAX_BYTES,
  acceptedStmts,
  blindIncidentStmt,
  byteLength,
  deliverFeed,
  failedStmts,
  incidentUrl,
  isBlind,
  parseFail,
  pollDayStmt,
  pollKind,
  reportBlind,
  sentinelUrl,
  sha256Hex,
  type FailState,
} from "./sentinel";
import { acquire, recordOutcome } from "./token";

export type AsxEnv = DbEnv & {
  PRAXIS_ENV: string;
  /** "1" turns the live poll on. Unset (default) means no network call is ever made. */
  ASX_LIVE?: string;
  /** Identifying User-Agent, a plain var (e.g. "praxis-sentinel (contact: ...)"). */
  ASX_USER_AGENT?: string;
  /** Sentinel hand-off target and signing secret (M5 T5); both are needed to deliver a feed. */
  APP_BASE_URL?: string;
  WORKER_HMAC_SECRET?: string;
};
export type AsxDeps = { fetch: typeof fetch; nowMs: () => number };

export type AsxJob = {
  id: string;
  priority: Priority;
  /** Pure: is this job wanted at this Sydney minute (on an ASX slot tick)? */
  due: (local: Local) => boolean;
  marketBound: boolean;
  label: string;
};

export const POLL_START_MIN = MAP_START_MIN;
export const POLL_END_MIN = MAP_END_MIN;
export const POLL_EVERY_MIN = 4;

/** ASX slots occur on alternate ticks (DAT-122): the even local minutes. */
export const isSlotTick = (local: Local): boolean => local.minute % 2 === 0;

export function pollDue(local: Local): boolean {
  return (
    !isWeekend(local) &&
    isSlotTick(local) &&
    local.minute >= POLL_START_MIN &&
    local.minute <= POLL_END_MIN &&
    (local.minute - POLL_START_MIN) % POLL_EVERY_MIN === 0
  );
}

export const ASX_JOBS: readonly AsxJob[] = [
  { id: "asx-poll", priority: 1, due: pollDue, marketBound: true, label: "poll" },
];

/** The due job with the lowest priority number; ties keep list order. Pure. */
export function chooseJob(jobs: readonly AsxJob[], local: Local): AsxJob | null {
  let best: AsxJob | null = null;
  for (const j of jobs) {
    if (!j.due(local)) continue;
    if (best === null || j.priority < best.priority) best = j;
  }
  return best;
}

export type AsxSummary = {
  job: string | null;
  /** Why nothing was requested (fixed words), or null when a request was made. */
  skipped: string | null;
  outcome: Outcome | null;
  tripped: boolean;
  /** Database requests made (subrequests, not counting the ASX fetch). */
  requests: number;
  fetched: number;
  /** HTTP status of the Sentinel route's answer, or null when nothing was handed over. */
  delivered: number | null;
  /** True when the Sentinel was blind at this attempt (the incident was asked to open). */
  blind: boolean;
};

const str = (r: Row | undefined, i: number): string | null =>
  r !== undefined && typeof r[i] === "string" ? (r[i] as string) : null;

/**
 * Sentinel blind (PLT-018): ask the app to open the incident and send its e-mail (M5 T6). Returns
 * true when the app answered 200; false (not configured, no answer, any other status) means the
 * caller writes the in-app incident itself, so blindness is never lost. The route is idempotent.
 */
async function askAppForBlindIncident(
  env: AsxEnv,
  deps: AsxDeps,
  date: string,
  nowMs: number,
): Promise<boolean> {
  const url = incidentUrl(env.APP_BASE_URL);
  const secret = (env.WORKER_HMAC_SECRET ?? "").trim();
  if (url === null || secret === "") return false;
  const r = await reportBlind(deps.fetch, { url, secret, env: env.PRAXIS_ENV, date, nowMs });
  return r.status === 200;
}

/** One tick. Never throws. */
export async function runAsx(
  env: AsxEnv,
  scheduledTime: number,
  deps: AsxDeps,
  jobs: readonly AsxJob[] = ASX_JOBS,
): Promise<AsxSummary> {
  const sum: AsxSummary = {
    job: null,
    skipped: null,
    outcome: null,
    tripped: false,
    requests: 0,
    fetched: 0,
    delivered: null,
    blind: false,
  };
  try {
    const local = sydneyLocal(scheduledTime);
    const job = chooseJob(jobs, local);
    if (job === null) return sum;
    sum.job = job.id;
    const skip = (why: string, line: string): AsxSummary => {
      sum.skipped = why;
      console.log(line);
      return sum;
    };
    if (env.ASX_LIVE !== "1") return skip("live-off", `asx: ${job.label} skipped (ASX_LIVE off)`);
    if (env.PRAXIS_ENV !== "production") {
      return skip("not-production", `asx: ${job.label} skipped (not production)`);
    }
    if (!dbConfigured(env))
      return skip("no-db", `asx: ${job.label} skipped (database not configured)`);
    if (buildAsxRequest(env.ASX_USER_AGENT, null) === null) {
      return skip("no-user-agent", `asx: ${job.label} skipped (no identifying user agent)`);
    }

    // ---- request 1: kill switch, stored ETag, market mode, calendar ---------------------------
    sum.requests++;
    let etag: string | null = null;
    let lastSha: string | null = null;
    let fail: FailState | null = null;
    let lastOkMs: number | null = null;
    try {
      const [state, mode, cal, lastOk] = await pipeline(
        env,
        [
          {
            sql: "SELECT key, value_json FROM worker_state WHERE key IN (?, ?, ?, ?)",
            args: [ASX_ENABLED_KEY, ETAG_KEY, LAST_SHA_KEY, FAIL_KEY],
          },
          { sql: "SELECT mode FROM market WHERE code = 'AU'" },
          {
            sql: "SELECT kind FROM trading_calendar WHERE market = 'AU' AND d = ?",
            args: [local.date],
          },
          {
            sql:
              "SELECT last_ok_at FROM sentinel_poll_day WHERE market = 'AU' AND source = ? " +
              "AND last_ok_at IS NOT NULL ORDER BY d DESC LIMIT 1",
            args: [ASX_SOURCE],
          },
        ],
        deps.fetch,
      );
      const lo = str(lastOk.rows[0], 0);
      if (lo !== null && Number.isFinite(Date.parse(lo))) lastOkMs = Date.parse(lo);
      let enabledRaw: string | null = null;
      for (const r of state.rows) {
        if (r[0] === ASX_ENABLED_KEY) enabledRaw = str(r, 1);
        else if (r[0] === ETAG_KEY && typeof r[1] === "string") {
          try {
            const v: unknown = JSON.parse(r[1]);
            etag = typeof v === "string" ? v : null;
          } catch {
            etag = null;
          }
        } else if (r[0] === LAST_SHA_KEY && typeof r[1] === "string") {
          try {
            const v: unknown = JSON.parse(r[1]);
            lastSha = typeof v === "string" ? v : null;
          } catch {
            lastSha = null;
          }
        } else if (r[0] === FAIL_KEY) fail = parseFail(str(r, 1));
      }
      if (!parseOn(enabledRaw)) return skip("disabled", "asx: skipped (asx_enabled off)");
      if (job.marketBound) {
        const m = str(mode.rows[0], 0);
        if (m === null || m === "off") return skip("market-off", "asx: skipped (market off)");
        if (str(cal.rows[0], 0) === "holiday") return skip("holiday", "asx: skipped (holiday)");
      }
    } catch {
      return skip("db-error", "asx: skipped (database error)");
    }

    // ---- request 2: the token ---------------------------------------------------------------
    sum.requests++;
    const got = await acquire(env, deps.nowMs(), job.priority, deps.fetch);
    // Blind test for this attempt (PLT-018): every due poll that passed the switches counts, also
    // one the token refused; an open incident suppresses a second (blindIncidentStmt).
    const blindNow = isBlind(scheduledTime, local.minute, lastOkMs);
    if (!got.granted) {
      sum.requests++;
      const now = deps.nowMs();
      const stmts = [pollDayStmt(now, local.date, "denied")];
      if (blindNow) {
        if (!(await askAppForBlindIncident(env, deps, local.date, now))) {
          stmts.push(blindIncidentStmt(now));
        }
        sum.blind = true;
      }
      try {
        await pipeline(env, stmts, deps.fetch);
      } catch {
        console.log("asx: poll counters not written");
      }
      return skip(`denied-${got.reason}`, `asx: ${job.label} denied (${got.reason})`);
    }

    // ---- the one ASX request ------------------------------------------------------------------
    const req = buildAsxRequest(env.ASX_USER_AGENT, etag);
    let outcome: Outcome = "error";
    let retryAfterS: number | null = null;
    let newEtag: string | null = null;
    let status: number | null = null;
    let feed: string | null = null;
    if (req !== null) {
      try {
        sum.fetched++;
        const res = await deps.fetch(req.url, req.init);
        status = res.status;
        let body = "";
        let tooBig = false;
        if (res.status !== 304) {
          const declared = res.headers.get("content-length");
          if (declared !== null && Number(declared) > SENTINEL_BODY_MAX_BYTES) tooBig = true;
          else {
            try {
              body = await res.text();
            } catch {
              body = "";
            }
          }
        }
        outcome = classifyResponse(
          res.status,
          res.headers.get("content-type"),
          body.slice(0, 4000),
        );
        if (outcome === "rate_limited")
          retryAfterS = parseRetryAfter(res.headers.get("retry-after"));
        if (outcome === "ok" && res.status === 200) {
          // A body over `sentinel_body_max_kb` is never handed over: the poll counts as failed.
          if (tooBig || byteLength(body) > SENTINEL_BODY_MAX_BYTES) outcome = "error";
          else {
            feed = body;
            newEtag = res.headers.get("etag");
          }
        }
      } catch {
        outcome = "error";
      }
    }
    sum.outcome = outcome;

    // ---- hand-off to the Sentinel route (decision 36): changed bodies only ---------------------
    const now = deps.nowMs();
    const extra: Stmt[] = [];
    if (outcome === "ok" && feed !== null) {
      const sha = await sha256Hex(feed);
      if (sha !== lastSha) {
        const url = sentinelUrl(env.APP_BASE_URL);
        const secret = (env.WORKER_HMAC_SECRET ?? "").trim();
        if (url === null || secret === "") {
          newEtag = null; // not delivered: keep fetching the full body
          console.log("sentinel: hand-off skipped (app not configured)");
        } else {
          const d = await deliverFeed(deps.fetch, {
            url,
            secret,
            env: env.PRAXIS_ENV,
            date: local.date,
            sha,
            feed,
            nowMs: now,
          });
          sum.delivered = d.status;
          if (d.status === 200) {
            extra.push(...acceptedStmts(sha, now));
            console.log("sentinel: feed accepted");
          } else {
            const n = (fail !== null && fail.sha === sha ? fail.n : 0) + 1;
            extra.push(...failedStmts(sha, n, now));
            if (n < MAX_DELIVERY_ATTEMPTS) newEtag = null; // offered again on the next poll
            console.log(`sentinel: feed not accepted (attempt ${n})`);
          }
        }
      }
    }
    const kind = pollKind(outcome, status);
    extra.push(pollDayStmt(now, local.date, kind));
    if (blindNow && kind !== "ok" && kind !== "not_modified") {
      if (!(await askAppForBlindIncident(env, deps, local.date, now))) {
        extra.push(blindIncidentStmt(now));
      }
      sum.blind = true;
    }

    // ---- request 3 (and 4 only when the trip fires): record the outcome ---------------------
    sum.requests++;
    const rec = await recordOutcome(env, now, outcome, deps.fetch, {
      retryAfterS,
      etag: newEtag,
      extra,
    });
    sum.tripped = rec.tripped;
    if (rec.tripped) sum.requests++;
    console.log(`asx: ${job.label} ${outcome}`);
  } catch {
    console.log("asx: error");
  }
  return sum;
}
