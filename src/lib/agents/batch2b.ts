// Batch 2b "signals and orders" (M4 T8; docs/M4_design.md 4.1-4.4, 4.12; ARN-060, ARN-020, FAM-001,
// FAM-002, ARN-004; decisions 7, 17, 18, 19, 33; D-077). HIGH-RISK: this is where the family rules
// meet the money modules.
//
// ONE run decides ONE session D for every live cohort and writes ONE run_record keyed
// `arena-2b:<market>:<D>`. Order of work (every step is idempotent on deterministic ids, a killed
// run resumes, a re-run writes nothing new and a stored row that differs RAISES):
//   0. preconditions - market mode (`full`, or `data_only` only as a REPLAY against a non-production
//      database), D is a trading session, batch 2a of D succeeded (never sized on a stale ledger).
//      Anything else records a `skipped` run and touches no table.
//   1. A4 -> A3 -> A2 through the DecisionView (inputs bounded by D and cut-off(D)); the regime,
//      event and insider/flow rows are recorded.
//   2. `runFamilies` once per active rule version (M6 T8: the live set, then every other version); every candidate becomes a `signal` row.
//   3. exits first, per cohort with open trades: CS rules -> `exit_cs` orders for D+1, trailing IS
//      levels -> append-only `stop_level` rows (active from the next session).
//   4. entries, per live E cohort (cohort id ascending): re-entry block, quality gate at creation,
//      FAM-001 sizing through the M3 sizing engine on post-event terms, `arena_order` rows with the
//      order plan (`stop_spec`), the F3 gap cap (`max_open_micro`) and the signal link.
//   5. controls: each live C2-f / C3-f cohort draws one control per matched E entry (seeded).
// Money is bigint micro-AUD, rates are exact rationals; libsql must be opened with intMode "bigint".
// No clock is read for engine rows (`decided_at` = cut-off(D)); the injected `now` stamps only
// run_record / app_log.
import type { Client } from "@libsql/client";
import {
  isTradingDay,
  nextTradingDay,
  type CalendarRow,
  type MarketHours,
} from "@/lib/data/calendar";
import { entriesAllowed, type EntryDecision } from "@/lib/data/quality/gate";
import { hasSuccess, finishRun, startRun } from "@/lib/runs/runRecord";
import {
  ARENA_MASTER_SEED,
  closeBooksKey,
  loadCalendar,
  loadSleeveConfig,
} from "@/lib/arena/closeBooks";
import { COST_PROFILES, feeFor } from "@/lib/arena/costs";
import { lockStatus, sleeveEligibility, sleeveMarginMicro } from "@/lib/arena/sleeve";
import { loadSleeveStates, loadSleeveTrades } from "@/lib/arena/sleeveWriter";
import {
  canonicalJson,
  carriesSleeve,
  createPrng,
  deriveRngSeed,
  parseCohortParams,
  type CohortParams,
} from "@/lib/arena/cohort";
import { ensureCohorts } from "@/lib/arena/cohortStart";
import { loadExecutions, loadUnresolvedCohorts, type StoredCohort } from "@/lib/arena/cohortWriter";
import { loadConfirmedActions, loadQtyAdjustments } from "@/lib/arena/corpActionWriter";
import { knownBy, type CorpActionRecord } from "@/lib/arena/corpActions";
import { loadIngestBound } from "@/lib/sentinel/cutoffPoll";
import { decisionCutoffUtc } from "./decisionView";
import {
  availableCash,
  balancesFromRows,
  pendingSettlements,
  type LedgerFill,
  type QtyAdjustment,
} from "@/lib/arena/ledger";
import { loadLedgerFills, loadLedgerRows, toBig } from "@/lib/arena/ledgerWriter";
import { derivePositions } from "@/lib/arena/nav";
import type { ExecutionRow } from "@/lib/arena/schema";
import type { LlmRouter } from "@/lib/llm/router";
import { type Rational } from "@/lib/money/rational";
import {
  AGENT_VERSION,
  REGIME_VERSION,
  SIGNAL_SCHEMA_VERSION,
  evaluateOpen,
  loadDayInputs,
  planLegs,
  positionState,
  rankedCandidates,
  rejectReasonText,
  sizingEnvFor,
  type DayInputs,
  type Leg,
  type LegResult,
  type OpenTrade,
  type SizingContext,
} from "./candidates";
import { loadCostGateTable, type CostGateTable } from "./costGate";
import { firstLegRetryCode, selectEntries } from "./entryGates";
import {
  cardIdOf,
  CardError,
  cardNote,
  checkCard,
  finishCard,
  loadScenarioInput,
  putCard,
  putCardNote,
  type BuiltCard,
  type CardNote,
  type ScenarioInput,
} from "./cards";
import {
  controlPlan,
  controlPool,
  controlReason,
  controlStates,
  effectiveControl,
  type ControlState,
  type ControlStates,
} from "./controls";
import { applyArn011 } from "./families/arn011";
import { createContext } from "./families/context";
import { FAMILY_RULE_VERSION } from "./families";
import { liveParams, loadVersionSet, runVersions, versionIdOf } from "./versionRuns";
import type { Candidate, CodeFacts, Family } from "./families/types";
import {
  crossing,
  exitOrderSpec,
  parsePlan,
  rescaleQty,
  scaleMicro,
  scalePlanPrices,
  serializePlan,
  type OrderPlan,
} from "./orderPlan";
import { createAlertRowSink, type BreakerAlertSink } from "./breakerEval";
import { evaluateSubject, loadBreakerSubjects, writeEvaluation } from "./breakerNightly";
import { loadAgentParams, type AgentParams } from "./params";
import type { Tier } from "./families/types";
import {
  cortexSignalId,
  allowedFamilies,
  cortexStage,
  persistLiveDecisions,
  type LiveLink,
  type StageOptions,
  type StageResult,
} from "@/lib/cortex/stage";
import { familyStatusMap } from "@/lib/cortex/store";
import type { AngleDef } from "@/lib/cortex/angles/types";
import { cellKey, TOP3_BAND_KEY } from "@/lib/stats/cells";

export const SIGNALS_JOB = "arena-signals";
const LOG_MESSAGE_MAX = 500; // threshold-ok: app_log message length cap (as closeBooks logApp)

/** `arena-2b:<market>:<d>`: the concurrency key of batch 2b (cf. `arena-2a:<market>:<d>`). */
export const signalsKey = (market: string, d: string): string => `arena-2b:${market}:${d}`;

export class SignalsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SignalsError";
    this.code = code;
  }
}

export type SignalsOptions = {
  readonly market: string;
  /** The session decided (Sydney trading date). */
  readonly d: string;
  /** An explicit replay against a NON-production database (D-066 / BLD-024). */
  readonly replay?: boolean;
  /** Stamps run_record only; never an engine row. */
  readonly now: () => string;
  readonly commitSha?: string | null;
  readonly masterSeed?: bigint;
  readonly calendar?: CalendarRow[];
  /** Agent parameters (default: the config store, falling back to the registry defaults). */
  readonly params?: AgentParams;
  /** Optional LLM router for the card summaries (D-084); absent = rules-only text, no call. */
  readonly llm?: LlmRouter;
  /** Receives every red thesis-breaker (M5 T7); default: writes the `alert` row when the table exists. */
  readonly breakerSink?: BreakerAlertSink;
  /**
   * D-191: the leverage-sleeve executions (L twins, C3) trade too. Off in every live and replay
   * path (the Owner runs no leverage); the sleeve engine's own tests switch it on.
   */
  readonly withLeverage?: boolean;
  /**
   * The Cortex stage (M15 P2, D-265). On by default: it only writes cortex_* rows while every family
   * is `shadow` (D-280), so v1 is unchanged; `enabled: false` switches it off (the v1 byte-identity
   * test). The rest is test injection.
   */
  readonly cortex?: {
    readonly enabled?: boolean;
    readonly angles?: readonly AngleDef[];
    readonly nowMs?: StageOptions["nowMs"];
    readonly goLiveD?: string | null;
    /** Overrides the cortex_stage_minutes time box (tests). */
    readonly timeoutMs?: number;
    readonly onStage?: (r: StageResult) => void;
  };
};

export type SignalsStatus = "success" | "degraded" | "failed" | "skipped" | "already_done";

export type SignalsStats = {
  signals: number;
  orders: number;
  rejected: number;
  exits: number;
  stopLevels: number;
  /** Regime, event and insider/flow rows recorded (A3/A2). */
  agentRows: number;
  controls: number;
  skips: number;
  cohorts: number;
  /** Decision Cards written (taken and not taken, E cohorts only). */
  cards: number;
  /** Live cohorts held back by arena_control (D-094), and the candidates / draws that became skips. */
  controlPaused: number;
  controlKilled: number;
  controlSkips: number;
  /** Thesis-breaker rows written, positions with a red breaker, and the exits they queued (M5 T7). */
  breakerEvals: number;
  breakerRed: number;
  breakerExits: number;
};

export type SignalsResult = {
  readonly market: string;
  readonly d: string;
  readonly status: SignalsStatus;
  readonly reason: string | null;
  readonly runId: number | null;
  readonly partial: boolean;
  readonly stats: SignalsStats;
};

const text = (v: unknown): string => String(v);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const ratText = (r: Rational): string => `${r.num}/${r.den}`;

export const entryOrderId = (cohortId: string, d: string, code: string): string =>
  `EN:${cohortId}:${d}:${code}`;
