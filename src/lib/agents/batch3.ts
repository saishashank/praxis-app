// Batch 3 "deterministic review numbers" (M4 T15; docs/M4_design.md 4.1, 4.10, 4.11, decisions 4, 28,
// 29; ARN-070/071, ARN-093, ARN-101, VAL-102; D-077 guard, D-093 proposed). HIGH-RISK: it writes the
// forward signal ledger and the kill-switch state.
//
// ONE run per session D, keyed `arena-3:<market>:<D>`, back-to-back after batch 2b (decision 4: numbers
// only, NO LLM call anywhere in this module). Stages, each idempotent on deterministic ids:
//   1. forward signal ledger (forwardLedger.ts): the day's new rows and closures, then final controls;
//   2. nightly scorecards and CIFs on the live cohorts (T14 functions: buildReplayStats on the live
//      cohort outcomes plus the forward trade scorecards) into `replay_stat` under this run's key;
//   2b. cost-profile re-cost and uniform price-shock rows of every live cohort with a NAV on D
//      (arena/recost.ts, M7 T4, D-132 draft): `replay_stat` scopes `cost:<cohort>` and `shock:<cohort>`;
//   3. ARN-101 invariant re-check of every live cohort that has a NAV on D: REPORT ONLY (a
//      `recheck` summary row and an app_log line); it never writes to or changes a cohort, a NAV row
//      or a ledger row, and a violation does not stop the other stages;
//   4. kill switch: K for the calendar year (first night of a year, or first evaluation), then the
//      looks that are due (stats/killSwitch.ts). A trip recommends, see that file;
//   5. VAL-102 evidence timeline per (lineage, rule version) into `replay_stat` (UI is M7);
//   6. VAL-114 daily rank quality (M14, D-232): the Spearman IC of D' = two sessions before D, one
//      `rank_ic_daily` row per (family, rank variant), and the bootstrap summaries as `replay_stat`
//      metric `rank_ic`. Descriptive and read only: a failure here only degrades the run.
// Preconditions as 2b: market mode `full` (or `data_only` only as a replay against a non-production
// database, D-066 / BLD-024), D a trading session, and batch 2b of D `success` or `degraded`. Anything
// else records a `skipped` run and touches no table. The status is `degraded` when the re-check found
// violations or a stage had to be partial; `failed` carries the stage code.
import type { Client } from "@libsql/client";
import {
  gateDayStatus,
  sessionsBetween,
  type CalendarRow,
  type MarketHours,
} from "@/lib/data/calendar";
import { hasSuccess, finishRun, startRun } from "@/lib/runs/runRecord";
import { ARENA_MASTER_SEED, loadCalendar, loadSleeveConfig } from "@/lib/arena/closeBooks";
import { COST_PROFILES } from "@/lib/arena/costs";
import { recostRowsFor } from "@/lib/arena/recost";
import { parseCohortParams } from "@/lib/arena/cohort";
import { loadExecutions } from "@/lib/arena/cohortWriter";
import { loadQtyAdjustments } from "@/lib/arena/corpActionWriter";
import { loadLedgerFills, loadLedgerRows, toBig } from "@/lib/arena/ledgerWriter";
import { checkCohortBooks, isFatal, type Violation } from "@/lib/arena/invariants";
import type { CohortBooks } from "@/lib/arena/nav";
import { loadSleeveStates, loadSleeveTrades } from "@/lib/arena/sleeveWriter";
import type { Mark } from "@/lib/arena/nav";
import { cifProportions } from "@/lib/replay/cif";
import { type CohortOutcome, type CohortReplayResult } from "@/lib/replay/cohortReplay";
import type { LedgerEntry, LedgerResult } from "@/lib/replay/ledger";
import { buildReplayStats, tradeScorecards, type ReplayStatRow } from "@/lib/replay/scorecards";
import { SESSIONS_PER_YEAR, ensureLooksPerYear, evaluateKillSwitch } from "@/lib/stats/killSwitch";
import { addWeekdays } from "@/lib/stats/splits";
import { getConfig } from "@/lib/config/store";
import type { LlmRouter } from "@/lib/llm/router";
import { checkGrounding } from "@/lib/llm/grounding";
import { NARRATIVE_METRIC, narrativeScope } from "@/lib/review/facts";
import {
  loadCtx,
  narrativeRequest,
  readNarrativePack,
  type NarrativeRow,
} from "@/lib/review/sections";
import { syncForwardLedger, type ForwardResult } from "./forwardLedger";
import { runStatusLooks } from "@/lib/cortex/look";
import { scoreOutcomes } from "@/lib/cortex/stage";
import { loadAgentParams, type AgentParams } from "./params";
import { wordsKey } from "@/lib/learning/learnFacts";
import { liveRankIc } from "@/lib/learning/rankIcStage";
import { signalsKey } from "./batch2b";
import { notifyIncident, type NotifyCtx } from "@/lib/incidents/notify";
import type { Family } from "./families";

export const REVIEW_JOB = "arena-review";
const LOG_MESSAGE_MAX = 500; // threshold-ok: app_log message length cap (as batch 2b)
const FAMILIES: readonly Family[] = ["F1", "F2", "F3", "F4", "F5", "F6"];

/** `arena-3:<market>:<d>`: the concurrency key of batch 3 (cf. `arena-2b:<market>:<d>`). */
export const reviewKey = (market: string, d: string): string => `arena-3:${market}:${d}`;

export class ReviewError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
  }
}

