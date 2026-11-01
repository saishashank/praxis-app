// Paper tracker for expert calls (M13-lite WP7; KB-080, D-524, D-640). A "call" is a claim of type `call`
// with a code, a direction, a horizon and optional target and stop levels. It is never a pick and never an
// order: nothing here reaches ranking, sizing or the arena. Each tracked call is settled once, after the
// fact, on closes only and WITHOUT costs (labelled "paper call"), and set against the market with the same
// total-return series and window helper as picks (`windowReturnPpm`, `loadTotalReturnSeries`). The luck share
// is the percentage of the active universe that did better over the same window in the same direction.
// `tracked` is decided at import (only codes of the active universe); this file never changes it.
import type { Client } from "@libsql/client";
import { addDays } from "@/lib/data/calendar";
import { toMicroFromVendor } from "@/lib/money/micro";
import { makeRational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { loadTotalReturnSeries } from "@/lib/picks/benchmark";
import { BENCH_INDEX, windowReturnPpm } from "@/lib/picks/vsMarket";
import type { CallState } from "./types";

const PPM = 1_000_000n; // threshold-ok: parts per million
const PERCENT = 100; // threshold-ok: percent base
const SERIES_LEAD_DAYS = 14; // threshold-ok: lead so the index level before the entry close is in the series

export type CallInput = {
  readonly direction: "long" | "short";
  readonly callD: string;
  readonly horizonSessions: number;
  readonly targetMicro: bigint | null;
  readonly stopMicro: bigint | null;
};
/** A close on a session after the call date, oldest first. */
export type CallBar = { readonly d: string; readonly closeMicro: bigint };
export type CallOutcomeCore = {
  readonly state: CallState;
  readonly entryD: string | null;
  readonly exitD: string | null;
  /** Direction-signed return from the entry close to the exit close, in ppm; no costs. */
  readonly netPpm: number | null;
};

/** Direction-signed return in ppm between two closes, rounded half away from zero. */
export function signedReturnPpm(
  direction: "long" | "short",
  entryMicro: bigint,
  exitMicro: bigint,
): number {
  const diff = direction === "long" ? exitMicro - entryMicro : entryMicro - exitMicro;
  return Number(roundHalfAwayFromZero(makeRational(diff * PPM, entryMicro))); // money-float-ok: ppm fits a safe integer
}

/**
 * Pure. Entry = the first close after the call date. The call then closes at the first later close that
 * reaches its target or its stop (stop first when one close would do both), else at the close `horizonSessions`
 * bars after the entry. Returns null while undecided. `elapsed` says the horizon session has passed: then a
 * call with no usable bars is `no_bars`, and one whose bars stop early closes at its last bar.
 */
export function callOutcome(
  call: CallInput,
  bars: readonly CallBar[],
  elapsed: boolean,
): CallOutcomeCore | null {
  const usable = bars.filter((b) => b.d > call.callD && b.closeMicro > 0n);
  if (usable.length < 2) {
    return elapsed ? { state: "no_bars", entryD: null, exitD: null, netPpm: null } : null;
  }
  const entry = usable[0]!;
  const long = call.direction === "long";
  const closeAt = (state: CallState, bar: CallBar): CallOutcomeCore => ({
    state,
    entryD: entry.d,
    exitD: bar.d,
    netPpm: signedReturnPpm(call.direction, entry.closeMicro, bar.closeMicro),
  });
  const last = Math.min(usable.length - 1, call.horizonSessions);
  for (let i = 1; i <= last; i += 1) {
    const bar = usable[i]!;
    const c = bar.closeMicro;
    if (call.stopMicro !== null && (long ? c <= call.stopMicro : c >= call.stopMicro)) {
      return closeAt("closed_stop", bar);
    }
    if (call.targetMicro !== null && (long ? c >= call.targetMicro : c <= call.targetMicro)) {
      return closeAt("closed_target", bar);
    }
  }
  if (usable.length - 1 >= call.horizonSessions || elapsed) {
    return closeAt("closed_horizon", usable[last]!);
  }
  return null;
}

type CallRow = CallInput & { readonly claimId: string; readonly code: string };

async function dueCalls(db: Client, market: string, d: string): Promise<CallRow[]> {
  const r = await db.execute({
    sql: `SELECT c.claim_id, c.code, c.direction, c.call_d, c.horizon_sessions, c.target_micro, c.stop_micro
            FROM expert_call c
           WHERE c.market = ? AND c.tracked = 1 AND c.call_d < ?
             AND NOT EXISTS (SELECT 1 FROM expert_call_outcome o WHERE o.claim_id = c.claim_id)
           ORDER BY c.claim_id`,
    args: [market, d],
  });
  return r.rows.map((x) => ({
    claimId: String(x.claim_id),
    code: String(x.code),
    direction: String(x.direction) === "short" ? "short" : "long",
    callD: String(x.call_d),
    horizonSessions: Number(x.horizon_sessions),
    targetMicro: x.target_micro === null ? null : BigInt(String(x.target_micro)),
    stopMicro: x.stop_micro === null ? null : BigInt(String(x.stop_micro)),
  }));
}

async function closesOf(
  db: Client,
  market: string,
  code: string,
  after: string,
  upTo: string,
): Promise<CallBar[]> {
  const r = await db.execute({
    sql: "SELECT d, c FROM price_bar WHERE market = ? AND code = ? AND d > ? AND d <= ? ORDER BY d",
    args: [market, code, after, upTo],
  });
  return r.rows.map((x) => ({ d: String(x.d), closeMicro: toMicroFromVendor(Number(x.c)) }));
}

/**
 * The luck share: of the active-universe codes (snapshot at or before the entry, the call's own code left
 * out) with a close on both the entry and the exit date, the whole percent whose same-direction return was
 * higher than the call's. NULL when no snapshot or no comparable code exists.
 */
export async function luckPct(
  db: Client,
  x: {
    market: string;
    code: string;
    direction: "long" | "short";
    entryD: string;
    exitD: string;
    netPpm: number;
  },
): Promise<number | null> {
  const snap = await db.execute({
    sql: "SELECT MAX(d) AS d FROM universe_snapshot WHERE market = ? AND d <= ?",
    args: [x.market, x.entryD],
  });
  const snapD = snap.rows[0]?.d;
  if (snapD === null || snapD === undefined) return null;
  const r = await db.execute({
    sql: `SELECT b.code, b.d, b.c FROM price_bar b
            JOIN universe_snapshot u ON u.market = b.market AND u.code = b.code AND u.d = ?
           WHERE b.market = ? AND u.status = 'active' AND b.code <> ? AND b.d IN (?, ?)
           ORDER BY b.code, b.d`,
    args: [String(snapD), x.market, x.code, x.entryD, x.exitD],
  });
  const closes = new Map<string, { entry?: bigint; exit?: bigint }>();
  for (const row of r.rows) {
    const v = closes.get(String(row.code)) ?? {};
    const micro = toMicroFromVendor(Number(row.c));
    if (String(row.d) === x.entryD) v.entry = micro;
    else v.exit = micro;
    closes.set(String(row.code), v);
  }
  let n = 0;
  let higher = 0;
  for (const v of closes.values()) {
    if (v.entry === undefined || v.exit === undefined || v.entry <= 0n) continue;
    n += 1;
    if (signedReturnPpm(x.direction, v.entry, v.exit) > x.netPpm) higher += 1;
  }
  return n === 0 ? null : Math.floor((2 * PERCENT * higher + n) / (2 * n));
}

export type SettleSummary = {
  /** Tracked calls of the market. */
  readonly tracked: number;
  /** Outcomes written by this run. */
  readonly settled: number;
  /** Tracked calls still without an outcome after this run (undecided, or no market window yet). */
  readonly skipped: number;
};

/**
 * Settles the tracked calls that can be decided as of `d`. Idempotent: a call with an outcome is never read
 * again and the insert is `ON CONFLICT DO NOTHING`. `sessions` (market sessions, oldest first) lets a call
 * whose horizon has passed close on the bars it has, or be marked `no_bars`; without it only a call whose
 * target, stop or horizon bar exists is settled.
 */
export async function settleCalls(
  db: Client,
  market: string,
  d: string,
  sessions?: readonly string[],
): Promise<SettleSummary> {
  const total = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM expert_call WHERE market = ? AND tracked = 1",
    args: [market],
  });
  const tracked = Number(total.rows[0]?.n ?? 0);
  const due = await dueCalls(db, market, d);
  let settled = 0;
  for (const call of due) {
    const after = sessions?.filter((s) => s > call.callD) ?? [];
    const exitSession = after[call.horizonSessions];
    const elapsed = exitSession !== undefined && exitSession <= d;
    const upTo = elapsed && exitSession !== undefined ? exitSession : d;
    const bars = await closesOf(db, market, call.code, call.callD, upTo);
    const core = callOutcome(call, bars, elapsed);
    if (core === null) continue;
    let marketRet: number | null = null;
    let vs: number | null = null;
    let luck: number | null = null;
    let basis = "none";
    if (core.state !== "no_bars" && core.entryD !== null && core.exitD !== null) {
      const lead = addDays(core.entryD, -SERIES_LEAD_DAYS);
      const loaded = await loadTotalReturnSeries(db, market, BENCH_INDEX, lead, core.exitD);
      // from the entry close (the level on `entryD` itself), not from the session before it
      const w = windowReturnPpm(loaded.series, addDays(core.entryD, 1), core.exitD);
      if (w === null) continue; // no index data for the window yet: try again next week
      basis = loaded.basis;
      marketRet = w.retPpm;
      vs = core.netPpm! - (call.direction === "long" ? w.retPpm : -w.retPpm);
      luck = await luckPct(db, {
        market,
        code: call.code,
        direction: call.direction,
        entryD: core.entryD,
        exitD: core.exitD,
        netPpm: core.netPpm!,
      });
    }
    const r = await db.execute({
      sql: `INSERT INTO expert_call_outcome (claim_id, state, entry_d, exit_d, net_ppm, index_code, basis,
              market_ret_ppm, vs_market_ppm, luck_pct, settled_d)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      args: [
        call.claimId,
        core.state,
        core.entryD,
        core.exitD,
        core.netPpm,
        BENCH_INDEX,
        basis,
        marketRet,
        vs,
        luck,
        d,
      ],
    });
    if (r.rowsAffected > 0) settled += 1;
  }
  return { tracked, settled, skipped: due.length - settled };
}
