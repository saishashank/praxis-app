// Daily orchestrator, batch 2a "close the books" (M3 T10; M3 design 4.1, 4.2, 4.6; ARN-060;
// D-069, D-075, D-076, proposed D-077). HIGH-RISK: this is where the money modules meet the clock.
//
// ONE run closes ONE session D for every active cohort, in a fixed order (cohort id ascending,
// order id ascending) and writes ONE run_record keyed `arena-2a:<market>:<D>`:
//
//   1. preconditions - market mode (`full`, or `data_only` only as an explicit REPLAY against a
//      non-production database), D is a trading session, Batch 1's completion_marker for D exists.
//      Anything else records a `skipped` run and writes NOTHING to an arena table.
//   2. per cohort (the stage order below; every stage is idempotent, so a killed run resumes):
//        a. ledger catch-up for fills not yet posted, then T+2 settlements due on D
//        b. corporate actions of D (quantity re-bases, dividends, DAT-223) - BEFORE the fills, so the
//           factor-adjusted stop and close-out levels and a disposal of the holding are known
//        c. fills of the orders decided before D at D's raw bar: entries re-gated at fill time
//           (entriesAllowed -> cancelled('gate')), CS exits, liquidation orders (`LQ:`, exitType
//           terminal); exits are never blocked by quality (exitsAllowed)
//        d. IS stops of every open position, including one opened this session (afterOpen)
//        e. sleeve: entry (ARN-003: both fit or the sleeve is skipped), exits that follow the stock
//           exit, the 50 % close-out, financing posted to the end of D
//        f. mark to market, nav_daily / nav_daily_pos, ARN-101 invariants (a violation stores the
//           day with invariants_ok = 0, logs an app_log error and freezes the cohort: no later phase)
//        g. sleeve unlock check
//   3. terminal checks on liquidation NAV for every healthy cohort (cohortWriter.runTerminalChecks),
//      then, for cohorts that ended earlier, the legacy ledger and the `liquidated` event once the
//      liquidation open has happened.
//
// Reads come from `createMarketData` (marketData.ts), which refuses any date after D (TST-109).
// No clock is read for engine rows and there is no randomness; the injected `now` stamps only
// run_record / app_log (which are not part of a replay). Money is bigint micro-AUD; libsql must be
// opened with intMode "bigint".
import type { Client } from "@libsql/client";
import {
  addDays,
  isTradingDay,
  previousTradingDay,
  type CalendarKind,
  type CalendarRow,
} from "@/lib/data/calendar";
import {
  caBasisOf,
  crossing,
  initialStopAtFill,
  isUnit,
  parsePlan,
  rescaleQty,
  scaleMicro,
} from "@/lib/agents/orderPlan";
import { entriesAllowed, type EntryDecision } from "@/lib/data/quality/gate";
import { hasSuccess, finishRun, startRun } from "@/lib/runs/runRecord";
import type { Micro } from "@/lib/money/micro";
import { makeRational, mulRat, type Rational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import {
  parseCohortParams,
  resolveCohortParams,
  type CohortParams,
  type ParamOverrides,
} from "./cohort";
import {
  loadCohort,
  loadExecutions,
  loadPendingLiquidationOrders,
  runTerminalChecks,
  writeLegacyMoves,
  writeLiquidated,
  type RestartConfig,
  type StoredCohort,
} from "./cohortWriter";
import {
  applyCorporateActionsDay,
  loadConfirmedActions,
  loadQtyAdjustments,
} from "./corpActionWriter";
import { suspensionMark } from "./corpActions";
import { exDividendOn, toExDividendActions, type ExDividendAction } from "./exDividend";
import { decisionCutoffUtc } from "@/lib/agents/decisionView";
import { getConfig } from "@/lib/config/store";
import { COST_PROFILES, type CostProfile, type CostProfileCode } from "./costs";
import {
  fillCloseSignalExit,
  fillEntryLimit,
  fillIntradayStop,
  fillOrder,
  selectExit,
  type FillEnv,
  type FillOrderEnv,
  type LimitFillOutcome,
  type OrderToFill,
  type SimulatedFill,
} from "./fills";
import { fillRowRule } from "@/lib/cortex/economics/fillRow";
import { cortexOpenGuard } from "@/lib/cortex/stage";
import { resizeEntryAtFill } from "./sizing";
import { writeFill } from "./fillWriter";
import { isFatal, checkCohortBooks, type Violation } from "./invariants";
import {
  availableCash,
  balancesFromRows,
  fillTxns,
  pendingSettlements,
  replayCostBasis,
  settlementsDue,
  type LedgerFill,
  type QtyAdjustment,
} from "./ledger";
import {
  loadLedgerFills,
  loadLedgerRows,
  toBig,
  writeLedgerTxn,
  writeNavDay,
} from "./ledgerWriter";
import { createMarketData, type MarketData } from "./marketData";
import {
  computeNavDay,
  derivePositions,
  withInvariantsOk,
  type CohortBooks,
  type Mark,
  type NavDay,
} from "./nav";
import type { ExitType, RecoveryMode } from "./schema";
import {
  earlierSleeveExit,
  financingAccruedAt,
  lockStatus,
  openRealTradeAt,
  openTrade,
  priceFactorSince,
  quoteSleeveEntry,
  quoteSleeveExit,
  sleeveEligibility,
  sleeveLiquidationCostMicro,
  sleeveMarginMicro,
  sleeveUnrealAt,
  type SleeveConfig,
  type SleeveExitMode,
  type SleeveExitQuote,
  type SleeveTrade,
} from "./sleeve";
import {
  loadSleeveStates,
  loadSleeveTrades,
  runSleeveUnlockCheck,
  writeSleeveClose,
  writeSleeveFinancing,
  writeSleeveOpen,
} from "./sleeveWriter";
import { markNotRechecked } from "./preopen";
import { planLegacy } from "./terminal";
import { openS2Once } from "@/lib/heartbeat/incidents";
import { INVARIANTS_CLEARED } from "./unfreezeCore";
import type { NotifyCtx } from "@/lib/incidents/notify";

export const ARENA_JOB = "arena-close";
export const ARENA_MASTER_SEED = 20_261_011n;

/** `arena-2a:<market>:<d>`: the concurrency key of batch 2a (design 4.1, cf. `batch1:<market>:<d>`). */
export const closeBooksKey = (market: string, d: string): string => `arena-2a:${market}:${d}`;

export class CloseBooksError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CloseBooksError";
    this.code = code;
  }
}

export type CloseBooksOptions = {
  readonly market: string;
  /** The session to close (Sydney trading date). */
  readonly d: string;
  /**
   * An explicit replay against a NON-production database. Only then may a `data_only` market be
   * processed (D-066 / BLD-024: production in data_only mode never writes arena tables).
   */
  readonly replay?: boolean;
  /** Stamps run_record / app_log only; never an engine row. */
  readonly now: () => string;
  readonly commitSha?: string | null;
  readonly masterSeed?: bigint;
  /** The market's calendar rows when the caller already holds them (a replay); else read per run. */
  readonly calendar?: CalendarRow[];
  /** Parameter overrides for cohorts started by a restart (default: ch.15 defaults). */
  readonly restartParams?: (executionId: string) => ParamOverrides;
  /** ch.15 max_promotions_per_week for a pending promotion at a restart (default: the registry value). */
  readonly maxPromotionsPerWeek?: number;
  /** Email context for the P1 "previous session not closed" incident (V1-B1); absent = recorded only. */
  readonly notify?: Omit<NotifyCtx, "db" | "now">;
};

/** V1-S15 (D-682): a held code with no bar on this many sessions in a row opens the S2 `stale_mark` incident. */
export const STALE_MARK_ALERT_SESSIONS = 3; // threshold-ok: decision D-682, bounded wait before an alert
export const STALE_MARK_INCIDENT = "stale_mark";

export type CloseBooksStatus = "success" | "degraded" | "failed" | "skipped" | "already_done";

export type CloseBooksResult = {
  readonly market: string;
  readonly d: string;
  readonly status: CloseBooksStatus;
  /** Skip reason or failure code; null for success. */
  readonly reason: string | null;
  readonly runId: number | null;
  /** Cohort ids processed to a stored NAV (ascending). */
  readonly closed: readonly string[];
  /** Cohorts whose invariants failed today. */
  readonly failed: readonly string[];
  /** Cohorts frozen by an earlier failure (no phase runs for them). */
  readonly frozen: readonly string[];
  /** Cohorts that reached a terminal state at this close. */
  readonly terminal: readonly string[];
  readonly stats: {
    readonly fills: number;
    readonly orders: number;
    readonly ledgerTxns: number;
    readonly navDays: number;
  };
};

const text = (value: unknown): string => String(value);

type Stats = { fills: number; orders: number; ledgerTxns: number; navDays: number };