export type ReviewOptions = {
  readonly market: string;
  readonly d: string;
  /** An explicit replay against a NON-production database (D-066 / BLD-024). */
  readonly replay?: boolean;
  /**
   * D-711: the live entry points set this so a weekday the calendar has no row for is skipped as
   * `calendar_missing` (fail safe). Off (default): the looser "not a holiday row" rule that
   * replays and the synthetic-date tests rely on.
   */
  readonly strictCalendar?: boolean;
  /** Stamps run_record, app_log and the arena_control row only; never a number. */
  readonly now: () => string;
  readonly commitSha?: string | null;
  readonly masterSeed?: bigint;
  readonly calendar?: CalendarRow[];
  readonly params?: AgentParams;
  /** Email wiring for the ledger-invariant incident (D-105); absent = record only, no email. */
  readonly notify?: Omit<NotifyCtx, "db" | "now">;
};

export type ReviewStatus = "success" | "degraded" | "failed" | "skipped" | "already_done";

export type ReviewStats = {
  ledger: ForwardResult | null;
  statRows: number;
  recostRows: number;
  cohorts: number;
  invariantCohorts: number;
  invariantViolations: number;
  invariantFatal: number;
  killLooks: number;
  killTriggered: number;
  killLooksPerYear: number | null;
  evidenceRows: number;
  rankIcRows: number;
};

export type ReviewResult = {
  readonly market: string;
  readonly d: string;
  readonly status: ReviewStatus;
  readonly reason: string | null;
  readonly runId: number | null;
  readonly stats: ReviewStats;
};

const text = (v: unknown): string => String(v);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const num = (v: unknown): number => Number(v as bigint); // money-float-ok: a count or session index read from SQL

function emptyStats(): ReviewStats {
  return {
    ledger: null,
    statRows: 0,
    recostRows: 0,
    cohorts: 0,
    invariantCohorts: 0,
    invariantViolations: 0,
    invariantFatal: 0,
    killLooks: 0,
    killTriggered: 0,
    killLooksPerYear: null,
    evidenceRows: 0,
    rankIcRows: 0,
  };
}

const emptyResult = (
  o: ReviewOptions,
  status: ReviewStatus,
  reason: string | null,
  runId: number | null,
  stats = emptyStats(),
): ReviewResult => ({ market: o.market, d: o.d, status, reason, runId, stats });

async function recordSkip(db: Client, o: ReviewOptions, reason: string): Promise<ReviewResult> {
  const runId = await startRun(db, {
    job: REVIEW_JOB,
    market: o.market,
    concurrencyKey: reviewKey(o.market, o.d),
    scheduledFor: o.d,
    commitSha: o.commitSha ?? undefined,
    now: o.now(),
  });
  await finishRun(db, runId, { status: "skipped", details: { reason }, now: o.now() });
  return emptyResult(o, "skipped", reason, runId);
}

async function decidedOk(db: Client, market: string, d: string): Promise<boolean> {
  const rs = await db.execute({
    sql: `SELECT 1 FROM run_record WHERE concurrency_key = ? AND status IN ('success', 'degraded') LIMIT 1`,
    args: [signalsKey(market, d)],
  });
  return rs.rows.length > 0;
}

// ---- replay_stat rows (this run) ---------------------------------------------------------------------------------

