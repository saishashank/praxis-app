// Weekly learning run: stage orchestration (M6 T12; docs/M6_design.md 4.6; D-095, D-110 #23/#24/#41;
// D-124 draft). Pure of any database or clock of its own: the caller supplies the stage functions and
// a millisecond clock, so the tests can drive the order, the budget stop and the resume rule.
//
// Stage order (fixed):
//   forward       the replay of the live rule versions over the snapshot (always runs, it is in memory);
//   comparisons   weekly Benjamini-Hochberg tests and the confirmation looks that are due;
//   lessons       windows, L0/L1, L2 by alpha-investing, retirement;
//   preregistered M14 (KB-081, O-46): releases the pre-registered challengers as slots free up;
//   challengers   the weekly generator, proposed -> replay, VAL-110 evidence (holdout confirmations due
//                 are listed, not run);
//   rolls         `rollAfterPromotion` for every promotion applied since the last run (D-121);
//   arn076        leave-one-class-out (F6 classes, F4 event filter);
//   factors       AGT-112 development factor buckets;
//   robustness    M14 (ARN-106/107/108, VAL-115): exit ablation, one-tick slip, neighbourhood, MinBTL;
//   rankIc        M14 (VAL-114): backfill of the daily rank quality from the replay;
//   experts       M13-lite (D-517): screens confirmed expert clusters and offers survivors to createChallenger;
//                 last so the v1 generator keeps priority on the weekly cap and the KB-042 slots.
// A stage that ends over the budget stops the run at that boundary (`paused_budget`) and its output is
// dropped: no partial statistics are kept (D-095). Stages that finished in an earlier run of the same
// ISO week are skipped (`done`), so a paused week resumes from the first unfinished stage and a finished
// week is a no-op. Every stage writer is idempotent, so a stage that was cut off is simply run again.
import type { ReplayStatInput } from "@/lib/replay/scorecards";

export const LEARNING_STAGES = [
  "forward",
  "comparisons",
  "lessons",
  "preregistered",
  "challengers",
  "rolls",
  "arn076",
  "factors",
  "robustness",
  "rankIc",
  "experts",
] as const;
export type LearningStage = (typeof LEARNING_STAGES)[number];
/** The stages that are recorded as done and can be skipped (forward is always rebuilt). */
export const RESUMABLE_STAGES: readonly LearningStage[] = LEARNING_STAGES.slice(1);

export type StageFile = { readonly name: string; readonly text: string };
export type StageOutput = {
  readonly stats: readonly ReplayStatInput[];
  readonly file?: StageFile | null;
};
export type StageFn = () => Promise<StageOutput>;

/** A registered stage with nothing to do yet (M14 WP0): marks itself done and writes no statistic. */
export const noopStage: StageFn = async () => ({ stats: [] });

export type StageTiming = { readonly stage: LearningStage; readonly minutes: number };

export type WeeklyOptions = {
  readonly now: () => number;
  readonly budgetMinutes: number;
  /** Stages finished by earlier runs of this ISO week. */
  readonly done: ReadonlySet<LearningStage>;
  readonly stages: Readonly<Record<LearningStage, StageFn>>;
};

export type WeeklyResult = {
  readonly status: "complete" | "paused_budget";
  readonly pausedAt: LearningStage | null;
  /** Stages run to completion within budget in this run, in order (output kept). */
  readonly ran: readonly LearningStage[];
  /** Stages skipped because an earlier run of the week finished them. */
  readonly skipped: readonly LearningStage[];
  readonly outputs: ReadonlyMap<LearningStage, StageOutput>;
  readonly timings: readonly StageTiming[];
  readonly totalMinutes: number;
};

const MS_PER_MINUTE = 60_000; // threshold-ok: ms per minute

export async function runWeekly(o: WeeklyOptions): Promise<WeeklyResult> {
  const t0 = o.now();
  const elapsed = (): number => (o.now() - t0) / MS_PER_MINUTE;
  const ran: LearningStage[] = [];
  const skipped: LearningStage[] = [];
  const timings: StageTiming[] = [];
  const outputs = new Map<LearningStage, StageOutput>();
  let pausedAt: LearningStage | null = null;
  for (const stage of LEARNING_STAGES) {
    if (stage !== "forward" && o.done.has(stage)) {
      skipped.push(stage);
      continue;
    }
    const a = o.now();
    const out = await o.stages[stage]();
    timings.push({ stage, minutes: (o.now() - a) / MS_PER_MINUTE });
    if (elapsed() > o.budgetMinutes) {
      pausedAt = stage;
      break;
    }
    outputs.set(stage, out);
    ran.push(stage);
  }
  return {
    status: pausedAt === null ? "complete" : "paused_budget",
    pausedAt,
    ran,
    skipped,
    outputs,
    timings,
    totalMinutes: elapsed(),
  };
}

/** Stages of the week still to run, given those done. Empty = the week is finished. */
export function unfinishedStages(done: ReadonlySet<LearningStage>): LearningStage[] {
  return RESUMABLE_STAGES.filter((s) => !done.has(s));
}

/** Marker metric of a finished stage in `replay_stat` (scope `learning`). */
export const stageMetric = (stage: LearningStage): string => `stage:${stage}`;
export const LEARNING_SCOPE = "learning";

export function stageOfMetric(metric: string): LearningStage | null {
  if (!metric.startsWith("stage:")) return null;
  const s = metric.slice("stage:".length);
  return (RESUMABLE_STAGES as readonly string[]).includes(s) ? (s as LearningStage) : null;
}
