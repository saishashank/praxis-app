// Replay run orchestration (M4 T16; docs/M4_design.md 4.7-4.9; ARN-080/081/086/100; AT-17; D-095
// draft). Pure over its inputs: a loaded snapshot goes in, rows in the migration 0008 shapes plus the
// bulky output files come out. No database, no network and no clock of its own (`now` is injected),
// so the CLI wraps it with IO and the tests call it directly.
//
// Modes
//   light     signal ledger + controls + rolling-start cohorts from `since` (new rows only), the
//             descriptive statistics (development figures only: validation and holdout are never read);
//   full      the same over the whole snapshot;
//   evidence  full, then VAL-110 on the validation split and one holdout confirmation per rule
//             version (each access is written to the trial ledger first), survivorship, delisting
//             and labels (the AT-17 evidence run, Owner-approved, after the DAT-125 backfill);
//   null / injected  the AT-17 size and power checks (nullRuns.ts);
//   learning  the weekly learning run (M6 T12, D-124 draft): asynchronous (it reads and writes the learning
//             tables), so it lives in learningMode.ts; `runReplay` refuses it.
// Every stage is timed against the replay budget keys (replay_light_minutes, replay_full_minutes);
// when a stage ends over budget the run stops cleanly, writes only its run row, the compute report and
// a `paused_budget` status, and no partial statistics.
import { FAMILIES, type Family } from "@/lib/agents/schema";
import type { AgentParams } from "@/lib/agents/params";
import { agentParamsSha } from "@/lib/agents/params";
import {
  buildExecutionRegistry,
  canonicalJson,
  sha256Hex,
  unleveredExecutionIds,
} from "@/lib/arena/cohort";
import { bucketBpsFor } from "@/lib/arena/slippage";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { gzipDeterministic, sha256Hex as fileSha } from "@/lib/data/backfill/rules.mjs";
import { makeRational, type Rational } from "@/lib/money/rational";
import { mean as meanOf } from "@/lib/stats/bootstrap";
import { costFeasibility } from "@/lib/stats/feasibility";
import { returnMoments } from "@/lib/stats/dsr";
import { assignLabel, type LabelRecord } from "@/lib/stats/labels";
import {
  createLineage,
  createLineageSplit,
  lineageId,
  maxHoldingUpperBound,
  splitOf,
  spentTestsBefore,
  trialCounts,
  trialLedgerRow,
  validationSessions,
  type LineageRecord,
  type LineageSplitRecord,
  type TrialLedgerRow,
} from "@/lib/stats/splits";
import {
  delistingSensitivity,
  partitionByExposure,
  survivorshipSeries,
  type DelistRow,
  type SurvivorshipYear,
} from "@/lib/stats/survivorship";
import {
  evaluateHoldout,
  evaluateVal110,
  signalRowFromEntry,
  type SignalRow,
  type ValidationResultRecord,
} from "@/lib/stats/val110";
import {
  costGateRowsOf,
  costGateTable,
  type CostGateRow,
  type CostGateTable,
} from "@/lib/agents/costGate";
import type { SettlementMode } from "@/lib/arena/ledger";
import { replayCohorts, type CohortReplayResult } from "./cohortReplay";
import {
  dailySeries,
  replayLedger,
  serializeLedger,
  type LedgerEntry,
  type LedgerResult,
} from "./ledger";
import { periodReturns, roundTripBrokerage, costSetupFrom } from "./returns";
import {
  buildReplayStats,
  replayRunRow,
  statRows,
  type ReplayRunRow,
  type ReplayStatRow,
} from "./scorecards";
import { SnapshotWorld } from "./snapshotWorld";
import { loadSnapshot } from "./snapshot";
import {
  blockOf,
  detectionReport,
  fewBlocksCheck,
  INJECTED_EDGE,
  INJECTED_SPEC,
  matchedQ,
  realNullBatch,
  sizeReport,
  syntheticBatch,
  syntheticRows,
  testRows,
  UNIFORM_ALPHA,
  workingLevel,
  type SizeReport,
} from "./nullRuns";

export type RunMode = "light" | "full" | "null" | "injected" | "evidence" | "learning";
export const RUN_MODES: readonly RunMode[] = [
  "light",
  "full",
  "null",
  "injected",
  "evidence",
  "learning",
];

