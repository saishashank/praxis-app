// Worker "Run now" runner (D-840..D-849). HIGH-RISK: it starts production workflows and posts signed
// requests on the Owner's request. Read docs/runbooks/run-now.md first.
//
// The Owner writes a `pending` row to `run_now_request` (src/lib/jobs/runNow.ts, audited). On every
// per-minute tick this runner:
//   request 1  expires requests nobody started within 30 minutes (and claimed ones with no result 30
//              minutes after the claim, D-853), then reads up to MAX_PER_TICK pending ones. This is the ONLY cost of an idle minute: one request carrying two statements.
//   request 2  claims each one (`pending` -> `dispatched`, a conditional write, so two ticks never run
//              the same request) and reads every fact the gates need in the same request.
//   then       runs each claimed request through the SAME functions the schedule uses
//              (`dispatchWorkflow` for workflow jobs, `postSigned` for route jobs), and
//   request 3  records the result (`done` or `refused`) with a short fixed-word text.
// At most 6 subrequests plus one call per claimed request, of the 50 allowed (PLT-070).
//
// WHAT A MANUAL RUN BYPASSES: only the time window (the slot's start minute and catch-up).
// WHAT IT STILL RESPECTS (a refusal is recorded, never a silent skip):
//   - the request's market must be an ENABLED market (M19 C1, MKT-110 a, D-996): any other is refused
//     with the fixed reason `market_not_enabled`, before every other gate;
//   - the job must be `runNow` in the registry and a slot that is enabled in the Worker table;
//   - the dispatch kill switch `dispatch_enabled`;
//   - the Owner list `slots_enabled` for go-live jobs (not listed, not yet released or an unreadable
//     list -> "refused: not listed"; the safer choice, D-845);
//   - the market mode (a market-bound job is refused while the market is off);
//   - the trading-day rule for the date it would run for (calendar fail-safe, V1-S3);
//   - the route's own condition (alert flush only when an alert is due; pre-open attempt 2 only after
//     attempt 1 failed) and the workflow inputs a job needs (bake-off candidates);
//   - the job's own idempotency and guards (concurrency key, close-books previous-session guard):
//     they live in the workflow or route, which this runner calls unchanged.
// It does NOT touch the schedule's own `slot:<id>:<date>` state, so a manual run never makes the
// scheduled run think it already happened (and the scheduled run is not blocked by it).
// Logs carry job ids and fixed words only; never a URL, header, secret or body.
import { dbConfigured, pipeline, type DbEnv, type Stmt, type StmtResult } from "./db";
import { dispatchWorkflow, refFor, type DispatchEnv } from "./dispatch";
import {
  DISPATCH_ENABLED_KEY,
  SLOTS_ENABLED_KEY,
  listSkip,
  parseEnabled,
  parseInputs,
  parseSlotsEnabled,
  parseState,
  slotKey,
  type SlotList,
} from "./clock";
import { sydneyLocal } from "./localtime";
import { isTradingDayKind } from "../../src/lib/data/calendarCore.mjs";
import {
  MARKETS_STMT,
  cachedMarkets,
  parseMarketRows,
  readMarkets,
  type MarketRow,
} from "./markets";
import { findJob, validateParams } from "../../src/lib/jobs/registry.mjs";
import {
  FLUSH_DUE_KEY,
  flushDue,
  mapBounded,
  POST_CONCURRENCY,
  postSigned,
  type RouteEnv,
} from "./routes";
import { slotTable, type Slot } from "./schedule";

/** A request nobody started within this long is expired. */
export const RUN_NOW_EXPIRY_MS = 30 * 60_000; // threshold-ok: D-846
export const MAX_PER_TICK = 3; // threshold-ok: bounds subrequests and the 28 s route timeout

export type RunNowEnv = DbEnv & DispatchEnv & RouteEnv;
export type RunNowDeps = { fetch: typeof fetch; nowMs: () => number };

export type PendingRequest = { id: number; jobId: string; paramsJson: string; market: string };

