// Rolling-start cohort replay (M4 T14; design 4.7; ARN-080 "every rolling_start_step sessions",
// ARN-053, ARN-049, ARN-102; decisions 25, 30, 32, D-091 draft). An IN-MEMORY driver over the M3
// pure functions (sizing, fills, ledger postings and settlement, NAV, terminal rules, sleeve) and the
// batch 2b logic (ranking, FAM-001 sizing legs, C2/C3 matched controls, CS exits and IS levels): no
// database, no write. It is the same two-step day as production:
//
//   2a  settlements -> corporate actions -> fills of the orders decided the session before (CS
//       exits, then entries) -> IS stops -> sleeve -> mark to market and NAV -> sleeve unlock ->
//       terminal verdict on LIQUIDATION NAV (the verdict sees signals only up to the previous
//       session, ARN-060);
//   2b  exits (CS rules -> exit orders for D+1, trailing IS levels), entries of every live E
//       cohort (rank, slots, FAM-001 sizing), controls of every live C2 / C3 cohort (one matched
//       random-entry draw per distinct E entry, seeded `c2:<cohort>:<d>`).
//
// A new set of cohorts (E01..E12, C1 when its ETF is set, C2 and C3 at `c2_live_per_family`) starts
// every `rolling_start_step` sessions, each with A$600; every cohort runs to its own terminal state
// or to the end of the data, where it is CENSORED. Signals are computed once per session and shared
// by all cohorts (`runFamilies`, the live function). These cohorts are also the capacity-constrained
// book of ARN-080 (decision 30). Sleeve figures come from running the leverage-carrying executions
// at `sleeve_leverage` (10x, the base group with all executions) and at `reality_cap` (5x, a group of
// the L twins and C3 only; its controls are matched to the L twins' entries): ARN-049, data only.
//
// Same as the live engine (D-091 follow-up; the SAME pure functions, no copies): a halted code gets no
// fill and is marked with the ARN-026 suspension mark (`suspensionMark`, haircut from session 21,
// injected `SuspensionConfig`); an entry is re-gated at its fill by the quality-gate result the
// source supplies (`qualityGate`; without one every code passes and the result says so:
// `qualityGate: "assumed_all_pass"`); a cohort that reaches a terminal state is wound down as in
// closeBooks `windDown`: `planLiquidation` sells every holding at the next open (exit fill rules),
// `planLegacy` moves a holding that cannot be sold (halted) to the legacy ledger at its suspension
// mark, and the realised NAV (NAV of that session less the legacy value) is the outcome.
//
// Deliberate simplifications that remain: no group restart after a terminal state (the next start of
// the grid is the restart), twins and controls simply share the start grid.
//
// Determinism (2.8): no clock, no Math.random; every iteration over codes, cohorts and orders is
// sorted; the PRNG is the arena SplitMix64 seeded by `deriveRngSeed(master, <scope>)`.
import { PROGRESS_SESSIONS_DEFAULT } from "@/lib/config/keys";
import {
  evaluateExit,
  runFamilies,
  type Candidate,
  type CodeFacts,
  type CsRule,
  type CsTrigger,
  type ExitPlan,
  type Family,
  type FamilyInputs,
  type FamilyOptions,
  type FamilyOutput,
  type Tier,
} from "@/lib/agents/families";
import {
  buildObservation,
  evaluateBreakers,
  eventLowOf,
  itemsFromEvents,
  type AnnouncementText,
} from "@/lib/agents/breakerEval";
import { cardBreakers, type CardBreaker } from "@/lib/agents/thesisBreakers";
import { applyArn011 } from "@/lib/agents/families/arn011";
import { createContext } from "@/lib/agents/families/context";
import {
  planLegs,
  rankedCandidates,
  sizingEnvFor,
  type Leg,
  type LegResult,
  type SizingContext,
} from "@/lib/agents/candidates";
import { controlPlan, controlPool } from "@/lib/agents/controls";
import type { CostGateTable } from "@/lib/agents/costGate";
import { ABSTAIN_SHOCK_REASON, firstLegRetryCode, selectEntries } from "@/lib/agents/entryGates";
import {
  crossing,
  initialStopAtFill,
  scaleMicro,
  scalePlanPrices,
  type OrderPlan,
} from "@/lib/agents/orderPlan";
import type { AgentParams } from "@/lib/agents/params";
import {
  buildExecutionRegistry,
  C1_ETF_PLACEHOLDER,
  carriesSleeve,
  cohortIdFor,
  cohortSlots,
  createPrng,
  deriveRngSeed,
  resolveCohortParams,
  type CohortParams,
  type ParamOverrides,
} from "@/lib/arena/cohort";
import { COST_PROFILES, feeFor, type CostProfile } from "@/lib/arena/costs";
import {
  fillCloseSignalExit,
  fillEntryLimit,
  fillIntradayStop,
  fillOrder,
  selectExit,
  type FillEnv,
  type FillOutcome,
  type SimulatedFill,
} from "@/lib/arena/fills";
import {
  availableCash,
  fillTxns,
  fillNetMicro,
  SETTLEMENT_LAG_SESSIONS,
  seedTxn,
  settlementsDue,
  txnRows,
  type LedgerBalances,
  type LedgerFill,
  type LedgerRow,
  type LedgerTxn,
  type QtyAdjustment,
  type SettlementItem,
} from "@/lib/arena/ledger";
import { computeNavDay, type Mark, type NavPosRow } from "@/lib/arena/nav";
import type { ExecutionRow, LedgerAccount, TerminalKind } from "@/lib/arena/schema";
import { isParcelOnlyRejection, resizeEntryAtFill } from "@/lib/arena/sizing";
import {
  defaultSleeveConfig,
  evaluateUnlock,
  earlierSleeveExit,
  financingAccruedAt,
  lockAfterClose,
  lockStatus,
  netPlMicro,
  openRealTradeAt,
  openTrade,
  priceFactorSince,
  quoteSleeveEntry,
  quoteSleeveExit,
  realisedUnleveredNetSince,
  closeSleeve,
  closedTrade,
  shadowNetSince,
  sleeveCloseTxn,
  sleeveEligibility,
  sleeveFinancingTxn,
  sleeveLiquidationCostMicro,
  sleeveMarginMicro,
  sleeveOpenTxn,
  sleeveUnrealAt,
  type SleeveConfig,
  type SleeveExitMode,
  type SleeveExitQuote,
  type SleeveStateEntry,
  type SleeveTrade,
} from "@/lib/arena/sleeve";
import {
  parcelStallWindow,
  stallFloorStreak,
  terminalThresholds,
  type CloseDay,
  type TerminalParams,
  type TerminalRule,
} from "@/lib/arena/terminal";
import {
  DEFAULT_SUSPENSION,
  planCorporateActions,
  suspensionMark,
  knownBy,
  type CorpActionRecord,
  type PlannedAdjustment,
  type SuspensionConfig,
} from "@/lib/arena/corpActions";
import { planLegacy, planLiquidation } from "@/lib/arena/terminal";
import { addDays, isWeekend, type CalendarRow } from "@/lib/data/calendar";
import type { EntryDecision } from "@/lib/data/quality/gate";
import { exDividendOn, toExDividendActions } from "@/lib/arena/exDividend";
import { floorRat } from "@/lib/money/round";
import { divFloor, type Rational } from "@/lib/money/rational";
import { decisionCutoffUtc, type ViewBar } from "@/lib/agents/decisionView";
import { fillRowRule, type FillRowRule } from "@/lib/cortex/economics/fillRow";
import type { BookState as CortexBook, FamilyStatusMap, NightOutput } from "@/lib/cortex/night";
import type { LedgerSource } from "./ledger";
import type { PositionFacts } from "./returns";

/** Session counts at which a live cohort's liquidation NAV is sampled for the progress table (ARN-071). */
export const PROGRESS_SESSIONS: readonly number[] = PROGRESS_SESSIONS_DEFAULT; // key progress_sessions_edges (D-111)

/**
 * Same source as the signal ledger: bars, position facts, family inputs and the control universe,
 * plus two optional pieces of live-engine state a snapshot may carry.
 */
export type CohortReplaySource = LedgerSource & {
  /**
   * Universe-snapshot halt flag of `code` on `d`: true halted, false trading, null no universe row.
   * Without it the `halted` flag of the family facts of the session is used.
   */
  halted?(code: string, d: string): boolean | null;
  /** The entry decision of the data-quality gate (`entriesAllowed`) on `d`; absent: no quality data. */
  qualityGate?(code: string, d: string): EntryDecision;
  /** Short-interest change (latest minus the value a window earlier, ppm) usable on `d`; absent: unknown. */
  shortDeltaPpm?(code: string, d: string): number | null;
  /** Title and ASX type of an event (`source|ann_id`) for the TB-KW keywords; absent: no text, no keyword hit. */
  announcementText?(ref: string): AnnouncementText | null;
};

/** `supplied`: entries were re-gated; `assumed_all_pass`: no quality data, every code passed. */
export type QualityGateMode = "supplied" | "assumed_all_pass";

export type ReplayProgress = {
  readonly stage: "starts" | "sessions";
  /** Sessions processed so far (1-based) of `total`. */
  readonly session: number;
  readonly total: number;
  readonly d: string;
  readonly cohortsStarted: number;
  readonly cohortsActive: number;
  readonly cohortsEnded: number;
};

/** One stored cohort-day (diagnostics and the parity test against the database engine). */
export type CohortDayTrace = {
  readonly cohortId: string;
  readonly d: string;
  readonly navMicro: bigint;
  readonly liqNavMicro: bigint;
  readonly openPositions: number;
  readonly cashSettledMicro: bigint;
  /** The `nav_daily_pos` rows of the day (the haircut flag shows the ARN-026 mark). */
  readonly positions: readonly NavPosRow[];
};