async function putStats(db: Client, rows: readonly ReplayStatRow[]): Promise<number> {
  let written = 0;
  for (const r of rows) {
    const res = await db.execute({
      sql: `INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
      args: [r.run_id, r.scope, r.metric, r.d, r.value_json],
    });
    written += res.rowsAffected;
  }
  return written;
}

const jsonRow = (
  runId: string,
  d: string,
  scope: string,
  metric: string,
  value: unknown,
): ReplayStatRow => ({
  run_id: runId,
  scope,
  metric,
  d,
  value_json: JSON.stringify(value),
});

// ---- stage 2: live cohorts -------------------------------------------------------------------------------------------

type CohortRow = {
  id: string;
  executionId: string;
  controlIdx: number | null;
  startD: string;
  seedMicro: bigint;
  terminalKind: string | null;
  terminalD: string | null;
  ttd: number | null;
  outcome: bigint | null;
};

/** The live cohorts as `CohortOutcome`s (the T14 shape), censored at D when unresolved. */
export async function liveCohortOutcomes(
  db: Client,
  d: string,
  sessions: readonly string[],
  progressSessions: readonly number[],
): Promise<CohortOutcome[]> {
  const executions = new Map((await loadExecutions(db)).map((e) => [e.id, e]));
  const cs = await db.execute({
    sql: `SELECT id, execution_id, control_idx, start_d, seed_micro, terminal_kind, terminal_d, ttd_sessions,
                 outcome_micro FROM cohort WHERE start_d <= ? ORDER BY start_d, id`,
    args: [d],
  });
  const cohorts: CohortRow[] = cs.rows.map((r) => ({
    id: text(r.id),
    executionId: text(r.execution_id),
    controlIdx: r.control_idx === null ? null : num(r.control_idx),
    startD: text(r.start_d),
    seedMicro: toBig(r.seed_micro),
    terminalKind: r.terminal_kind === null ? null : text(r.terminal_kind),
    terminalD: r.terminal_d === null ? null : text(r.terminal_d),
    ttd: r.ttd_sessions === null ? null : num(r.ttd_sessions),
    outcome: r.outcome_micro === null ? null : toBig(r.outcome_micro),
  }));
  const nav = await db.execute({
    sql: "SELECT cohort_id, d, nav_micro, liq_nav_micro FROM nav_daily WHERE d <= ? ORDER BY cohort_id, d",
    args: [d],
  });
  const navBy = new Map<string, { d: string; nav: bigint; liq: bigint }[]>();
  for (const r of nav.rows) {
    const id = text(r.cohort_id);
    const list = navBy.get(id) ?? [];
    list.push({ d: text(r.d), nav: toBig(r.nav_micro), liq: toBig(r.liq_nav_micro) });
    navBy.set(id, list);
  }
  const trades = await db.execute({
    sql: `SELECT cohort_id, COUNT(*) AS n,
                 SUM(CASE WHEN exit_type = 'IS' THEN 1 ELSE 0 END) AS is_n,
                 SUM(CASE WHEN exit_type = 'CS' THEN 1 ELSE 0 END) AS cs_n
          FROM trade GROUP BY cohort_id`,
  });
  const tradeBy = new Map(
    trades.rows.map((r) => [text(r.cohort_id), { n: num(r.n), is: num(r.is_n), cs: num(r.cs_n) }]),
  );
  const index = new Map<string, number>();
  sessions.forEach((s, i) => index.set(s, i));
  const out: CohortOutcome[] = [];
  for (const c of cohorts) {
    const ex = executions.get(c.executionId);
    const days = navBy.get(c.id) ?? [];
    const startIdx = index.get(c.startD);
    if (ex === undefined || startIdx === undefined || days.length === 0) continue;
    const resolved = c.terminalKind !== null && c.terminalD !== null && c.ttd !== null;
    const lastDay = days[days.length - 1]!;
    const endD = resolved ? c.terminalD! : lastDay.d;
    const endIdx = index.get(endD) ?? startIdx;
    const atEnd = days.find((x) => x.d === endD) ?? lastDay;
    const cfg = await loadSleeveConfig(db, c.id);
    const checkpoints: [number, number][] = [];
    for (const s of progressSessions) {
      const x = days.find((p) => (index.get(p.d) ?? -1) - startIdx + 1 === s);
      if (x !== undefined) {
        checkpoints.push([s, Number((x.liq * 1_000_000n) / c.seedMicro)]); // threshold-ok: ppm of the seed
      }
    }
    const t = tradeBy.get(c.id) ?? { n: 0, is: 0, cs: 0 };
    out.push({
      id: c.id,
      executionId: c.executionId,
      kind: ex.kind,
      family: ex.family,
      variant: ex.variant,
      controlIdx: c.controlIdx,
      group: "base",
      leverage: cfg === null ? null : Number(cfg.leverage),
      startD: c.startD,
      startIdx,
      endD,
      sessions: resolved ? c.ttd! : endIdx - startIdx + 1,
      terminalKind: resolved ? (c.terminalKind as CohortOutcome["terminalKind"]) : null,
      terminalRule: null,
      censored: !resolved,
      seedMicro: c.seedMicro,
      outcomeMicro: resolved && c.outcome !== null ? c.outcome : atEnd.liq,
      // Live cohorts: the terminal-close liquidation NAV is the stored outcome; the realised
      // wind-down value lives in the `liquidated` cohort event and is not re-read here.
      terminalLiqNavMicro: resolved && c.outcome !== null ? c.outcome : atEnd.liq,
      liquidatedD: null,
      legacyValueMicro: 0n,
      navMicro: atEnd.nav,
      entries: t.n,
      exitsIs: t.is,
      exitsCs: t.cs,
      sleeve: null,
      checkpoints,
    });
  }
  return out.sort((a, b) => cmp(a.startD, b.startD) || cmp(a.id, b.id));
}

/** Closed forward ledger rows as ledger entries (net/stress/gross from the stored micro amounts). */
export async function forwardLedgerResult(
  db: Client,
  market: string,
  d: string,
  sessions: readonly string[],
): Promise<LedgerResult> {
  const rs = await db.execute({
    sql: `SELECT lr.*, s.family, s.rule_version, s.variant, s.code, s.d AS decision_d
          FROM ledger_row lr JOIN signal s ON s.id = lr.signal_id
          WHERE lr.forward = 1 AND lr.exit_d IS NOT NULL AND s.market = ?
          ORDER BY lr.entry_d, lr.id`,
    args: [market],
  });
  const entries: LedgerEntry[] = rs.rows.map((r) => {
    const cost = toBig(r.qty) * toBig(r.fill_in_micro) + toBig(r.brok_in_micro);
    const proceeds =
      toBig(r.qty_out) * toBig(r.fill_out_micro) -
      toBig(r.brok_out_micro) +
      toBig(r.dividend_micro);
    const stressIn = toBig(r.stress_in_micro);
    const family = text(r.family) as Family;
    return {
      row: {
        id: text(r.id),
        signal_id: text(r.signal_id),
        group_key: r.group_key === null ? null : text(r.group_key),
        entry_d: text(r.entry_d),
        exit_d: text(r.exit_d),
        exit_tag: text(r.exit_tag) as "IS" | "CS",
        qty: num(r.qty),
        fill_in_micro: toBig(r.fill_in_micro),
        fill_out_micro: toBig(r.fill_out_micro),
        brok_in_micro: toBig(r.brok_in_micro),
        brok_out_micro: toBig(r.brok_out_micro),
        stress_in_micro: stressIn,
        stress_out_micro: toBig(r.stress_out_micro),
        qty_out: num(r.qty_out),
        dividend_micro: toBig(r.dividend_micro),
        gross_num: toBig(r.gross_num),
        gross_den: toBig(r.gross_den),
        timed: num(r.timed) === 1 ? 1 : 0,
        forward: 1,
      },
      lineage: `${market}:${family}`,
      family,
      ruleVersion: text(r.rule_version),
      variant: text(r.variant),
      code: text(r.code),
      decisionD: text(r.decision_d),
      exitRule: null,
      net: { num: proceeds - cost, den: cost },
      stress: { num: toBig(r.stress_out_micro) - stressIn, den: stressIn },
      excess: null,
      flags: [],
      mtm: [],
      controls: null,
    };
  });
  return {
    market,
    from: entries[0]?.row.entry_d ?? d,
    to: d,
    sessions: sessions.length,
    entries,
    skipped: [],
    controlPaths: 0,
  };
}

async function scorecardStage(
  db: Client,
  o: ReviewOptions,
  params: AgentParams,
  sessions: readonly string[],
): Promise<{ rows: ReplayStatRow[]; cohorts: number }> {
  const runId = reviewKey(o.market, o.d);
  const outcomes = await liveCohortOutcomes(db, o.d, sessions, params.progress.sessionsEdges);
  const starts = [...new Set(outcomes.map((c) => c.startD))].sort(cmp);
  const idx = new Map<string, number>();
  sessions.forEach((s, i) => idx.set(s, i));
  let step = 1;
  for (let i = 1; i < starts.length; i += 1) {
    const gap = (idx.get(starts[i]!) ?? 0) - (idx.get(starts[i - 1]!) ?? 0);
    if (gap > 0 && (i === 1 || gap < step)) step = gap;
  }
  const cohorts: CohortReplayResult = {
    qualityGate: "supplied", // live 2a applied the real quality gate
    market: o.market,
    from: starts[0] ?? o.d,
    to: o.d,
    sessions: sessions.length,
    step,
    starts,
    cohorts: outcomes,
    skippedC1: false,
  };
  const forward = await forwardLedgerResult(db, o.market, o.d, sessions);
  const extra = tradeScorecards(forward, sessions, params).map((c) => ({
    scope: `fwd:${c.scope}`,
    metric: "scorecard",
    value: c,
  }));
  const timeout = Number(await getConfig(db, "timeout_sessions"));
  const built = buildReplayStats({
    runId,
    d: o.d,
    params,
    market: o.market,
    families: FAMILIES,
    cohorts,
    ledger: null,
    src: null,
    timeoutSessions: timeout,
    extra,
  });
  return { rows: [...built.rows], cohorts: outcomes.length };
}

// ---- stage 2b: re-cost and price-shock rows (M7 T4) ------------------------------------------------------------------

/** The rows only read the stored books: no cohort, NAV or ledger row is changed. */
async function recostStage(
  db: Client,
  o: ReviewOptions,
  params: AgentParams,
  calendar: readonly CalendarRow[],
): Promise<ReplayStatRow[]> {
  const runId = reviewKey(o.market, o.d);
  const ids = await db.execute({
    sql: `SELECT c.id FROM cohort c WHERE c.start_d <= ?
            AND EXISTS (SELECT 1 FROM nav_daily n WHERE n.cohort_id = c.id AND n.d = ?) ORDER BY c.id`,
    args: [o.d, o.d],
  });
  const out: ReplayStatRow[] = [];
  for (const r of ids.rows) {
    const rows = await recostRowsFor(db, {
      market: o.market,
      cohortId: text(r.id),
      d: o.d,
      calendar,
      params: {
        stressProfile: params.stats.stressCostProfile,
        stressSlippageExtraPct: params.stats.stressSlippageExtraPct,
      },
    });
    for (const x of rows) out.push(jsonRow(runId, o.d, x.scope, x.metric, x.value));
  }
  return out;
}

// ---- stage 3: ARN-101 re-check (report only) ---------------------------------------------------------------------

export type RecheckSummary = {
  readonly cohorts: number;
  readonly violations: number;
  readonly fatal: number;
  readonly byCode: Readonly<Record<string, number>>;
  readonly cohortsWithViolations: readonly string[];
};

export const LEDGER_INVARIANT_KIND = "ledger_invariant";

/**
 * D-105: a violation found by the ARN-101 re-check opens one S1 `ledger_invariant` incident through
 * `notifyIncident` (which also emails it once). At most one per kind per session date: a rerun, or a
 * later night's finding while the first is still open, records nothing new. Never throws and never
 * touches the ledger: the re-check itself stays report only.
 */
export async function raiseLedgerInvariantIncident(
  db: Client,
  o: { d: string; now: string; notify?: Omit<NotifyCtx, "db" | "now"> },
  rc: RecheckSummary,
): Promise<boolean> {
  if (rc.violations === 0) return false;
  try {
    const seen = await db.execute({
      sql: "SELECT 1 FROM incident WHERE kind = ? AND json_extract(detail_json, '$.d') = ? LIMIT 1",
      args: [LEDGER_INVARIANT_KIND, o.d],
    });
    if (seen.rows.length > 0) return false;
    const r = await notifyIncident(
      { ...o.notify, db, now: () => new Date(o.now) },
      LEDGER_INVARIANT_KIND,
      "S1",
      {
        summary: `Ledger invariant: ${rc.violations} violations in ${rc.cohortsWithViolations.length} cohorts on ${o.d}`,
        detail: {
          d: o.d,
          violations: rc.violations,
          fatal: rc.fatal,
          byCode: rc.byCode,
          cohorts: rc.cohortsWithViolations,
        },
      },
    );
    return r.opened;
  } catch {
    return false; // the incident is a notice; it never fails the batch
  }
}

/** Re-run the ARN-101 checks on the stored books of every cohort that has a NAV on `d`. Reads only. */
export async function recheckInvariants(
  db: Client,
  d: string,
  calendar: readonly CalendarRow[],
): Promise<RecheckSummary> {
  const ids = await db.execute({
    sql: `SELECT c.id FROM cohort c WHERE c.start_d <= ?
            AND EXISTS (SELECT 1 FROM nav_daily n WHERE n.cohort_id = c.id AND n.d = ?) ORDER BY c.id`,
    args: [d, d],
  });
  const byCode: Record<string, number> = {};
  const bad: string[] = [];
  let total = 0;
  let fatal = 0;
  for (const r of ids.rows) {
    const id = text(r.id);
    const violations = await recheckCohort(db, id, d, calendar);
    if (violations.length > 0) bad.push(id);
    for (const v of violations) {
      byCode[v.code] = (byCode[v.code] ?? 0) + 1;
      total += 1;
      if (isFatal(v)) fatal += 1;
    }
  }
  return {
    cohorts: ids.rows.length,
    violations: total,
    fatal,
    byCode: Object.fromEntries(Object.entries(byCode).sort((a, b) => cmp(a[0], b[0]))),
    cohortsWithViolations: bad,
  };
}

async function recheckCohort(
  db: Client,
  id: string,
  d: string,
  calendar: readonly CalendarRow[],
): Promise<Violation[]> {
  const c = await db.execute({
    sql: "SELECT seed_micro, params_json FROM cohort WHERE id = ?",
    args: [id],
  });
  const params = parseCohortParams(text(c.rows[0]!.params_json));
  const [rows, fills, adjustments] = await Promise.all([
    loadLedgerRows(db, id, d),
    loadLedgerFills(db, id),
    loadQtyAdjustments(db, id),
  ]);
  const navRs = await db.execute({
    sql: "SELECT code, close_micro, value_micro FROM nav_daily_pos WHERE cohort_id = ? AND d = ?",
    args: [id, d],
  });
  const storedClose = new Map(navRs.rows.map((p) => [text(p.code), toBig(p.close_micro)]));
  const unreal = await db.execute({
    sql: "SELECT sleeve_unreal_micro FROM nav_daily WHERE cohort_id = ? AND d = ?",
    args: [id, d],
  });
  const sleeveUnreal = unreal.rows.length === 0 ? 0n : toBig(unreal.rows[0]!.sleeve_unreal_micro);
  const cfg = await loadSleeveConfig(db, id);
  const [trades, states] =
    cfg === null
      ? [[], []]
      : await Promise.all([loadSleeveTrades(db, id), loadSleeveStates(db, id)]);
  const books: CohortBooks = {
    cohortId: id,
    rows,
    fills,
    adjustments,
    // the stored close is the evidence; ADV only prices the liquidation estimate, which is not compared
    markFor: (_dd, code): Mark | undefined => {
      const close = storedClose.get(code);
      return close === undefined ? undefined : { closeMicro: close, advMicro: 0n };
    },
    sleeveUnrealFor: () => sleeveUnreal,
    sleeveLiquidationCostFor: () => 0n,
    profile: COST_PROFILES[params.costProfile],
    tickCrossFactor: params.tickCrossFactor,
  };
  return checkCohortBooks(books, {
    mode: params.settlementMode,
    calendar,
    dates: [d],
    seedMicro: toBig(c.rows[0]!.seed_micro),
    sleeve: cfg === null ? undefined : { trades, states, cfg },
  });
}

// ---- stage 5: VAL-102 evidence timeline -------------------------------------------------------------------------

export type EvidenceTimeline = {
  readonly lineage: string;
  readonly ruleVersion: string;
  readonly forwardRows: number;
  readonly closedRows: number;
  readonly forwardSessions: number;
  /** Rows opened per session since the first forward entry. */
  readonly rowsPerSession: number | null;
  readonly rowsTarget: number;
  readonly effectiveCohorts: number;
  readonly cohortsTarget: number;
  /** Estimates on the weekday calendar (no holidays): the date `rowsTarget` rows are reached. */
  readonly expectedRowsD: string | null;
  readonly expectedCohortsD: string | null;
  readonly minMonthsD: string | null;
  /** First date CONSISTENT-FORWARD can be reached: both counts and the minimum months. */
  readonly earliestForwardD: string | null;
  readonly split: {
    readonly version: number;
    readonly deferredUntilD: string | null;
    readonly validationStartD: string | null;
    readonly validationEndD: string | null;
    readonly holdoutStartD: string | null;
    readonly holdoutEndD: string | null;
  } | null;
  readonly currentLabel: string | null;
  readonly reachableLabel: string;
};

const dayOf = (d: string, sessions: number): string =>
  addWeekdays(d, Math.max(0, Math.ceil(sessions)));

async function evidenceTimelines(
  db: Client,
  market: string,
  d: string,
  sessions: readonly string[],
  params: AgentParams,
): Promise<EvidenceTimeline[]> {
  const rs = await db.execute({
    sql: `SELECT s.family, s.rule_version, COUNT(*) AS n,
                 SUM(CASE WHEN lr.exit_d IS NOT NULL THEN 1 ELSE 0 END) AS closed, MIN(lr.entry_d) AS first_entry
          FROM ledger_row lr JOIN signal s ON s.id = lr.signal_id
          WHERE lr.forward = 1 AND s.market = ? AND s.variant = s.family
          GROUP BY s.family, s.rule_version ORDER BY s.family, s.rule_version`,
    args: [market],
  });
  const out: EvidenceTimeline[] = [];
  const target = params.stats.minTrades;
  const cohortsTarget = params.stats.minCohortsRanked;
  const months = params.stats.forwardMinMonths;
  for (const r of rs.rows) {
    const family = text(r.family);
    const lineage = `${market}:${family}`;
    const ruleVersion = text(r.rule_version);
    const rows = num(r.n);
    const firstEntry = text(r.first_entry);
    const since = sessions.filter((s) => s >= firstEntry && s <= d).length;
    const rate = since > 0 ? rows / since : null;
    const rowsD =
      rows >= target ? d : rate === null || rate === 0 ? null : dayOf(d, (target - rows) / rate);
    const eff = await effectiveForwardCohorts(db, family);
    const cohortsD =
      eff.n >= cohortsTarget
        ? d
        : eff.n === 0 || eff.since === 0
          ? null
          : dayOf(d, ((cohortsTarget - eff.n) * eff.since) / eff.n);
    const monthsD = addMonthsIso(firstEntry, months);
    const earliest = rowsD === null ? null : rowsD > monthsD ? rowsD : monthsD;
    const sp = await db.execute({
      sql: `SELECT version, deferred_until_d, validation_start_d, validation_end_d, holdout_start_d, holdout_end_d
            FROM lineage_split WHERE lineage_id = ? ORDER BY version DESC LIMIT 1`,
      args: [lineage],
    });
    const split =
      sp.rows.length === 0
        ? null
        : {
            version: num(sp.rows[0]!.version),
            deferredUntilD:
              sp.rows[0]!.deferred_until_d === null ? null : text(sp.rows[0]!.deferred_until_d),
            validationStartD:
              sp.rows[0]!.validation_start_d === null ? null : text(sp.rows[0]!.validation_start_d),
            validationEndD:
              sp.rows[0]!.validation_end_d === null ? null : text(sp.rows[0]!.validation_end_d),
            holdoutStartD:
              sp.rows[0]!.holdout_start_d === null ? null : text(sp.rows[0]!.holdout_start_d),
            holdoutEndD:
              sp.rows[0]!.holdout_end_d === null ? null : text(sp.rows[0]!.holdout_end_d),
          };
    const lab = await db.execute({
      sql: `SELECT l.label FROM label l JOIN execution e ON e.id = l.execution_id
            WHERE e.family = ? AND l.rule_version = ? ORDER BY l.d DESC, l.id DESC LIMIT 1`,
      args: [family, ruleVersion],
    });
    const currentLabel = lab.rows.length === 0 ? null : text(lab.rows[0]!.label);
    // CONSISTENT-FORWARD is reachable only through PASSED-BACKTEST (ARN-086): without it the best
    // reachable label is the current one
    const reachable =
      currentLabel === "PASSED-BACKTEST" || currentLabel === "CONSISTENT-FORWARD"
        ? "CONSISTENT-FORWARD"
        : (currentLabel ?? "UNVALIDATED");
    out.push({
      lineage,
      ruleVersion,
      forwardRows: rows,
      closedRows: num(r.closed),
      forwardSessions: since,
      rowsPerSession: rate,
      rowsTarget: target,
      effectiveCohorts: eff.n,
      cohortsTarget,
      expectedRowsD: rowsD,
      expectedCohortsD: cohortsD,
      minMonthsD: monthsD,
      earliestForwardD: earliest,
      split,
      currentLabel,
      reachableLabel: reachable,
    });
  }
  return out;
}

/** Calendar months added to an ISO date (month-end clamped). */
function addMonthsIso(d: string, months: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  const day = t.getUTCDate();
  t.setUTCDate(1);
  t.setUTCMonth(t.getUTCMonth() + months);
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10); // threshold-ok: ISO date length
}

async function effectiveForwardCohorts(
  db: Client,
  family: string,
): Promise<{ n: number; since: number }> {
  const rs = await db.execute({
    sql: `SELECT c.id, c.execution_id, c.start_d, c.terminal_kind, c.terminal_d, c.ttd_sessions
          FROM cohort c JOIN execution e ON e.id = c.execution_id
          WHERE e.kind = 'E' AND e.family = ? AND e.variant = 'U' AND c.terminal_kind IS NOT NULL
          ORDER BY c.start_d, c.id`,
    args: [family],
  });
  if (rs.rows.length === 0) return { n: 0, since: 0 };
  const cohorts = rs.rows.map((r) => ({
    id: text(r.id),
    executionId: text(r.execution_id),
    startD: text(r.start_d),
    terminalD: text(r.terminal_d),
    terminalKind: text(r.terminal_kind) as "target" | "bust" | "stalled" | "timeout",
    ttdSessions: num(r.ttd_sessions),
  }));
  const p = cifProportions(cohorts, [SESSIONS_PER_YEAR])[0]!;
  const first = cohorts[0]!;
  const last = cohorts.reduce((m, c) => (c.terminalD > m ? c.terminalD : m), first.terminalD);
  const span = sessionsBetween(first.startD, last, []).length;
  return { n: p.n, since: span };
}

// ---- entry point -----------------------------------------------------------------------------------------------------

/**
 * Batch 3 for session `o.d`. Never throws for a data problem: the outcome is the run record and the
 * returned status (`failed` carries the stage code).
 */
export async function reviewDay(db: Client, o: ReviewOptions): Promise<ReviewResult> {
  const key = reviewKey(o.market, o.d);
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
  const dayState = gateDayStatus(o.d, calendar, o.strictCalendar);
  if (dayState === "missing") return recordSkip(db, o, "calendar_missing"); // D-711 fail safe
  if (dayState !== "open") return recordSkip(db, o, "non_trading_day");
  if (!(await decidedOk(db, o.market, o.d))) return recordSkip(db, o, "no_2b_success");
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
    job: REVIEW_JOB,
    market: o.market,
    concurrencyKey: key,
    scheduledFor: o.d,
    commitSha: o.commitSha ?? undefined,
    now: o.now(),
  });
  const stats = emptyStats();
  let stage = "start";
  try {
    let params = o.params ?? (await loadAgentParams(db));
    const sessions = await sessionsOfRun(db, o.market, o.d, calendar);

    stage = "ledger";
    stats.ledger = await syncForwardLedger(db, {
      market: o.market,
      d: o.d,
      calendar,
      hours,
      params,
      replay: o.replay === true,
      masterSeed: o.masterSeed ?? ARENA_MASTER_SEED,
    });

    stage = "scorecards";
    const sc = await scorecardStage(db, o, params, sessions);
    stats.statRows += await putStats(db, sc.rows);
    stats.cohorts = sc.cohorts;

    stage = "recost";
    let recostFailed = false;
    try {
      const rr = await recostStage(db, o, params, calendar);
      stats.recostRows = rr.length;
      stats.statRows += await putStats(db, rr);
    } catch (error) {
      // display-only rows: a failure here must not stop the kill switch (stage 4); the run is degraded
      recostFailed = true;
      await db.execute({
        sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'warn', ?, ?, ?)",
        args: [
          o.now(),
          REVIEW_JOB,
          `re-cost rows not written on ${o.d}: ${error instanceof Error ? error.message : "error"}`.slice(
            0,
            LOG_MESSAGE_MAX,
          ),
          runId,
        ],
      });
    }

    stage = "invariants";
    const rc = await recheckInvariants(db, o.d, calendar);
    stats.invariantCohorts = rc.cohorts;
    stats.invariantViolations = rc.violations;
    stats.invariantFatal = rc.fatal;
    stats.statRows += await putStats(db, [jsonRow(key, o.d, "invariants", "recheck", rc)]);
    if (rc.violations > 0) {
      await db.execute({
        sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, ?, ?, ?, ?)",
        args: [
          o.now(),
          rc.fatal > 0 ? "error" : "warn",
          REVIEW_JOB,
          `ARN-101 re-check on ${o.d}: ${rc.violations} violations in ${rc.cohortsWithViolations.length} cohorts (report only)`.slice(
            0,
            LOG_MESSAGE_MAX,
          ),
          runId,
        ],
      });
      await raiseLedgerInvariantIncident(db, { d: o.d, now: o.now(), notify: o.notify }, rc);
    }

    stage = "killswitch";
    const k = await ensureLooksPerYear(db, {
      market: o.market,
      d: o.d,
      perLook: params.killswitch.tradesPerLook,
      now: o.now(),
    });
    if (k.computed) params = o.params ?? (await loadAgentParams(db));
    stats.killLooksPerYear = params.killswitch.maxLooksPerYear;
    const ks = await evaluateKillSwitch(db, {
      market: o.market,
      d: o.d,
      now: o.now,
      sessions: sessions,
      params: {
        tradesPerLook: params.killswitch.tradesPerLook,
        alphaTotal: params.killswitch.alphaTotal,
        criteria: params.killswitch.criteria,
        maxLooksPerYear: params.killswitch.maxLooksPerYear,
        bootstrapReplicationsMin: params.stats.bootstrapReplicationsMin,
        bootstrapBlockMinSessions: params.stats.bootstrapBlockMinSessions,
        progressMinNeff: params.stats.progressMinNeff,
      },
    });
    stats.killLooks = ks.looksWritten;
    stats.killTriggered = ks.triggered;
    if (ks.triggered > 0) {
      await db.execute({
        sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'warn', ?, ?, ?)",
        args: [
          o.now(),
          REVIEW_JOB,
          `ARN-093 kill switch tripped for ${ks.recommended.join(",")} on ${o.d}: recommendation only`.slice(
            0,
            LOG_MESSAGE_MAX,
          ),
          runId,
        ],
      });
    }

    stage = "evidence";
    const timelines = await evidenceTimelines(db, o.market, o.d, sessions, params);
    stats.evidenceRows = timelines.length;
    stats.statRows += await putStats(
      db,
      timelines.map((t) =>
        jsonRow(key, o.d, `${t.lineage}|${t.ruleVersion}`, "evidence_timeline", t),
      ),
    );

    stage = "rank_ic";
    let rankIcFailed = false;
    try {
      const ric = await liveRankIc(db, {
        market: o.market,
        d: o.d,
        calendar,
        hours,
        params,
        replay: o.replay === true,
        now: o.now(),
      });
      stats.rankIcRows = ric.rows;
      stats.statRows += await putStats(
        db,
        ric.stats.map((x) => jsonRow(key, o.d, x.scope, "rank_ic", x.value)),
      );
    } catch (error) {
      // descriptive rows: a failure must not fail the review (the kill switch and evidence have run)
      rankIcFailed = true;
      await db.execute({
        sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'warn', ?, ?, ?)",
        args: [
          o.now(),
          REVIEW_JOB,
          `rank IC not written on ${o.d}: ${error instanceof Error ? error.message : "error"}`.slice(
            0,
            LOG_MESSAGE_MAX,
          ),
          runId,
        ],
      });
    }

    // M15 P2 (CTX-023, CTX-054): would-have outcomes of every Cortex decision whose hold has closed.
    // Descriptive and idempotent; a failure only logs (the run's status does not depend on it).
    stage = "cortex_outcome";
    try {
      await scoreOutcomes(db, { market: o.market, d: o.d, params, now: o.now });
    } catch (error) {
      await db.execute({
        sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'warn', ?, ?, ?)",
        args: [
          o.now(),
          REVIEW_JOB,
          `cortex outcomes not scored on ${o.d}: ${error instanceof Error ? error.message : "error"}`.slice(
            0,
            LOG_MESSAGE_MAX,
          ),
          runId,
        ],
      });
    }

    // V2-S1 (CTX-053, CTX-082, D-700): the quarterly live look at each family's status, after the
    // outcomes above. One look per family per quarter (a ledger cell), never a promotion outside the
    // CTX-053 rules; a failure only logs.
    stage = "cortex_status_look";
    try {
      await runStatusLooks(db, { market: o.market, d: o.d, now: o.now() });
    } catch (error) {
      await db.execute({
        sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'warn', ?, ?, ?)",
        args: [
          o.now(),
          REVIEW_JOB,
          `cortex status look failed on ${o.d}: ${error instanceof Error ? error.message : "error"}`.slice(
            0,
            LOG_MESSAGE_MAX,
          ),
          runId,
        ],
      });
    }

    const status: ReviewStatus =
      rc.violations > 0 || recostFailed || rankIcFailed ? "degraded" : "success";
    await finishRun(db, runId, {
      status,
      itemsProcessed: stats.cohorts,
      rowsWritten:
        stats.statRows +
        stats.killLooks +
        (stats.ledger?.opened ?? 0) +
        (stats.ledger?.closed ?? 0),
      details: { ...stats },
      now: o.now(),
    });
    return emptyResult(
      o,
      status,
      rc.violations > 0
        ? "invariant_violations"
        : recostFailed
          ? "recost_failed"
          : rankIcFailed
            ? "rank_ic_failed"
            : null,
      runId,
      stats,
    );
  } catch (error) {
    const code =
      error instanceof ReviewError
        ? error.code
        : error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : error instanceof Error
            ? error.name
            : "unknown_error";
    await finishRun(db, runId, {
      status: "failed",
      errorSummary:
        error instanceof Error ? `${stage}/${code}: ${error.message}` : `${stage}/${code}`,
      details: { stage, code },
      now: o.now(),
    });
    await db.execute({
      sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'error', ?, ?, ?)",
      args: [
        o.now(),
        REVIEW_JOB,
        `batch 3 failed on ${o.d} in ${stage}: ${code}`.slice(0, LOG_MESSAGE_MAX),
        runId,
      ],
    });
    return emptyResult(o, "failed", `${stage}/${code}`, runId, stats);
  }
}

// ---- the R5 narrative row (M5 T9; moved to the `words` phase after `learn` in M6 T11, D-123) ----------------------------------------------------------------------------

/**
 * The Evening Review narrative (sections 4-6). The router is the only way to a model; an answer
 * is used only if it passed the router checks and the numeric grounding against the facts pack
 * (LLM-034), checked again here. Otherwise the row records the facts-only lists ("rules").
 */
export async function narrativeStage(
  db: Client,
  o: Pick<ReviewOptions, "market" | "d" | "now">,
  router: LlmRouter,
): Promise<"llm" | "rules"> {
  const c = await loadCtx(db, {
    market: o.market,
    d: o.d,
    env: "production",
    appUrl: "",
    now: new Date(o.now()),
  });
  const pack = await readNarrativePack(c);
  const r = await router.route(narrativeRequest(o.market, pack, false));
  const used = r.llmUsed && checkGrounding(r.value, pack).ok;
  const last = r.attempts[r.attempts.length - 1];
  const value: NarrativeRow = {
    kind: used ? "llm" : "rules",
    provider: used ? (last?.provider ?? r.source) : "rules-only",
    fallbackDepth: used ? String(r.attempts.length - 1) : "rules-only",
    s4: used ? r.value.s4 : narrativeRequest(o.market, pack, false).rules.s4,
    s5: used ? r.value.s5 : narrativeRequest(o.market, pack, false).rules.s5,
    s6: used ? r.value.s6 : narrativeRequest(o.market, pack, false).rules.s6,
  };
  await putStats(db, [
    jsonRow(wordsKey(o.market, o.d), o.d, narrativeScope(o.market, o.d), NARRATIVE_METRIC, value),
  ]);
  return value.kind;
}

/** Trading sessions from the first cohort or signal of the market to D (indexes for starts and entries). */
async function sessionsOfRun(
  db: Client,
  market: string,
  d: string,
  calendar: readonly CalendarRow[],
): Promise<string[]> {
  const rs = await db.execute({
    sql: `SELECT MIN(x) AS d FROM (SELECT MIN(start_d) AS x FROM cohort
                                   UNION ALL SELECT MIN(d) FROM signal WHERE market = ?)`,
    args: [market],
  });
  const from = rs.rows.length === 0 || rs.rows[0]!.d === null ? null : text(rs.rows[0]!.d);
  return from === null || from > d ? [d] : sessionsBetween(from, d, calendar);
}