const MARKET = "AU";
const MS_PER_MINUTE = 60_000; // threshold-ok: ms per minute
const NULL_RUNS_DEFAULT = 2000; // threshold-ok: AT-17 null runs (design 4.9)
const SIZE_B = 2000; // threshold-ok: decision 24 size-check replicates (bootstrap_size_check_replications)

/** Stage names in order (the budget report lists each with its minutes). */
export type Stage =
  | "world"
  | "ledger"
  | "cohorts"
  | "stats"
  | "validation"
  | "null"
  | "injected"
  // weekly learning run (learningMode.ts)
  | "forward"
  | "comparisons"
  | "lessons"
  | "preregistered"
  | "challengers"
  | "rolls"
  | "arn076"
  | "factors"
  | "robustness"
  | "rankIc";

export type StageTime = { readonly stage: Stage; readonly minutes: number };

export type ComputeReport = {
  readonly mode: RunMode;
  readonly budgetMinutes: number;
  readonly totalMinutes: number;
  readonly within: boolean;
  readonly stages: readonly StageTime[];
  readonly sessions: number;
  readonly ledgerRows: number;
  readonly controlPaths: number;
  readonly cohorts: number;
  readonly status: "complete" | "paused_budget";
  readonly pausedAt: Stage | null;
};

export type RunFile = { readonly name: string; readonly bytes: Uint8Array };

export type ReplayOutput = {
  readonly run: ReplayRunRow;
  readonly stats: readonly ReplayStatRow[];
  readonly validation: readonly ValidationResultRecord[];
  readonly labels: readonly LabelRecord[];
  readonly trials: readonly TrialLedgerRow[];
  readonly lineages: readonly LineageRecord[];
  readonly splits: readonly LineageSplitRecord[];
  readonly files: readonly RunFile[];
  readonly report: ComputeReport;
  readonly size: SizeReport | null;
};