export type CohortReplayOptions = {
  readonly params: AgentParams;
  /** First start session (default: the second session). Starts repeat every `rolling_start_step`. */
  readonly from?: string;
  /** Last session processed (default: the last of the source). */
  readonly to?: string;
  readonly masterSeed?: bigint;
  readonly familyOptions?: FamilyOptions;
  /** Parameter overrides for every cohort (default: the ch.15 defaults). */
  readonly cohortParams?: (execution: ExecutionRow) => ParamOverrides;
  /** Leverage of the base group (default `sleeve_leverage`) and of the reality group (`reality_cap`). */
  readonly leverage?: number;
  readonly realityLeverage?: number | null;
  /** Controls per family override (default `c2_live_per_family`). */
  readonly controlsPerFamily?: number;
  /** Rolling-start step override (default `rolling_start_step`). */
  readonly step?: number;
  /** Real ETF code of control C1; the placeholder (default) places no orders. */
  readonly c1EtfCode?: string;
  readonly checkpoints?: readonly number[];
  /** Gate source; overrides the one of the source. Absent on both: every code passes (flagged). */
  readonly qualityGate?: (code: string, d: string) => EntryDecision;
  /** ARN-026 haircut and the sessions before it (default `DEFAULT_SUSPENSION`: 1/2 from session 21). */
  readonly suspension?: SuspensionConfig;
  readonly progress?: (p: ReplayProgress) => void;
  /** Called with every cohort-day after its NAV is computed (off by default). */
  readonly trace?: (e: CohortDayTrace) => void;
  /** Restrict the registry to these execution ids (default: all). */
  readonly executions?: readonly string[];
  readonly ruleVersion?: string;
  /**
   * FAM-005 (D-214): development-split medians the E cohorts' entries are gated by. Absent: every
   * signal is unmeasured and passes (the no-split goldens stay as they are).
   */
  readonly costGate?: CostGateTable;
  /**
   * M15 P3 (design 3c): Cortex-governed entries. Absent = the v1 path, byte for byte. When set, the
   * E cohort of a family whose status is `allowed` takes the night's `decisions` of its own book
   * (book id = cohort id; already ranked and sized, with `limitMicro`) in place of
   * `rankedCandidates`; every other family runs the v1 path. `night` runs once per session.
   */
  readonly cortex?: CortexReplayHook;
};

/** The Cortex hook of `replayCohorts`; `cortexReplay.ts` builds it over a SnapshotWorld. */
export type CortexReplayHook = {
  night(d: string, books: readonly CortexBook[]): NightOutput;
  readonly status: FamilyStatusMap;
  /** Every night's full output (shadow rows, blocked candidates, abstains) as it is produced. */
  sink?(d: string, out: NightOutput): void;
  /** Every Cortex entry fill with the `fill.rule` the row would carry (D-307). */
  onFill?(e: { d: string; cohortId: string; code: string; rule: FillRowRule }): void;
};

export type SleeveSummary = {
  readonly trades: number;
  readonly shadowTrades: number;
  readonly closeouts: number;
  readonly locks: number;
  /** Sum of the net P/L (capped price P/L - financing - brokerage) of closed real trades, micro. */
  readonly netPlMicro: bigint;
};

export type CohortOutcome = {
  readonly id: string;
  readonly executionId: string;
  readonly kind: "E" | "C1" | "C2" | "C3";
  readonly family: string | null;
  readonly variant: "U" | "L" | null;
  readonly controlIdx: number | null;
  /** `base` (all executions at `sleeve_leverage`) or `reality` (L twins and C3 at `reality_cap`). */
  readonly group: "base" | "reality";
  /** Sleeve leverage of the cohort, null when it carries no sleeve. */
  readonly leverage: number | null;
  readonly startD: string;
  readonly startIdx: number;
  /** Terminal close, or the last session observed when censored. */
  readonly endD: string;
  /** Sessions from the start to `endD` (the time of the CIF). */
  readonly sessions: number;
  readonly terminalKind: TerminalKind | null;
  readonly terminalRule: TerminalRule | null;
  readonly censored: boolean;
  readonly seedMicro: bigint;
  /**
   * The outcome of a resolved cohort: the realised NAV of its liquidation session (NAV less the legacy
   * value) when `liquidatedD` is set, else the liquidation NAV at `endD` (also when censored).
   */
  readonly outcomeMicro: bigint;
  /** NAV and liquidation NAV at `endD` (the terminal close, or the last session when censored). */
  readonly navMicro: bigint;
  readonly terminalLiqNavMicro: bigint;
  /** Wound down: the session of the liquidation open (the `liquidated` event), else null. */
  readonly liquidatedD: string | null;
  /** Value of the halted holdings moved to the legacy ledger at the liquidation (0 without any). */
  readonly legacyValueMicro: bigint;
  readonly entries: number;
  readonly exitsIs: number;
  readonly exitsCs: number;
  readonly sleeve: SleeveSummary | null;
  /** [sessions elapsed, liquidation NAV in ppm of the seed] for the live checkpoints. */
  readonly checkpoints: readonly (readonly [number, number])[];
};

export type CohortReplayResult = {
  readonly market: string;
  readonly from: string;
  readonly to: string;
  readonly sessions: number;
  readonly step: number;
  readonly starts: readonly string[];
  readonly cohorts: readonly CohortOutcome[];
  readonly skippedC1: boolean;
  readonly qualityGate: QualityGateMode;
};

// ---------------------------------------------------------------------------------------------------------
// Terminal verdict (the M3 evaluateTerminal sequence on a trimmed history)
// ---------------------------------------------------------------------------------------------------------

/**
 * The sequence of M3 `evaluateTerminal` (target, bust, floor stall, parcel stall, timeout) on the
 * last close of `history`, using the same M3 helpers; `sessions` is the number of sessions from the
 * start to that close, inclusive. Equal to `evaluateTerminal` (tested); it avoids the calendar walk
 * that `evaluateTerminal` repeats on every call.
 */
