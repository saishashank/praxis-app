// Replay mode `learning`: the weekly learning run (M6 T12; docs/M6_design.md 4.6; D-095, D-110 #23/#24/
// #41; D-124 draft). Asynchronous because the stages read and write the learning tables, so it is not
// part of the synchronous `runReplay`; the CLI calls `runLearning` for `--mode learning`.
//
// Idempotent per ISO week: a run id is `replay:learning:<market>:<week>:<snapshot>:<commit>`, finished
// stages are recorded as `replay_stat` rows (scope `learning`, metric `stage:<name>`), and a run skips
// every stage a run of the same week already finished. A week whose stages are all recorded is a
// no-op (`learningDone`). A stage that ends over `replay_light_minutes` stops the run at that boundary
// with `paused_budget`; its output is dropped and the next run resumes from it. Stage writers are
// idempotent, so a stage cut off after its database writes simply runs again and writes nothing new.
import type { Client } from "@libsql/client";
import { liveParams, loadVersionSet } from "@/lib/agents/versionRuns";
import type { AgentParams } from "@/lib/agents/params";
import { agentParamsSha } from "@/lib/agents/params";
import { canonicalJson, sha256Hex } from "@/lib/arena/cohort";
import { gzipDeterministic, sha256Hex as fileSha } from "@/lib/data/backfill/rules.mjs";
import type { Family } from "@/lib/agents/schema";
import type { FamilyOutput } from "@/lib/agents/families";
import {
  arn076Stage,
  challengersStage,
  comparisonsStage,
  factorsStage,
  lessonsStage,
  loadMarketCalendar,
  preRegisteredStage,
  rollsStage,
  type WeeklyContext,
} from "@/lib/learning/weeklyStages";
import { expertsStage } from "@/lib/experts/weeklyStage";
import { rankIcStage } from "@/lib/learning/rankIcStage";
import { robustnessStage } from "@/lib/learning/robustnessStage";
import {
  LEARNING_SCOPE,
  RESUMABLE_STAGES,
  runWeekly,
  stageMetric,
  stageOfMetric,
  unfinishedStages,
  type LearningStage,
  type StageFn,
} from "@/lib/learning/weeklyRun";
import { replayLedger, type EntryFacts, type LedgerResult } from "./ledger";
import { replayRunRow, statRows, type ReplayStatInput, type ReplayStatRow } from "./scorecards";
import { loadSnapshot } from "./snapshot";
import { SnapshotWorld } from "./snapshotWorld";
import { budgetFor, isoWeek, type ComputeReport, type ReplayOutput, type RunFile } from "./runner";

const MARKET = "AU";

export const learningRunId = (
  market: string,
  week: string,
  snapshotSha: string,
  commitSha: string,
): string =>
  `replay:learning:${market}:${week}:${snapshotSha.slice(0, 8)}:${commitSha.slice(0, 8)}`;

/** The ISO week of a run date (the idempotency unit). */
export const learningWeek = (d: string): string => isoWeek(d);

/** Stages recorded as finished by any run of the week. */
export async function finishedStages(
  db: Client,
  market: string,
  week: string,
): Promise<Set<LearningStage>> {
  const rs = await db.execute({
    sql: `SELECT s.metric FROM replay_stat s JOIN replay_run r ON r.id = s.run_id
          WHERE r.kind = 'learning' AND r.market = ? AND s.scope = ? AND s.metric LIKE 'stage:%'
            AND r.id LIKE ?`,
    args: [market, LEARNING_SCOPE, `replay:learning:${market}:${week}:%`],
  });
  const out = new Set<LearningStage>();
  for (const r of rs.rows) {
    const s = stageOfMetric(String(r.metric));
    if (s !== null) out.add(s);
  }
  return out;
}

/** True when every stage of the week is recorded: the run is a no-op. */
export async function learningDone(db: Client, market: string, week: string): Promise<boolean> {
  return unfinishedStages(await finishedStages(db, market, week)).length === 0;
}

export type LearningRunOptions = {
  readonly db: Client;
  readonly market?: string;
  readonly d: string;
  readonly params: AgentParams;
  readonly commitSha: string;
  readonly nodeVersion: string;
  readonly snapshotBytes: Uint8Array;
  readonly now: () => number;
  readonly budgetMinutes?: number;
};

export type LearningOutput = ReplayOutput & {
  /** Stages this run finished / skipped (an earlier run of the week finished them). */
  readonly ran: readonly LearningStage[];
  readonly skipped: readonly LearningStage[];
};

const slug = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]+/g, "-"); // threshold-ok: file-name slug pattern