export type RunOptions = {
  readonly mode: RunMode;
  /** The as-of date of the run (Sydney date). */
  readonly d: string;
  readonly params: AgentParams;
  readonly commitSha: string;
  readonly nodeVersion: string;
  /** The loaded snapshot bytes (modes other than `injected`, or `null` with `synthetic`). */
  readonly snapshotBytes: Uint8Array | null;
  /** First decision date of a light run (default: the last `turso_recent_sessions` sessions). */
  readonly since?: string;
  /** Trial-ledger rows already recorded (to count the budget and keep each access to once). */
  readonly existingTrials?: readonly TrialLedgerRow[];
  /** Stored lineage splits (newest version wins); the cost-gate table uses them as live does (D-282). */
  readonly existingSplits?: readonly LineageSplitRecord[];
  readonly nullRuns?: number;
  /** Null/injected runs on synthetic rows only (CI and local checks; decision 31 runs real data). */
  readonly synthetic?: boolean;
  /** Clock in milliseconds; injected (the CLI passes Date.now). */
  readonly now: () => number;
  /** Budget override in minutes (tests). */
  readonly budgetMinutes?: number;
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const jsonl = (rows: readonly unknown[]): string =>
  `${rows.map((r) => canonicalJson(JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))))).join("\n")}\n`;

class OverBudget extends Error {
  constructor(readonly stage: Stage) {
    super("over budget");
  }
}

/** The budget key for a mode: light and learning use replay_light_minutes, everything else replay_full_minutes. */
export function budgetFor(mode: RunMode, params: AgentParams): number {
  return mode === "light" || mode === "learning"
    ? params.replay.lightMinutes
    : params.replay.fullMinutes;
}

export function runIdOf(mode: RunMode, d: string, snapshotSha: string, commitSha: string): string {
  return `replay:${mode}:${MARKET}:${d}:${snapshotSha.slice(0, 8)}:${commitSha.slice(0, 8)}`;
}

type Timer = {
  stage<T>(s: Stage, fn: () => T): T;
  readonly stages: StageTime[];
  elapsed(): number;
};

function timer(now: () => number, budget: number): Timer {
  const t0 = now();
  const stages: StageTime[] = [];
  return {
    stages,
    elapsed: () => (now() - t0) / MS_PER_MINUTE,
    stage<T>(s: Stage, fn: () => T): T {
      const a = now();
      const out = fn();
      stages.push({ stage: s, minutes: (now() - a) / MS_PER_MINUTE });
      if ((now() - t0) / MS_PER_MINUTE > budget) throw new OverBudget(s);
      return out;
    },
  };
}

// ---- helpers over the ledger ---------------------------------------------------------------------------------

type Group = {
  readonly key: string;
  readonly family: Family;
  readonly ruleVersion: string;
  readonly variant: string;
  readonly entries: LedgerEntry[];
};

/** Entries grouped by (family, rule version, variant), in key order. */
export function groupsOf(ledger: LedgerResult): Group[] {
  const m = new Map<string, Group>();
  for (const e of ledger.entries) {
    const key = `${e.family}|${e.ruleVersion}|${e.variant}`;
    let g = m.get(key);
    if (g === undefined)
      m.set(
        key,
        (g = {
          key,
          family: e.family,
          ruleVersion: e.ruleVersion,
          variant: e.variant,
          entries: [],
        }),
      );
    g.entries.push(e);
  }
  return [...m.values()].sort((a, b) => cmp(a.key, b.key));
}

const isoWeek = (d: string): string => {
  const t = new Date(`${d}T00:00:00Z`);
  const day = (t.getUTCDay() + 6) % 7; // Monday = 0 // threshold-ok: ISO weekday arithmetic (Monday = 0, Sunday = 6)
  t.setUTCDate(t.getUTCDate() - day + 3); // threshold-ok: ISO week: Thursday of the week
  const y = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4)); // threshold-ok: ISO week 1 contains 4 January
  const w =
    1 +
    Math.round(
      ((t.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7, // threshold-ok: ISO week arithmetic, ms per day, days per week
    );
  return `${y}-${String(w).padStart(2, "0")}`;
};
export { isoWeek };

/** Sample variance (n - 1). */
function sampleVariance(xs: readonly number[]): number {
  const m = meanOf(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - 1);
}

function ratNumber(r: Rational): number {
  return Number(r.num) / Number(r.den);
}

// ---- the run ------------------------------------------------------------------------------------------------------

function emptyReport(mode: RunMode, budget: number): ComputeReport {
  return {
    mode,
    budgetMinutes: budget,
    totalMinutes: 0,
    within: true,
    stages: [],
    sessions: 0,
    ledgerRows: 0,
    controlPaths: 0,
    cohorts: 0,
    status: "complete",
    pausedAt: null,
  };
}

/** Run one replay mode end to end. Deterministic given the snapshot, parameters and commit. */
export function runReplay(o: RunOptions): ReplayOutput {
  const { params, mode } = o;
  if (mode === "learning") throw new RangeError("learning mode runs through runLearning");
  const budget = o.budgetMinutes ?? budgetFor(mode, params);
  const tm = timer(o.now, budget);
  const paramsSha = agentParamsSha(params);
  const seed = params.replay.zeroEdgeSeed;
  const snapshotSha = o.snapshotBytes === null ? "synthetic" : fileSha(o.snapshotBytes); // content sha of the file bytes
  let sessions = 0;
  let ledgerRows = 0;
  let controlPaths = 0;
  let cohortCount = 0;
  const runId = runIdOf(mode, o.d, snapshotSha, o.commitSha);
  const stats: ReplayStatRow[] = [];
  const validation: ValidationResultRecord[] = [];
  const labels: LabelRecord[] = [];
  const trials: TrialLedgerRow[] = [];
  const lineages: LineageRecord[] = [];
  const splits: LineageSplitRecord[] = [];
  const files: RunFile[] = [];
  let size: SizeReport | null = null;
  let pausedAt: Stage | null = null;

  const addFile = (name: string, text: string): void => {
    files.push({
      name: `${runId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${name}.jsonl.gz`,
      bytes: gzipDeterministic(text),
    });
  };

  try {
    if (mode === "null" || mode === "injected") {
      size = runChecks(o, tm, runId, stats, validation);
    } else {
      if (o.snapshotBytes === null) throw new RangeError("this mode needs a snapshot");
      const snap = loadSnapshot(o.snapshotBytes);
      const world = tm.stage(
        "world",
        () => new SnapshotWorld(snap, { params, tierSource: "bars" }),
      );
      sessions = world.sessions.length;
      const first = world.sessions[0] ?? "";
      const lastIdx = world.sessions.length - 1;
      const fromD =
        mode === "light"
          ? (o.since ??
            world.sessions[Math.max(0, lastIdx - params.replay.tursoRecentSessions)] ??
            first)
          : first;
      const ledger = tm.stage("ledger", () => replayLedger(world, { params, from: fromD }));
      ledgerRows = ledger.entries.length;
      controlPaths = ledger.controlPaths;
      // FAM-005 (D-214): the cost-gate table from this run's own ledger, development rows only
      const costGate = costGateTableOf(
        ledger,
        world.sessions,
        params,
        runId,
        o.existingSplits ?? [],
      );
      const cohortsFor = (settlementMode: SettlementMode): CohortReplayResult =>
        replayCohorts(world, {
          params,
          from: fromD > first ? fromD : undefined,
          executions: unleveredExecutionIds(buildExecutionRegistry()), // D-191: no leverage
          // ARN-109 (D-225): replay statistics use `settlement_stats_mode` (default conservative)
          cohortParams: () => ({ settlementMode }),
          costGate,
          progress: () => {
            if (tm.elapsed() > budget) throw new OverBudget("cohorts");
          },
        });
      const statsMode = params.stats.settlementStatsMode;
      const otherMode: SettlementMode = statsMode === "matched" ? "conservative" : "matched";
      const sensitivity = mode === "full" || mode === "evidence";
      let otherCohorts: CohortReplayResult | null = null;
      const cohorts: CohortReplayResult = tm.stage("cohorts", () => {
        const main = cohortsFor(statsMode);
        if (sensitivity) otherCohorts = cohortsFor(otherMode);
        return main;
      });
      cohortCount = cohorts.cohorts.length;
      const built = tm.stage("stats", () =>
        buildReplayStats({
          runId,
          d: o.d,
          params,
          market: MARKET,
          families: [...FAMILIES],
          cohorts,
          ledger,
          src: world,
          timeoutSessions: CONFIG_KEYS.timeout_sessions.default,
        }),
      );
      stats.push(...built.rows);
      if (otherCohorts !== null) {
        // the same cohort statistics under the other settlement mode: a sensitivity, scope suffix `:<mode>`
        const alt = tm.stage("stats", () =>
          buildReplayStats({
            runId,
            d: o.d,
            params,
            market: MARKET,
            families: [...FAMILIES],
            cohorts: otherCohorts as CohortReplayResult,
            ledger: null,
            src: null,
            timeoutSessions: CONFIG_KEYS.timeout_sessions.default,
          }),
        );
        stats.push(...alt.rows.map((r) => ({ ...r, scope: `${r.scope}:${otherMode}` })));
      }
      if (mode === "evidence") {
        tm.stage("validation", () =>
          evidence(o, world, ledger, runId, {
            validation,
            labels,
            trials,
            lineages,
            splits,
            stats,
          }),
        );
      }
      addFile("ledger", `${serializeLedger(ledger)}\n`);
      addFile(
        "cohorts",
        jsonl(
          cohorts.cohorts.map((c) => ({
            id: c.id,
            execution: c.executionId,
            startD: c.startD,
            endD: c.endD,
            sessions: c.sessions,
            terminal: c.terminalKind,
            censored: c.censored,
            outcomeMicro: c.outcomeMicro,
          })),
        ),
      );
    }
  } catch (e) {
    if (e instanceof OverBudget) pausedAt = e.stage;
    else throw e;
  }

  const total = tm.elapsed();
  const report: ComputeReport = {
    ...emptyReport(mode, budget),
    totalMinutes: total,
    within: pausedAt === null && total <= budget,
    stages: tm.stages,
    sessions,
    ledgerRows,
    controlPaths,
    cohorts: cohortCount,
    status: pausedAt === null ? "complete" : "paused_budget",
    pausedAt,
  };
  // A paused run keeps no partial statistics: only its status and the compute report.
  const keep = pausedAt === null;
  const tail = statRows(runId, o.d, [
    { scope: "run", metric: "compute_report", value: report },
    { scope: "run", metric: "status", value: { status: report.status, stage: pausedAt } },
  ]);
  const allStats = keep ? [...stats, ...tail] : tail;
  const runRow = replayRunRow({
    id: runId,
    kind: mode,
    market: MARKET,
    snapshotSha,
    commitSha: o.commitSha,
    paramsSha,
    seed: BigInt(seed),
    nodeVersion: o.nodeVersion,
    minutes: Math.round(total * 1000) / 1000, // threshold-ok: rounding to 3 decimals
    files: keep ? files.map((f) => f.name) : [],
    // the digest covers the results, not the (clock-dependent) run scope
    digest: sha256Hex(
      canonicalJson(
        allStats.filter((s) => s.scope !== "run").map((s) => [s.scope, s.metric, s.value_json]),
      ),
    ),
  });
  return {
    run: runRow,
    stats: allStats,
    validation: keep ? validation : [],
    labels: keep ? labels : [],
    trials: keep ? trials : [],
    lineages: keep ? lineages : [],
    splits: keep ? splits : [],
    files: keep ? files : [],
    report,
    size,
  };
}

// ---- null / injected --------------------------------------------------------------------------------------------

function runChecks(
  o: RunOptions,
  tm: Timer,
  runId: string,
  stats: ReplayStatRow[],
  validation: ValidationResultRecord[],
): SizeReport | null {
  const { params, mode } = o;
  const budget = o.budgetMinutes ?? budgetFor(mode, params);
  const stop = (): boolean => tm.elapsed() > budget;
  const L = params.stats.activeLineagesFloor;
  const m = params.stats.trialBudgetPerLineage;
  const rec = (
    test: ValidationResultRecord["test"],
    f: Omit<
      ValidationResultRecord,
      | "id"
      | "run_id"
      | "lineage_id"
      | "rule_version"
      | "variant"
      | "split_version"
      | "test"
      | "L_used"
      | "m_used"
    >,
    variant: string,
  ): ValidationResultRecord => ({
    id: `val:${runId}:${variant}:${test}:${f.level}`,
    run_id: runId,
    lineage_id: `${MARKET}:F1`,
    rule_version: mode,
    variant,
    split_version: 0,
    test,
    L_used: L,
    m_used: m,
    ...f,
  });

  if (mode === "null") {
    const runs = o.nullRuns ?? NULL_RUNS_DEFAULT;
    let batch;
    if (o.synthetic === true || o.snapshotBytes === null) {
      batch = tm.stage("null", () => syntheticBatch("null", { runs, B: SIZE_B, shouldStop: stop }));
    } else {
      const world = tm.stage(
        "world",
        () => new SnapshotWorld(loadSnapshot(o.snapshotBytes!), { params, tierSource: "bars" }),
      );
      batch = tm.stage("null", () => {
        // q so the expected row count matches F1's measured rate on the real snapshot.
        const base = replayLedger(world, {
          params,
          controls: false,
          familyOptions: { families: ["F1"], restrictToU1: true },
        });
        let eligible = 0;
        for (const d of world.sessions) {
          eligible += world.controlUniverse(d).filter((u) => u.eligible).length;
        }
        const q = matchedQ(base.entries.length, eligible);
        return realNullBatch({ world, params, runs, q, B: SIZE_B, shouldStop: stop });
      });
    }
    const report = sizeReport(batch.tests, params);
    const items = [
      {
        scope: "null",
        metric: "size_report",
        value: { ...report, requested: batch.requested, completed: batch.tests.length },
      },
    ];
    stats.push(...statRows(runId, o.d, items));
    for (const l of report.levels) {
      validation.push(
        rec(
          "size",
          {
            level: l.level,
            B: SIZE_B,
            n: report.n,
            blocks: 0,
            stat: l.rate,
            p: null,
            mde: null,
            lower: report.n === 0 ? null : l.lo / report.n,
            upper: report.n === 0 ? null : l.hi / report.n,
            outcome: l.within ? "within binomial bounds" : "outside binomial bounds",
            reachable_d: null,
          },
          "random-signal",
        ),
      );
    }
    validation.push(
      rec(
        "ks",
        {
          level: UNIFORM_ALPHA,
          B: SIZE_B,
          n: report.uniformity.n,
          blocks: 0,
          stat: report.uniformity.d,
          p: report.uniformity.p,
          mde: null,
          lower: null,
          upper: null,
          outcome: report.uniformity.pass ? "uniform" : "not uniform",
          reachable_d: null,
        },
        "random-signal",
      ),
    );
    if (batch.pausedBudget) throw new OverBudget("null");
    return report;
  }

  // injected
  const power = 0.8; // threshold-ok: ARN-081 MDE power (gates.POWER)
  const { level, B } = workingLevel(params);
  const runs = o.nullRuns ?? 30; // threshold-ok: injected-edge detection runs
  const batch = tm.stage("injected", () =>
    syntheticBatch("injected", { runs, B: SIZE_B, shouldStop: stop }),
  );
  const det = detectionReport(batch.tests, params.stats.alpha / m, power);
  const rows = syntheticRows("injected", 0, INJECTED_SPEC, INJECTED_EDGE);
  const committed = testRows("injected", 0, rows, INJECTED_SPEC.sessions, INJECTED_SPEC.block, B);
  const few = fewBlocksCheck();
  stats.push(
    ...statRows(runId, o.d, [
      { scope: "injected", metric: "detection", value: { ...det, requested: batch.requested } },
      { scope: "injected", metric: "committed_seed", value: { level, ...committed } },
      { scope: "injected", metric: "few_blocks", value: few },
    ]),
  );
  validation.push(
    rec(
      "i",
      {
        level,
        B,
        n: committed.rows,
        blocks: committed.blocks,
        stat: det.rate,
        p: committed.p,
        mde: null,
        lower: null,
        upper: null,
        outcome: committed.p <= level ? "detected" : "not detected",
        reachable_d: null,
      },
      "injected-edge",
    ),
  );
  if (batch.pausedBudget) throw new OverBudget("injected");
  return null;
}

// ---- evidence ------------------------------------------------------------------------------------------------------

type Sinks = {
  validation: ValidationResultRecord[];
  labels: LabelRecord[];
  trials: TrialLedgerRow[];
  lineages: LineageRecord[];
  splits: LineageSplitRecord[];
  stats: ReplayStatRow[];
};

/** Closed rows as delisting-sensitivity input (net return as a float). */
function delistRows(entries: readonly LedgerEntry[]): DelistRow[] {
  const out: DelistRow[] = [];
  for (const e of entries) {
    if (e.net === null || e.row.exit_d === null) continue;
    out.push({
      id: e.row.id,
      code: e.code,
      entryD: e.row.entry_d,
      exitD: e.row.exit_d,
      net: Number(e.net.num) / Number(e.net.den),
    });
  }
  return out;
}

const EVENT_FAMILIES: ReadonlySet<Family> = new Set<Family>(["F2", "F3", "F5", "F6"]);

/**
 * FAM-005 (D-282): medians of gross return per (family, rule version, variant), through the same
 * `costGateRowsOf` as the live loader. The stored split of the lineage is used when one exists
 * (`existingSplits`); only without one is it recomputed from this run's ledger.
 */
export function costGateTableOf(
  ledger: LedgerResult,
  calendar: readonly string[],
  params: AgentParams,
  runId: string,
  existingSplits: readonly LineageSplitRecord[],
): CostGateTable {
  const rows: CostGateRow[] = [];
  for (const g of groupsOf(ledger)) {
    const lineage = lineageId(MARKET, g.family);
    const stored = existingSplits
      .filter((x) => x.lineage_id === lineage)
      .reduce<LineageSplitRecord | null>(
        (m, x) => (m === null || x.version > m.version ? x : m),
        null,
      );
    const split =
      stored ??
      createLineageSplit({
        market: MARKET,
        family: g.family,
        calendar,
        maxHoldingUpper: maxHoldingUpperBound(g.family),
        primaryRows: g.entries.map((e) => ({ entryD: e.row.entry_d, exitD: e.row.exit_d })),
        params: params.stats,
        measuredOnRun: runId,
      });
    rows.push(
      ...costGateRowsOf(
        g.entries.map((e) => ({
          family: g.family,
          ruleVersion: g.ruleVersion,
          variant: g.variant,
          entryD: e.row.entry_d,
          exitD: e.row.exit_d,
          grossNum: e.row.gross_num,
          grossDen: e.row.gross_den,
        })),
        split,
      ),
    );
  }
  return costGateTable(rows, params.entry.costGateMinRows);
}

function evidence(
  o: RunOptions,
  world: SnapshotWorld,
  ledger: LedgerResult,
  runId: string,
  sinks: Sinks,
): void {
  const { params } = o;
  const calendar = world.sessions;
  const index = new Map(calendar.map((d, i) => [d, i]));
  const cost = costSetupFrom(params);
  const groups = groupsOf(ledger);
  const existing = [...(o.existingTrials ?? [])];
  const all: TrialLedgerRow[] = [...existing];
  const activeLineages = new Set(groups.map((g) => lineageId(MARKET, g.family))).size;

  // daily Sharpe of every group over its development rows -> the frozen default SR variance
  const devSharpes: number[] = [];
  type Prep = { g: Group; split: LineageSplitRecord; lineage: string };
  const preps: Prep[] = [];
  for (const g of groups) {
    const lineage = lineageId(MARKET, g.family);
    const split = createLineageSplit({
      market: MARKET,
      family: g.family,
      calendar,
      maxHoldingUpper: maxHoldingUpperBound(g.family),
      primaryRows: g.entries.map((e) => ({ entryD: e.row.entry_d, exitD: e.row.exit_d })),
      params: params.stats,
      measuredOnRun: runId,
    });
    preps.push({ g, split, lineage });
    if (split.deferred_until_d === null) {
      const dev = g.entries.filter((e) => splitOf(split, e.row.entry_d) === "development");
      const daily = periodReturns(
        dailySeries({ ...ledger, entries: dev } as LedgerResult),
        cost.notionalMicro,
        (d) => d,
      ).map((x) => ratNumber(x.ret));
      if (daily.length > 2) devSharpes.push(returnMoments(daily).sharpe);
    }
  }
  const defaultSrVariance =
    devSharpes.length > 1 ? sampleVariance(devSharpes) : params.stats.dsrDefaultSrVariance;

  // Survivorship (DAT-125): the missing-share series, only when the snapshot carries announcements.
  const survivorship: SurvivorshipYear[] | null =
    world.announcements.length === 0
      ? null
      : survivorshipSeries({
          announcements: world.announcements,
          calendar,
          hasPrice: new Set(world.codes),
          params: params.stats,
        });
  if (survivorship !== null) {
    sinks.stats.push(
      ...statRows(runId, o.d, [{ scope: MARKET, metric: "survivorship", value: survivorship }]),
    );
  }

  const lineageSeen = new Set<string>();
  for (const { g, split, lineage } of preps) {
    if (!lineageSeen.has(lineage)) {
      lineageSeen.add(lineage);
      sinks.lineages.push(createLineage(MARKET, g.family, o.d));
    }
    sinks.splits.push(split);
    const kids = {
      executionId: `${g.family}-U`,
      ruleVersion: g.ruleVersion,
      variant: g.variant,
      d: o.d,
      params: params.stats,
      activeLineages,
      eventFamily: EVENT_FAMILIES.has(g.family),
      coverage: null,
      f5DescriptiveOnly: g.family === "F5",
      forward: null,
      doubledWithoutPass: false,
      survivorshipExposedShare:
        survivorship === null
          ? null
          : partitionByExposure(
              g.entries.map((e) => ({ entryD: e.row.entry_d })),
              survivorship,
            ).exposedShare,
      liveRuleDiffersFromVariant: false,
    } as const;
    if (split.deferred_until_d !== null) {
      sinks.labels.push(
        assignLabel({ ...kids, validation: null, holdout: null, costInfeasible: false }),
      );
      sinks.stats.push(
        ...statRows(runId, o.d, [
          {
            scope: `${lineage}:${g.ruleVersion}:${g.variant}`,
            metric: "split_deferred",
            value: { deferred_until_d: split.deferred_until_d },
          },
        ]),
      );
      continue;
    }

    const rowsIn = (name: "development" | "validation" | "holdout") =>
      g.entries.filter((e) => splitOf(split, e.row.entry_d) === name);

    // cost feasibility on the development rows (ARN-094, decision 29)
    const dev = rowsIn("development").filter((e) => e.row.gross_num !== null);
    const advOf = new Map<string, Map<string, bigint>>();
    const bps = (e: LedgerEntry): Rational => {
      let m = advOf.get(e.decisionD);
      if (m === undefined) {
        m = new Map(world.controlUniverse(e.decisionD).map((u) => [u.code, u.advMicro]));
        advOf.set(e.decisionD, m);
      }
      return bucketBpsFor(m.get(e.code) ?? 0n);
    };
    const feas = costFeasibility({
      rows: dev.map((e) => ({
        gross: makeRational(e.row.gross_num!, e.row.gross_den!),
        slippageBps: bps(e),
      })),
      notionalMicro: cost.notionalMicro,
      roundTripBrokerageMicro: roundTripBrokerage(cost, cost.notionalMicro),
      params: params.stats,
    });

    const evalWindow = (name: "validation" | "holdout") => {
      const sess =
        name === "validation"
          ? validationSessions(split, calendar)
          : calendar.filter((d) => d >= split.holdout_start_d! && d <= split.holdout_end_d!);
      const start = sess[0] === undefined ? 0 : index.get(sess[0])!;
      const rows: SignalRow[] = [];
      for (const e of rowsIn(name)) {
        const s = signalRowFromEntry(e, index.get(e.row.entry_d)! - start);
        if (s !== null) rows.push(s);
      }
      return { sess, rows, entries: rowsIn(name) };
    };

    const accessed = (kind: "validation_access" | "holdout_access") =>
      existing.some(
        (t) =>
          t.kind === kind &&
          t.lineage_id === lineage &&
          t.split_version === split.version &&
          t.rule_version === g.ruleVersion &&
          t.variant === g.variant,
      );

    let val: ReturnType<typeof evaluateVal110> | null = null;
    let hold: ReturnType<typeof evaluateHoldout> | null = null;
    const skipped: string[] = [];
    if (accessed("validation_access")) skipped.push("validation already accessed on this split");
    else {
      // VAL-112 (D-226): tests already spent on this split version (validation and pattern tests)
      const level112 = { priorTests: spentTestsBefore(all, lineage, split.version) };
      const access = trialLedgerRow({
        market: MARKET,
        lineage_id: lineage,
        split_version: split.version,
        kind: "validation_access",
        rule_version: g.ruleVersion,
        variant: g.variant,
        run_id: runId,
        d: o.d,
      });
      all.push(access);
      sinks.trials.push(access);
      const w = evalWindow("validation");
      const dailyVal = periodReturns(
        dailySeries(
          ledger,
          (e) => g.entries.includes(e) && splitOf(split, e.row.entry_d) === "validation",
        ),
        cost.notionalMicro,
        (d) => d,
      ).map((x) => ratNumber(x.ret));
      const weeklyOk = false;
      val = evaluateVal110({
        runId,
        lineageId: lineage,
        ruleVersion: g.ruleVersion,
        variant: g.variant,
        split,
        access,
        params: params.stats,
        activeLineages,
        rows: w.rows,
        sessionCount: w.sess.length,
        block: split.block_sessions,
        windowEndD: split.validation_end_d!,
        ...level112,
        trialsOnSplit: Math.max(1, trialCounts(all, lineage, split.version).total),
        costInfeasible: feas.costInfeasible,
        safety: null,
        pboWeekly: weeklyOk ? [] : null,
        dsr:
          dailyVal.length > 2 ? { daily: dailyVal, variantDailySr: [], defaultSrVariance } : null,
      });
      sinks.validation.push(...val.results);
      if (val.passes) {
        if (accessed("holdout_access")) skipped.push("holdout already used for this rule version");
        else {
          const hAccess = trialLedgerRow({
            market: MARKET,
            lineage_id: lineage,
            split_version: split.version,
            kind: "holdout_access",
            rule_version: g.ruleVersion,
            variant: g.variant,
            run_id: runId,
            d: o.d,
          });
          all.push(hAccess);
          sinks.trials.push(hAccess);
          const h = evalWindow("holdout");
          hold = evaluateHoldout({
            runId,
            lineageId: lineage,
            ruleVersion: g.ruleVersion,
            variant: g.variant,
            split,
            access: hAccess,
            params: params.stats,
            activeLineages,
            rows: h.rows,
            sessionCount: h.sess.length,
            block: split.block_sessions,
            windowEndD: split.holdout_end_d!,
          });
          sinks.validation.push(hold.result);
        }
      }
    }
    const label = assignLabel({
      ...kids,
      validation: val,
      holdout: hold,
      costInfeasible: feas.costInfeasible,
    });
    sinks.labels.push(label);
    sinks.stats.push(
      ...statRows(runId, o.d, [
        {
          scope: `${lineage}:${g.ruleVersion}:${g.variant}`,
          metric: "evidence",
          value: {
            label: label.label,
            n: label.n,
            mde: label.mde,
            skipped,
            costInfeasible: feas.costInfeasible,
            block: split.block_sessions,
            delisting: delistingSensitivity(delistRows(g.entries), world.delistings),
          },
        },
      ]),
    );
  }
}

export { blockOf };