type DayCtx = {
  readonly db: Client;
  readonly market: string;
  readonly d: string;
  readonly priorD: string;
  readonly calendar: CalendarRow[];
  readonly data: MarketData;
  readonly now: () => string;
  readonly runId: number;
  readonly stats: Stats;
  readonly actions: Awaited<ReturnType<typeof loadConfirmedActions>>;
  readonly lastCloses: Map<string, Micro>;
  /** FAM-007: the dividends going ex today, and the decision cut-off of the previous session (GL-02). */
  readonly exDividends: readonly ExDividendAction[];
  readonly exDivCutoff: string;
  readonly gates: Map<string, EntryDecision>;
  /** Fills older than this are settled and posted (T+2 plus holidays fit well inside 14 days). */
  readonly recentFrom: string;
  /** V1-S15: email context for the "stale mark" incident; absent = recorded only. */
  readonly notify?: Omit<NotifyCtx, "db" | "now">;
};

/** Per-cohort, per-day cache of the two book reads that most stages need (dropped on every write). */
type BookCache = { fills?: LedgerFill[]; adjustments?: QtyAdjustment[] };

type CohortCtx = {
  readonly cache: BookCache;
  readonly cohort: StoredCohort;
  readonly params: CohortParams;
  readonly profile: CostProfile;
  readonly cfg: SleeveConfig | null;
};

// ---- small readers ---------------------------------------------------------------------------------

export async function loadCalendar(db: Client, market: string): Promise<CalendarRow[]> {
  const rs = await db.execute({
    sql: "SELECT d, kind, close_time, confirmed FROM trading_calendar WHERE market = ? ORDER BY d",
    args: [market],
  });
  return rs.rows.map((r) => ({
    d: text(r.d),
    kind: text(r.kind) as CalendarKind,
    close_time: r.close_time === null ? null : text(r.close_time),
    confirmed: toBig(r.confirmed) === 1n ? 1 : 0,
  }));
}

function ratFromText(value: string): Rational {
  const parts = value.split("/");
  return makeRational(BigInt(parts[0]), BigInt(parts[1] ?? "1"));
}

/** The sleeve settings of a cohort from its `sleeve_json` (written by cohort.sleeveJsonFor). */
export function sleeveConfigFrom(json: string): SleeveConfig {
  const j = JSON.parse(json) as Record<string, string | number>;
  return {
    leverage: BigInt(j.leverage),
    marginCapMicro: BigInt(j.margin_cap_micro),
    marginNavFraction: ratFromText(text(j.margin_nav_fraction)),
    closeoutFraction: ratFromText(text(j.closeout_fraction)),
    financingRate: ratFromText(text(j.financing_rate)),
    financingBasis: BigInt(j.financing_basis),
    recoveryMode: text(j.recovery_mode) as RecoveryMode,
    rec4Sessions: Number.parseInt(text(j.rec4_sessions), 10),
    profile: COST_PROFILES[text(j.profile) as CostProfileCode],
  };
}

export async function loadSleeveConfig(db: Client, cohortId: string): Promise<SleeveConfig | null> {
  const rs = await db.execute({
    sql: "SELECT sleeve_json FROM cohort WHERE id = ?",
    args: [cohortId],
  });
  return rs.rows.length === 0 || rs.rows[0].sleeve_json === null
    ? null
    : sleeveConfigFrom(text(rs.rows[0].sleeve_json));
}

/** Cohorts to process on `d`: started, and either unresolved or still winding down. */
async function activeCohortIds(db: Client, d: string, recentFrom: string): Promise<string[]> {
  const rs = await db.execute({
    sql: `SELECT c.id FROM cohort c
          WHERE c.start_d <= ?
            AND (c.terminal_kind IS NULL
              OR NOT EXISTS (SELECT 1 FROM cohort_event e WHERE e.cohort_id = c.id AND e.kind = 'liquidated')
              OR EXISTS (SELECT 1 FROM sleeve_trade s
                         WHERE s.cohort_id = c.id AND s.shadow = 0 AND s.closed_by IS NULL)
              OR EXISTS (SELECT 1 FROM fill f
                         WHERE f.cohort_id = c.id AND f.d >= ? AND (f.side = 'buy' OR f.value_micro <> f.brokerage_micro)
                           AND f.order_id NOT IN (SELECT o.id FROM arena_order o
                                                  WHERE o.cohort_id = c.id AND o.kind IN ('sleeve_open','sleeve_close'))
                           AND NOT EXISTS (SELECT 1 FROM cash_ledger l
                                           WHERE l.cohort_id = c.id AND l.d >= ? AND l.txn_id = 'settle:' || f.id)))
          ORDER BY c.id`,
    args: [d, recentFrom, recentFrom],
  });
  return rs.rows.map((r) => text(r.id));
}

async function logApp(
  ctx: Pick<DayCtx, "db" | "now" | "runId">,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  await ctx.db.execute({
    sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, ?, ?, ?, ?)",
    args: [ctx.now(), level, ARENA_JOB, message.slice(0, 500), ctx.runId],
  });
}

// ---- stage a: ledger catch-up and settlement -------------------------------------------------------------

const STOCK_FILLS = `f.cohort_id = ? AND f.order_id NOT IN
  (SELECT o.id FROM arena_order o WHERE o.cohort_id = ? AND o.kind IN ('sleeve_open','sleeve_close'))`;

/** Post the ledger transactions of every stock fill that has none yet (also resumes a killed run). */
async function postUnposted(ctx: DayCtx, cc: CohortCtx): Promise<void> {
  const id = cc.cohort.id;
  const missing = await ctx.db.execute({
    sql: `SELECT f.id FROM fill f WHERE ${STOCK_FILLS} AND f.d >= ?
            AND NOT EXISTS (SELECT 1 FROM cash_ledger l WHERE l.cohort_id = f.cohort_id AND l.d >= ?
                            AND l.txn_id = 'fill:' || f.id)
          ORDER BY f.d, f.id`,
    args: [id, id, ctx.recentFrom, ctx.recentFrom],
  });
  if (missing.rows.length === 0) return;
  const wanted = new Set(missing.rows.map((r) => text(r.id)));
  const [fills, adjustments] = await Promise.all([fillsOf(ctx, cc), adjustmentsOf(ctx, cc)]);
  const costs = replayCostBasis(fills, adjustments, "9999-12-31").saleCostByFillId;
  for (const f of fills) {
    if (!wanted.has(f.id)) continue;
    for (const txn of fillTxns(f, costs.get(f.id))) {
      if ((await writeLedgerTxn(ctx.db, id, txn)).written) ctx.stats.ledgerTxns += 1;
    }
  }
}

/** Settle every fill whose T+2 session has come (receipts first, then payments). */
async function settleDue(ctx: DayCtx, cc: CohortCtx): Promise<void> {
  const id = cc.cohort.id;
  const open = await ctx.db.execute({
    sql: `SELECT f.id FROM fill f WHERE ${STOCK_FILLS} AND f.d >= ?
            AND (f.side = 'buy' OR f.value_micro <> f.brokerage_micro)
            AND NOT EXISTS (SELECT 1 FROM cash_ledger l WHERE l.cohort_id = f.cohort_id AND l.d >= ?
                            AND l.txn_id = 'settle:' || f.id)
          LIMIT 1`,
    args: [id, id, ctx.recentFrom, ctx.recentFrom],
  });
  if (open.rows.length === 0) return;
  const [fills, rows] = await Promise.all([fillsOf(ctx, cc), loadLedgerRows(ctx.db, id)]);
  const settled = new Set(
    rows.filter((r) => r.kind === "settle" && r.refType === "fill").map((r) => text(r.refId)),
  );
  const pending = pendingSettlements(fills, settled, ctx.calendar);
  for (const txn of settlementsDue(pending, ctx.d)) {
    if ((await writeLedgerTxn(ctx.db, id, txn)).written) ctx.stats.ledgerTxns += 1;
  }
}

// ---- stage b: corporate actions ----------------------------------------------------------------------------

async function applyCorporate(ctx: DayCtx, cc: CohortCtx): Promise<void> {
  if (ctx.actions.length === 0) return;
  const id = cc.cohort.id;
  if (!ctx.actions.some((a) => a.exDate === ctx.d)) {
    const unpaid = await ctx.db.execute({
      sql: `SELECT 1 FROM cash_ledger a WHERE a.cohort_id = ? AND a.kind = 'div_accrue'
              AND NOT EXISTS (SELECT 1 FROM cash_ledger p WHERE p.cohort_id = a.cohort_id
                              AND p.kind = 'div_pay' AND p.ref_id = a.ref_id)
            LIMIT 1`,
      args: [id],
    });
    if (unpaid.rows.length === 0) return;
  }
  const result = await applyCorporateActionsDay(ctx.db, {
    cohortId: id,
    market: ctx.market,
    d: ctx.d,
    priorD: ctx.priorD,
    lastCloseFor: (code) => ctx.lastCloses.get(code),
  });
  ctx.stats.ledgerTxns += result.txnsWritten;
  cc.cache.adjustments = undefined;
}