export const exitOrderId = (cohortId: string, d: string, code: string): string =>
  `CS:${cohortId}:${d}:${code}`;
export const signalIdOf = (
  market: string,
  c: Pick<Candidate, "d" | "family" | "ruleVersion" | "variant" | "code">,
): string => `sig:${market}:${c.d}:${c.family}:${c.ruleVersion}:${c.variant}:${c.code}`;

function emptyStats(): SignalsStats {
  return {
    signals: 0,
    orders: 0,
    rejected: 0,
    exits: 0,
    stopLevels: 0,
    agentRows: 0,
    controls: 0,
    skips: 0,
    cohorts: 0,
    cards: 0,
    controlPaused: 0,
    controlKilled: 0,
    controlSkips: 0,
    breakerEvals: 0,
    breakerRed: 0,
    breakerExits: 0,
  };
}

// ---- idempotent writers ------------------------------------------------------------------------------------

type Exec = Pick<Client, "execute">;

/** Compares two column values as text (bigint, number and string forms of one integer agree). */
function same(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return String(a) === String(b);
}

/**
 * INSERT ... ON CONFLICT DO NOTHING; when the row already exists every `compare` column must equal
 * the stored one or the run raises (a re-run is exact, never an overwrite). Returns true when a row
 * was written.
 */