export function judgeClose(
  params: TerminalParams,
  history: readonly CloseDay[],
  sessions: number,
  options: {
    readonly thresholds?: { readonly targetMicro: bigint; readonly bustMicro: bigint };
    /** The caller knows no entry order was decided in the parcel window: skip that test. */
    readonly noRecentSignals?: boolean;
  } = {},
): { readonly kind: TerminalKind; readonly rule: TerminalRule } | null {
  const last = history[history.length - 1];
  if (last === undefined) return null;
  const { targetMicro, bustMicro } = options.thresholds ?? terminalThresholds(params);
  if (last.liqNavMicro >= targetMicro) return { kind: "target", rule: "target" };
  if (last.liqNavMicro <= bustMicro) return { kind: "bust", rule: "bust" };
  if (stallFloorStreak(history, params.stallFloorMicro) >= params.stallSessions) {
    return { kind: "stalled", rule: "stall_floor" };
  }
  if (
    options.noRecentSignals !== true &&
    parcelStallWindow(history, params.stallParcelRejections).stalled
  ) {
    return { kind: "stalled", rule: "stall_parcel" };
  }
  if (sessions >= params.timeoutSessions) return { kind: "timeout", rule: "timeout" };
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------

type Pos = {
  readonly code: string;
  qty: bigint;
  /** Shares of the buy fill (the ledger derives the holding from fills plus re-bases). */
  readonly qty0: bigint;
  readonly costMicro: bigint;
  readonly entryIdx: number;
  readonly entryD: string;
  readonly tier: Tier;
  readonly orderId: string;
  fillFrame: bigint;
  level0: bigint;
  trail: bigint[];
  plan: ExitPlan;
  highest: bigint;
  pendingCs: CsTrigger | null;
  /** The card's thesis-breakers of an E entry (M5 T7); null for controls. */
  readonly thesis: Thesis | null;
};

/** What an E entry carries from its Decision Card into the hold (AGT-111). */
type Thesis = {
  readonly breakers: readonly CardBreaker[];
  /** Ids of the events known at the decision (published before its cut-off): not new later. */
  readonly known: ReadonlySet<string>;
  readonly refCloseMicro: bigint | null;
};

type EntryOrder = {
  readonly code: string;
  readonly qty: bigint;
  readonly plan: OrderPlan;
  readonly maxOpen: bigint | null;
  readonly tier: Tier;
  readonly id: string;
  readonly thesis: Thesis | null;
  /** M15: the limit of a Cortex entry (D-288); absent = a v1 market-at-open entry. */
  readonly limitMicro?: bigint;
};

type FillOutcomeFill = Extract<FillOutcome, { status: "filled" }>["fill"];

type StockExit = {
  readonly type: "IS" | "CS";
  readonly d: string;
  readonly levelMicro: bigint | null;
};

type MutableCloseDay = { -readonly [K in keyof CloseDay]: CloseDay[K] };

type Cohort = {
  readonly id: string;
  readonly execution: ExecutionRow;
  readonly controlIdx: number | null;
  readonly group: "base" | "reality";
  readonly startIdx: number;
  readonly startD: string;
  readonly params: CohortParams;
  readonly profile: CostProfile;
  readonly cfg: SleeveConfig | null;
  readonly thresholds: { readonly targetMicro: bigint; readonly bustMicro: bigint };
  readonly bal: Record<LedgerAccount, bigint>;
  pending: SettlementItem[];
  readonly positions: Map<string, Pos>;
  orders: EntryOrder[];
  readonly lastIs: Map<string, number>;
  readonly stockExits: Map<string, StockExit>;
  readonly adjustments: QtyAdjustment[];
  readonly caRows: LedgerRow[];
  readonly unpaid: Map<string, CorpActionRecord>;
  readonly recRows: LedgerRow[];
  sleeveTrades: SleeveTrade[];
  readonly sleeveEntryFee: Map<string, bigint>;
  sleeveStates: SleeveStateEntry[];
  filledToday: { readonly orderId: string; readonly code: string; readonly tier: Tier }[];
  navs: bigint[];
  history: MutableCloseDay[];
  /** Any posting, position or sleeve change since the last stored NAV (an idle cohort reuses it). */
  dirty: boolean;
  lastNav: bigint;
  lastLiq: bigint;
  /** Positions stored with the last NAV day (code, qty, close, value, haircut flag). */
  lastPos: readonly NavPosRow[];
  todaySignals: number;
  /** Session index of the last close with an entry order decided (-1: none yet). */
  lastSignalIdx: number;
  todayParcel: number;
  done: boolean;
  /** Codes held at the terminal close: sold at the next open (`planLiquidation`). */
  liqCodes: string[];
  liquidatedIdx: number;
  termNav: bigint;
  termLiq: bigint;
  realisedMicro: bigint;
  legacyMicro: bigint;
  verdict: {
    readonly kind: TerminalKind;
    readonly rule: TerminalRule;
    readonly idx: number;
  } | null;
  endIdx: number;
  entries: number;
  exitsIs: number;
  exitsCs: number;
  locks: number;
  closeouts: number;
  checkpoints: [number, number][];
  /** D-183: the sleeve summary kept when a finished cohort drops its working state. */
  sleeveSummary?: SleeveSummary | null;
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sleeveSummaryOf(c: Cohort): SleeveSummary | null {
  if (c.cfg === null) return null;
  const closedReal = c.sleeveTrades.filter((t) => !t.shadow && t.closed !== null);
  return {
    trades: c.sleeveTrades.filter((t) => !t.shadow).length,
    shadowTrades: c.sleeveTrades.filter((t) => t.shadow).length,
    closeouts: c.closeouts,
    locks: c.locks,
    netPlMicro: closedReal.reduce((s, t) => s + netPlMicro(t.closed!), 0n),
  };
}

/**
 * D-183: a cohort that has left the live set is never touched again by the session loop; only its
 * outcome is read. Keep the outcome fields and drop the working state (ledger rows, NAV series,
 * history, positions, orders), which otherwise grows with cohorts x sessions until the end of the
 * replay (it ran a 12 GB heap out on the 2020-2026 history).
 */
function retire(c: Cohort): void {
  c.sleeveSummary = sleeveSummaryOf(c);
  c.sleeveTrades = [];
  c.sleeveStates = [];
  c.navs = [];
  c.history = [];
  c.pending = [];
  c.orders = [];
  c.filledToday = [];
  c.lastPos = [];
  c.recRows.length = 0;
  c.caRows.length = 0;
  c.adjustments.length = 0;
  c.positions.clear();
  c.lastIs.clear();
  c.stockExits.clear();
  c.unpaid.clear();
  c.sleeveEntryFee.clear();
}

function apply(c: Cohort, txn: LedgerTxn): void {
  for (const p of txn.postings) c.bal[p.account] += p.deltaMicro;
  c.dirty = true;
}

const NEVER = "9999-12-31";

function zeroBal(): Record<LedgerAccount, bigint> {
  return {
    cash_settled: 0n,
    cash_recv: 0n,
    cash_pay: 0n,
    div_recv: 0n,
    sleeve_margin: 0n,
    fin_accrued: 0n,
    fees_paid: 0n,
    position_cost: 0n,
    equity: 0n,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------------------------------------

type DayEnv = {
  readonly i: number;
  readonly d: string;
  readonly nextD: string | null;
  readonly inputs: FamilyInputs;
  readonly out: FamilyOutput;
  readonly facts: ReadonlyMap<string, CodeFacts>;
  bar(code: string): ViewBar | null;
  /** Halted today (universe flag, ARN-026); a trading day also advances the code's halt clock. */
  halted(code: string): boolean;
  positionFacts(code: string): PositionFacts | null;
  readonly advPrev: ReadonlyMap<string, bigint>;
  readonly prevClose: ReadonlyMap<string, bigint>;
};

type Taken = {
  readonly candidate: Candidate;
  readonly signalId: string;
  readonly halfSize: boolean;
};

export function replayCohorts(
  src: CohortReplaySource,
  opts: CohortReplayOptions,
): CohortReplayResult {
  const { params } = opts;
  const sessions = src.sessions;
  if (sessions.length < 2) throw new RangeError("a replay needs at least two sessions");
  const index = new Map<string, number>();
  sessions.forEach((d, i) => index.set(d, i));
  const idxOf = (d: string, what: string): number => {
    const i = index.get(d);
    if (i === undefined) throw new RangeError(`${what} ${d} is not a session of the source`);
    return i;
  };
  const endIdx = opts.to === undefined ? sessions.length - 1 : idxOf(opts.to, "to");
  const firstStart = opts.from === undefined ? 1 : idxOf(opts.from, "from");
  const step = opts.step ?? params.replay.rollingStartStep;
  if (!Number.isInteger(step) || step < 1) throw new RangeError("step must be a positive integer");
  const masterSeed = opts.masterSeed ?? 20_261_011n; // threshold-ok: arena master seed (closeBooks ARENA_MASTER_SEED)
  const controls = opts.controlsPerFamily ?? params.replay.c2LivePerFamily;
  const leverage = opts.leverage ?? params.replay.sleeveLeverage;
  const realityLeverage =
    opts.realityLeverage === undefined ? params.replay.realityCap : opts.realityLeverage;
  const checkpoints = opts.checkpoints ?? params.progress.sessionsEdges;
  const c1Code = opts.c1EtfCode ?? C1_ETF_PLACEHOLDER;
  const c1Active = c1Code !== C1_ETF_PLACEHOLDER;
  const registry = buildExecutionRegistry({ ruleVersion: opts.ruleVersion });
  const byId = new Map(registry.map((e) => [e.id, e]));
  const wanted = opts.executions === undefined ? null : new Set(opts.executions);
  const slots = cohortSlots(registry, controls).filter(
    (s) => wanted === null || wanted.has(s.executionId),
  );

  const suspension = opts.suspension ?? DEFAULT_SUSPENSION;
  const gateSource =
    opts.qualityGate ??
    (src.qualityGate === undefined
      ? undefined
      : (code: string, d: string) => src.qualityGate!(code, d));
  const calendar = calendarOf(sessions);
  /** Session index of the last session each held code was seen trading (the halt starts the next one). */
  const lastTrading = new Map<string, number>();

  // confirmed corporate actions of the codes seen so far (read lazily through the source)
  const actionsByCode = new Map<string, readonly CorpActionRecord[]>();
  const actionsOf = (code: string): readonly CorpActionRecord[] => {
    let a = actionsByCode.get(code);
    if (a === undefined) {
      a = src.corpActions?.(code) ?? [];
      actionsByCode.set(code, a);
    }
    return a;
  };
  let actionsAll: CorpActionRecord[] = [];
  let actionsAllCodes = -1;
  // GL-02: what a decision on session d may use is the actions confirmed by the decision cut-off of d
  let anyKnownAt = false;
  let actionsKnownD = "";
  let actionsKnown: CorpActionRecord[] = [];
  const allActions = (d: string): CorpActionRecord[] => {
    if (actionsAllCodes !== actionsByCode.size) {
      actionsAll = [...actionsByCode.keys()]
        .sort()
        .flatMap((k) => [...(actionsByCode.get(k) ?? [])]);
      actionsAllCodes = actionsByCode.size;
      actionsKnownD = "";
      anyKnownAt = actionsAll.some((x) => x.knownAt !== null && x.knownAt !== undefined);
    }
    // legacy rows (known_at null) are always known: skip the per-day cut-off work entirely
    if (!anyKnownAt) return actionsAll;
    if (actionsKnownD !== d) {
      actionsKnown = knownBy(actionsAll, decisionCutoffUtc(d, params.decisionCutoff));
      actionsKnownD = d;
    }
    return actionsKnown;
  };

  // FAM-007 (D-219): the dividend per share going ex on session env.d, known by the cut-off of the
  // previous session (the same records that credit the dividend)
  const exDividendFor = (env: DayEnv, code: string): bigint => {
    const today = actionsOf(code).filter((a) => a.exDate === env.d);
    if (today.length === 0) return 0n;
    const prev = sessions[env.i - 1];
    if (prev === undefined) return 0n;
    return exDividendOn(
      toExDividendActions(today),
      code,
      env.d,
      decisionCutoffUtc(prev, params.decisionCutoff),
    );
  };

  const cohorts: Cohort[] = [];
  let live: Cohort[] = [];
  const startsSeen: string[] = [];
  let advPrev = new Map<string, bigint>();
  const advMemory = new Map<string, bigint>(); // last known ADV per code (marks of a code without facts)
  const closeMemory = new Map<string, bigint>(); // last close per code
  let prevClose = new Map<string, bigint>();

  // ---- creating a group of cohorts ------------------------------------------------------------------------
  const makeCohort = (
    execution: ExecutionRow,
    controlIdx: number | null,
    group: "base" | "reality",
    startIdx: number,
  ): Cohort => {
    const startD = sessions[startIdx]!;
    const p = resolveCohortParams(opts.cohortParams?.(execution) ?? {});
    const profile = COST_PROFILES[p.costProfile];
    const lev = group === "reality" ? (realityLeverage ?? leverage) : leverage;
    const cfg = carriesSleeve(execution)
      ? { ...defaultSleeveConfig(profile), leverage: BigInt(lev) }
      : null;
    const base = cohortIdFor(execution.id, controlIdx, startD);
    const c: Cohort = {
      id: group === "reality" ? `${base}~L${lev}` : base,
      execution,
      controlIdx,
      group,
      startIdx,
      startD,
      params: p,
      profile,
      cfg,
      thresholds: terminalThresholds(p.terminal),
      bal: zeroBal(),
      pending: [],
      positions: new Map(),
      orders: [],
      lastIs: new Map(),
      stockExits: new Map(),
      adjustments: [],
      caRows: [],
      unpaid: new Map(),
      recRows: [],
      sleeveTrades: [],
      sleeveEntryFee: new Map(),
      sleeveStates: [],
      filledToday: [],
      navs: [],
      history: [],
      dirty: true,
      lastNav: p.seedMicro,
      lastLiq: p.seedMicro,
      lastPos: [],
      todaySignals: 0,
      lastSignalIdx: -1,
      todayParcel: 0,
      done: false,
      liqCodes: [],
      liquidatedIdx: -1,
      termNav: 0n,
      termLiq: 0n,
      realisedMicro: 0n,
      legacyMicro: 0n,
      verdict: null,
      endIdx: startIdx,
      entries: 0,
      exitsIs: 0,
      exitsCs: 0,
      locks: 0,
      closeouts: 0,
      checkpoints: [],
    };
    apply(c, seedTxn(startD, p.seedMicro));
    return c;
  };

  const startGroup = (startIdx: number): void => {
    startsSeen.push(sessions[startIdx]!);
    const made: Cohort[] = [];
    for (const slot of slots) {
      const execution = byId.get(slot.executionId)!;
      if (execution.kind === "C1" && !c1Active) continue;
      made.push(makeCohort(execution, slot.controlIdx, "base", startIdx));
    }
    if (realityLeverage !== null) {
      for (const slot of slots) {
        const execution = byId.get(slot.executionId)!;
        if (!carriesSleeve(execution)) continue;
        made.push(makeCohort(execution, slot.controlIdx, "reality", startIdx));
      }
    }
    made.sort((a, b) => cmp(a.id, b.id));
    cohorts.push(...made);
    live.push(...made);
  };

  // ---- fills -------------------------------------------------------------------------------------------------
  const fillEnv = (c: Cohort, bar: ViewBar, env: DayEnv, code: string, first = true): FillEnv => ({
    bar: { openMicro: bar.open, highMicro: bar.high, lowMicro: bar.low, closeMicro: bar.close },
    advMicro: env.advPrev.get(code) ?? advMemory.get(code) ?? 0n,
    profile: c.profile,
    tickCrossFactor: c.params.tickCrossFactor,
    feeContext: { code, firstBuyOfSecurityToday: first },
  });

  /** T+2 trading sessions of THIS calendar (the source's); never settles inside the data when beyond it. */
  const settleItem = (fill: LedgerFill, idx: number): SettlementItem => ({
    fillId: fill.id,
    side: fill.side,
    tradeD: fill.d,
    settleD: sessions[idx + SETTLEMENT_LAG_SESSIONS] ?? NEVER,
    netMicro: fillNetMicro(fill),
  });

  const effLevel = (pos: Pos): bigint => {
    let level = pos.level0;
    for (const l of pos.trail) if (l > level) level = l;
    return level < 1n ? 1n : level;
  };

  const rebasePrice = (price: bigint, ratio: { num: bigint; den: bigint }): bigint =>
    divFloor(price * ratio.den, ratio.num);

  const closePosition = (
    c: Cohort,
    pos: Pos,
    fill: SimulatedFill,
    type: "IS" | "CS",
    env: DayEnv,
    level: bigint | null,
    liquidation = false,
  ): void => {
    const ledgerFill: LedgerFill = {
      id: `${c.id}|sell|${pos.orderId}`,
      d: env.d,
      code: pos.code,
      side: "sell",
      qty: fill.qty,
      valueMicro: fill.valueMicro,
      brokerageMicro: fill.brokerageMicro,
    };
    for (const txn of fillTxns(ledgerFill, pos.costMicro)) {
      apply(c, txn);
      if (c.cfg !== null) c.recRows.push(...txnRows(txn));
    }
    const item = settleItem(ledgerFill, env.i);
    if (item.netMicro !== 0n) c.pending.push(item);
    c.positions.delete(pos.code);
    c.stockExits.set(pos.orderId, { type, d: env.d, levelMicro: level });
    if (liquidation) {
      // a terminal liquidation is neither an IS nor a CS exit of the cohort's record (exit_type terminal)
    } else if (type === "IS") {
      c.exitsIs += 1;
      c.lastIs.set(pos.code, env.i);
    } else {
      c.exitsCs += 1;
    }
  };

  const cashNow = (c: Cohort, env: DayEnv): bigint =>
    availableCash({
      mode: c.params.settlementMode,
      balances: c.bal as LedgerBalances,
      pending: c.pending,
      sessionD: env.d,
    });

  // ---- 2a stages -----------------------------------------------------------------------------------------------
  const applyActions = (c: Cohort, env: DayEnv): void => {
    if (c.positions.size === 0 && c.unpaid.size === 0) return;
    const todays: CorpActionRecord[] = [];
    for (const code of [...c.positions.keys()].sort()) {
      for (const a of actionsOf(code)) if (a.exDate === env.d) todays.push(a);
    }
    if (todays.length === 0 && c.unpaid.size === 0) return;
    const priorD = sessions[env.i - 1];
    if (priorD === undefined) return;
    const fills: LedgerFill[] = [...c.positions.values()]
      .sort((a, b) => cmp(a.code, b.code))
      .map((p) => ({
        id: `pos:${p.orderId}`,
        d: p.entryD,
        code: p.code,
        side: "buy",
        qty: p.qty0,
        valueMicro: p.costMicro,
        brokerageMicro: 0n,
      }));
    const plan = planCorporateActions({
      d: env.d,
      priorD,
      actions: [...todays, ...c.unpaid.values()],
      fills,
      adjustments: c.adjustments,
      ledgerRows: c.caRows,
      lastCloseFor: (code) => env.prevClose.get(code),
    });
    for (const txn of plan.txns) {
      apply(c, txn);
      c.caRows.push(...txnRows(txn));
      if (txn.kind === "div_accrue" && txn.refId !== null) {
        const rec = todays.find((a) => a.id === txn.refId);
        if (rec !== undefined) c.unpaid.set(txn.refId, rec);
      }
      if (txn.kind === "div_pay" && txn.refId !== null) c.unpaid.delete(txn.refId);
    }
    for (const adj of plan.adjustments as readonly PlannedAdjustment[]) {
      const pos = c.positions.get(adj.code);
      if (pos === undefined) continue;
      c.adjustments.push({ code: adj.code, exD: env.d, ratio: adj.ratio });
      if (adj.qtyAfter === 0n) {
        c.positions.delete(adj.code);
        c.stockExits.set(pos.orderId, { type: "CS", d: env.d, levelMicro: null });
        c.exitsCs += 1;
        continue;
      }
      pos.qty = adj.qtyAfter;
      pos.fillFrame = rebasePrice(pos.fillFrame, adj.ratio);
      pos.level0 = rebasePrice(pos.level0, adj.ratio);
      pos.highest = rebasePrice(pos.highest, adj.ratio);
      pos.trail = pos.trail.map((l) => rebasePrice(l, adj.ratio));
      pos.plan = {
        ...pos.plan,
        cs: pos.plan.cs.map((r) =>
          r.kind === "close_below_level"
            ? { ...r, levelMicro: rebasePrice(r.levelMicro, adj.ratio) }
            : r,
        ),
      };
    }
  };

  const fillPending = (c: Cohort, env: DayEnv): void => {
    if (c.positions.size === 0 && c.orders.length === 0) return;
    // CS exits first (ids CS: < EN:), then the entries
    for (const pos of [...c.positions.values()].sort((a, b) => cmp(a.code, b.code))) {
      if (pos.pendingCs === null) continue;
      const bar = env.bar(pos.code);
      if (bar === null || env.halted(pos.code)) continue; // waits for a session with a bar, not halted
      const fe = fillEnv(c, bar, env, pos.code);
      const cs = fillCloseSignalExit(fe, pos.qty);
      const level = effLevel(pos);
      const stop = fillIntradayStop(fe, pos.qty, level, {
        exDividendMicro: exDividendFor(env, pos.code),
      });
      const chosen = selectExit(cs, stop);
      if (chosen === null) continue;
      closePosition(c, pos, chosen, chosen.rule === "close_signal" ? "CS" : "IS", env, level);
    }
    const orders = [...c.orders].sort((a, b) => cmp(a.id, b.id));
    c.orders = [];
    for (const o of orders) {
      const bar = env.bar(o.code);
      if (bar === null) continue; // cancelled: no bar
      if (c.positions.has(o.code)) continue;
      const fe = fillEnv(c, bar, env, o.code);
      const fillEntryV1 = (qty: bigint): FillOutcome =>
        fillOrder(
          {
            kind: "entry",
            qty,
            stopFrom: (fillMicro) => initialStopAtFill(o.plan, fillMicro),
          },
          {
            ...fe,
            halted: env.halted(o.code),
            // the gate result of the fill session; without quality data every code passes (flagged)
            gate:
              gateSource === undefined
                ? { allowed: true, reason: "ok" }
                : gateSource(o.code, env.d),
          },
        );
      const limitMicro = o.limitMicro;
      let limitRule: FillRowRule | null = null;
      // M15: a Cortex entry fills through `fillEntryLimit` (D-288) after the same gate and halt checks
      const fillEntry = (qty: bigint): FillOutcome | { readonly status: "unfilled" } => {
        const v1 = fillEntryV1(qty);
        if (limitMicro === undefined || v1.status !== "filled") return v1;
        const lim = fillEntryLimit(fe, qty, limitMicro);
        if (lim.status !== "filled") return { status: "unfilled" };
        limitRule = fillRowRule(lim);
        return {
          status: "filled",
          fill: lim.fill as FillOutcomeFill,
          initialStopMicro: initialStopAtFill(o.plan, lim.fill.fillPriceMicro),
        };
      };
      let outcome = fillEntry(o.qty);
      if (outcome.status !== "filled") continue;
      if (o.maxOpen !== null && bar.open >= o.maxOpen) continue; // F3 gap cap: cancelled at the fill
      // GL-03: the same resize rule as closeBooks (resizeEntryAtFill); cancelled only for cash
      const sized = resizeEntryAtFill({
        plannedQty: outcome.fill.qty,
        fillPriceMicro: outcome.fill.fillPriceMicro,
        availableCashMicro: cashNow(c, env),
        profile: c.profile,
        feeContext: fe.feeContext,
      });
      if (sized.status === "cancel") continue; // cancelled: cash
      if (sized.status === "resized") {
        outcome = fillEntry(sized.qty);
        if (outcome.status !== "filled") continue;
      }
      const fill = outcome.fill;
      if (limitRule !== null) {
        opts.cortex?.onFill?.({ d: env.d, cohortId: c.id, code: o.code, rule: limitRule });
      }
      const ledgerFill: LedgerFill = {
        id: `${c.id}|buy|${o.id}`,
        d: env.d,
        code: o.code,
        side: "buy",
        qty: fill.qty,
        valueMicro: fill.valueMicro,
        brokerageMicro: fill.brokerageMicro,
      };
      for (const txn of fillTxns(ledgerFill)) {
        apply(c, txn);
        if (c.cfg !== null) c.recRows.push(...txnRows(txn));
      }
      c.pending.push(settleItem(ledgerFill, env.i));
      const cs: CsRule[] = [...o.plan.plan.cs];
      for (const rel of o.plan.rel) {
        const level = fill.fillPriceMicro - scaleMicro(rel.atrMicro, rel.k);
        cs.push({
          id: rel.id,
          via: null,
          kind: "close_below_level",
          levelMicro: level < 1n ? 1n : level,
        });
      }
      c.positions.set(o.code, {
        code: o.code,
        qty: fill.qty,
        qty0: fill.qty,
        costMicro: fill.valueMicro,
        entryIdx: env.i,
        entryD: env.d,
        tier: o.tier,
        orderId: o.id,
        fillFrame: fill.fillPriceMicro,
        level0: outcome.initialStopMicro ?? 1n,
        trail: [],
        plan: { ...o.plan.plan, cs },
        highest: 0n,
        pendingCs: null,
        thesis: o.thesis,
      });
      c.entries += 1;
      c.filledToday.push({ orderId: o.id, code: o.code, tier: o.tier });
    }
  };

  const isStops = (c: Cohort, env: DayEnv): void => {
    if (c.positions.size === 0) return;
    for (const pos of [...c.positions.values()].sort((a, b) => cmp(a.code, b.code))) {
      const bar = env.bar(pos.code);
      if (bar === null || env.halted(pos.code)) continue;
      const level = effLevel(pos);
      const fill = fillIntradayStop(fillEnv(c, bar, env, pos.code), pos.qty, level, {
        afterOpen: pos.entryIdx === env.i,
        exDividendMicro: exDividendFor(env, pos.code),
      });
      if (fill !== null) closePosition(c, pos, fill, "IS", env, level);
    }
  };

  // ---- the sleeve (closeBooks stage e) ----------------------------------------------------------------------------
  const sleeveStage = (c: Cohort, env: DayEnv, cfg: SleeveConfig): void => {
    const sleeveEnv = (code: string): FillEnv | null => {
      const bar = env.bar(code);
      return bar === null ? null : { ...fillEnv(c, bar, env, code), profile: cfg.profile };
    };
    for (const f of c.filledToday) {
      const fe = sleeveEnv(f.code);
      if (fe === null) continue;
      if (!sleeveEligibility({ tier: f.tier }).eligible) continue;
      const margin = sleeveMarginMicro(c.lastNav, cfg);
      if (margin <= 0n) continue;
      const quote = quoteSleeveEntry(fe, margin, cfg);
      const id = `S:${f.orderId}`;
      if (lockStatus(c.sleeveStates).locked) {
        if (c.sleeveTrades.some((t) => t.shadow && t.closed === null)) continue;
        c.sleeveTrades.push(
          openTrade({
            id,
            cohortId: c.id,
            code: f.code,
            openD: env.d,
            quote,
            entryFillId: null,
            shadow: true,
            cfg,
          }),
        );
        c.sleeveEntryFee.set(id, quote.entryBrokerageMicro);
        continue;
      }
      if (c.sleeveTrades.some((t) => !t.shadow && t.closed === null)) continue;
      const need = margin + quote.entryBrokerageMicro;
      if (c.bal.cash_settled < need || cashNow(c, env) < need) continue; // ARN-003: sleeve skipped
      const trade = openTrade({
        id,
        cohortId: c.id,
        code: f.code,
        openD: env.d,
        quote,
        entryFillId: `SF:${f.orderId}`,
        cfg,
      });
      apply(c, sleeveOpenTxn(trade, quote.entryBrokerageMicro));
      c.sleeveTrades.push(trade);
      c.sleeveEntryFee.set(id, quote.entryBrokerageMicro);
    }
    const catchUp = (t: SleeveTrade): void => {
      if (t.shadow) return;
      const accrued = -c.bal.fin_accrued;
      const owed = financingAccruedAt(t, env.d, cfg) - accrued;
      if (owed > 0n) apply(c, sleeveFinancingTxn(t, env.d, owed));
    };
    for (const t of c.sleeveTrades.filter((x) => x.closed === null)) {
      const bar = env.bar(t.code);
      if (bar === null || env.halted(t.code)) continue;
      const fe: FillEnv = { ...fillEnv(c, bar, env, t.code), profile: cfg.profile };
      const afterOpen = t.openD === env.d;
      const closeout = quoteSleeveExit(
        fe,
        t,
        {
          kind: "closeout",
          financingMicro: financingAccruedAt(t, env.d, cfg),
          factor: priceFactorSince(t.code, t.openD, env.d, c.adjustments),
          afterOpen,
        },
        cfg,
      );
      let family: SleeveExitQuote | null = null;
      const orderId = t.id.slice(2);
      const stockOpen = [...c.positions.values()].some((p) => p.orderId === orderId);
      if (!stockOpen) {
        const exit = c.stockExits.get(orderId);
        if (exit !== undefined) {
          const mode: SleeveExitMode =
            exit.type === "IS" && exit.d === env.d && exit.levelMicro !== null
              ? { kind: "is", levelMicro: exit.levelMicro, afterOpen }
              : { kind: "cs" };
          family = quoteSleeveExit(fe, t, mode, cfg);
        }
      }
      const pick =
        closeout !== null && family !== null
          ? earlierSleeveExit(family, closeout)
          : (closeout ?? family);
      if (pick === null) continue;
      catchUp(t);
      const result = closeSleeve({
        trade: t,
        entryBrokerageMicro: c.sleeveEntryFee.get(t.id) ?? 0n,
        closeD: env.d,
        exitPriceMicro: pick.fill.fillPriceMicro,
        exitBrokerageMicro: pick.fill.brokerageMicro,
        closedBy: pick.closedBy,
        exitFillId: t.shadow ? null : `SCF:${t.id}`,
        financingMicro: financingAccruedAt(t, env.d, cfg),
        factor: priceFactorSince(t.code, t.openD, env.d, c.adjustments),
      });
      if (!t.shadow) apply(c, sleeveCloseTxn(t, result));
      const closed = closedTrade(t, result);
      c.sleeveTrades = c.sleeveTrades.map((x) => (x.id === t.id ? closed : x));
      if (pick.closedBy === "closeout" && !t.shadow) c.closeouts += 1;
      const lock = lockAfterClose(c.sleeveStates, closed, cfg);
      if (lock !== null) {
        c.sleeveStates = [...c.sleeveStates, lock];
        c.locks += 1;
      }
    }
    const open = c.sleeveTrades.find((t) => !t.shadow && t.closed === null);
    if (open !== undefined) catchUp(open);
  };

  const unlockCheck = (c: Cohort, env: DayEnv, cfg: SleeveConfig): void => {
    const status = lockStatus(c.sleeveStates);
    if (!status.locked || status.lockD === null) return;
    const locking = c.sleeveTrades
      .filter((t) => !t.shadow && t.closed !== null && t.closed.closeD === status.lockD)
      .sort((a, b) => (a.openD < b.openD ? 1 : -1))[0];
    const lockIdx = index.get(status.lockD) ?? env.i;
    const refIdx = locking === undefined ? -1 : (index.get(locking.openD) ?? 0) - 1;
    const entry = evaluateUnlock(
      c.sleeveStates,
      {
        d: env.d,
        navMicro: c.lastNav,
        refNavMicro:
          status.mode === "REC-1" && locking !== undefined
            ? (c.navs[refIdx - c.startIdx] ?? c.params.seedMicro)
            : undefined,
        realisedUnleveredNetMicro:
          status.mode === "REC-2"
            ? realisedUnleveredNetSince(c.recRows, status.lockD, env.d)
            : undefined,
        shadowNetMicro:
          status.mode === "REC-3" ? shadowNetSince(c.sleeveTrades, status.lockD, env.d) : undefined,
        sessionsSinceLock: status.mode === "REC-4" ? env.i - lockIdx : undefined,
      },
      cfg,
    );
    if (entry !== null) c.sleeveStates = [...c.sleeveStates, entry];
  };

  // ---- NAV and the terminal verdict -----------------------------------------------------------------------------
  const markFor = (env: DayEnv, code: string): Mark | undefined => {
    const bar = env.bar(code);
    const close = bar !== null ? bar.close : closeMemory.get(code);
    if (close === undefined) return undefined;
    const advMicro = advMemory.get(code) ?? 0n;
    if (!env.halted(code)) return { closeMicro: close, advMicro };
    // ARN-026: frozen at the last traded close; the halt began the session after the last trading one
    const last = lastTrading.get(code);
    const start = last === undefined ? env.i : Math.min(last + 1, env.i);
    return suspensionMark({
      lastCloseMicro: close,
      advMicro,
      haltStartD: sessions[start]!,
      d: env.d,
      calendar,
      config: suspension,
    });
  };

  /** One close for the terminal tests; only the last few are kept (the tests look back a fixed window). */
  const pushHistory = (c: Cohort, d: string, nav: bigint, liq: bigint, open: bigint): void => {
    const keep =
      Math.max(c.params.terminal.stallSessions, c.params.terminal.stallParcelRejections) + 1;
    c.history.push({
      d,
      navMicro: nav,
      liqNavMicro: liq,
      openPositions: open,
      signals: null,
      parcelOnlyRejections: 0,
    });
    if (c.history.length > keep) c.history.splice(0, c.history.length - keep);
  };

  const navStage = (c: Cohort, env: DayEnv): void => {
    const idle =
      !c.dirty &&
      c.positions.size === 0 &&
      c.navs.length > 0 &&
      !c.sleeveTrades.some((t) => t.closed === null);
    if (idle) {
      // nothing moved since the last stored NAV: the same cash, no position, no sleeve
      c.navs.push(c.lastNav);
      c.lastPos = [];
      pushHistory(c, env.d, c.lastNav, c.lastLiq, 0n);
      return;
    }
    const qty = new Map<string, bigint>();
    for (const [code, p] of c.positions) qty.set(code, p.qty);
    let sleeveUnreal = 0n;
    let sleeveLiq = 0n;
    if (c.cfg !== null) {
      const open = openRealTradeAt(c.sleeveTrades, env.d);
      sleeveUnreal = sleeveUnrealAt({
        trades: c.sleeveTrades,
        d: env.d,
        closeFor: (code) => markFor(env, code)?.closeMicro,
        adjustments: c.adjustments,
        cfg: c.cfg,
      });
      sleeveLiq = sleeveLiquidationCostMicro(open, c.cfg);
    }
    const day = computeNavDay({
      cohortId: c.id,
      d: env.d,
      balances: c.bal as LedgerBalances,
      positions: qty,
      markFor: (code) => markFor(env, code),
      sleeveUnrealMicro: sleeveUnreal,
      sleeveLiquidationCostMicro: sleeveLiq,
      profile: c.profile,
      tickCrossFactor: c.params.tickCrossFactor,
    });
    c.lastNav = day.row.navMicro;
    c.lastLiq = day.row.liqNavMicro;
    c.lastPos = day.positions;
    c.navs.push(day.row.navMicro);
    c.dirty = false;
    pushHistory(c, env.d, day.row.navMicro, day.row.liqNavMicro, day.row.openPositions);
    for (const pos of c.positions.values()) {
      const bar = env.bar(pos.code);
      if (bar !== null && bar.close > pos.highest) pos.highest = bar.close;
    }
  };

  /** Terminal liquidation (ARN-053): every code held at the terminal close is sold at this open. */
  const fillLiquidation = (c: Cohort, env: DayEnv): void => {
    for (const code of c.liqCodes) {
      const pos = c.positions.get(code);
      if (pos === undefined) continue;
      const bar = env.bar(code);
      if (bar === null || env.halted(code)) continue; // waits: no bar, or halted (legacy at wind-down)
      const fe = fillEnv(c, bar, env, code);
      const level = effLevel(pos);
      const chosen = selectExit(
        fillCloseSignalExit(fe, pos.qty),
        fillIntradayStop(fe, pos.qty, level, { exDividendMicro: exDividendFor(env, code) }),
      );
      if (chosen === null) continue;
      closePosition(c, pos, chosen, "CS", env, null, true);
    }
  };

  /** closeBooks `windDown`: once only halted codes are left unsold, they go to the legacy ledger. */
  const windDown = (c: Cohort, env: DayEnv): void => {
    if (c.liquidatedIdx >= 0) return; // the realised value is written once
    const pending = c.liqCodes.filter((code) => c.positions.has(code));
    const halted = new Set(pending.filter((code) => env.halted(code)));
    if (pending.some((code) => !halted.has(code))) return; // a tradeable code is still unsold
    const held = new Map<string, bigint>();
    for (const [code, p] of c.positions) held.set(code, p.qty);
    const items = planLegacy({
      positions: held,
      openTrades: [...c.positions.values()].map((p) => ({ tradeId: p.orderId, code: p.code })),
      halted,
      markFor: (code) => markFor(env, code) as Mark,
    });
    let legacy = 0n;
    for (const item of items) legacy += item.valueMicro;
    c.legacyMicro = legacy;
    c.realisedMicro = c.lastNav - legacy;
    c.liquidatedIdx = env.i;
  };

  const close2a = (c: Cohort, env: DayEnv): void => {
    if (c.filledToday.length > 0) c.filledToday = [];
    c.todaySignals = 0;
    c.todayParcel = 0;
    if (c.pending.length > 0) {
      for (const txn of settlementsDue(c.pending, env.d)) apply(c, txn);
      c.pending = c.pending.filter((p) => p.settleD > env.d);
    }
    applyActions(c, env);
    fillPending(c, env);
    if (c.done) fillLiquidation(c, env);
    isStops(c, env);
    if (c.cfg !== null && (c.filledToday.length > 0 || c.sleeveTrades.length > 0)) {
      sleeveStage(c, env, c.cfg);
    }
    navStage(c, env);
    opts.trace?.({
      cohortId: c.id,
      d: env.d,
      navMicro: c.lastNav,
      liqNavMicro: c.lastLiq,
      positions: c.lastPos,
      openPositions: c.positions.size,
      cashSettledMicro: c.bal.cash_settled,
    });
    if (c.cfg !== null) unlockCheck(c, env, c.cfg);
    if (c.done) {
      windDown(c, env); // a resolved cohort keeps its terminal endIdx and verdict
      return;
    }
    c.endIdx = env.i;
    const elapsed = env.i - c.startIdx + 1;
    const v = judgeClose(c.params.terminal, c.history, elapsed, {
      thresholds: c.thresholds,
      noRecentSignals: c.lastSignalIdx < env.i - c.params.terminal.stallParcelRejections,
    });
    if (v !== null) {
      c.done = true;
      c.verdict = { kind: v.kind, rule: v.rule, idx: env.i };
      c.termNav = c.lastNav;
      c.termLiq = c.lastLiq;
      const held = new Map<string, bigint>();
      for (const [code, p] of c.positions) held.set(code, p.qty);
      c.liqCodes = planLiquidation({
        cohortId: c.id,
        d: env.d,
        calendar,
        positions: held,
        openTrades: [...c.positions.values()].map((p) => ({ tradeId: p.orderId, code: p.code })),
      }).orders.map((o) => o.code);
      return;
    }
    if (checkpoints.includes(elapsed)) {
      c.checkpoints.push([elapsed, Number(divFloor(c.lastLiq * 1_000_000n, c.params.seedMicro))]); // threshold-ok: ppm of the seed
    }
  };

  // ---- 2b: exits ----------------------------------------------------------------------------------------------------
  const exitsStage = (c: Cohort, env: DayEnv): void => {
    if (env.nextD === null || c.positions.size === 0) return;
    for (const pos of [...c.positions.values()].sort((a, b) => cmp(a.code, b.code))) {
      const bar = env.bar(pos.code);
      const facts = env.positionFacts(pos.code);
      if (bar === null || facts === null) continue;
      const ev = evaluateExit({
        tradeId: pos.orderId,
        code: pos.code,
        family: "F1", // evaluateExit does not branch on the family; the plan carries every rule
        plan: pos.plan,
        fillDay: pos.entryD,
        fillMicro: pos.fillFrame,
        sessionsHeld: env.i - pos.entryIdx + 1,
        closeMicro: bar.close,
        highestCloseMicro: pos.highest,
        atrMicro: facts.atrMicro,
        closeAboveExitSma: facts.closeAboveExitSma,
        volumeRatios: facts.volumeRatios,
        events: facts.events,
      });
      pos.trail = ev.isLevels.map((l) => l.levelMicro).filter((l) => l >= 1n);
      if (pos.pendingCs === null && ev.cs !== null) {
        const cross = crossing(allActions(env.d), pos.code, env.d, env.nextD);
        if (!cross.disposal) pos.pendingCs = ev.cs;
      }
      // thesis-breakers (AGT-111, M5 T7): the SAME pure evaluator as batch 2b; a red one on a held
      // position queues the exit for the next open unless an exit is already waiting. Never gated.
      if (pos.pendingCs === null && pos.thesis !== null && c.execution.kind === "E") {
        const t = pos.thesis;
        const fresh = env.inputs.events.filter((e) => e.code === pos.code && !t.known.has(e.id));
        const texts = new Map<string, AnnouncementText>();
        for (const e of fresh) {
          const text = src.announcementText?.(e.id);
          if (text !== undefined && text !== null) texts.set(e.id, text);
        }
        const obs = buildObservation(
          {
            d: env.d,
            phase: "nightly",
            rawBars: env.facts.get(pos.code)?.rawBars ?? [bar],
            refCloseMicro: t.refCloseMicro,
            shortDeltaPpm: src.shortDeltaPpm?.(pos.code, env.d) ?? null,
            regime: env.inputs.regime,
            items: itemsFromEvents(fresh, env.inputs.sessions, env.d, texts),
          },
          params,
        );
        const verdict = evaluateBreakers(t.breakers, obs, params);
        const red = verdict.evaluations.find((e) => e.status === "red");
        if (red !== undefined) {
          const cross = crossing(allActions(env.d), pos.code, env.d, env.nextD);
          if (!cross.disposal) {
            pos.pendingCs = { rule: red.id, via: null, detail: red.valueText };
          }
        }
      }
    }
  };

  // ---- 2b: entries ----------------------------------------------------------------------------------------------------
  const sleeveReserve = (c: Cohort): bigint => {
    if (c.cfg === null) return 0n;
    const margin = sleeveMarginMicro(c.lastNav, c.cfg);
    if (
      margin > 0n &&
      !lockStatus(c.sleeveStates).locked &&
      !c.sleeveTrades.some((t) => !t.shadow && t.closed === null)
    ) {
      return margin + feeFor(c.cfg.profile, margin * c.cfg.leverage, "buy");
    }
    return 0n;
  };

  const markSleeve = (legs: readonly Leg[], reserve: bigint): Leg[] => {
    let given = reserve <= 0n;
    return legs.map((l) => {
      if (given || !sleeveEligibility({ tier: l.env.tier }).eligible) return l;
      given = true;
      return { ...l, sleeve: true };
    });
  };

  const sizingOf = (c: Cohort, env: DayEnv): SizingContext => ({
    params: c.params,
    cashMicro: availableCash({
      mode: c.params.settlementMode,
      balances: c.bal as LedgerBalances,
      pending: c.pending,
      sessionD: env.d,
    }),
    navMicro: c.lastNav,
    sleeveReserveMicro: sleeveReserve(c),
  });

  const legFor = (
    env: DayEnv,
    facts: CodeFacts,
    halfSize: boolean,
    key: string,
  ): { leg: Leg; priceFactor: Rational; ids: readonly string[] } | null => {
    const cross = crossing(allActions(env.d), facts.code, env.d, env.nextD!);
    if (cross.disposal) return null;
    return {
      leg: { key, halfSize, sleeve: false, env: sizingEnvFor({ facts, cross, p: params }) },
      priceFactor: cross.priceFactor,
      ids: cross.ids,
    };
  };

  const placeOrders = (
    c: Cohort,
    env: DayEnv,
    results: readonly LegResult[],
    describe: (leg: Leg) => {
      plan: OrderPlan;
      maxOpen: bigint | null;
      tier: Tier;
      thesis?: Thesis;
    },
  ): void => {
    for (const r of results) {
      c.todaySignals += 1;
      if (!r.sizing.accepted) {
        if (isParcelOnlyRejection(r.sizing.reasons)) c.todayParcel += 1;
        continue;
      }
      const info = describe(r.leg);
      c.orders.push({
        code: r.leg.key,
        qty: r.sizing.qty,
        plan: info.plan,
        maxOpen: info.maxOpen,
        tier: info.tier,
        id: `EN:${c.id}:${env.d}:${r.leg.key}`,
        thesis: info.thesis ?? null,
      });
    }
  };

  const entryPlanOf = (
    c: Candidate,
    env: DayEnv,
    cross: { priceFactor: Rational; ids: readonly string[] },
  ): { plan: OrderPlan; maxOpen: bigint | null } => ({
    plan: {
      family: c.family,
      variant: c.variant,
      ruleVersion: c.ruleVersion,
      caThrough: env.d,
      caApplied: cross.ids,
      plan: scalePlanPrices(c.plan, cross.priceFactor),
      rel: [],
    },
    maxOpen: c.maxOpenMicro === null ? null : scaleMicro(c.maxOpenMicro, cross.priceFactor),
  });

  /** The night of the session when the Cortex hook is set (run once, before the entries stage). */
  let cortexNight: NightOutput | null = null;

  /** M15: the book each E cohort is to the night (book id = cohort id; design 3c). */
  const cortexBooks = (cohortsNow: readonly Cohort[], env: DayEnv): CortexBook[] =>
    cohortsNow
      .filter(
        (c) =>
          c.execution.kind === "E" &&
          c.execution.family !== null &&
          c.group === "base" &&
          c.startIdx <= env.i,
      )
      .map((c) => ({
        bookId: c.id,
        family: c.execution.family as Family,
        executionId: c.execution.id,
        positions: [...c.positions.values()]
          .sort((a, b) => cmp(a.code, b.code))
          .map((p) => ({
            code: p.code,
            qty: p.qty,
            costMicro: p.costMicro,
            stopMicro: effLevel(p),
            entryD: p.entryD,
          })),
        // the replay ledger's own deployable cash (as the v1 sizing reads it): no separate pending list
        settledCashMicro: cashNow(c, env),
        navMicro: c.lastNav,
        costProfile: c.profile,
        sessionsSinceGoLive: env.i - c.startIdx,
      }));

  /** M15: the cohort's own Cortex decisions become limit orders (design 3c); no controls match them. */
  const cortexEntries = (c: Cohort, env: DayEnv, family: Family): Taken[] => {
    if (cortexNight === null || env.nextD === null) return [];
    const slotsLeft = c.params.maxOpenPositions - c.positions.size;
    const blockFrom = env.i - params.reentryBlock;
    let placed = 0;
    for (const dec of cortexNight.decisions) {
      if (placed >= slotsLeft) break;
      if (dec.bookId !== c.id || dec.family !== family) continue;
      if (c.positions.has(dec.code)) continue;
      const last = c.lastIs.get(dec.code);
      if (last !== undefined && last >= blockFrom) continue; // re-entry block (FAM-002)
      const cross = crossing(allActions(env.d), dec.code, env.d, env.nextD);
      // the night sized in today's share terms: a quantity change across the fill is not placed
      if (cross.disposal || cross.priceFactor.num !== cross.priceFactor.den) continue;
      c.todaySignals += 1;
      placed += 1;
      c.orders.push({
        code: dec.code,
        qty: dec.qty,
        plan: {
          family: dec.family,
          variant: "cortex",
          ruleVersion: "cortex",
          caThrough: env.d,
          caApplied: cross.ids,
          plan: dec.plan,
          rel: [],
        },
        maxOpen: null,
        tier: dec.tier,
        id: `EN:${c.id}:${env.d}:${dec.code}`,
        thesis: null,
        limitMicro: dec.limitMicro,
      });
    }
    return [];
  };

  const entriesFor = (c: Cohort, env: DayEnv, family: Family): Taken[] => {
    if (env.nextD === null) return [];
    if (opts.cortex !== undefined && opts.cortex.status[family] === "allowed") {
      return cortexEntries(c, env, family);
    }
    const ranked = rankedCandidates(env.out.candidates.filter((x) => x.family === family));
    if (ranked.length === 0) return [];
    const slotsLeft = c.params.maxOpenPositions - c.positions.size;
    if (slotsLeft < 1) return [];
    const blockFrom = env.i - params.reentryBlock;
    const pool = ranked.filter((cand) => {
      if (c.positions.has(cand.code)) return false;
      const last = c.lastIs.get(cand.code);
      return last === undefined || last < blockFrom; // re-entry block (FAM-002)
    });
    // M14 entry gates: the same function as the live night (cost gate, second position, abstain)
    const sizing = sizingOf(c, env);
    // a disposal across the next session cannot open, so it is not the FAM-006 first leg (as batch 2b)
    const noPosition = new Set(
      pool
        .filter((cand) => crossing(allActions(env.d), cand.code, env.d, env.nextD!).disposal)
        .map((cand) => cand.code),
    );
    // D-284 (FAM-006): a rejected first leg is dropped and the gates run once more (as batch 2b)
    const attempt = (rejected: ReadonlySet<string>) => {
      const legs: Leg[] = [];
      const meta = new Map<
        string,
        { cand: Candidate; plan: OrderPlan; maxOpen: bigint | null; thesis: Thesis | undefined }
      >();
      const poolA = pool.filter((cand) => !rejected.has(cand.code));
      const noPositionA = new Set([...noPosition, ...rejected]);
      const gated = selectEntries(poolA, {
        entry: params.entry,
        advWindow: params.windows.adv,
        costProfile: c.profile,
        costTable: opts.costGate,
        factsOf: (code) => env.facts.get(code),
        heldCodes: [...c.positions.keys()].sort(),
        cashMicro: sizing.cashMicro,
        noPosition: noPositionA,
      });
      for (const cand of gated.eligible) {
        if (legs.length >= slotsLeft) break;
        const facts = env.facts.get(cand.code);
        if (facts === undefined) continue;
        const made = legFor(env, facts, cand.halfSize, cand.code);
        if (made === null) continue;
        legs.push(made.leg);
        // the thesis-breakers the live card would carry (cards.ts: same function, same levels)
        const codeEvents = env.inputs.events.filter((e) => e.code === cand.code);
        const low = eventLowOf(codeEvents, cand.groupKey);
        const cross = made.priceFactor;
        const thesis: Thesis = {
          breakers: cardBreakers(
            { family: cand.family, shortInterestAvailable: facts.shortDrop !== "unknown" },
            params,
            {
              closeMicro: scaleMicro(facts.bar.close, cross),
              eventLowMicro: low === null ? null : scaleMicro(low, cross),
            },
          ),
          known: new Set(codeEvents.map((e) => e.id)),
          refCloseMicro: facts.bar.close,
        };
        meta.set(cand.code, { cand, thesis, ...entryPlanOf(cand, env, made) });
      }
      const results = planLegs(sizing, markSleeve(legs, sleeveReserve(c)), slotsLeft);
      const abstained = [...gated.skipped.values()].some((r) => r === ABSTAIN_SHOCK_REASON);
      return { meta, results, abstained };
    };
    let att = attempt(new Set());
    const rejectedFirst = firstLegRetryCode(att.results);
    if (rejectedFirst !== null) {
      const retry = attempt(new Set([rejectedFirst]));
      att = {
        ...retry,
        meta: new Map([...att.meta, ...retry.meta]),
        results: [att.results[0]!, ...retry.results],
        abstained: retry.abstained,
      };
    }
    const { meta, results, abstained } = att;
    if (abstained && results.length === 0) {
      // the abstain replaces the below-two-parcels rejection one for one (stall counters unchanged)
      c.todaySignals += 1;
      c.todayParcel += 1;
    }
    placeOrders(c, env, results, (leg) => {
      const m = meta.get(leg.key)!;
      return { plan: m.plan, maxOpen: m.maxOpen, tier: m.cand.tier, thesis: m.thesis };
    });
    const taken: Taken[] = [];
    for (const r of results) {
      if (!r.sizing.accepted) continue;
      const cand = meta.get(r.leg.key)!.cand;
      taken.push({
        candidate: cand,
        signalId: `sig:${cand.d}:${cand.family}:${cand.ruleVersion}:${cand.variant}:${cand.code}`,
        halfSize: cand.halfSize,
      });
    }
    return taken;
  };

  const controlsFor = (
    c: Cohort,
    env: DayEnv,
    family: Family,
    matched: readonly Taken[],
    qualifying: ReadonlySet<string>,
    evalCtx: ReturnType<typeof createContext>,
  ): void => {
    if (env.nextD === null) return;
    const prng = createPrng(deriveRngSeed(masterSeed, `c2:${c.id}:${env.d}`));
    const universe = src.controlUniverse(env.d, family);
    const tierOf = new Map<string, string>();
    const vol20 = new Map<string, number>();
    for (const u of universe) {
      tierOf.set(u.code, u.tier);
      if (u.vol20 !== null) vol20.set(u.code, u.vol20);
    }
    const eventToday = new Set<string>();
    if (family !== "F1" && family !== "F4") {
      for (const e of env.inputs.events) if (e.day0 === env.d) eventToday.add(e.code);
    }
    const slotsLeft = c.params.maxOpenPositions - c.positions.size;
    const legs: Leg[] = [];
    const planOf = new Map<string, OrderPlan>();
    const tierByLeg = new Map<string, Tier>();
    for (const m of [...matched].sort((a, b) => cmp(a.signalId, b.signalId))) {
      const signalFacts = env.facts.get(m.candidate.code);
      const excluded = new Set<string>([m.candidate.code, ...qualifying, ...eventToday]);
      const base = controlPool({
        code: m.candidate.code,
        tier: m.candidate.tier,
        vol20,
        tierOf,
        excluded,
        passes: (code) => {
          const f = env.facts.get(code);
          if (f === undefined || f.halted || !f.ind.atrWarm || f.ind.atrMicro === null)
            return false;
          return f.tier === "U1" || applyArn011(f, evalCtx).failed.length === 0;
        },
      });
      if (base.length === 0 || signalFacts === undefined) continue;
      const code = base[Number(prng.below(BigInt(base.length)))]!;
      if (c.positions.has(code)) continue;
      if (slotsLeft < 1 || legs.length >= slotsLeft) continue;
      const controlFacts = env.facts.get(code)!;
      const plan = controlPlan({ family, matched: m.candidate, signalFacts, controlFacts });
      if ("skip" in plan) continue;
      const made = legFor(env, controlFacts, m.halfSize, code);
      if (made === null) continue;
      legs.push(made.leg);
      tierByLeg.set(code, controlFacts.tier);
      planOf.set(code, {
        ...plan,
        caThrough: env.d,
        caApplied: made.ids,
        plan: scalePlanPrices(plan.plan, made.priceFactor),
        rel: plan.rel.map((r) => ({ ...r, atrMicro: scaleMicro(r.atrMicro, made.priceFactor) })),
      });
    }
    const results = planLegs(
      sizingOf(c, env),
      markSleeve(legs, sleeveReserve(c)),
      Math.max(0, slotsLeft),
    );
    placeOrders(c, env, results, (leg) => ({
      plan: planOf.get(leg.key)!,
      maxOpen: null,
      tier: tierByLeg.get(leg.key)!,
    }));
  };

  const c1Entry = (c: Cohort, env: DayEnv): void => {
    if (env.nextD === null || c.positions.size > 0 || c.orders.length > 0 || c.entries > 0) return;
    const facts = env.facts.get(c1Code);
    if (facts === undefined) return;
    const made = legFor(env, facts, false, c1Code);
    if (made === null) return;
    const results = planLegs(sizingOf(c, env), [made.leg], 1);
    placeOrders(c, env, results, () => ({
      plan: {
        family: "F1",
        variant: "C1",
        ruleVersion: c.execution.rule_version,
        caThrough: env.d,
        caApplied: made.ids,
        plan: { initialStops: [], trails: [], cs: [] },
        rel: [],
      },
      maxOpen: null,
      tier: facts.tier,
    }));
  };

  // ---- the day loop ------------------------------------------------------------------------------------------------------
  const ended = (): number => cohorts.length - live.length;
  for (let i = firstStart; i <= endIdx; i += 1) {
    const d = sessions[i]!;
    const inputs = src.familyInputs(d);
    if (inputs.d !== d || inputs.sessions[inputs.sessions.length - 1] !== d) {
      throw new RangeError(`family inputs for ${d} must end at ${d}`);
    }
    const out = runFamilies(inputs, params, opts.familyOptions);
    const facts = new Map<string, CodeFacts>();
    for (const f of inputs.codes) facts.set(f.code, f);
    const barMemo = new Map<string, ViewBar | null>();
    const bar = (code: string): ViewBar | null => {
      let b = barMemo.get(code);
      if (b === undefined) {
        b = src.bar(code, d);
        barMemo.set(code, b);
      }
      return b;
    };
    const pfMemo = new Map<string, PositionFacts | null>();
    const haltMemo = new Map<string, boolean>();
    const halted = (code: string): boolean => {
      let h = haltMemo.get(code);
      if (h === undefined) {
        const f = facts.get(code);
        const row =
          src.halted !== undefined ? src.halted(code, d) : f === undefined ? null : f.halted;
        if (row === false) lastTrading.set(code, i); // a trading session: the next halt starts after it
        h = row === true;
        haltMemo.set(code, h);
      }
      return h;
    };
    const env: DayEnv = {
      i,
      d,
      nextD: i < endIdx ? (sessions[i + 1] ?? null) : null,
      inputs,
      out,
      facts,
      bar,
      halted,
      positionFacts: (code) => {
        let p = pfMemo.get(code);
        if (p === undefined) {
          p = src.positionFacts(code, d);
          pfMemo.set(code, p);
        }
        return p;
      },
      advPrev,
      prevClose,
    };
    // actions of every code that can matter are loaded lazily through `actionsOf`; touch the
    // universe so `allActions()` knows its codes before the first order is sized
    for (const f of inputs.codes) actionsOf(f.code);
    // today's ADV marks the books (the fills read yesterday's, `advPrev`)
    const advNow = new Map<string, bigint>();
    const closeNow = new Map<string, bigint>();
    for (const f of inputs.codes) {
      advNow.set(f.code, f.ind.adv === null ? 0n : floorRat(f.ind.adv));
    }
    for (const [code, adv] of advNow) advMemory.set(code, adv);

    if (i >= firstStart && (i - firstStart) % step === 0 && i < endIdx) startGroup(i);

    // 2a: all fills use yesterday's ADV (advPrev) and today's bar
    for (const c of live) {
      if (c.startIdx > i) continue;
      close2a(c, env);
    }
    // a held code without a bar tomorrow is marked at today's close
    for (const f of inputs.codes) {
      const b = bar(f.code);
      if (b !== null) closeNow.set(f.code, b.close);
    }
    for (const [code, close] of closeNow) closeMemory.set(code, close);

    // 2b
    if (env.nextD !== null) {
      const liveNow = live.filter((c) => !c.done);
      const matched = new Map<Family, Taken[]>();
      for (const c of liveNow) exitsStage(c, env);
      if (opts.cortex !== undefined) {
        cortexNight = opts.cortex.night(d, cortexBooks(liveNow, env));
        opts.cortex.sink?.(d, cortexNight);
      }
      for (const c of liveNow) {
        if (c.execution.kind === "C1") {
          if (c1Active) c1Entry(c, env);
          continue;
        }
        if (c.execution.kind !== "E" || c.execution.family === null) continue;
        const family = c.execution.family as Family;
        const taken = entriesFor(c, env, family);
        const list = matched.get(family) ?? [];
        for (const t of taken) if (!list.some((x) => x.signalId === t.signalId)) list.push(t);
        matched.set(family, list);
      }
      const evalCtx = createContext(inputs, params, {});
      for (const c of liveNow) {
        const kind = c.execution.kind;
        if ((kind !== "C2" && kind !== "C3") || c.execution.family === null) continue;
        const family = c.execution.family as Family;
        const list = matched.get(family) ?? [];
        if (list.length === 0) continue;
        const qualifying = new Set<string>([
          ...out.candidates.filter((x) => x.family === family).map((x) => x.code),
          ...out.blocked.filter((x) => x.family === family).map((x) => x.code),
        ]);
        controlsFor(c, env, family, list, qualifying, evalCtx);
      }
    }
    // signals of today are known now (the next close's verdict sees them)
    for (const c of live) {
      if (c.startIdx > i || c.history.length === 0) continue;
      const day = c.history[c.history.length - 1]!;
      if (day.d === d) {
        day.signals = c.todaySignals;
        day.parcelOnlyRejections = c.todayParcel;
        if (c.todaySignals > 0) c.lastSignalIdx = i;
      }
    }
    // a resolved cohort stays until it is wound down (and its real sleeve trade, if any, is closed)
    const stillLive = live.filter(
      (c) =>
        !c.done ||
        c.liquidatedIdx < 0 ||
        c.sleeveTrades.some((t) => !t.shadow && t.closed === null),
    );
    if (stillLive.length < live.length) {
      const keep = new Set(stillLive);
      for (const c of live) if (!keep.has(c)) retire(c);
    }
    live = stillLive;
    advPrev = advNow;
    prevClose = closeNow;
    opts.progress?.({
      stage: "sessions",
      session: i - firstStart + 1,
      total: endIdx - firstStart + 1,
      d,
      cohortsStarted: cohorts.length,
      cohortsActive: live.length,
      cohortsEnded: ended(),
    });
  }

  // ---- outcomes --------------------------------------------------------------------------------------------------------------
  const outcomes: CohortOutcome[] = cohorts
    .map((c): CohortOutcome => {
      const v = c.verdict;
      const lev = c.cfg === null ? null : Number(c.cfg.leverage);
      const sleeve = c.sleeveSummary !== undefined ? c.sleeveSummary : sleeveSummaryOf(c);
      return {
        id: c.id,
        executionId: c.execution.id,
        kind: c.execution.kind,
        family: c.execution.family,
        variant: c.execution.variant,
        controlIdx: c.controlIdx,
        group: c.group,
        leverage: lev,
        startD: c.startD,
        startIdx: c.startIdx,
        endD: sessions[c.endIdx]!,
        sessions: c.endIdx - c.startIdx + 1,
        terminalKind: v === null ? null : v.kind,
        terminalRule: v === null ? null : v.rule,
        censored: v === null,
        seedMicro: c.params.seedMicro,
        outcomeMicro: c.liquidatedIdx >= 0 ? c.realisedMicro : c.done ? c.termLiq : c.lastLiq,
        navMicro: c.done ? c.termNav : c.lastNav,
        terminalLiqNavMicro: c.done ? c.termLiq : c.lastLiq,
        liquidatedD: c.liquidatedIdx >= 0 ? sessions[c.liquidatedIdx]! : null,
        legacyValueMicro: c.legacyMicro,
        entries: c.entries,
        exitsIs: c.exitsIs,
        exitsCs: c.exitsCs,
        sleeve,
        checkpoints: c.checkpoints,
      };
    })
    .sort((a, b) => cmp(a.startD, b.startD) || cmp(a.id, b.id));
  return {
    market: "AU",
    from: sessions[firstStart]!,
    to: sessions[endIdx]!,
    sessions: sessions.length,
    step,
    starts: startsSeen,
    cohorts: outcomes,
    skippedC1: !c1Active,
    qualityGate: gateSource === undefined ? "assumed_all_pass" : "supplied",
  };
}

/** Calendar rows of a session list: every weekday between its first and last session that is not one is a holiday. */
function calendarOf(sessions: readonly string[]): CalendarRow[] {
  const have = new Set(sessions);
  const rows: CalendarRow[] = [];
  const first = sessions[0];
  const last = sessions[sessions.length - 1];
  if (first === undefined || last === undefined) return rows;
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (!isWeekend(d) && !have.has(d)) rows.push({ d, kind: "holiday", close_time: null });
  }
  return rows;
}