// ---- stages c and d: fills and IS stops --------------------------------------------------------------------

type OpenTradeRow = {
  readonly id: string;
  readonly code: string;
  readonly stopMicro: Micro;
  readonly entryD: string;
  /**
   * In-session IS levels written by batch 2b at the latest close before today (stop_level, design
   * 2.6 and decision 7), each with the session it was written on. Empty for M3 trades.
   */
  readonly levels: readonly { readonly d: string; readonly levelMicro: Micro }[];
};

async function openTrades(ctx: DayCtx, cohortId: string): Promise<OpenTradeRow[]> {
  const rs = await ctx.db.execute({
    sql: `SELECT t.id, t.code, t.stop_micro, f.d AS entry_d FROM trade t
          JOIN fill f ON f.id = t.entry_fill_id
          WHERE t.cohort_id = ? AND t.exit_type IS NULL ORDER BY t.code, t.id`,
    args: [cohortId],
  });
  if (rs.rows.length === 0) return [];
  const levels = await ctx.db.execute({
    sql: `SELECT s.trade_id, s.d, s.level_micro FROM stop_level s
          WHERE s.cohort_id = ? AND s.d = (SELECT MAX(x.d) FROM stop_level x
                                           WHERE x.trade_id = s.trade_id AND x.d < ?)
          ORDER BY s.trade_id, s.rule`,
    args: [cohortId, ctx.d],
  });
  const byTrade = new Map<string, { d: string; levelMicro: Micro }[]>();
  for (const l of levels.rows) {
    const list = byTrade.get(text(l.trade_id)) ?? [];
    list.push({ d: text(l.d), levelMicro: toBig(l.level_micro) });
    byTrade.set(text(l.trade_id), list);
  }
  return rs.rows.map((r) => ({
    id: text(r.id),
    code: text(r.code),
    stopMicro: toBig(r.stop_micro),
    entryD: text(r.entry_d),
    levels: byTrade.get(text(r.id)) ?? [],
  }));
}

async function fillsOf(ctx: DayCtx, cc: CohortCtx): Promise<LedgerFill[]> {
  cc.cache.fills ??= await loadLedgerFills(ctx.db, cc.cohort.id);
  return cc.cache.fills;
}

async function adjustmentsOf(ctx: DayCtx, cc: CohortCtx): Promise<QtyAdjustment[]> {
  cc.cache.adjustments ??= await loadQtyAdjustments(ctx.db, cc.cohort.id);
  return cc.cache.adjustments;
}

async function holdingsOf(
  ctx: DayCtx,
  cc: CohortCtx,
): Promise<{ positions: ReadonlyMap<string, bigint>; adjustments: QtyAdjustment[] }> {
  const [fills, adjustments] = await Promise.all([fillsOf(ctx, cc), adjustmentsOf(ctx, cc)]);
  return { positions: derivePositions(fills, adjustments, ctx.d).positions, adjustments };
}

/**
 * The IS level in force on `d`, in the code's current price terms after splits (ARN-043): the
 * highest of the initial stop and of every level batch 2b wrote at the latest earlier close
 * (design 2.6), each re-based by the exact factor since the date it was set.
 */
function effectiveStop(
  trade: OpenTradeRow,
  d: string,
  adjustments: readonly QtyAdjustment[],
): Micro {
  const rebased = (level: Micro, from: string): Micro => {
    const factor = priceFactorSince(trade.code, from, d, adjustments);
    const v = roundHalfAwayFromZero(mulRat(makeRational(level), factor));
    return v < 1n ? 1n : v;
  };
  let best = rebased(trade.stopMicro, trade.entryD);
  for (const l of trade.levels) {
    const v = rebased(l.levelMicro, l.d);
    if (v > best) best = v;
  }
  return best;
}

/** FAM-007 (D-219): the confirmed dividend per share going ex today, known by the previous cut-off. */
function exDividendToday(ctx: DayCtx, code: string): Micro {
  return exDividendOn(ctx.exDividends, code, ctx.d, ctx.exDivCutoff);
}

async function cancelOrder(ctx: DayCtx, orderId: string, reason: string): Promise<void> {
  await ctx.db.execute({
    sql: "UPDATE arena_order SET status = 'cancelled', reject_reason = ? WHERE id = ? AND status = 'pending'",
    args: [reason, orderId],
  });
  ctx.stats.orders += 1;
}

async function gateFor(ctx: DayCtx, code: string): Promise<EntryDecision> {
  const cached = ctx.gates.get(code);
  if (cached !== undefined) return cached;
  const decision = await entriesAllowed(ctx.db, code, ctx.d, ctx.market);
  ctx.gates.set(code, decision);
  return decision;
}

function fillEnvOf(cc: CohortCtx, bar: FillEnv["bar"], advMicro: Micro): FillEnv {
  return { bar, advMicro, profile: cc.profile, tickCrossFactor: cc.params.tickCrossFactor };
}

/** The cohort's available cash right now (ARN-025, by settlement mode). */
async function availableCashNow(ctx: DayCtx, cc: CohortCtx): Promise<Micro> {
  await postUnposted(ctx, cc);
  const id = cc.cohort.id;
  const [fills, rows] = await Promise.all([fillsOf(ctx, cc), loadLedgerRows(ctx.db, id)]);
  const settled = new Set(
    rows.filter((r) => r.kind === "settle" && r.refType === "fill").map((r) => text(r.refId)),
  );
  const available = availableCash({
    mode: cc.params.settlementMode,
    balances: balancesFromRows(rows, ctx.d),
    pending: pendingSettlements(fills, settled, ctx.calendar),
    sessionD: ctx.d,
  });
  return available;
}

/**
 * Fill ids encode the intraday order the ledger replays them in (loadLedgerFills sorts by date and
 * id, replayCostBasis too): CS and liquidation exits at the open (F1:), entries at the open (F2:),
 * IS stops after the open (F3:). So a position opened and stopped out in one session is bought
 * before it is sold, and an exit never follows a re-entry of the same code at the open.
 */
/**
 * The entry fill of one order. A v1 order (no `limit_micro`) goes through `fillOrder` exactly as
 * before. A Cortex order (D-288) re-checks the gate and the halt, then fills through `fillEntryLimit`:
 * at the open when the open is at or below the limit, else at the limit on a trade-through, else
 * `unfilled`. The in-memory `limit` rule is written as the 0007-legal `level` (D-307).
 */
type EntryOutcome =
  | ReturnType<typeof fillOrder>
  | { readonly status: "unfilled"; readonly reason: "limit_not_reached" }
  | {
      readonly status: "filled";
      readonly fill: SimulatedFill;
      readonly initialStopMicro: bigint | null;
      readonly limit: LimitFillOutcome;
    };
function fillEntry(
  order: Extract<OrderToFill, { kind: "entry" }>,
  env: FillOrderEnv,
  limitMicro: bigint | null,
): EntryOutcome {
  if (limitMicro === null) return fillOrder(order, env);
  if (env.gate === undefined || !env.gate.allowed) {
    const detail = env.gate === undefined ? "no_gate_decision" : env.gate.reason;
    return { status: "cancelled", reason: "gate", detail };
  }
  if (env.halted === true) return { status: "cancelled", reason: "halted", detail: "halted" };
  const limit = fillEntryLimit(env, order.qty, limitMicro);
  if (limit.status === "unfilled") return { status: "unfilled", reason: "limit_not_reached" };
  if (order.stopFrom === undefined) throw new RangeError("a limit order needs a stop rule");
  const fill: SimulatedFill = { ...limit.fill, rule: fillRowRule(limit) };
  const stop = order.stopFrom(fill.fillPriceMicro);
  if (stop <= 0n) throw new RangeError("initial stop must be positive");
  return { status: "filled", fill, initialStopMicro: stop, limit };
}

/** The open-time checks of a Cortex entry at its fill; the cancel reason, or null when all pass. */
async function cortexGuardAtFill(
  ctx: DayCtx,
  o: Record<string, unknown>,
  cohortId: string,
  plan: ReturnType<typeof parsePlan> | null,
  limit: LimitFillOutcome,
): Promise<string | null> {
  const exec = await ctx.db.execute({
    sql: "SELECT e.family AS family FROM cohort c JOIN execution e ON e.id = c.execution_id WHERE c.id = ?",
    args: [cohortId],
  });
  const family = exec.rows.length === 0 ? null : exec.rows[0]!.family;
  if (family === null || family === undefined) return null;
  const rechecked = await ctx.db.execute({
    sql: "SELECT 1 FROM preopen_result WHERE order_id = ? AND outcome IN ('pass', 'cancel')",
    args: [text(o.id)],
  });
  const g = await cortexOpenGuard(ctx.db, {
    market: ctx.market,
    d: ctx.d,
    barD: ctx.d,
    orderId: text(o.id),
    signalId: o.signal_id === null || o.signal_id === undefined ? null : text(o.signal_id),
    family: text(family) as never,
    fill: limit,
    stopSpec: plan?.plan.initialStops[0]?.spec ?? null,
    rechecked: rechecked.rows.length > 0,
  });
  return g.firstFail === null ? null : `filter:open_${g.firstFail}`;
}