/** What the gates know about one enabled market: its mode and its calendar kind by date (absent = no row). */
export type MarketGateFacts = { mode: string; calendar: ReadonlyMap<string, string> };

export type RunNowFacts = {
  dispatchEnabled: boolean;
  /** The enabled markets by code; a request for any other market is refused `market_not_enabled`. */
  markets: ReadonlyMap<string, MarketGateFacts>;
  slotsEnabled: SlotList;
  flushDue: boolean;
  /** Parsed workflow inputs by `worker_state` key; null = present but invalid. */
  slotInputs: Readonly<Record<string, Record<string, string> | null>>;
  /** `slot:<id>:<date>` raw state texts for the `after` rule. */
  states: ReadonlyMap<string, string>;
};

/** The slot a request runs: the job's slot of the request's market (a later market's ids carry its code). */
export function slotOfRequest(
  slots: readonly Slot[],
  jobId: string,
  market: string,
): Slot | undefined {
  return (
    slots.find((s) => s.id === jobId && (s.market === undefined || s.market === market)) ??
    slots.find((s) => s.id === `${jobId}:${market}`)
  );
}

export type Plan =
  | { run: false; status: "refused"; result: string }
  | { run: true; slot: Slot; d: string; inputs?: Record<string, string> };

/** The gates, in order. Pure: no I/O. `today` is the Sydney date of the tick. */
export function planRequest(
  req: PendingRequest,
  today: string,
  facts: RunNowFacts,
  slots: readonly Slot[],
): Plan {
  const refuse = (why: string): Plan => ({
    run: false,
    status: "refused",
    result: `refused: ${why}`,
  });
  const gate = facts.markets.get(req.market);
  if (gate === undefined) return refuse("market_not_enabled");
  const job = findJob(req.jobId);
  if (job === undefined || !job.runNow) return refuse("unknown job");
  let raw: unknown;
  try {
    raw = JSON.parse(req.paramsJson);
  } catch {
    return refuse("bad request");
  }
  const params = validateParams(job, raw, today);
  if (params === null) return refuse("bad request");
  const slot = slotOfRequest(slots, job.id, req.market);
  if (
    slot === undefined ||
    !slot.enabled ||
    (slot.runner === "actions" && (slot.workflow === null || job.kind !== "workflow")) ||
    (slot.runner === "route" && (typeof slot.route !== "string" || job.kind !== "route")) ||
    (slot.runner !== "actions" && slot.runner !== "route")
  ) {
    return refuse("not available");
  }
  if (!facts.dispatchEnabled) return refuse("dispatch is off");
  if (listSkip(slot, facts.slotsEnabled) !== null) return refuse("not listed");
  if (slot.marketBound && gate.mode === "off") {
    return refuse("market is off");
  }
  const d = params.d ?? today;
  if (slot.tradingDaysOnly && !isTradingDayKind(d, gate.calendar.get(d) ?? null)) {
    return refuse("not a trading day");
  }
  if (slot.needs === "alert_flush_due" && !facts.flushDue) return refuse("nothing is due");
  if (slot.after !== undefined) {
    const first = facts.states.get(slotKey(slot.after, today));
    if (first !== undefined && parseState(first)?.s === "dispatched") {
      return refuse("attempt 1 already worked");
    }
  }
  let inputs: Record<string, string> | undefined = slot.fixedInputs;
  if (slot.inputsKey !== undefined) {
    const got = facts.slotInputs[slot.inputsKey] ?? null;
    if (got === null || (slot.requiredInputs ?? []).some((k) => (got[k] ?? "").trim() === "")) {
      return refuse("inputs missing");
    }
    inputs = got;
  }
  return { run: true, slot, d, inputs };
}

export type RunNowSummary = { requests: number; started: string[]; refused: string[] };

