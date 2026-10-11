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
//  - The Worker does not parse the list in M2 (parsing and ingest are T5/T6/T9); it records the
//    outcome class and the ETag only. Logs carry fixed words and status classes, nothing else.
import { dbConfigured, pipeline, type DbEnv, type Row } from "../db";
import { isWeekend, sydneyLocal, type Local } from "../localtime";
import {
  ETAG_KEY,
  ASX_ENABLED_KEY,
  classifyResponse,
  parseOn,
  parseRetryAfter,
  type Outcome,
  type Priority,
} from "./policy";
import { buildAsxRequest } from "./request";
import { acquire, recordOutcome } from "./token";

export type AsxEnv = DbEnv & {
  PRAXIS_ENV: string;
  /** "1" turns the live poll on. Unset (default) means no network call is ever made. */
  ASX_LIVE?: string;
  /** Identifying User-Agent, a plain var (e.g. "praxis-sentinel (contact: ...)"). */
  ASX_USER_AGENT?: string;
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

export const POLL_START_MIN = 7 * 60;
export const POLL_END_MIN = 19 * 60 + 30;
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
};

const str = (r: Row | undefined, i: number): string | null =>
  r !== undefined && typeof r[i] === "string" ? (r[i] as string) : null;

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
    try {
      const [state, mode, cal] = await pipeline(
        env,
        [
          {
            sql: "SELECT key, value_json FROM worker_state WHERE key IN (?, ?)",
            args: [ASX_ENABLED_KEY, ETAG_KEY],
          },
          { sql: "SELECT mode FROM market WHERE code = 'AU'" },
          {
            sql: "SELECT kind FROM trading_calendar WHERE market = 'AU' AND d = ?",
            args: [local.date],
          },
        ],
        deps.fetch,
      );
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
        }
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
    if (!got.granted)
      return skip(`denied-${got.reason}`, `asx: ${job.label} denied (${got.reason})`);

    // ---- the one ASX request ------------------------------------------------------------------
    const req = buildAsxRequest(env.ASX_USER_AGENT, etag);
    let outcome: Outcome = "error";
    let retryAfterS: number | null = null;
    let newEtag: string | null = null;
    if (req !== null) {
      try {
        sum.fetched++;
        const res = await deps.fetch(req.url, req.init);
        let body = "";
        if (res.status !== 304) {
          try {
            body = (await res.text()).slice(0, 4000);
          } catch {
            body = "";
          }
        }
        outcome = classifyResponse(res.status, res.headers.get("content-type"), body);
        if (outcome === "rate_limited")
          retryAfterS = parseRetryAfter(res.headers.get("retry-after"));
        if (outcome === "ok" && res.status === 200) newEtag = res.headers.get("etag");
      } catch {
        outcome = "error";
      }
    }
    sum.outcome = outcome;

    // ---- request 3 (and 4 only when the trip fires): record the outcome ---------------------
    sum.requests++;
    const rec = await recordOutcome(env, deps.nowMs(), outcome, deps.fetch, {
      retryAfterS,
      etag: newEtag,
    });
    sum.tripped = rec.tripped;
    if (rec.tripped) sum.requests++;
    console.log(`asx: ${job.label} ${outcome}`);
  } catch {
    console.log("asx: error");
  }
  return sum;
}