async function fillPending(ctx: DayCtx, cc: CohortCtx): Promise<void> {
  const id = cc.cohort.id;
  const rs = await ctx.db.execute({
    sql: `SELECT id, code, kind, qty, ref_stop_micro, decided_d, stop_spec, max_open_micro, card_id,
                 limit_micro, signal_id
          FROM arena_order
          WHERE cohort_id = ? AND status = 'pending' AND decided_d < ? AND kind IN ('entry','exit_cs')
          ORDER BY id`,
    args: [id, ctx.d],
  });
  for (const o of rs.rows) {
    const orderId = text(o.id);
    const code = text(o.code);
    const stopSpec = o.stop_spec === null ? null : text(o.stop_spec);
    // Corporate actions between the order's quantity basis and today re-base its shares and prices
    // (M4 T8; the M3 `order_qty_stale` limitation): a split rescales it, a disposal cancels it.
    const basis = caBasisOf(stopSpec, text(o.decided_d));
    const crossed = crossing(ctx.actions, code, basis.through, ctx.d, basis.applied);
    const qty = !isUnit(crossed.ratio) ? rescaleQty(toBig(o.qty), crossed) : toBig(o.qty);
    const bar = await ctx.data.bar(code, ctx.d);
    const advMicro = await ctx.data.adv(code, ctx.priorD);
    const halted = await ctx.data.halted(code, ctx.d);
    if (text(o.kind) === "entry") {
      if (bar === null) {
        await cancelOrder(ctx, orderId, "no_bar");
        continue;
      }
      if (o.ref_stop_micro === null && stopSpec === null) {
        await cancelOrder(ctx, orderId, "no_stop");
        continue;
      }
      if (crossed.disposal) {
        await cancelOrder(ctx, orderId, "corporate_action");
        continue;
      }
      if (qty < 1n) {
        await cancelOrder(ctx, orderId, "whole_share");
        continue;
      }
      let plan: ReturnType<typeof parsePlan> | null = null;
      if (stopSpec !== null) {
        try {
          plan = parsePlan(stopSpec);
        } catch {
          // a stop_spec that is not a plan (an exit order's basis note) cannot size a stop
          if (o.ref_stop_micro === null) {
            await cancelOrder(ctx, orderId, "no_stop");
            continue;
          }
        }
      }
      if (plan === null && o.ref_stop_micro === null) {
        await cancelOrder(ctx, orderId, "no_stop");
        continue;
      }
      const gate = await gateFor(ctx, code);
      let first = true;
      if (cc.profile.code === "P2") {
        const fills = await fillsOf(ctx, cc);
        first = !fills.some((f) => f.side === "buy" && f.code === code && f.d === ctx.d);
      }
      // Cortex orders only (D-288): the limit, on the fill-session price basis
      const limitMicro =
        o.limit_micro === null || o.limit_micro === undefined
          ? null
          : scaleMicro(toBig(o.limit_micro), crossed.priceFactor);
      let outcome: EntryOutcome;
      try {
        outcome = fillEntry(
          plan !== null
            ? {
                kind: "entry",
                qty,
                stopFrom: (fillMicro) => initialStopAtFill(plan, fillMicro, crossed.priceFactor),
              }
            : { kind: "entry", qty, stopDistanceMicro: toBig(o.ref_stop_micro) },
          {
            ...fillEnvOf(cc, bar, advMicro),
            feeContext: { code, firstBuyOfSecurityToday: first },
            halted,
            gate,
          },
          limitMicro,
        );
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        await cancelOrder(ctx, orderId, "unfillable");
        continue;
      }
      if (outcome.status === "unfilled") {
        // a limit order the session never reached (D-288): no trade in either arm
        await cancelOrder(ctx, orderId, outcome.reason);
      } else if (outcome.status === "cancelled") {
        await cancelOrder(ctx, orderId, outcome.reason);
      } else if (
        outcome.status === "filled" &&
        o.max_open_micro !== null &&
        bar.openMicro >= scaleMicro(toBig(o.max_open_micro), crossed.priceFactor)
      ) {
        // F3 (spec 7.4): the order is cancelled at the fill when the open gaps to the cap or above
        await cancelOrder(ctx, orderId, "gap");
      } else if (outcome.status === "filled") {
        // GL-03 (D-207): a gap above the expected price can leave the planned quantity unaffordable.
        // Resize to the largest affordable whole parcel; cancel 'cash' only when one marketable
        // parcel (A$500) is unaffordable (ARN-101 cash >= 0 holds either way).
        const sized = resizeEntryAtFill({
          plannedQty: outcome.fill.qty,
          fillPriceMicro: outcome.fill.fillPriceMicro,
          availableCashMicro: await availableCashNow(ctx, cc),
          profile: cc.profile,
          feeContext: { code, firstBuyOfSecurityToday: first },
        });
        if (sized.status === "cancel") {
          await cancelOrder(ctx, orderId, sized.reason);
          continue;
        }
        if (sized.status === "resized") {
          outcome = fillEntry(
            plan !== null
              ? {
                  kind: "entry",
                  qty: sized.qty,
                  stopFrom: (fillMicro) => initialStopAtFill(plan, fillMicro, crossed.priceFactor),
                }
              : { kind: "entry", qty: sized.qty, stopDistanceMicro: toBig(o.ref_stop_micro) },
            {
              ...fillEnvOf(cc, bar, advMicro),
              feeContext: { code, firstBuyOfSecurityToday: first },
              halted,
              gate,
            },
            limitMicro,
          );
          if (outcome.status !== "filled") {
            await cancelOrder(ctx, orderId, "unfillable");
            continue;
          }
        }
        // CTX-028 open-time list (Cortex orders only): kills, sources, shock, stale universe, the limit
        // at the fill, the stop plus gap95 re-check, and a missing 09:55 re-check (O07)
        if (limitMicro !== null && "limit" in outcome) {
          const guard = await cortexGuardAtFill(ctx, o, id, plan, outcome.limit);
          if (guard !== null) {
            await cancelOrder(ctx, orderId, guard);
            continue;
          }
        }
        // ARN-020a: an entry that was never re-checked fills flagged `not_rechecked` (AT-18 part B)
        await markNotRechecked(ctx.db, {
          market: ctx.market,
          d: ctx.d,
          orderId,
          cardId: o.card_id === null ? null : text(o.card_id),
          at: ctx.now(),
        });
        const written = await writeFill(ctx.db, {
          fillId: `F2:${orderId}`,
          orderId,
          cohortId: id,
          d: ctx.d,
          code,
          fill: outcome.fill,
          trade: {
            kind: "open",
            tradeId: `T:${orderId}`,
            stopMicro: outcome.initialStopMicro as bigint,
          },
        });
        if (written.written) {
          ctx.stats.fills += 1;
          cc.cache.fills = undefined;
        }
      }
      continue;
    }
    // exit_cs (including the liquidation orders): wait when the code cannot trade today
    if (bar === null || halted) continue;
    const trade = (await openTrades(ctx, id)).find((t) => t.code === code);
    const { positions, adjustments } = await holdingsOf(ctx, cc);
    const holding = positions.get(code) ?? 0n;
    if (trade === undefined || holding === 0n) {
      await cancelOrder(ctx, orderId, "no_position");
      continue;
    }
    if (holding > qty) {
      // only reachable when an action the order could not know about was confirmed late
      throw new CloseBooksError("order_qty_stale", `order ${orderId} sells less than the holding`);
    }
    const sellQty = holding < qty ? holding : qty;
    const env = fillEnvOf(cc, bar, advMicro);
    const cs = fillCloseSignalExit(env, sellQty);
    const stop = fillIntradayStop(env, sellQty, effectiveStop(trade, ctx.d, adjustments), {
      exDividendMicro: exDividendToday(ctx, code),
    });
    const chosen = selectExit(cs, stop);
    if (chosen === null) continue;
    const liquidation = orderId.startsWith("LQ:");
    const exitType: ExitType = liquidation
      ? "terminal"
      : chosen.rule === "close_signal"
        ? "CS"
        : "IS";
    const written = await writeFill(ctx.db, {
      fillId: `F1:${orderId}`,
      orderId,
      cohortId: id,
      d: ctx.d,
      code,
      fill: chosen,
      trade: { kind: "close", tradeId: trade.id, exitType },
    });
    if (written.written) {
      ctx.stats.fills += 1;
      cc.cache.fills = undefined;
    }
  }
}