const iso = (ms: number) => new Date(ms).toISOString();
const errName = (e: unknown) => (e instanceof Error && e.name ? e.name.slice(0, 40) : "Error");
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** One tick. Never throws. One request, and no log line, on an idle minute. */
export async function runRunNow(
  env: RunNowEnv,
  scheduledTime: number,
  deps: RunNowDeps,
  /** A fixed slot table (tests). Production passes none: the table is built from the enabled market rows. */
  fixedSlots?: readonly Slot[],
): Promise<RunNowSummary> {
  const summary: RunNowSummary = { requests: 0, started: [], refused: [] };
  try {
    if (!dbConfigured(env) || refFor(env.PRAXIS_ENV) === null) return summary;
    const local = sydneyLocal(scheduledTime);
    const nowMs = deps.nowMs();

    // ---- request 1: expire the stale, read the pending ----------------------------------------------
    let r1: StmtResult[];
    try {
      summary.requests++;
      r1 = await pipeline(
        env,
        [
          {
            sql:
              "UPDATE run_now_request SET status = 'expired', updated_at = ?, " +
              "result = CASE status WHEN 'pending' THEN 'expired: not started in 30 minutes' " +
              "ELSE 'expired: no result was recorded' END " +
              "WHERE (status = 'pending' AND requested_at < ?) " +
              "OR (status = 'dispatched' AND updated_at < ?)",
            args: [iso(nowMs), iso(nowMs - RUN_NOW_EXPIRY_MS), iso(nowMs - RUN_NOW_EXPIRY_MS)],
          },
          {
            sql:
              "SELECT id, job_id, params_json, market FROM run_now_request WHERE status = 'pending' " +
              "ORDER BY id LIMIT ?",
            args: [MAX_PER_TICK],
          },
        ],
        deps.fetch,
      );
    } catch (e) {
      console.log(`run-now: db error ${errName(e)}`);
      return summary;
    }
    const pending: PendingRequest[] = r1[1].rows.map((r) => ({
      id: Number(r[0]),
      jobId: String(r[1]),
      paramsJson: String(r[2]),
      market: String(r[3]),
    }));
    if (pending.length === 0) return summary;

    // the slot table: fixed (tests) or built from the enabled market rows (D-996); a cold or expired isolate
    // reads the rows in one extra request (run-now requests are rare)
    let slots: readonly Slot[];
    if (fixedSlots !== undefined) {
      slots = fixedSlots;
    } else {
      let rows: MarketRow[] | null = cachedMarkets(deps.nowMs());
      if (rows === null) {
        try {
          summary.requests++;
          rows = await readMarkets(env, deps.fetch, deps.nowMs());
        } catch (e) {
          console.log(`run-now: db error ${errName(e)}`);
          return summary;
        }
      }
      slots = slotTable(rows).slots;
    }

    // ---- request 2: claim, and read every fact the gates need ------------------------------------------
    const claimAt = iso(deps.nowMs());
    const claimStmts: Stmt[] = pending.map((p) => ({
      sql:
        "UPDATE run_now_request SET status = 'dispatched', updated_at = ? " +
        "WHERE id = ? AND status = 'pending'",
      args: [claimAt, p.id],
    }));
    const inputKeys = new Set<string>();
    const afterKeys = new Set<string>();
    const dates = new Set<string>([local.date]);
    for (const p of pending) {
      const slot = slotOfRequest(slots, p.jobId, p.market);
      if (slot?.inputsKey) inputKeys.add(slot.inputsKey);
      if (slot?.after) afterKeys.add(slotKey(slot.after, local.date));
      try {
        const d = (JSON.parse(p.paramsJson) as { d?: unknown }).d;
        if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
      } catch {
        // planRequest refuses it
      }
    }
    const keys = [
      DISPATCH_ENABLED_KEY,
      SLOTS_ENABLED_KEY,
      FLUSH_DUE_KEY,
      ...inputKeys,
      ...afterKeys,
    ];
    const dateList = [...dates];
    const readStmts: Stmt[] = [
      {
        sql: `SELECT key, value_json FROM worker_state WHERE key IN (${placeholders(keys.length)})`,
        args: keys,
      },
      MARKETS_STMT,
      {
        sql:
          `SELECT market, d, kind FROM trading_calendar WHERE d IN (${placeholders(dateList.length)}) ` +
          "AND market IN (SELECT code FROM market WHERE enabled = 1)",
        args: dateList,
      },
    ];
    let r2: StmtResult[];
    try {
      summary.requests++;
      r2 = await pipeline(env, [...claimStmts, ...readStmts], deps.fetch);
    } catch (e) {
      console.log(`run-now: db error ${errName(e)}`);
      return summary; // nothing was claimed or the claim failed as a whole: the next tick retries
    }
    const n = pending.length;
    const owned = pending.filter((_, i) => r2[i]!.affected === 1);
    if (owned.length === 0) return summary;

    let enabledRaw: string | undefined;
    let listRaw: string | null | undefined;
    let flushRaw: string | undefined;
    const slotInputs: Record<string, Record<string, string> | null> = {};
    const states = new Map<string, string>();
    for (const row of r2[n]!.rows) {
      const k = String(row[0]);
      const raw = String(row[1]);
      if (k === DISPATCH_ENABLED_KEY) enabledRaw = raw;
      else if (k === SLOTS_ENABLED_KEY) listRaw = row[1] === null ? null : raw;
      else if (k === FLUSH_DUE_KEY) flushRaw = raw;
      else if (inputKeys.has(k)) slotInputs[k] = parseInputs(raw);
      else states.set(k, raw);
    }
    const enabledRows = parseMarketRows(r2[n + 1]!.rows);
    const markets = new Map<string, MarketGateFacts>();
    for (const m of enabledRows) markets.set(m.code, { mode: m.mode, calendar: new Map() });
    for (const row of r2[n + 2]!.rows) {
      (markets.get(String(row[0]))?.calendar as Map<string, string> | undefined)?.set(
        String(row[1]),
        String(row[2]),
      );
    }
    // the plan uses the table of the rows read now (the gates above read the same rows)
    if (fixedSlots === undefined) slots = slotTable(enabledRows).slots;
    const facts: RunNowFacts = {
      dispatchEnabled: parseEnabled(enabledRaw),
      markets,
      slotsEnabled: parseSlotsEnabled(listRaw),
      flushDue: flushDue(flushRaw, deps.nowMs()),
      slotInputs,
      states,
    };

    // ---- run (bounded parallel), then request 3: record every result ---------------------------------
    const results = await mapBounded(owned, POST_CONCURRENCY, async (req) => {
      const plan = planRequest(req, local.date, facts, slots);
      if (!plan.run) return { status: plan.status, result: plan.result };
      if (plan.slot.runner === "actions") {
        const res = await dispatchWorkflow(env, plan.slot.workflow ?? "", deps.fetch, plan.inputs);
        return res.ok
          ? { status: "done" as const, result: `started: ${res.detail}` }
          : { status: "done" as const, result: `failed: ${res.detail}`.slice(0, 120) };
      }
      const res = await postSigned(env, plan.slot, plan.d, deps);
      return res.ok
        ? { status: "done" as const, result: `ran: ${res.detail}` }
        : { status: "done" as const, result: `failed: ${res.detail}`.slice(0, 120) };
    });
    const record: Stmt[] = [];
    const at = iso(deps.nowMs());
    for (const [i, req] of owned.entries()) {
      const out = results[i]!;
      (out.status === "refused" ? summary.refused : summary.started).push(req.jobId);
      console.log(`run-now: ${out.status} ${req.jobId}`);
      record.push({
        sql:
          "UPDATE run_now_request SET status = ?, result = ?, updated_at = ? " +
          "WHERE id = ? AND status = 'dispatched'",
        args: [out.status, out.result, at, req.id],
      });
    }
    for (let tries = 0; tries < 2; tries++) {
      try {
        summary.requests++;
        await pipeline(env, record, deps.fetch);
        break;
      } catch (e) {
        console.log(`run-now: record error ${errName(e)}`);
      }
    }
  } catch (e) {
    console.log(`run-now: error ${errName(e)}`);
  }
  return summary;
}