/** Run the weekly learning run; rows are returned in the `ReplayOutput` shape for the CLI's writer. */
export async function runLearning(o: LearningRunOptions): Promise<LearningOutput | null> {
  const market = o.market ?? MARKET;
  const week = learningWeek(o.d);
  const done = await finishedStages(o.db, market, week);
  if (unfinishedStages(done).length === 0) return null;
  const budget = o.budgetMinutes ?? budgetFor("learning", o.params);
  const snapshotSha = fileSha(o.snapshotBytes);
  const runId = learningRunId(market, week, snapshotSha, o.commitSha);

  let ctx: WeeklyContext | null = null;
  const need = (): WeeklyContext => {
    if (ctx === null) throw new Error("forward stage has not run");
    return ctx;
  };
  const wrap =
    (f: (c: WeeklyContext) => ReturnType<StageFn>): StageFn =>
    () =>
      f(need());
  const forward: StageFn = async () => {
    const snap = loadSnapshot(o.snapshotBytes);
    const world = new SnapshotWorld(snap, { params: o.params, tierSource: "bars" });
    const set = await loadVersionSet(o.db, market, []);
    const live = liveParams(o.params, set);
    const ruleVersions: Partial<Record<Family, string>> = {};
    for (const [family, v] of set === null ? [] : [...set.live]) ruleVersions[family] = v.id;
    const facts = new Map<string, EntryFacts>();
    const familyOutputs = new Map<string, Pick<FamilyOutput, "candidates" | "blocked">>();
    const ledger: LedgerResult = replayLedger(world, {
      params: live,
      familyOptions: { ruleVersions },
      factsSink: facts,
      outputSink: familyOutputs,
    });
    ctx = {
      db: o.db,
      market,
      d: o.d,
      params: live,
      runId,
      world,
      ledger,
      facts,
      familyOutputs,
      calendar: await loadMarketCalendar(o.db, market),
    };
    return {
      stats: [
        {
          scope: market,
          metric: "forward",
          value: { sessions: world.sessions.length, ledger_rows: ledger.entries.length },
        },
      ],
    };
  };

  const result = await runWeekly({
    now: o.now,
    budgetMinutes: budget,
    done,
    stages: {
      forward,
      comparisons: wrap(comparisonsStage),
      lessons: wrap(lessonsStage),
      preregistered: wrap(preRegisteredStage),
      challengers: wrap(challengersStage),
      rolls: wrap(rollsStage),
      arn076: wrap(arn076Stage),
      factors: wrap(factorsStage),
      robustness: wrap(robustnessStage),
      rankIc: wrap(rankIcStage),
      experts: wrap(expertsStage),
    },
  });

  const items: ReplayStatInput[] = [];
  const files: RunFile[] = [];
  for (const [stage, out] of result.outputs) {
    items.push(...out.stats);
    if (stage !== "forward") {
      items.push({
        scope: LEARNING_SCOPE,
        metric: stageMetric(stage),
        value: { done: true },
      });
    }
    if (out.file) {
      files.push({
        name: `${slug(runId)}-${out.file.name}.jsonl.gz`,
        bytes: gzipDeterministic(out.file.text),
      });
    }
  }
  const complete = result.status === "complete";
  const report: ComputeReport = {
    mode: "learning",
    budgetMinutes: budget,
    totalMinutes: result.totalMinutes,
    within: complete && result.totalMinutes <= budget,
    stages: result.timings,
    sessions: 0,
    ledgerRows: 0,
    controlPaths: 0,
    cohorts: 0,
    status: complete ? "complete" : "paused_budget",
    pausedAt: result.pausedAt,
  };
  const sessions = (ctx as WeeklyContext | null)?.world.sessions.length ?? 0;
  const ledgerRows = (ctx as WeeklyContext | null)?.ledger.entries.length ?? 0;
  const full: ComputeReport = { ...report, sessions, ledgerRows };
  items.push({ scope: "run", metric: `compute_report:${o.d}`, value: full });
  if (complete) {
    items.push({
      scope: LEARNING_SCOPE,
      metric: "status",
      value: { status: "complete", stages: RESUMABLE_STAGES },
    });
  } else {
    items.push({
      scope: LEARNING_SCOPE,
      metric: `paused:${o.d}`,
      value: { status: "paused_budget", stage: result.pausedAt },
    });
  }
  const stats: ReplayStatRow[] = statRows(runId, o.d, items);
  const run = replayRunRow({
    id: runId,
    kind: "learning",
    market,
    snapshotSha,
    commitSha: o.commitSha,
    paramsSha: agentParamsSha(o.params),
    seed: BigInt(o.params.replay.zeroEdgeSeed),
    nodeVersion: o.nodeVersion,
    minutes: Math.round(result.totalMinutes * 1000) / 1000, // threshold-ok: rounding to 3 decimals
    files: files.map((f) => f.name),
    // the digest covers the results, not the (clock-dependent) run scope
    digest: sha256Hex(
      canonicalJson(
        stats.filter((s) => s.scope !== "run").map((s) => [s.scope, s.metric, s.value_json]),
      ),
    ),
  });
  return {
    run,
    stats,
    validation: [],
    labels: [],
    trials: [],
    lineages: [],
    splits: [],
    files,
    report: full,
    size: null,
    ran: result.ran,
    skipped: result.skipped,
  };
}