async function putRow(
  db: Exec,
  table: string,
  cols: readonly string[],
  keys: readonly string[],
  values: readonly unknown[],
  compare: readonly string[],
): Promise<boolean> {
  const res = await db.execute({
    sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
          ON CONFLICT DO NOTHING`,
    args: values as never,
  });
  if (res.rowsAffected > 0) return true;
  const keyArgs = keys.map((k) => values[cols.indexOf(k)]);
  const stored = await db.execute({
    sql: `SELECT ${compare.join(", ")} FROM ${table} WHERE ${keys.map((k) => `${k} = ?`).join(" AND ")}`,
    args: keyArgs as never,
  });
  if (stored.rows.length === 0) {
    throw new SignalsError("row_conflict", `${table}: a different row holds a unique key`);
  }
  for (const c of compare) {
    if (!same(stored.rows[0]![c], values[cols.indexOf(c)])) {
      throw new SignalsError("row_conflict", `${table}: stored row differs in ${c}`);
    }
  }
  return false;
}

async function withTx<T>(db: Client, fn: (tx: Exec) => Promise<T>): Promise<T> {
  const tx = await db.transaction("write");
  try {
    const out = await fn(tx);
    await tx.commit();
    return out;
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}

// ---- orders ---------------------------------------------------------------------------------------------------------

type NewOrder = {
  readonly id: string;
  readonly cohortId: string;
  readonly decidedD: string;
  readonly code: string;
  readonly side: "buy" | "sell";
  readonly kind: "entry" | "exit_cs";
  readonly qty: bigint;
  readonly status: "pending" | "rejected";
  readonly rejectReason: string | null;
  readonly tier: Tier | null;
  readonly untradeable: boolean;
  readonly signalId: string | null;
  /** Decision Card of the signal (entries and controls) or of the entry (exits); decision 20. */
  readonly cardId: string | null;
  readonly maxOpenMicro: bigint | null;
  readonly stopSpec: string | null;
  /** Cortex orders only (D-288, migration 0019): the entry fills at or below this price. */
  readonly limitMicro?: bigint | null;
};

const ORDER_COLS = [
  "id",
  "cohort_id",
  "decided_d",
  "code",
  "side",
  "kind",
  "qty",
  "status",
  "reject_reason",
  "tier",
  "untradeable_flag",
  "signal_id",
  "card_id",
  "max_open_micro",
  "stop_spec",
  "limit_micro",
] as const;

async function putOrder(db: Exec, o: NewOrder): Promise<boolean> {
  const values = [
    o.id,
    o.cohortId,
    o.decidedD,
    o.code,
    o.side,
    o.kind,
    o.qty,
    o.status,
    o.rejectReason,
    o.tier,
    o.untradeable ? 1 : 0,
    o.signalId,
    o.cardId,
    o.maxOpenMicro,
    o.stopSpec,
    o.limitMicro ?? null,
  ];
  // an already-decided order may have moved on (filled/cancelled) only on a later session, never on D
  return putRow(db, "arena_order", ORDER_COLS, ["id"], values, ORDER_COLS);
}

// ---- recorded agent rows ----------------------------------------------------------------------------------

const EVENT_COLS = [
  "market",
  "source",
  "ann_id",
  "code",
  "published_at",
  "timed",
  "day0_d",
  "group_key",
  "category",
  "price_sensitive",
  "ar_ppm",
  "ar_num",
  "ar_den",
  "vol_ratio_ppm",
  "polarity",
  "rule_version",
] as const;

async function recordAgentRows(db: Client, day: DayInputs, market: string): Promise<number> {
  let written = 0;
  if (day.regime !== null) {
    const r = day.regime.result;
    const cols = [
      "market",
      "d",
      "version",
      "close_micro",
      "sma200_micro",
      "vol20",
      "vol_pct",
      "fall5_ppm",
      "raw_state",
      "state",
      "exit_streak",
    ];
    if (
      await putRow(
        db,
        "regime_daily",
        cols,
        ["market", "d", "version"],
        [
          market,
          day.d,
          REGIME_VERSION,
          r.close_micro,
          r.sma_micro,
          r.vol20,
          r.vol_pct,
          r.fall5_ppm,
          r.raw_state,
          r.state,
          r.exit_streak,
        ],
        cols,
      )
    ) {
      written += 1;
    }
  }
  for (const e of day.newEvents) {
    const values = EVENT_COLS.map((c) => (e as unknown as Record<string, unknown>)[c]);
    if (await putRow(db, "event", EVENT_COLS, ["market", "source", "ann_id"], values, EVENT_COLS)) {
      written += 1;
    }
  }
  for (const s of day.scores) {
    const cols = ["market", "code", "d", "score_q", "inputs_json"];
    if (
      await putRow(
        db,
        "insider_flow_score",
        cols,
        ["market", "code", "d"],
        [s.market, s.code, s.d, s.score_q, s.inputs_json],
        cols,
      )
    ) {
      written += 1;
    }
  }
  return written;
}

const SIGNAL_COLS = [
  "id",
  "market",
  "d",
  "family",
  "rule_version",
  "variant",
  "code",
  "regime",
  "rank_score",
  "rules_json",
  "evidence_json",
  "classes",
  "group_key",
  "partial",
  "schema_version",
  "agent_version",
  "inputs_ref",
  "decided_at",
] as const;

function signalValues(market: string, c: Candidate, day: DayInputs): unknown[] {
  const facts = day.facts.get(c.code);
  const evidence = canonicalJson({
    adv: c.adv === null ? null : ratText(c.adv),
    atr_micro:
      facts?.ind.atrMicro === null || facts === undefined ? null : String(facts.ind.atrMicro),
    close_micro: facts === undefined ? null : String(facts.bar.close),
    contributors: [...c.contributors].sort(),
    flags: [...c.flags],
    half_size: c.halfSize,
    max_open_micro: c.maxOpenMicro === null ? null : String(c.maxOpenMicro),
    partial_reasons: [...day.partialReasons],
    tier: c.tier,
  });
  const rules = canonicalJson(
    c.rules.map((r) => ({ rule: r.id, value: r.value, threshold: r.threshold, pass: r.pass })),
  );
  return [
    signalIdOf(market, c),
    market,
    c.d,
    c.family,
    c.ruleVersion,
    c.variant,
    c.code,
    c.regime,
    c.rankText,
    rules,
    evidence,
    c.classes === null ? null : canonicalJson([...c.classes]),
    c.groupKey,
    day.partial ? 1 : 0,
    SIGNAL_SCHEMA_VERSION,
    AGENT_VERSION,
    day.inputsRef,
    day.cutoff,
  ];
}

// ---- per-cohort books -----------------------------------------------------------------------------------------

type CohortBooks = {
  readonly cohort: StoredCohort;
  readonly params: CohortParams;
  readonly positions: ReadonlyMap<string, bigint>;
  readonly fills: readonly LedgerFill[];
  readonly adjustments: readonly QtyAdjustment[];
  readonly cashMicro: bigint;
  readonly navMicro: bigint;
  /** Margin + entry brokerage a free leverage sleeve would take (ARN-003); 0 when none can open. */
  readonly sleeveReserveMicro: bigint;
};

/** The leg that would carry the sleeve: the first one the sleeve rules allow (ARN-040/044). */
function markSleeve(legs: readonly Leg[], books: CohortBooks): Leg[] {
  let given = books.sleeveReserveMicro <= 0n;
  return legs.map((l) => {
    if (given || !sleeveEligibility({ tier: l.env.tier }).eligible) return l;
    given = true;
    return { ...l, sleeve: true };
  });
}

/** The cohort as 2a left it at the close of D; null when it has no sound NAV for D (frozen, new). */
async function booksOf(
  db: Client,
  cohort: StoredCohort,
  calendar: readonly CalendarRow[],
  d: string,
): Promise<CohortBooks | null> {
  const nav = await db.execute({
    sql: "SELECT nav_micro, invariants_ok FROM nav_daily WHERE cohort_id = ? AND d = ?",
    args: [cohort.id, d],
  });
  if (nav.rows.length === 0 || toBig(nav.rows[0]!.invariants_ok) !== 1n) return null;
  const params = parseCohortParams(cohort.paramsJson);
  const [fills, adjustments, rows] = await Promise.all([
    loadLedgerFills(db, cohort.id),
    loadQtyAdjustments(db, cohort.id),
    loadLedgerRows(db, cohort.id),
  ]);
  const settled = new Set(
    rows.filter((r) => r.kind === "settle" && r.refType === "fill").map((r) => text(r.refId)),
  );
  const cashMicro = availableCash({
    mode: params.settlementMode,
    balances: balancesFromRows(rows, d),
    pending: pendingSettlements(fills, settled, calendar),
    sessionD: d,
  });
  const navMicro = toBig(nav.rows[0]!.nav_micro);
  let sleeveReserveMicro = 0n;
  const cfg = await loadSleeveConfig(db, cohort.id);
  if (cfg !== null) {
    const [trades, states] = await Promise.all([
      loadSleeveTrades(db, cohort.id),
      loadSleeveStates(db, cohort.id),
    ]);
    const margin = sleeveMarginMicro(navMicro, cfg);
    if (
      margin > 0n &&
      !lockStatus(states).locked &&
      !trades.some((t) => !t.shadow && t.closed === null)
    ) {
      sleeveReserveMicro = margin + feeFor(cfg.profile, margin * cfg.leverage, "buy");
    }
  }
  return {
    cohort,
    params,
    positions: derivePositions(fills, adjustments, d).positions,
    fills,
    adjustments,
    cashMicro,
    navMicro,
    sleeveReserveMicro,
  };
}

// ---- the day ------------------------------------------------------------------------------------------------------

type Ctx = {
  readonly db: Client;
  readonly market: string;
  readonly d: string;
  readonly nextD: string;
  readonly calendar: readonly CalendarRow[];
  readonly params: AgentParams;
  readonly day: DayInputs;
  /** Confirmed actions with ex-date <= D+1 (post-event terms for the fill session). */
  readonly actionsNext: readonly CorpActionRecord[];
  readonly masterSeed: bigint;
  readonly stats: SignalsStats;
  readonly gates: Map<string, EntryDecision>;
  readonly llm: LlmRouter | undefined;
  /** Scenario inputs per family|rule version|variant (one ledger read each per night). */
  readonly scenarios: Map<string, ScenarioInput>;
  /** FAM-005 development-split medians (D-214); loaded once per run. */
  readonly costTable: CostGateTable;
  /** arena_control as of the start of the run (D-094). */
  readonly control: ControlStates;
  /** Matched-setup cells of tonight's Cortex stage (gap95 on the Cortex signal evidence). */
  readonly cortexCells?: ReadonlyMap<string, { readonly gap95: number }>;
};

async function loadControl(db: Client): Promise<ControlStates> {
  const rs = await db.execute("SELECT scope, scope_key, state FROM arena_control ORDER BY id");
  return controlStates(
    rs.rows.map((r) => ({
      scope: text(r.scope),
      scopeKey: text(r.scope_key),
      state: text(r.state),
    })),
  );
}

/** The not-taken reason of a cohort held back by arena_control (entries and sleeves stop, exits never do). */
function heldReason(ctx: Ctx, exec: ExecutionRow): string | null {
  const s: ControlState = effectiveControl(ctx.control, {
    market: ctx.market,
    family: exec.family,
    execution: exec.id,
  });
  if (s === "paused") ctx.stats.controlPaused += 1;
  if (s === "killed") ctx.stats.controlKilled += 1;
  return controlReason(s);
}

async function gateOf(ctx: Ctx, code: string): Promise<EntryDecision> {
  const hit = ctx.gates.get(code);
  if (hit !== undefined) return hit;
  // a global refusal (no score, U1 gate failed) is the same for every code: ask once
  for (const known of ctx.gates.values()) {
    if (
      !known.allowed &&
      (known.reason === "no_quality_score" || known.reason === "u1_gate_failed")
    ) {
      ctx.gates.set(code, known);
      return known;
    }
  }
  const decision = await entriesAllowed(ctx.db, code, ctx.d, ctx.market);
  ctx.gates.set(code, decision);
  return decision;
}

async function loadOpenTrades(db: Client): Promise<OpenTrade[]> {
  const rs = await db.execute(
    `SELECT t.id, t.cohort_id, t.code, f.d AS fill_d, f.fill_price_micro, o.stop_spec, o.card_id
     FROM trade t
     JOIN cohort c ON c.id = t.cohort_id
     JOIN fill f ON f.id = t.entry_fill_id
     JOIN arena_order o ON o.id = f.order_id
     WHERE t.exit_type IS NULL AND c.terminal_kind IS NULL
     ORDER BY t.cohort_id, t.id`,
  );
  return rs.rows.map((r) => ({
    tradeId: text(r.id),
    cohortId: text(r.cohort_id),
    code: text(r.code),
    fillD: text(r.fill_d),
    fillMicro: toBig(r.fill_price_micro),
    stopSpec: r.stop_spec === null ? null : text(r.stop_spec),
    cardId: r.card_id === null ? null : text(r.card_id),
  }));
}

/** Step 3: CS exits for D+1 and the IS levels for stop_level, per cohort with open trades. */
async function exitsStage(ctx: Ctx, cohorts: ReadonlyMap<string, StoredCohort>): Promise<void> {
  const { db, d, nextD } = ctx;
  const trades = await loadOpenTrades(db);
  const byCohort = new Map<string, OpenTrade[]>();
  for (const t of trades) {
    const list = byCohort.get(t.cohortId) ?? [];
    list.push(t);
    byCohort.set(t.cohortId, list);
  }
  for (const [cohortId, list] of [...byCohort].sort((a, b) => cmp(a[0], b[0]))) {
    const cohort = cohorts.get(cohortId);
    if (cohort === undefined) continue;
    const [fills, adjustments] = await Promise.all([
      loadLedgerFills(db, cohortId),
      loadQtyAdjustments(db, cohortId),
    ]);
    const held = derivePositions(fills, adjustments, d).positions;
    const plans = new Map<string, OrderPlan>();
    const states = [];
    for (const t of list) {
      if (t.stopSpec === null || !held.has(t.code)) continue;
      let plan: OrderPlan;
      try {
        plan = parsePlan(t.stopSpec);
      } catch {
        continue; // an M3 order carries no plan: nothing to evaluate
      }
      const state = positionState(t, plan, ctx.day, ctx.actionsNext, ctx.calendar, ctx.params);
      if (state === null) continue;
      plans.set(t.tradeId, plan);
      states.push(state);
    }
    if (states.length === 0) continue;
    const evals = evaluateOpen(states);
    await withTx(db, async (tx) => {
      for (const ev of evals) {
        for (const lvl of ev.isLevels) {
          if (lvl.levelMicro < 1n) continue;
          const wrote = await putRow(
            tx,
            "stop_level",
            ["trade_id", "d", "rule", "cohort_id", "level_micro"],
            ["trade_id", "d", "rule"],
            [ev.tradeId, d, lvl.rule, cohortId, lvl.levelMicro],
            ["cohort_id", "level_micro"],
          );
          if (wrote) ctx.stats.stopLevels += 1;
        }
        if (ev.cs === null) continue;
        const pending = await tx.execute({
          sql: `SELECT 1 FROM arena_order WHERE cohort_id = ? AND code = ? AND status = 'pending'
                AND kind = 'exit_cs' AND decided_d < ?`,
          args: [cohortId, ev.code, d],
        });
        if (pending.rows.length > 0) continue; // an earlier exit is still waiting (halt)
        const cross = crossing(ctx.actionsNext, ev.code, d, nextD);
        const qty = rescaleQty(held.get(ev.code) ?? 0n, cross);
        if (cross.disposal || qty < 1n) continue;
        const order: NewOrder = {
          id: exitOrderId(cohortId, d, ev.code),
          cohortId,
          decidedD: d,
          code: ev.code,
          side: "sell",
          kind: "exit_cs",
          qty,
          status: "pending",
          rejectReason: null,
          tier: null,
          untradeable: false,
          signalId: null,
          cardId: list.find((t) => t.code === ev.code)?.cardId ?? null,
          maxOpenMicro: null,
          stopSpec: exitOrderSpec(d, cross.ids, ev.cs.rule, ev.cs.via),
        };
        if (await putOrder(tx, order)) ctx.stats.exits += 1;
      }
    });
  }
}

/**
 * Step 3b (M5 T7, AGT-111, D-096 #39): thesis-breakers of the open E positions and pending E entries.
 * Every breaker is logged (`thesis_breaker_eval`, phase nightly); a red breaker on a HELD position
 * queues one `exit_cs` for D+1 with rule = the breaker id (`TB-<id>`), unless an exit is already
 * waiting. Exits are never blocked by arena_control (D-094) or by the quality gate. A red on a pending
 * buy only logs and alerts here: the pre-open re-check cancels it (ARN-020a).
 */
async function breakersStage(ctx: Ctx, sink: BreakerAlertSink, now: string): Promise<void> {
  const { db, d, nextD } = ctx;
  const subjects = await loadBreakerSubjects(db, d);
  const held = new Map<string, ReadonlyMap<string, bigint>>();
  for (const s of subjects) {
    const ev = await evaluateSubject(
      { db, market: ctx.market, d, calendar: ctx.calendar, params: ctx.params, day: ctx.day },
      s,
    );
    ctx.stats.breakerEvals += await withTx(db, (tx) =>
      writeEvaluation(tx, s, ctx.market, d, "nightly", 1, ev),
    );
    if (ev.red.length === 0) continue;
    ctx.stats.breakerRed += 1;
    let queued = false;
    const rule = ev.red[0]!;
    if (s.kind === "trade") {
      let positions = held.get(s.cohortId);
      if (positions === undefined) {
        const [fills, adjustments] = await Promise.all([
          loadLedgerFills(db, s.cohortId),
          loadQtyAdjustments(db, s.cohortId),
        ]);
        positions = derivePositions(fills, adjustments, d).positions;
        held.set(s.cohortId, positions);
      }
      const cross = crossing(ctx.actionsNext, s.code, d, nextD);
      const qty = rescaleQty(positions.get(s.code) ?? 0n, cross);
      queued = await withTx(db, async (tx) => {
        const waiting = await tx.execute({
          sql: `SELECT 1 FROM arena_order WHERE cohort_id = ? AND code = ? AND status = 'pending'
                AND kind = 'exit_cs' AND decided_d <= ?`,
          args: [s.cohortId, s.code, d],
        });
        if (waiting.rows.length > 0 || cross.disposal || qty < 1n) return false;
        return putOrder(tx, {
          id: exitOrderId(s.cohortId, d, s.code),
          cohortId: s.cohortId,
          decidedD: d,
          code: s.code,
          side: "sell",
          kind: "exit_cs",
          qty,
          status: "pending",
          rejectReason: null,
          tier: null,
          untradeable: false,
          signalId: null,
          cardId: s.cardId,
          maxOpenMicro: null,
          stopSpec: exitOrderSpec(d, cross.ids, rule, null),
        });
      });
      if (queued) {
        ctx.stats.breakerExits += 1;
        ctx.stats.exits += 1;
      }
    }
    for (const e of ev.evaluations.filter((x) => x.status === "red")) {
      await sink.record({
        key: `tb:${s.id}:${e.id}:${d}`,
        market: ctx.market,
        code: s.code,
        d,
        phase: "nightly",
        subjectKind: s.kind,
        subjectId: s.id,
        cardId: s.cardId,
        executionId: s.executionId,
        breakerId: e.id,
        status: "red",
        valueText: e.valueText,
        triggerText: e.triggerText,
        triggerRef: e.triggerRef,
        effect: queued ? "exit_queued" : "none",
        detectedAt: now,
      });
    }
  }
}

/** Codes an IS exit of this execution (any cohort) keeps out for `reentry_block` sessions (FAM-002). */
async function reentryBlocked(ctx: Ctx, executionId: string): Promise<Set<string>> {
  const sessions = ctx.day.inputs.sessions;
  const blockFrom = sessions[Math.max(0, sessions.length - 1 - ctx.params.reentryBlock)] ?? ctx.d; // money-float-ok: slot count, not money
  const rs = await ctx.db.execute({
    sql: `SELECT DISTINCT t.code FROM trade t
          JOIN cohort c ON c.id = t.cohort_id
          JOIN fill f ON f.id = t.exit_fill_id
          WHERE c.execution_id = ? AND t.exit_type = 'IS' AND f.d >= ? AND f.d <= ?`,
    args: [executionId, blockFrom, ctx.d],
  });
  return new Set(rs.rows.map((r) => text(r.code)));
}

type Taken = {
  readonly candidate: Candidate;
  readonly signalId: string;
  readonly halfSize: boolean;
  /** The E execution's Decision Card of the signal: controls link to it (decision 20). */
  readonly cardId: string;
};

function legFor(ctx: Ctx, facts: CodeFacts, halfSize: boolean, key: string): Leg | null {
  const cross = crossing(ctx.actionsNext, facts.code, ctx.d, ctx.nextD);
  if (cross.disposal) return null;
  return { key, halfSize, sleeve: false, env: sizingEnvFor({ facts, cross, p: ctx.params }) };
}

function entryPlan(ctx: Ctx, c: Candidate): { plan: OrderPlan; maxOpen: bigint | null } {
  const cross = crossing(ctx.actionsNext, c.code, ctx.d, ctx.nextD);
  return {
    plan: {
      family: c.family,
      variant: c.variant,
      ruleVersion: c.ruleVersion,
      caThrough: ctx.d,
      caApplied: cross.ids,
      plan: scalePlanPrices(c.plan, cross.priceFactor),
      rel: [],
    },
    maxOpen: c.maxOpenMicro === null ? null : scaleMicro(c.maxOpenMicro, cross.priceFactor),
  };
}

/** Writes the rejected/pending orders of the sized legs; returns the accepted ones. */
async function writeLegs(
  ctx: Ctx,
  tx: Exec,
  books: CohortBooks,
  results: readonly LegResult[],
  describe: (leg: Leg) => {
    code: string;
    tier: Tier;
    signalId: string;
    cardId: string | null;
    plan: OrderPlan;
    maxOpen: bigint | null;
  },
): Promise<{ accepted: string[]; rejected: Map<string, string> }> {
  const accepted: string[] = [];
  const rejected = new Map<string, string>();
  for (const r of results) {
    const info = describe(r.leg);
    const base = {
      id: entryOrderId(books.cohort.id, ctx.d, info.code),
      cohortId: books.cohort.id,
      decidedD: ctx.d,
      code: info.code,
      side: "buy" as const,
      kind: "entry" as const,
      tier: info.tier,
      signalId: info.signalId,
      cardId: info.cardId,
    };
    if (r.sizing.accepted) {
      const wrote = await putOrder(tx, {
        ...base,
        qty: r.sizing.qty,
        status: "pending",
        rejectReason: null,
        untradeable: r.sizing.untradeable !== null,
        maxOpenMicro: info.maxOpen,
        stopSpec: serializePlan(info.plan),
      });
      if (wrote) ctx.stats.orders += 1;
      accepted.push(r.leg.key);
    } else {
      const reason = rejectReasonText(r.sizing.reasons);
      const wrote = await putOrder(tx, {
        ...base,
        qty: r.sizing.qty,
        status: "rejected",
        rejectReason: reason,
        untradeable: false,
        maxOpenMicro: null,
        stopSpec: null,
      });
      if (wrote) ctx.stats.rejected += 1;
      rejected.set(r.leg.key, reason);
    }
  }
  return { accepted, rejected };
}

// ---- Decision Cards (AGT-110, decision 20) ---------------------------------------------------------------

async function scenarioFor(ctx: Ctx, c: Candidate): Promise<ScenarioInput> {
  const key = `${c.family}|${c.ruleVersion}|${c.variant}`;
  const hit = ctx.scenarios.get(key);
  if (hit !== undefined) return hit;
  const input = await loadScenarioInput(ctx.db, {
    market: ctx.market,
    family: c.family,
    ruleVersion: c.ruleVersion,
    variant: c.variant,
  });
  ctx.scenarios.set(key, input);
  return input;
}

type CardStatus = {
  readonly taken: boolean;
  readonly reason: string | null;
  /** The sizing result when the candidate was sized (accepted or rejected). */
  readonly sized: LegResult | null;
  /** M14 card flags of the entry gates (`cost_gate_unmeasured`, `industry_unknown`, `corr_unknown`). */
  readonly flags?: readonly string[];
};

type PreparedCard = {
  readonly built: BuiltCard;
  readonly note: CardNote;
  readonly orderId: string | null;
};

/** Builds one card and its note (no database write; the router call happens before the transaction). */
async function prepareCard(
  ctx: Ctx,
  books: CohortBooks,
  exec: ExecutionRow,
  c: Candidate,
  signalId: string,
  status: CardStatus,
): Promise<PreparedCard | null> {
  const facts = ctx.day.facts.get(c.code);
  if (facts === undefined) return null;
  const cross = crossing(ctx.actionsNext, c.code, ctx.d, ctx.nextD);
  const sessions = ctx.day.inputs.sessions;
  const from = sessions[Math.max(0, sessions.length - 1 - ctx.params.f2.lookbackSessions)] ?? ctx.d; // money-float-ok: slot count, not money
  const events = (ctx.day.eventsByCode.get(c.code) ?? []).filter(
    (e) => e.day0 >= from || (c.groupKey !== null && e.groupKey === c.groupKey),
  );
  const low =
    c.groupKey === null
      ? null
      : (events.find((e) => e.groupKey === c.groupKey && e.day0LowMicro !== null)?.day0LowMicro ??
        null);
  const z = status.sized;
  const built = finishCard({
    signalId,
    market: ctx.market,
    d: ctx.d,
    executionId: exec.id,
    candidate: status.flags === undefined ? c : { ...c, flags: [...c.flags, ...status.flags] },
    taken: status.taken,
    notTakenReason: status.reason,
    closeMicro: scaleMicro(facts.bar.close, cross.priceFactor),
    plan: entryPlan(ctx, c).plan.plan,
    events,
    insiderScoreQ: facts.insiderScoreQ,
    shortDrop: facts.shortDrop,
    eventLowMicro: low === null ? null : scaleMicro(low, cross.priceFactor),
    sizing:
      z === null
        ? null
        : {
            accepted: z.sizing.accepted,
            reasons: z.sizing.reasons,
            qty: z.sizing.qty,
            fillPriceMicro: z.sizing.fillPriceMicro,
            slipMicro: z.sizing.slipMicro,
            brokerageMicro: z.sizing.brokerageMicro,
            orderValueMicro: z.sizing.orderValueMicro,
            refPriceMicro: z.leg.env.refPriceMicro,
            advValueMicro: z.leg.env.advValueMicro,
          },
    scenario: await scenarioFor(ctx, c),
    params: ctx.params,
    costProfile: COST_PROFILES[books.params.costProfile],
    tickCrossFactor: books.params.tickCrossFactor,
  });
  const errors = checkCard(JSON.parse(built.json), ctx.params);
  if (errors.length > 0) {
    throw new SignalsError("card_invalid", errors.slice(0, 3).join("; ")); // threshold-ok: error text length
  }
  return {
    built,
    note: await cardNote(built.card, ctx.llm),
    orderId: status.taken ? entryOrderId(books.cohort.id, ctx.d, c.code) : null,
  };
}

/** Step 4 for one E cohort: returns the entries it took (for the controls). */
async function entriesFor(
  ctx: Ctx,
  books: CohortBooks,
  exec: ExecutionRow,
  family: Family,
  candidates: readonly Candidate[],
  signalIds: ReadonlyMap<Candidate, string>,
): Promise<Taken[]> {
  const slots = books.params.maxOpenPositions - books.positions.size;
  const ranked = rankedCandidates(candidates.filter((c) => c.family === family));
  if (ranked.length === 0) return [];
  const cardIdFor = (c: Candidate): string => cardIdOf(signalIds.get(c)!, exec.id);
  // every ranked candidate ends with exactly one status (a card each, taken or not)
  const notTaken = new Map<Candidate, string>();
  const open = new Set(books.positions.keys());
  const held = heldReason(ctx, exec);
  const blocked =
    slots < 1 || held !== null ? new Set<string>() : await reentryBlocked(ctx, exec.id);
  const pool: Candidate[] = [];
  for (const c of ranked) {
    if (held !== null) {
      notTaken.set(c, held);
      ctx.stats.controlSkips += 1;
    } else if (slots < 1) notTaken.set(c, "positions_full");
    else if (open.has(c.code)) notTaken.set(c, "holding");
    else if (blocked.has(c.code)) notTaken.set(c, "reentry_block");
    else pool.push(c);
  }
  // codes that cannot open tonight do not count as the first leg of FAM-006
  const noPosition = new Set<string>();
  for (const c of pool) {
    if (
      crossing(ctx.actionsNext, c.code, ctx.d, ctx.nextD).disposal ||
      (await gateOf(ctx, c.code)).reason === "code_blocked"
    ) {
      noPosition.add(c.code);
    }
  }
  // M14 entry gates (cost gate, second position, SHOCK abstain; the same function the replay calls).
  // D-284 (FAM-006): when the first leg is then rejected at sizing, the gates run once more with that
  // code out of the pool, so the same-industry second it blocked and the next candidate get a turn.
  const attempt = async (rejected: ReadonlySet<string>) => {
    const nt = new Map<Candidate, string>();
    const poolA = pool.filter((c) => !rejected.has(c.code));
    const noPositionA = new Set([...noPosition, ...rejected]);
    const selection = selectEntries(poolA, {
      entry: ctx.params.entry,
      advWindow: ctx.params.windows.adv,
      costProfile: COST_PROFILES[books.params.costProfile],
      costTable: ctx.costTable,
      factsOf: (code) => ctx.day.facts.get(code),
      heldCodes: [...open].sort(),
      cashMicro: books.cashMicro,
      noPosition: noPositionA,
    });
    for (const [c, reason] of selection.skipped) nt.set(c, reason);
    const gated = selection.eligible;
    // the quality gate at creation: a global refusal rejects the top-ranked once, a blocked code
    // is rejected and the next candidate takes its place (entries only; exits are never gated)
    const eligible: Candidate[] = [];
    const gateRejects: { c: Candidate; reason: string }[] = [];
    let stoppedAt = gated.length;
    for (const [i, c] of gated.entries()) {
      if (eligible.length >= slots) {
        stoppedAt = i;
        break;
      }
      if (crossing(ctx.actionsNext, c.code, ctx.d, ctx.nextD).disposal) {
        nt.set(c, "corporate_action");
        continue;
      }
      const g = await gateOf(ctx, c.code);
      if (g.allowed) {
        eligible.push(c);
        continue;
      }
      gateRejects.push({ c, reason: g.reason });
      if (g.reason !== "code_blocked") {
        stoppedAt = i + 1;
        break;
      }
    }
    for (const c of gated.slice(stoppedAt)) nt.set(c, "rank");
    const legs: Leg[] = [];
    const byKey = new Map<string, Candidate>();
    for (const c of eligible) {
      const facts = ctx.day.facts.get(c.code);
      if (facts === undefined) {
        nt.set(c, "no_facts");
        continue;
      }
      const leg = legFor(ctx, facts, c.halfSize, c.code);
      if (leg === null) {
        nt.set(c, "corporate_action");
        continue;
      }
      legs.push(leg);
      byKey.set(c.code, c);
    }
    const sizing: SizingContext = {
      params: books.params,
      cashMicro: books.cashMicro,
      navMicro: books.navMicro,
      sleeveReserveMicro: books.sleeveReserveMicro,
    };
    const results = planLegs(sizing, markSleeve(legs, books), slots);
    return { selection, gateRejects, byKey, results, nt };
  };
  let att = await attempt(new Set());
  const rejectedFirst = firstLegRetryCode(att.results);
  if (rejectedFirst !== null) {
    const retry = await attempt(new Set([rejectedFirst]));
    att = {
      ...retry,
      byKey: new Map([[rejectedFirst, att.byKey.get(rejectedFirst)!], ...retry.byKey]),
      results: [att.results[0]!, ...retry.results],
    };
  }
  const { selection, gateRejects, byKey, results } = att;
  for (const [c, reason] of att.nt) notTaken.set(c, reason);
  const sizedOf = new Map(results.map((r) => [r.leg.key, r] as const));
  const status = new Map<Candidate, CardStatus>();
  for (const g of gateRejects) status.set(g.c, { taken: false, reason: "gate", sized: null });
  for (const c of byKey.values()) {
    const r = sizedOf.get(c.code);
    if (r === undefined) {
      notTaken.set(c, "rank");
    } else {
      status.set(
        c,
        r.sizing.accepted
          ? { taken: true, reason: null, sized: r }
          : { taken: false, reason: `rejected:${r.sizing.reasons.join(",")}`, sized: r },
      );
    }
  }
  for (const [c, reason] of notTaken) status.set(c, { taken: false, reason, sized: null });
  for (const [c, flags] of selection.flags) {
    const st = status.get(c);
    if (st !== undefined) status.set(c, { ...st, flags });
  }
  // cards and notes first (the router call must not sit inside the write transaction)
  const prepared = new Map<Candidate, PreparedCard>();
  for (const c of ranked) {
    const p = await prepareCard(ctx, books, exec, c, signalIds.get(c)!, status.get(c)!);
    if (p !== null) prepared.set(c, p);
  }
  const taken: Taken[] = [];
  await withTx(ctx.db, async (tx) => {
    for (const c of ranked) {
      const p = prepared.get(c);
      if (p === undefined) continue;
      const link = { orderId: p.orderId, cohortId: books.cohort.id };
      if (await putCard(tx, p.built, link, signalIds.get(c)!, ctx.day.cutoff)) {
        ctx.stats.cards += 1;
      }
      await putCardNote(tx, p.built.id, p.note);
    }
    for (const g of gateRejects) {
      const wrote = await putOrder(tx, {
        id: entryOrderId(books.cohort.id, ctx.d, g.c.code),
        cohortId: books.cohort.id,
        decidedD: ctx.d,
        code: g.c.code,
        side: "buy",
        kind: "entry",
        qty: 0n,
        status: "rejected",
        rejectReason: "gate",
        tier: g.c.tier,
        untradeable: false,
        signalId: signalIds.get(g.c) ?? null,
        cardId: prepared.has(g.c) ? cardIdFor(g.c) : null,
        maxOpenMicro: null,
        stopSpec: null,
      });
      if (wrote) ctx.stats.rejected += 1;
    }
    const out = await writeLegs(ctx, tx, books, results, (leg) => {
      const c = byKey.get(leg.key)!;
      const plan = entryPlan(ctx, c);
      return {
        code: c.code,
        tier: c.tier,
        signalId: signalIds.get(c)!,
        cardId: prepared.has(c) ? cardIdFor(c) : null,
        plan: plan.plan,
        maxOpen: plan.maxOpen,
      };
    });
    for (const key of out.accepted) {
      const c = byKey.get(key)!;
      taken.push({
        candidate: c,
        signalId: signalIds.get(c)!,
        halfSize: c.halfSize,
        cardId: cardIdFor(c),
      });
    }
  });
  return taken;
}

/**
 * Step 4 for one E cohort whose family is `allowed` (M15 P2, D-266/D-280): the Cortex live-arm
 * decisions replace the v1 pool (no `selectEntries`, D-260). Each decision taken becomes a `signal`
 * (variant `cortex`), its Decision Card and a pending entry order carrying `limit_micro` (D-288) and
 * the family's v1 exit plan, in one transaction. The v1 position rules still hold (open slots, no
 * second line in a held code, FAM-002 re-entry block, arena_control, the quality gate and a
 * corporate-action disposal). Returns the links by `${bookId}|${code}`.
 */
async function cortexEntriesFor(
  ctx: Ctx,
  books: CohortBooks,
  exec: ExecutionRow,
  family: Family,
  cx: StageResult,
): Promise<Map<string, LiveLink>> {
  const links = new Map<string, LiveLink>();
  const decisions = cx.out.decisions.filter((x) => x.bookId === books.cohort.id);
  if (decisions.length === 0) return links;
  const held = heldReason(ctx, exec);
  if (held !== null) {
    ctx.stats.controlSkips += decisions.length;
    return links;
  }
  let slots = books.params.maxOpenPositions - books.positions.size;
  const open = new Set(books.positions.keys());
  const blocked = slots < 1 ? new Set<string>() : await reentryBlocked(ctx, exec.id);
  const ruleVersion = cx.signalRuleVersion.get(family) ?? cortexRuleVersionFallback(family);
  type Ready = {
    dec: (typeof decisions)[number];
    signalId: string;
    built: BuiltCard;
    note: CardNote;
  };
  const ready: Ready[] = [];
  for (const dec of decisions) {
    if (slots < 1 || open.has(dec.code) || blocked.has(dec.code)) continue;
    const cross = crossing(ctx.actionsNext, dec.code, ctx.d, ctx.nextD);
    if (cross.disposal) continue;
    if (!(await gateOf(ctx, dec.code)).allowed) continue;
    const facts = ctx.day.facts.get(dec.code);
    const leg = facts === undefined ? null : legFor(ctx, facts, dec.halfSize, dec.code);
    const signalId = cortexSignalId(ctx.market, ctx.d, family, ruleVersion, dec.code);
    const plan = scalePlanPrices(dec.plan, cross.priceFactor);
    const rules = dec.trace.map((t) => ({
      id: t.gateId,
      pass: t.pass,
      value: t.value ?? "",
      threshold: "",
    }));
    const rankText = dec.rankKey.length === 0 ? "none" : JSON.stringify(dec.rankKey);
    const built = finishCard({
      signalId,
      market: ctx.market,
      d: ctx.d,
      executionId: exec.id,
      candidate: {
        family,
        variant: CORTEX_SIGNAL_VARIANT,
        ruleVersion,
        code: dec.code,
        regime: dec.card.regime,
        rules,
        rankText,
        flags: [],
        halfSize: dec.halfSize,
        groupKey: null,
      },
      taken: true,
      notTakenReason: null,
      closeMicro: scaleMicro(dec.refMicro, cross.priceFactor),
      plan,
      events: [],
      insiderScoreQ: null,
      shortDrop: "unknown",
      eventLowMicro: null,
      sizing: {
        accepted: true,
        reasons: [],
        qty: dec.qty,
        fillPriceMicro: scaleMicro(dec.limitMicro, cross.priceFactor),
        slipMicro: 0n,
        brokerageMicro: 0n,
        orderValueMicro: dec.orderValueMicro,
        refPriceMicro: scaleMicro(dec.refMicro, cross.priceFactor),
        advValueMicro: leg === null ? 0n : leg.env.advValueMicro,
      },
      scenario: { split: null, nets: [] },
      params: ctx.params,
      costProfile: COST_PROFILES[books.params.costProfile],
      tickCrossFactor: books.params.tickCrossFactor,
    });
    const errors = checkCard(JSON.parse(built.json), ctx.params);
    if (errors.length > 0) {
      throw new SignalsError("card_invalid", errors.slice(0, 3).join("; ")); // threshold-ok: error text length
    }
    ready.push({ dec, signalId, built, note: await cardNote(built.card, ctx.llm) });
    slots -= 1;
  }
  await withTx(ctx.db, async (tx) => {
    for (const r of ready) {
      const { dec } = r;
      const cross = crossing(ctx.actionsNext, dec.code, ctx.d, ctx.nextD);
      const gap95 = ctx.cortexCells?.get(
        cellKey(family, TOP3_BAND_KEY, dec.volBucket, dec.tier),
      )?.gap95;
      const evidence = canonicalJson({
        gap95: gap95 ?? null,
        limit_micro: String(scaleMicro(dec.limitMicro, cross.priceFactor)),
        manifest_id: cx.manifestId,
        map_rule_version: ruleVersion,
        p: dec.p,
        s: dec.s,
        stop_micro: String(dec.stopMicro),
        tier: dec.tier,
        vol_bucket: dec.volBucket,
      });
      const values = [
        r.signalId,
        ctx.market,
        ctx.d,
        family,
        ruleVersion,
        CORTEX_SIGNAL_VARIANT,
        dec.code,
        dec.card.regime,
        JSON.stringify([dec.s]),
        // one signal per code (two books may take it): book-level gates (G11, G12) stay on the card
        canonicalJson(
          dec.trace
            .filter((t) => t.gateId !== "G11_portfolio" && t.gateId !== "G12_settled_cash")
            .map((t) => ({
              rule: t.gateId,
              value: t.value ?? "",
              threshold: "",
              pass: t.pass,
            })),
        ),
        evidence,
        null,
        null,
        ctx.day.partial ? 1 : 0,
        SIGNAL_SCHEMA_VERSION,
        AGENT_VERSION,
        ctx.day.inputsRef,
        ctx.day.cutoff,
      ];
      if (await putRow(tx, "signal", SIGNAL_COLS, ["id"], values, SIGNAL_COLS))
        ctx.stats.signals += 1;
      const orderId = entryOrderId(books.cohort.id, ctx.d, dec.code);
      if (
        await putCard(
          tx,
          r.built,
          { orderId, cohortId: books.cohort.id },
          r.signalId,
          ctx.day.cutoff,
        )
      ) {
        ctx.stats.cards += 1;
      }
      await putCardNote(tx, r.built.id, r.note);
      const wrote = await putOrder(tx, {
        id: orderId,
        cohortId: books.cohort.id,
        decidedD: ctx.d,
        code: dec.code,
        side: "buy",
        kind: "entry",
        qty: dec.qty,
        status: "pending",
        rejectReason: null,
        tier: dec.tier,
        untradeable: false,
        signalId: r.signalId,
        cardId: r.built.id,
        maxOpenMicro: null,
        stopSpec: serializePlan({
          family,
          variant: CORTEX_SIGNAL_VARIANT,
          ruleVersion,
          caThrough: ctx.d,
          caApplied: cross.ids,
          plan: scalePlanPrices(dec.plan, cross.priceFactor),
          rel: [],
        }),
        limitMicro: dec.limitMicro,
      });
      if (wrote) ctx.stats.orders += 1;
      links.set(`${dec.bookId}|${dec.code}`, { signalId: r.signalId, orderId, cardId: r.built.id });
    }
  });
  return links;
}

const CORTEX_SIGNAL_VARIANT = "cortex";
const CORTEX_V1_FAMILIES: readonly Family[] = ["F1", "F2", "F3", "F4", "F5", "F6"];
const cortexRuleVersionFallback = (family: Family): string => `${family}.cortex.none`;

/** Step 5: the matched random-entry controls of one C2 / C3 cohort. */
async function controlsFor(
  ctx: Ctx,
  books: CohortBooks,
  exec: ExecutionRow,
  family: Family,
  matched: readonly Taken[],
  qualifying: ReadonlySet<string>,
  evalCtx: ReturnType<typeof createContext>,
): Promise<void> {
  const held = heldReason(ctx, exec);
  const prng = createPrng(deriveRngSeed(ctx.masterSeed, `c2:${books.cohort.id}:${ctx.d}`));
  const tierOf = new Map<string, string>();
  for (const c of ctx.day.inputs.codes) tierOf.set(c.code, c.tier);
  const eventToday = new Set<string>();
  if (family !== "F1" && family !== "F4") {
    for (const [code, list] of ctx.day.eventsByCode) {
      if (list.some((e) => e.day0 === ctx.d)) eventToday.add(code);
    }
  }
  const open = new Set(books.positions.keys());
  let slots = books.params.maxOpenPositions - books.positions.size;
  type Draw = {
    m: Taken;
    code: string | null;
    pool: number;
    draw: number | null;
    skip: string | null;
  };
  const draws: Draw[] = [];
  const legs: Leg[] = [];
  const planOf = new Map<string, OrderPlan>();
  for (const m of [...matched].sort((a, b) => cmp(a.signalId, b.signalId))) {
    if (held !== null) {
      draws.push({ m, code: null, pool: 0, draw: null, skip: held });
      ctx.stats.controlSkips += 1;
      continue;
    }
    const signalFacts = ctx.day.facts.get(m.candidate.code);
    const excluded = new Set<string>([m.candidate.code, ...qualifying, ...eventToday]);
    const base = controlPool({
      code: m.candidate.code,
      tier: m.candidate.tier,
      vol20: ctx.day.vol20,
      tierOf,
      excluded,
      passes: (code) => {
        const f = ctx.day.facts.get(code);
        if (f === undefined || f.halted || !f.ind.atrWarm || f.ind.atrMicro === null) return false;
        return f.tier === "U1" || applyArn011(f, evalCtx).failed.length === 0;
      },
    });
    const pool: string[] = [];
    for (const code of base) if ((await gateOf(ctx, code)).allowed) pool.push(code);
    if (pool.length === 0 || signalFacts === undefined) {
      draws.push({ m, code: null, pool: 0, draw: null, skip: "empty_pool" });
      continue;
    }
    const idx = Number(prng.below(BigInt(pool.length))); // money-float-ok: index of the seeded draw, not money
    const code = pool[idx]!;
    const draw: Draw = { m, code, pool: pool.length, draw: idx, skip: null };
    draws.push(draw);
    if (open.has(code)) {
      draw.skip = "holding";
      continue;
    }
    if (slots < 1 || legs.length >= slots) {
      draw.skip = "positions";
      continue;
    }
    const controlFacts = ctx.day.facts.get(code)!;
    const plan = controlPlan({ family, matched: m.candidate, signalFacts, controlFacts });
    if ("skip" in plan) {
      draw.skip = plan.skip;
      continue;
    }
    const cross = crossing(ctx.actionsNext, code, ctx.d, ctx.nextD);
    if (cross.disposal) {
      draw.skip = "corporate_action";
      continue;
    }
    const leg = legFor(ctx, controlFacts, m.halfSize, code);
    if (leg === null) {
      draw.skip = "corporate_action";
      continue;
    }
    legs.push(leg);
    planOf.set(code, {
      ...plan,
      caThrough: ctx.d,
      caApplied: cross.ids,
      plan: scalePlanPrices(plan.plan, cross.priceFactor),
      rel: plan.rel.map((r) => ({ ...r, atrMicro: scaleMicro(r.atrMicro, cross.priceFactor) })),
    });
  }
  slots = Math.max(0, slots); // money-float-ok: slot count, not money
  const sizing: SizingContext = {
    params: books.params,
    cashMicro: books.cashMicro,
    navMicro: books.navMicro,
    sleeveReserveMicro: books.sleeveReserveMicro,
  };
  const results = planLegs(sizing, markSleeve(legs, books), slots);
  const byCode = new Map(draws.filter((x) => x.code !== null).map((x) => [x.code!, x] as const));
  await withTx(ctx.db, async (tx) => {
    const out = await writeLegs(ctx, tx, books, results, (leg) => {
      const dr = byCode.get(leg.key)!;
      const facts = ctx.day.facts.get(leg.key)!;
      return {
        code: leg.key,
        tier: facts.tier,
        signalId: dr.m.signalId,
        cardId: dr.m.cardId,
        plan: planOf.get(leg.key)!,
        maxOpen: null,
      };
    });
    for (const [key, reason] of out.rejected) byCode.get(key)!.skip = reason;
    for (const l of legs) {
      // a leg dropped by the two-leg rule (the pair did not both fit) is skipped, not silently lost
      if (!results.some((r) => r.leg.key === l.key)) byCode.get(l.key)!.skip = "second_leg";
    }
    for (const dr of draws) {
      const cols = [
        "cohort_id",
        "d",
        "matched_signal_id",
        "code",
        "skipped",
        "skip_reason",
        "pool_size",
        "rng_draw",
      ];
      const wrote = await putRow(
        tx,
        "c2_selection",
        cols,
        ["cohort_id", "d", "matched_signal_id"],
        [
          books.cohort.id,
          ctx.d,
          dr.m.signalId,
          dr.code,
          dr.skip === null ? 0 : 1,
          dr.skip,
          dr.pool,
          dr.draw,
        ],
        cols,
      );
      if (wrote) {
        if (dr.skip === null) ctx.stats.controls += 1;
        else ctx.stats.skips += 1;
      }
    }
  });
}

// ---- entry point ---------------------------------------------------------------------------------------------------

function emptyResult(
  o: SignalsOptions,
  status: SignalsStatus,
  reason: string | null,
  runId: number | null,
  stats = emptyStats(),
  partial = false,
): SignalsResult {
  return { market: o.market, d: o.d, status, reason, runId, partial, stats };
}

async function recordSkip(db: Client, o: SignalsOptions, reason: string): Promise<SignalsResult> {
  const runId = await startRun(db, {
    job: SIGNALS_JOB,
    market: o.market,
    concurrencyKey: signalsKey(o.market, o.d),
    scheduledFor: o.d,
    commitSha: o.commitSha ?? undefined,
    now: o.now(),
  });
  await finishRun(db, runId, { status: "skipped", details: { reason }, now: o.now() });
  return emptyResult(o, "skipped", reason, runId);
}

async function closedOk(db: Client, market: string, d: string): Promise<boolean> {
  const rs = await db.execute({
    sql: `SELECT 1 FROM run_record WHERE concurrency_key = ? AND status IN ('success', 'degraded')
          LIMIT 1`,
    args: [closeBooksKey(market, d)],
  });
  return rs.rows.length > 0;
}

/**
 * Decide session `o.d` (batch 2b). Never throws for a data problem: the outcome is the run record
 * and the returned status (`failed` carries the code).
 */
export async function signalsDay(db: Client, o: SignalsOptions): Promise<SignalsResult> {
  const key = signalsKey(o.market, o.d);
  if (await hasSuccess(db, key)) return emptyResult(o, "already_done", null, null);

  const market = await db.execute({
    sql: "SELECT mode, tz, open_time, close_time FROM market WHERE code = ?",
    args: [o.market],
  });
  if (market.rows.length === 0) return recordSkip(db, o, "market_missing");
  const mode = text(market.rows[0]!.mode);
  if (mode === "off") return recordSkip(db, o, "market_off");
  if (mode !== "full" && o.replay !== true) return recordSkip(db, o, "data_only_guard");
  const calendar = o.calendar ?? (await loadCalendar(db, o.market));
  if (!isTradingDay(o.d, calendar)) return recordSkip(db, o, "non_trading_day");
  if (!(await closedOk(db, o.market, o.d))) return recordSkip(db, o, "no_2a_success");
  const hours: MarketHours = {
    tz: text(market.rows[0]!.tz),
    open_time: text(market.rows[0]!.open_time),
    close_time: text(market.rows[0]!.close_time),
  };

  const stale = await db.execute({
    sql: "SELECT 1 FROM run_record WHERE concurrency_key = ? AND status = 'running' LIMIT 1",
    args: [key],
  });
  if (stale.rows.length > 0) {
    await db.execute({
      sql: `UPDATE run_record SET status = 'failed', ended_at = ?, error_summary = ?
            WHERE concurrency_key = ? AND status = 'running'`,
      args: [o.now(), "superseded: the previous run did not finish", key],
    });
  }
  const runId = await startRun(db, {
    job: SIGNALS_JOB,
    market: o.market,
    concurrencyKey: key,
    scheduledFor: o.d,
    commitSha: o.commitSha ?? undefined,
    now: o.now(),
  });
  const stats = emptyStats();
  try {
    const baseParams = o.params ?? (await loadAgentParams(db));
    // Cohort start stage (M8 T10, decision 3): `full` only, idempotent. It runs BEFORE the night's
    // signals and starts new cohorts on the NEXT trading day, so they are not in tonight's
    // `loadUnresolvedCohorts(d)` and first trade from the next session (BLD-030, no special path).
    // Any other mode is a no-op that writes nothing, so those nights are unchanged. An explicit
    // REPLAY (D-066 / BLD-024) skips it: replayed nights already hold their cohort rows, and history
    // replays create cohorts through their own path (D-077 / D-091), never through this stage.
    const started =
      o.replay === true
        ? null
        : await ensureCohorts(db, {
            market: o.market,
            d: o.d,
            now: o.now,
            calendar,
            masterSeed: o.masterSeed,
            controlsPerFamily: baseParams.replay.c2LivePerFamily,
            withLeverage: o.withLeverage,
          });
    const executionList = await loadExecutions(db);
    const versionSet = await loadVersionSet(db, o.market, executionList);
    // live parameters: the incumbent rule versions laid over the configuration (D-115)
    const params = liveParams(baseParams, versionSet);
    const nextD = nextTradingDay(o.d, calendar);
    // GL-02: both lists hold only actions confirmed by the decision cut-off of D
    const cutoffD = decisionCutoffUtc(o.d, params.decisionCutoff);
    // GL-05: a live night without the "first completed poll after the cut-off" marker is recorded
    const cutoffPollMissing =
      o.replay === true ? false : (await loadIngestBound(db, o.market, o.d, cutoffD)).missing;
    const actions = knownBy(await loadConfirmedActions(db, o.market, o.d), cutoffD);
    const actionsNext = knownBy(await loadConfirmedActions(db, o.market, nextD), cutoffD);
    const trades = await loadOpenTrades(db);
    const day = await loadDayInputs(db, {
      market: o.market,
      d: o.d,
      calendar,
      hours,
      params,
      replay: o.replay === true,
      heldCodes: [...new Set(trades.map((t) => t.code))].sort(cmp),
      actions,
    });
    stats.agentRows = await recordAgentRows(db, day, o.market);

    // A5: the rule interpreter, once per active rule version (live set first; D-110 #44)
    const { out, paramsOf } = runVersions(day.inputs, params, versionSet);
    const ctx: Ctx = {
      db,
      market: o.market,
      d: o.d,
      nextD,
      calendar,
      params,
      day,
      actionsNext,
      masterSeed: o.masterSeed ?? ARENA_MASTER_SEED,
      stats,
      gates: new Map(),
      llm: o.llm,
      scenarios: new Map(),
      costTable: await loadCostGateTable(db, o.market, params.entry.costGateMinRows),
      control: await loadControl(db),
    };
    const signalIds = new Map<Candidate, string>();
    await withTx(db, async (tx) => {
      for (const c of out.candidates) {
        const values = signalValues(o.market, c, day);
        signalIds.set(c, values[0] as string);
        if (await putRow(tx, "signal", SIGNAL_COLS, ["id"], values, SIGNAL_COLS))
          stats.signals += 1;
      }
    });

    const executions = new Map(executionList.map((e) => [e.id, e]));
    const unresolved = await loadUnresolvedCohorts(db, o.d);
    await exitsStage(ctx, new Map(unresolved.map((c) => [c.id, c])));
    await breakersStage(ctx, o.breakerSink ?? createAlertRowSink(db), o.now());

    // M15 P2 (D-265, D-352): order of work: the v1 cohorts of every non-allowed family first, then the
    // Cortex stage, then the Cortex entries of the allowed families. A stage failure or overrun never
    // touches v1: the stage only writes cortex_* rows, and an allowed family then opens nothing
    // tonight (it holds cash).
    const cortexOn = o.cortex?.enabled !== false;
    let cortexAllowed = new Set<Family>();
    let cortex: StageResult | null = null;
    const offControl = (key: string): boolean => {
      const v = ctx.control.get(key);
      return v === "paused" || v === "killed";
    };
    const killedArena = offControl(`market|${o.market}`);
    const killedFamilies = new Set<Family>(
      CORTEX_V1_FAMILIES.filter((f) => offControl(`family|${f}`)),
    );
    if (cortexOn) {
      try {
        cortexAllowed = allowedFamilies(
          await familyStatusMap(db, o.market, o.d),
          killedArena,
          killedFamilies,
        );
      } catch {
        cortexAllowed = new Set<Family>();
      }
    }
    const cortexLinks = new Map<string, LiveLink>();
    const warnCortex = async (what: string, error: unknown): Promise<void> => {
      await db.execute({
        sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'warn', ?, ?, ?)",
        args: [
          o.now(),
          SIGNALS_JOB,
          `${what} on ${o.d}: ${error instanceof Error ? error.message : "error"}`.slice(
            0,
            LOG_MESSAGE_MAX,
          ),
          runId,
        ],
      });
    };
    /** The whole stage (reads, runNight, persist) against cortex_stage_minutes (D-353). */
    const runStage = async (): Promise<StageResult | null> => {
      const abort = { aborted: false };
      const budgetMs = o.cortex?.timeoutMs ?? params.cortex.stageMinutes * 60_000; // threshold-ok: minutes to ms
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const arnCtx = createContext(day.inputs, params, {});
        const arn011Failed = new Map<string, readonly string[]>();
        for (const c of day.inputs.codes) {
          if (c.tier === "U1") continue;
          const failed = applyArn011(c, arnCtx).failed;
          if (failed.length > 0) arn011Failed.set(c.code, failed);
        }
        const work = cortexStage(db, {
          market: o.market,
          d: o.d,
          params,
          calendar,
          replay: o.replay === true,
          now: o.now,
          nowMs: o.cortex?.nowMs,
          killedArena,
          killedFamilies,
          arn011Failed,
          angles: o.cortex?.angles,
          goLiveD: o.cortex?.goLiveD,
          includeLeverage: o.withLeverage,
          abort,
          timeBoxMs: budgetMs,
        });
        const limit = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.aborted = true;
            reject(new Error(`over cortex_stage_minutes (${budgetMs} ms)`));
          }, budgetMs);
        });
        work.catch(() => undefined); // a late failure after the time box is already handled
        const result = await Promise.race([work, limit]);
        o.cortex?.onStage?.(result);
        return result;
      } catch (error) {
        await warnCortex("cortex stage failed", error);
        return null;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    const deferred: {
      books: CohortBooks;
      exec: ExecutionRow;
      family: Family;
      vctx: Ctx;
    }[] = [];

    const live = unresolved.filter((c) => c.live).sort((a, b) => cmp(a.id, b.id));
    const matched = new Map<string, Taken[]>();
    // a cohort trades the candidates of its execution's rule version only; a database with no
    // rule_version rows keeps the single v1 run, unfiltered
    const versionOf = (exec: ExecutionRow, family: Family): string =>
      versionSet === null ? FAMILY_RULE_VERSION[family] : versionIdOf(family, exec.rule_version);
    const forVersion = (family: Family, id: string): Candidate[] =>
      out.candidates.filter(
        (c) => c.family === family && (versionSet === null || c.ruleVersion === id),
      );
    for (const cohort of live) {
      const exec = executions.get(cohort.executionId);
      // D-191: no leverage: the L twins make no new entry (exits still run in the exit stage)
      if (exec === undefined || exec.kind !== "E" || exec.family === null) continue;
      if (o.withLeverage !== true && carriesSleeve(exec)) continue;
      const books = await booksOf(db, cohort, calendar, o.d);
      if (books === null) continue;
      stats.cohorts += 1;
      const family = exec.family as Family;
      const vid = versionOf(exec, family);
      const vctx: Ctx = { ...ctx, params: paramsOf.get(vid) ?? params };
      if (cortexOn && cortexAllowed.has(family)) {
        // D-266/D-280: an allowed family trades the Cortex live arm in place of the v1 pool, after
        // the stage (below); the cohort is not touched by the v1 path
        deferred.push({ books, exec, family, vctx });
        continue;
      }
      const taken = await entriesFor(vctx, books, exec, family, forVersion(family, vid), signalIds);
      const mkey = `${family}|${vid}`;
      const list = matched.get(mkey) ?? [];
      for (const t of taken) if (!list.some((x) => x.signalId === t.signalId)) list.push(t);
      matched.set(mkey, list);
    }

    if (cortexOn) {
      cortex = await runStage();
      if (cortex !== null) {
        // the one source of "allowed" is the stage's own (N3); a mismatch can only mean a status row
        // changed during the run: the later reading wins and the family holds cash otherwise
        cortexAllowed = new Set([...cortexAllowed].filter((f) => cortex!.allowed.has(f)));
        for (const x of deferred) {
          if (!cortexAllowed.has(x.family)) continue;
          try {
            const vctx: Ctx = { ...x.vctx, cortexCells: cortex.inputs.cells };
            for (const [k, v] of await cortexEntriesFor(vctx, x.books, x.exec, x.family, cortex)) {
              cortexLinks.set(k, v);
            }
          } catch (error) {
            // S3 (D-356): this family holds cash tonight; the other families are not affected
            await warnCortex(`cortex entries failed for ${x.family}`, error);
          }
        }
      }
    }

    if (cortex !== null) {
      try {
        await persistLiveDecisions(db, {
          market: o.market,
          d: o.d,
          manifestId: cortex.manifestId,
          out: cortex.out,
          links: cortexLinks,
        });
      } catch (error) {
        await db.execute({
          sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'warn', ?, ?, ?)",
          args: [
            o.now(),
            SIGNALS_JOB,
            `cortex live decisions not written on ${o.d}: ${error instanceof Error ? error.message : "error"}`.slice(
              0,
              LOG_MESSAGE_MAX,
            ),
            runId,
          ],
        });
      }
    }

    const evalCtxOf = new Map<string, ReturnType<typeof createContext>>();
    for (const cohort of live) {
      const exec = executions.get(cohort.executionId);
      if (
        exec === undefined ||
        (exec.kind !== "C2" && exec.kind !== "C3") ||
        exec.family === null ||
        (o.withLeverage !== true && carriesSleeve(exec)) // D-191: the C3 controls follow the L twins out
      ) {
        continue;
      }
      const family = exec.family as Family;
      const vid = versionOf(exec, family);
      const list = matched.get(`${family}|${vid}`) ?? [];
      if (list.length === 0) continue;
      const books = await booksOf(db, cohort, calendar, o.d);
      if (books === null) continue;
      stats.cohorts += 1;
      const qualifying = new Set<string>([
        ...forVersion(family, vid).map((c) => c.code),
        ...out.blocked
          .filter((c) => c.family === family && (versionSet === null || c.ruleVersion === vid))
          .map((c) => c.code),
      ]);
      const vp = paramsOf.get(vid) ?? params;
      let evalCtx = evalCtxOf.get(vid);
      if (evalCtx === undefined) {
        evalCtx = createContext(day.inputs, vp, {});
        evalCtxOf.set(vid, evalCtx);
      }
      await controlsFor({ ...ctx, params: vp }, books, exec, family, list, qualifying, evalCtx);
    }

    const status: SignalsStatus = day.partial ? "degraded" : "success";
    await finishRun(db, runId, {
      status,
      itemsProcessed: stats.cohorts,
      rowsWritten:
        stats.signals +
        stats.orders +
        stats.rejected +
        stats.exits +
        stats.stopLevels +
        stats.agentRows +
        stats.cards +
        stats.breakerEvals,
      details: {
        ...stats,
        partial: day.partialReasons.length > 0 ? day.partialReasons : null,
        ...(cutoffPollMissing ? { cutoff_poll_missing: true } : {}),
        ...(started !== null && started.opened > 0
          ? { cohortsOpened: started.opened, cohortStartD: started.startD }
          : {}),
      },
      now: o.now(),
    });
    return emptyResult(o, status, day.partial ? "partial_inputs" : null, runId, stats, day.partial);
  } catch (error) {
    const code =
      error instanceof SignalsError
        ? error.code
        : error instanceof CardError
          ? "row_conflict"
          : error instanceof Error
            ? error.name
            : "unknown_error";
    await finishRun(db, runId, {
      status: "failed",
      errorSummary: error instanceof Error ? `${code}: ${error.message}` : code,
      details: { code },
      now: o.now(),
    });
    await db.execute({
      sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'error', ?, ?, ?)",
      args: [
        o.now(),
        SIGNALS_JOB,
        `signals failed on ${o.d}: ${code}`.slice(0, LOG_MESSAGE_MAX),
        runId,
      ],
    });
    return emptyResult(o, "failed", code, runId, stats);
  }
}