async function isStops(ctx: DayCtx, cc: CohortCtx): Promise<void> {
  const id = cc.cohort.id;
  const trades = await openTrades(ctx, id);
  if (trades.length === 0) return;
  const { positions, adjustments } = await holdingsOf(ctx, cc);
  for (const t of trades) {
    const qty = positions.get(t.code);
    if (qty === undefined) continue;
    const bar = await ctx.data.bar(t.code, ctx.d);
    if (bar === null || (await ctx.data.halted(t.code, ctx.d))) continue;
    const env = fillEnvOf(cc, bar, await ctx.data.adv(t.code, ctx.priorD));
    const fill = fillIntradayStop(env, qty, effectiveStop(t, ctx.d, adjustments), {
      afterOpen: t.entryD === ctx.d,
      exDividendMicro: exDividendToday(ctx, t.code),
    });
    if (fill === null) continue;
    const orderId = `IS:${t.id}:${ctx.d}`;
    await ctx.db.execute({
      sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, ref_stop_micro)
            VALUES (?, ?, ?, ?, 'sell', 'exit_is', ?, ?) ON CONFLICT DO NOTHING`,
      args: [orderId, id, ctx.d, t.code, qty, t.stopMicro],
    });
    const written = await writeFill(ctx.db, {
      fillId: `F3:${orderId}`,
      orderId,
      cohortId: id,
      d: ctx.d,
      code: t.code,
      fill,
      trade: { kind: "close", tradeId: t.id, exitType: "IS" },
    });
    if (written.written) {
      ctx.stats.fills += 1;
      cc.cache.fills = undefined;
    }
  }
}

// ---- stage e: the sleeve -------------------------------------------------------------------------------------

/** NAV at the last close before `d`, or the seed on the first day (the margin base, ARN-040). */
async function referenceNav(ctx: DayCtx, cohort: StoredCohort): Promise<Micro> {
  const nav = await ctx.db.execute({
    sql: "SELECT nav_micro FROM nav_daily WHERE cohort_id = ? AND d < ? ORDER BY d DESC LIMIT 1",
    args: [cohort.id, ctx.d],
  });
  return nav.rows.length > 0 ? toBig(nav.rows[0].nav_micro) : cohort.seedMicro;
}

async function sleeveEntries(ctx: DayCtx, cc: CohortCtx, cfg: SleeveConfig): Promise<void> {
  const id = cc.cohort.id;
  const todays = await ctx.db.execute({
    sql: `SELECT id, code, decided_d, tier FROM arena_order
          WHERE cohort_id = ? AND kind = 'entry' AND status = 'filled' AND fill_d = ? ORDER BY id`,
    args: [id, ctx.d],
  });
  for (const o of todays.rows) {
    const orderId = text(o.id);
    const code = text(o.code);
    const sleeveId = `S:${orderId}`;
    const exists = await ctx.db.execute({
      sql: "SELECT 1 FROM sleeve_trade WHERE id = ?",
      args: [sleeveId],
    });
    if (exists.rows.length > 0) continue;
    const bar = await ctx.data.bar(code, ctx.d);
    if (bar === null) continue;
    const eligibility = sleeveEligibility({
      tier: o.tier === null ? "U3" : (text(o.tier) as "U1" | "U2" | "U3"),
    });
    if (!eligibility.eligible) continue;
    const [trades, states, rows, fills] = await Promise.all([
      loadSleeveTrades(ctx.db, id),
      loadSleeveStates(ctx.db, id),
      loadLedgerRows(ctx.db, id),
      fillsOf(ctx, cc),
    ]);
    const margin = sleeveMarginMicro(await referenceNav(ctx, cc.cohort), cfg);
    if (margin <= 0n) continue;
    const env = fillEnvOf(
      { ...cc, profile: cfg.profile },
      bar,
      await ctx.data.adv(code, ctx.priorD),
    );
    const quote = quoteSleeveEntry(env, margin, cfg);
    if (lockStatus(states).locked) {
      // ARN-048: a locked sleeve logs a shadow trade (one at a time, no cash)
      if (trades.some((t) => t.shadow && t.closed === null)) continue;
      const shadow = openTrade({
        id: sleeveId,
        cohortId: id,
        code,
        openD: ctx.d,
        quote,
        entryFillId: null,
        shadow: true,
        cfg,
      });
      await writeSleeveOpen(ctx.db, { cohortId: id, trade: shadow, quote });
      continue;
    }
    if (trades.some((t) => !t.shadow && t.closed === null)) continue;
    // ARN-003: margin + entry brokerage must fit in settled cash AND in available cash after the
    // stock entry; if not, the sleeve is skipped - never the stock entry.
    const need = margin + quote.entryBrokerageMicro;
    const balances = balancesFromRows(rows, ctx.d);
    const settled = new Set(
      rows.filter((r) => r.kind === "settle" && r.refType === "fill").map((r) => text(r.refId)),
    );
    const available = availableCash({
      mode: cc.params.settlementMode,
      balances,
      pending: pendingSettlements(fills, settled, ctx.calendar),
      sessionD: ctx.d,
    });
    if (balances.cash_settled < need || available < need) continue;
    const trade = openTrade({
      id: sleeveId,
      cohortId: id,
      code,
      openD: ctx.d,
      quote,
      entryFillId: `SF:${orderId}`,
      cfg,
    });
    await writeSleeveOpen(ctx.db, {
      cohortId: id,
      trade,
      quote,
      orderId: `SO:${orderId}`,
      fillId: `SF:${orderId}`,
      decidedD: text(o.decided_d),
    });
  }
}

type StockExit = { readonly exitType: string | null; readonly d: string | null };

async function stockExitOf(ctx: DayCtx, cohortId: string, sleeveId: string): Promise<StockExit> {
  const tradeId = `T:${sleeveId.slice(2)}`;
  const rs = await ctx.db.execute({
    sql: `SELECT t.exit_type, f.d FROM trade t LEFT JOIN fill f ON f.id = t.exit_fill_id
          WHERE t.id = ? AND t.cohort_id = ?`,
    args: [tradeId, cohortId],
  });
  if (rs.rows.length === 0) return { exitType: null, d: null };
  const r = rs.rows[0];
  return {
    exitType: r.exit_type === null ? null : text(r.exit_type),
    d: r.d === null ? null : text(r.d),
  };
}

async function sleeveExits(ctx: DayCtx, cc: CohortCtx, cfg: SleeveConfig): Promise<void> {
  const id = cc.cohort.id;
  const trades = (await loadSleeveTrades(ctx.db, id)).filter((t) => t.closed === null);
  if (trades.length === 0) return;
  const { adjustments } = await holdingsOf(ctx, cc);
  const stockTrades = new Map((await openTrades(ctx, id)).map((t) => [`S:${t.id.slice(2)}`, t]));
  for (const t of trades) {
    if ((await ctx.data.halted(t.code, ctx.d)) || t.openD > ctx.d) continue;
    const bar = await ctx.data.bar(t.code, ctx.d);
    if (bar === null) continue;
    const env: FillEnv = {
      bar,
      advMicro: await ctx.data.adv(t.code, ctx.priorD),
      profile: cfg.profile,
      tickCrossFactor: cc.params.tickCrossFactor,
    };
    const afterOpen = t.openD === ctx.d;
    const closeout = quoteSleeveExit(
      env,
      t,
      {
        kind: "closeout",
        financingMicro: financingAccruedAt(t, ctx.d, cfg),
        factor: priceFactorSince(t.code, t.openD, ctx.d, adjustments),
        afterOpen,
      },
      cfg,
    );
    // the sleeve follows its stock position out (CS and terminal at the open, IS at the stop level)
    let family: SleeveExitQuote | null = null;
    const stockOpen = stockTrades.get(t.id);
    if (stockOpen === undefined) {
      const stockExit = await stockExitOf(ctx, id, t.id);
      if (stockExit.exitType !== null) {
        const mode: SleeveExitMode =
          stockExit.exitType === "IS" && stockExit.d === ctx.d
            ? { kind: "is", levelMicro: await stopLevelOf(ctx, id, t.id, adjustments), afterOpen }
            : { kind: "cs" };
        family = quoteSleeveExit(env, t, mode, cfg);
      }
    }
    const pick =
      closeout !== null && family !== null
        ? earlierSleeveExit(family, closeout)
        : (closeout ?? family);
    if (pick === null) continue;
    await writeSleeveClose(ctx.db, {
      cohortId: id,
      tradeId: t.id,
      cfg,
      closeD: ctx.d,
      exit: pick,
      orderId: `SCO:${t.id}`,
      fillId: `SCF:${t.id}`,
      decidedD: ctx.d,
      adjustments,
    });
  }
}

async function stopLevelOf(
  ctx: DayCtx,
  cohortId: string,
  sleeveId: string,
  adjustments: readonly QtyAdjustment[],
): Promise<Micro> {
  const rs = await ctx.db.execute({
    sql: `SELECT t.id, t.code, t.stop_micro, f.d AS entry_d FROM trade t
          JOIN fill f ON f.id = t.entry_fill_id WHERE t.id = ? AND t.cohort_id = ?`,
    args: [`T:${sleeveId.slice(2)}`, cohortId],
  });
  const r = rs.rows[0];
  const levels = await ctx.db.execute({
    sql: `SELECT s.d, s.level_micro FROM stop_level s
          WHERE s.trade_id = ? AND s.d = (SELECT MAX(x.d) FROM stop_level x
                                          WHERE x.trade_id = s.trade_id AND x.d < ?)`,
    args: [text(r.id), ctx.d],
  });
  return effectiveStop(
    {
      id: text(r.id),
      code: text(r.code),
      stopMicro: toBig(r.stop_micro),
      entryD: text(r.entry_d),
      levels: levels.rows.map((l) => ({ d: text(l.d), levelMicro: toBig(l.level_micro) })),
    },
    ctx.d,
    adjustments,
  );
}

async function sleeveStage(ctx: DayCtx, cc: CohortCtx, cfg: SleeveConfig): Promise<void> {
  await sleeveEntries(ctx, cc, cfg);
  await sleeveExits(ctx, cc, cfg);
  const open = (await loadSleeveTrades(ctx.db, cc.cohort.id)).find(
    (t) => !t.shadow && t.closed === null,
  );
  if (open !== undefined) {
    await writeSleeveFinancing(ctx.db, { cohortId: cc.cohort.id, tradeId: open.id, d: ctx.d, cfg });
  }
}

// ---- stage f: marks, NAV, invariants -------------------------------------------------------------------------

async function markOf(ctx: DayCtx, code: string): Promise<Mark> {
  const advMicro = await ctx.data.adv(code, ctx.d);
  const last = await ctx.data.lastClose(code, ctx.d);
  if (last === null) throw new CloseBooksError("no_mark", `no close on record for ${code}`);
  if (await ctx.data.halted(code, ctx.d)) {
    return suspensionMark({
      lastCloseMicro: last,
      advMicro,
      haltStartD: await ctx.data.haltStart(code, ctx.d, ctx.calendar),
      d: ctx.d,
      calendar: ctx.calendar,
    });
  }
  const bar = await ctx.data.bar(code, ctx.d);
  // V1-S15 / DAT-127: no bar and no halt flag = a data gap, not a close. The position is marked at the
  // last price (no price is invented, no haircut: ARN-026 is for halts) but the mark is FLAGGED.
  if (bar === null) return { closeMicro: last, advMicro, stale: true };
  return { closeMicro: bar.closeMicro, advMicro };
}

/** V1-S15: sessions in a row, ending today, on which `code` has no usable bar (capped at the alert limit). */
async function staleSessions(ctx: DayCtx, code: string): Promise<number> {
  let n = 0;
  let day = ctx.d;
  while (n < STALE_MARK_ALERT_SESSIONS) {
    if ((await ctx.data.bar(code, day)) !== null) break;
    n += 1;
    day = previousTradingDay(day, ctx.calendar);
  }
  return n;
}

type NavOutcome = {
  readonly day: NavDay;
  readonly ok: boolean;
  readonly violations: Violation[];
  readonly marks: ReadonlyMap<string, Mark>;
  /** V1-S15: held codes marked at the last close because today's bar is missing, with the run length. */
  readonly stale: readonly { readonly code: string; readonly sessions: number }[];
};

async function navStage(ctx: DayCtx, cc: CohortCtx): Promise<NavOutcome> {
  const id = cc.cohort.id;
  const { d } = ctx;
  const [fills, adjustments, rows] = await Promise.all([
    fillsOf(ctx, cc),
    adjustmentsOf(ctx, cc),
    loadLedgerRows(ctx.db, id, d),
  ]);
  const state = derivePositions(fills, adjustments, d);
  const marks = new Map<string, Mark>();
  for (const code of state.positions.keys()) marks.set(code, await markOf(ctx, code));
  let trades: SleeveTrade[] = [];
  let states: Awaited<ReturnType<typeof loadSleeveStates>> = [];
  let sleeveUnreal = 0n;
  let sleeveLiq = 0n;
  const cfg = cc.cfg;
  if (cfg !== null) {
    [trades, states] = await Promise.all([
      loadSleeveTrades(ctx.db, id),
      loadSleeveStates(ctx.db, id),
    ]);
    const open = openRealTradeAt(trades, d);
    const sleeveCloses = new Map<string, Micro>();
    if (open !== null) {
      const close = (await markOf(ctx, open.code)).closeMicro;
      sleeveCloses.set(open.code, close);
    }
    sleeveUnreal = sleeveUnrealAt({
      trades,
      d,
      closeFor: (code) => sleeveCloses.get(code),
      adjustments,
      cfg,
    });
    sleeveLiq = sleeveLiquidationCostMicro(open, cfg);
  }
  const balances = balancesFromRows(rows, d);
  const day = computeNavDay({
    cohortId: id,
    d,
    balances,
    positions: state.positions,
    markFor: (code) => marks.get(code),
    sleeveUnrealMicro: sleeveUnreal,
    sleeveLiquidationCostMicro: sleeveLiq,
    profile: cc.profile,
    tickCrossFactor: cc.params.tickCrossFactor,
  });
  const books: CohortBooks = {
    cohortId: id,
    rows,
    fills,
    adjustments,
    markFor: (dd, code) => (dd === d ? marks.get(code) : undefined),
    sleeveUnrealFor: () => sleeveUnreal,
    sleeveLiquidationCostFor: () => sleeveLiq,
    profile: cc.profile,
    tickCrossFactor: cc.params.tickCrossFactor,
  };
  const violations = checkCohortBooks(books, {
    mode: cc.params.settlementMode,
    calendar: ctx.calendar,
    dates: [d],
    stored: [day],
    seedMicro: cc.cohort.seedMicro,
    sleeve: cfg === null ? undefined : { trades, states, cfg },
  });
  const stale: { code: string; sessions: number }[] = [];
  for (const [code, mark] of [...marks].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (mark.stale !== true) continue;
    const sessions = await staleSessions(ctx, code);
    stale.push({ code, sessions });
    // non-fatal: the day is stored as ok, the flag is the log line and (after the limit) an incident
    violations.push({
      code: "stale_mark",
      d,
      message: `${code} marked at the last close: no bar on ${d} (${sessions} session(s) in a row)`,
      fatal: false,
    });
  }
  const ok = !violations.some(isFatal);
  const stored = ok ? day : withInvariantsOk(day, false);
  await writeNavDay(ctx.db, stored);
  ctx.stats.navDays += 1;
  return { day: stored, ok, violations, marks, stale };
}

// ---- one cohort-day --------------------------------------------------------------------------------------------

type CohortResult =
  | { readonly state: "frozen" }
  | { readonly state: "failed"; readonly violations: Violation[] }
  | { readonly state: "ok"; readonly nav: NavOutcome; readonly cc: CohortCtx };

/** What a cohort has to do today, in one round trip (idle cohorts skip every stage). */
async function activityOf(ctx: DayCtx, cohortId: string) {
  const rs = await ctx.db.execute({
    sql: `SELECT
      (SELECT COUNT(*) FROM nav_daily WHERE cohort_id = ? AND invariants_ok = 0
         AND d > COALESCE((SELECT MAX(json_extract(e.detail_json, '$.through_d')) FROM cohort_event e
                           WHERE e.cohort_id = ? AND e.kind = 'data_event'
                             AND json_extract(e.detail_json, '$.type') = '${INVARIANTS_CLEARED}'), '')) AS bad,
      (SELECT COUNT(*) FROM arena_order WHERE cohort_id = ? AND status = 'pending'
         AND decided_d < ? AND kind IN ('entry','exit_cs')) AS pending,
      (SELECT COUNT(*) FROM trade WHERE cohort_id = ? AND exit_type IS NULL) AS open_trades,
      (SELECT COUNT(*) FROM fill f WHERE ${STOCK_FILLS} AND f.d >= ?
         AND NOT EXISTS (SELECT 1 FROM cash_ledger l WHERE l.cohort_id = f.cohort_id AND l.d >= ?
                         AND l.txn_id = 'fill:' || f.id)) AS unposted,
      (SELECT COUNT(*) FROM fill f WHERE ${STOCK_FILLS} AND f.d >= ?
         AND (f.side = 'buy' OR f.value_micro <> f.brokerage_micro)
         AND NOT EXISTS (SELECT 1 FROM cash_ledger l WHERE l.cohort_id = f.cohort_id AND l.d >= ?
                         AND l.txn_id = 'settle:' || f.id)) AS unsettled,
      (SELECT COUNT(*) FROM sleeve_trade WHERE cohort_id = ? AND closed_by IS NULL) AS sleeve_open,
      (SELECT COUNT(*) FROM arena_order WHERE cohort_id = ? AND kind = 'entry'
         AND status = 'filled' AND fill_d = ?) AS entries_today,
      (SELECT sleeve_json FROM cohort WHERE id = ?) AS sleeve_json`,
    args: [
      cohortId,
      cohortId,
      cohortId,
      ctx.d,
      cohortId,
      cohortId,
      cohortId,
      ctx.recentFrom,
      ctx.recentFrom,
      cohortId,
      cohortId,
      ctx.recentFrom,
      ctx.recentFrom,
      cohortId,
      cohortId,
      ctx.d,
      cohortId,
    ],
  });
  const r = rs.rows[0];
  const n = (v: unknown): bigint => toBig(v);
  return {
    frozen: n(r.bad) > 0n,
    pending: n(r.pending) > 0n,
    openTrades: n(r.open_trades) > 0n,
    unposted: n(r.unposted) > 0n,
    unsettled: n(r.unsettled) > 0n,
    sleeveOpen: n(r.sleeve_open) > 0n,
    entriesToday: n(r.entries_today) > 0n,
    sleeveJson: r.sleeve_json === null ? null : text(r.sleeve_json),
  };
}

async function closeCohortDay(ctx: DayCtx, cohortId: string): Promise<CohortResult> {
  const act = await activityOf(ctx, cohortId);
  if (act.frozen) return { state: "frozen" };
  const cohort = await loadCohort(ctx.db, cohortId);
  if (cohort === null) throw new CloseBooksError("cohort_missing", `no cohort ${cohortId}`);
  const params = parseCohortParams(cohort.paramsJson);
  const cc: CohortCtx = {
    cache: {},
    cohort,
    params,
    profile: COST_PROFILES[params.costProfile],
    cfg: act.sleeveJson === null ? null : sleeveConfigFrom(act.sleeveJson),
  };
  const fillsBefore = ctx.stats.fills;
  if (act.unposted) await postUnposted(ctx, cc);
  if (act.unsettled || act.unposted) await settleDue(ctx, cc);
  await applyCorporate(ctx, cc);
  if (act.pending) await fillPending(ctx, cc);
  if (act.openTrades || ctx.stats.fills > fillsBefore) await isStops(ctx, cc);
  if (ctx.stats.fills > fillsBefore) await postUnposted(ctx, cc);
  if (cc.cfg !== null && (act.sleeveOpen || act.entriesToday || ctx.stats.fills > fillsBefore)) {
    await sleeveStage(ctx, cc, cc.cfg);
  }
  const nav = await navStage(ctx, cc);
  if (!nav.ok) {
    const codes = [...new Set(nav.violations.filter(isFatal).map((v) => v.code))].sort();
    await logApp(ctx, "error", `invariants failed for ${cohortId} on ${ctx.d}: ${codes.join(",")}`);
    return { state: "failed", violations: nav.violations };
  }
  for (const v of nav.violations) {
    await logApp(
      ctx,
      "warn",
      v.code === "stale_mark"
        ? `${cohortId} ${ctx.d}: ${v.message}`
        : `${cohortId} ${ctx.d}: ${v.code}`,
    );
  }
  const overdue = nav.stale.filter((x) => x.sessions >= STALE_MARK_ALERT_SESSIONS);
  if (overdue.length > 0) {
    await openS2Once(
      ctx.db,
      STALE_MARK_INCIDENT,
      { cohortId, d: ctx.d, codes: overdue.map((x) => x.code).slice(0, 10) },
      ctx.now(),
      ctx.notify,
      `A held position has had no price bar for ${STALE_MARK_ALERT_SESSIONS} sessions in a row`,
    );
  }
  if (cc.cfg !== null) {
    await runSleeveUnlockCheck(ctx.db, {
      cohortId,
      d: ctx.d,
      navMicro: nav.day.row.navMicro,
      calendar: ctx.calendar,
      cfg: cc.cfg,
    });
  }
  return { state: "ok", nav, cc };
}

// ---- after the terminal step: legacy ledger and the realised value -------------------------------------------

async function windDown(ctx: DayCtx, cc: CohortCtx, nav: NavOutcome): Promise<void> {
  const cohort = cc.cohort;
  const cohortId = cohort.id;
  // only a cohort that was already resolved at the start of today can have been liquidated today
  if (cohort.terminalKind === null || cohort.terminalD === null || ctx.d <= cohort.terminalD)
    return;
  const done = await ctx.db.execute({
    sql: "SELECT 1 FROM cohort_event WHERE cohort_id = ? AND kind = 'liquidated'",
    args: [cohortId],
  });
  if (done.rows.length > 0) return; // the realised value is written once, on the liquidation session
  const pending = await loadPendingLiquidationOrders(ctx.db, cohortId);
  const halted = new Set<string>();
  for (const p of pending) if (await ctx.data.halted(p.code, ctx.d)) halted.add(p.code);
  if (pending.some((p) => !halted.has(p.code))) return; // a tradeable code is still unsold
  const { positions } = await holdingsOf(ctx, cc);
  const trades = await openTrades(ctx, cohortId);
  const items = planLegacy({
    positions,
    openTrades: trades.map((t) => ({ tradeId: t.id, code: t.code })),
    halted,
    markFor: (code) => nav.marks.get(code) as Mark,
  });
  let legacyValue = 0n;
  for (const item of items) legacyValue += item.valueMicro;
  if (items.length > 0) await writeLegacyMoves(ctx.db, { cohortId, d: ctx.d, items });
  await writeLiquidated(ctx.db, {
    cohortId,
    d: ctx.d,
    realisedNavMicro: nav.day.row.navMicro - legacyValue,
    legacyValueMicro: legacyValue,
  });
}

// ---- the day ------------------------------------------------------------------------------------------------------

function emptyResult(
  opts: CloseBooksOptions,
  status: CloseBooksStatus,
  reason: string | null,
  runId: number | null,
): CloseBooksResult {
  return {
    market: opts.market,
    d: opts.d,
    status,
    reason,
    runId,
    closed: [],
    failed: [],
    frozen: [],
    terminal: [],
    stats: { fills: 0, orders: 0, ledgerTxns: 0, navDays: 0 },
  };
}

async function recordSkip(
  db: Client,
  opts: CloseBooksOptions,
  reason: string,
): Promise<CloseBooksResult> {
  const key = closeBooksKey(opts.market, opts.d);
  const runId = await startRun(db, {
    job: ARENA_JOB,
    market: opts.market,
    concurrencyKey: key,
    scheduledFor: opts.d,
    commitSha: opts.commitSha ?? undefined,
    now: opts.now(),
  });
  await finishRun(db, runId, {
    status: "skipped",
    details: { reason },
    now: opts.now(),
  });
  return emptyResult(opts, "skipped", reason, runId);
}

/**
 * V1-B1 / D-661: is the session before `d` closed? True when its 2a run record is `success` or
 * `degraded` (books written), `failed` for invariants (the day completed, the cohort is frozen), or `skipped` for a reason that is not a missing Batch 1 marker
 * (market off, data only, non-trading). The first night is exempt: with no earlier closed
 * session for the market (go-live, fresh start, replay start) there is nothing to be late for.
 */
export async function previousSessionClosed(
  db: Client,
  market: string,
  d: string,
  calendar: CalendarRow[],
): Promise<{ ok: true } | { ok: false; priorD: string }> {
  let priorD: string;
  try {
    priorD = previousTradingDay(d, calendar);
  } catch {
    return { ok: true };
  }
  const prior = await db.execute({
    sql: `SELECT 1 FROM run_record WHERE concurrency_key = ? AND ${CLOSED_2A_SQL} LIMIT 1`,
    args: [closeBooksKey(market, priorD)],
  });
  if (prior.rows.length > 0) return { ok: true };
  // D-675: the exemption uses the same "closed" predicate as the check, so a market whose only
  // earlier nights ended in an invariant freeze (`failed` + navDays) is not a first night.
  const earlier = await db.execute({
    sql: `SELECT 1 FROM run_record WHERE job = ? AND market = ? AND scheduled_for < ?
          AND ${CLOSED_2A_SQL} LIMIT 1`,
    args: [ARENA_JOB, market, d],
  });
  return earlier.rows.length === 0 ? { ok: true } : { ok: false, priorD };
}

/**
 * SQL predicate "this arena-2a run record closed its session" (D-661, D-675). The Worker's
 * re-dispatch check (`worker/src/clock.ts`, `RECHECK_CLOSED_SQL`) mirrors it, plus `running`.
 */
export const CLOSED_2A_SQL =
  "(status IN ('success', 'degraded') " +
  "OR (status = 'failed' AND json_extract(details_json, '$.navDays') IS NOT NULL) " +
  "OR (status = 'skipped' AND json_extract(details_json, '$.reason') IS NOT 'no_completion_marker'))";

/** Refuse session d: a `failed` record (never `skipped`, which the next night would read as closed) + a P1 incident. */
async function refuseGap(
  db: Client,
  opts: CloseBooksOptions,
  priorD: string,
): Promise<CloseBooksResult> {
  const reason = "previous_session_not_closed";
  const runId = await startRun(db, {
    job: ARENA_JOB,
    market: opts.market,
    concurrencyKey: closeBooksKey(opts.market, opts.d),
    scheduledFor: opts.d,
    commitSha: opts.commitSha ?? undefined,
    now: opts.now(),
  });
  await finishRun(db, runId, {
    status: "failed",
    errorSummary: `${reason}: ${priorD} has no closed arena-2a record`,
    details: { reason, priorD },
    now: opts.now(),
  });
  await openS2Once(
    db,
    "arena_close_gap",
    { market: opts.market, d: opts.d, priorD },
    opts.now(),
    opts.notify,
    `Arena close refused for ${opts.d}: session ${priorD} is not closed`,
  );
  return emptyResult(opts, "failed", reason, runId);
}

/**
 * Close the books for session `opts.d` (batch 2a). Never throws for a data or invariant problem:
 * the outcome is the run record and the returned status (`failed` carries the code).
 */
export async function closeBooksDay(
  db: Client,
  opts: CloseBooksOptions,
): Promise<CloseBooksResult> {
  const key = closeBooksKey(opts.market, opts.d);
  if (await hasSuccess(db, key)) return emptyResult(opts, "already_done", null, null);

  // 1. preconditions - none of them touches an arena table
  const market = await db.execute({
    sql: "SELECT mode FROM market WHERE code = ?",
    args: [opts.market],
  });
  if (market.rows.length === 0) return recordSkip(db, opts, "market_missing");
  const mode = text(market.rows[0].mode);
  if (mode === "off") return recordSkip(db, opts, "market_off");
  if (mode !== "full" && opts.replay !== true) return recordSkip(db, opts, "data_only_guard");
  const calendar = opts.calendar ?? (await loadCalendar(db, opts.market));
  if (!isTradingDay(opts.d, calendar)) return recordSkip(db, opts, "non_trading_day");
  const marker = await db.execute({
    sql: "SELECT kind FROM completion_marker WHERE market = ? AND d = ? AND kind IN ('data', 'non-trading')",
    args: [opts.market, opts.d],
  });
  if (!marker.rows.some((r) => text(r.kind) === "data")) {
    return recordSkip(
      db,
      opts,
      marker.rows.length > 0 ? "non_trading_day" : "no_completion_marker",
    );
  }

  const gap = await previousSessionClosed(db, opts.market, opts.d, calendar);
  if (!gap.ok) return refuseGap(db, opts, gap.priorD);

  const stale = await db.execute({
    sql: "SELECT 1 FROM run_record WHERE concurrency_key = ? AND status = 'running' LIMIT 1",
    args: [key],
  });
  if (stale.rows.length > 0) {
    await db.execute({
      sql: `UPDATE run_record SET status = 'failed', ended_at = ?, error_summary = ?
            WHERE concurrency_key = ? AND status = 'running'`,
      args: [opts.now(), "superseded: the previous run did not finish", key],
    });
  }
  const runId = await startRun(db, {
    job: ARENA_JOB,
    market: opts.market,
    concurrencyKey: key,
    scheduledFor: opts.d,
    commitSha: opts.commitSha ?? undefined,
    now: opts.now(),
  });
  const stats: Stats = { fills: 0, orders: 0, ledgerTxns: 0, navDays: 0 };
  const closed: string[] = [];
  const failed: string[] = [];
  const frozenIds: string[] = [];
  const terminal: string[] = [];
  try {
    const priorD = previousTradingDay(opts.d, calendar);
    const actions = await loadConfirmedActions(db, opts.market, opts.d);
    const data = createMarketData(db, opts.market, opts.d);
    const lastCloses = new Map<string, Micro>();
    for (const a of actions.filter((x) => x.exDate === opts.d)) {
      const last = await data.lastClose(a.code, priorD);
      if (last !== null) lastCloses.set(a.code, last);
    }
    const cutoffHm = await getConfig(db, "decision_cutoff").catch(() => undefined);
    const exDivCutoff = decisionCutoffUtc(
      priorD,
      typeof cutoffHm === "string" ? cutoffHm : "18:10",
    );
    const ctx: DayCtx = {
      db,
      market: opts.market,
      d: opts.d,
      priorD,
      calendar,
      data,
      now: opts.now,
      runId,
      stats,
      actions,
      lastCloses,
      exDividends: toExDividendActions(actions.filter((x) => x.exDate === opts.d)),
      exDivCutoff,
      gates: new Map(),
      recentFrom: addDays(opts.d, -14),
      notify: opts.notify,
    };
    const outcomes = new Map<string, Extract<CohortResult, { state: "ok" }>>();
    for (const cohortId of await activeCohortIds(db, opts.d, ctx.recentFrom)) {
      const result = await closeCohortDay(ctx, cohortId);
      if (result.state === "frozen") frozenIds.push(cohortId);
      else if (result.state === "failed") failed.push(cohortId);
      else {
        closed.push(cohortId);
        outcomes.set(cohortId, result);
      }
    }
    // 3. terminal checks on liquidation NAV, then the legacy ledger of cohorts that ended earlier
    const executions = new Map((await loadExecutions(db)).map((e) => [e.id, e]));
    const restart: RestartConfig = {
      executionFor: (executionId) => {
        const e = executions.get(executionId);
        if (e === undefined) throw new CloseBooksError("execution_missing", executionId);
        return e;
      },
      paramsFor: (e) =>
        resolveCohortParams({
          costProfile: e.cost_profile as CostProfileCode,
          ...(opts.restartParams?.(e.id) ?? {}),
        }),
      masterSeed: opts.masterSeed ?? ARENA_MASTER_SEED,
      dataSnapshotId: await snapshotId(db, data, opts),
      maxPromotionsPerWeek: opts.maxPromotionsPerWeek,
    };
    const checked = await runTerminalChecks(db, [...outcomes.keys()], {
      d: opts.d,
      calendar,
      signalsThroughD: priorD,
      restart,
    });
    for (const e of checked.resolved) terminal.push(e.cohort.id);
    for (const outcome of outcomes.values()) await windDown(ctx, outcome.cc, outcome.nav);
    const status: CloseBooksStatus =
      failed.length > 0 ? "failed" : frozenIds.length > 0 ? "degraded" : "success";
    await finishRun(db, runId, {
      status,
      itemsProcessed: closed.length,
      rowsWritten: stats.fills + stats.orders + stats.ledgerTxns + stats.navDays,
      errorSummary:
        failed.length > 0 ? `invariants failed for ${failed.length} cohort(s)` : undefined,
      details: {
        cohorts: closed.length,
        failed: failed.length,
        frozen: frozenIds.length,
        terminal: terminal.length,
        fills: stats.fills,
        navDays: stats.navDays,
      },
      now: opts.now(),
    });
    return {
      market: opts.market,
      d: opts.d,
      status,
      reason: failed.length > 0 ? "invariants_failed" : null,
      runId,
      closed,
      failed,
      frozen: frozenIds,
      terminal,
      stats,
    };
  } catch (error) {
    const code =
      error instanceof CloseBooksError
        ? error.code
        : error instanceof Error
          ? error.name
          : "unknown_error";
    const summary = error instanceof Error ? `${code}: ${error.message}` : code;
    await finishRun(db, runId, {
      status: "failed",
      errorSummary: summary,
      details: { code, cohorts: closed.length },
      now: opts.now(),
    });
    await logApp(
      { db, now: opts.now, runId },
      "error",
      `close the books failed on ${opts.d}: ${code}`,
    );
    return {
      ...emptyResult(opts, "failed", code, runId),
      closed,
      failed,
      frozen: frozenIds,
      stats,
    };
  }
}

/** `data_snapshot_id` (design 4.6): the Batch 1 run that produced D's marker + the newest ingest instant. */
async function snapshotId(db: Client, data: MarketData, opts: CloseBooksOptions): Promise<string> {
  const marker = await db.execute({
    sql: "SELECT run_id FROM completion_marker WHERE market = ? AND d = ? AND kind = 'data'",
    args: [opts.market, opts.d],
  });
  const run =
    marker.rows.length === 0 || marker.rows[0].run_id === null
      ? "none"
      : text(marker.rows[0].run_id);
  return `batch1:${run}@${(await data.ingestedAt(opts.d)) ?? "none"}`;
}
