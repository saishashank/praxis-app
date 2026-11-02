// @vitest-environment node
// M6 T12: the weekly learning run's orchestration (stage order, budget stop at a stage boundary, resume
// from the first unfinished stage, nothing run twice in a week) with fake stages and a fake clock.
import { describe, expect, it } from "vitest";
import {
  LEARNING_STAGES,
  RESUMABLE_STAGES,
  runWeekly,
  stageMetric,
  stageOfMetric,
  unfinishedStages,
  type LearningStage,
  type StageFn,
} from "@/lib/learning/weeklyRun";

const ORDER: LearningStage[] = [
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
];

/** Stages that record their call order and advance the fake clock by `stepMs` each. */
function fakes(calls: LearningStage[], tick: { t: number }, stepMs: number) {
  const stages = {} as Record<LearningStage, StageFn>;
  for (const s of ORDER) {
    stages[s] = async () => {
      calls.push(s);
      tick.t += stepMs;
      return { stats: [{ scope: "AU", metric: s, value: { s } }] };
    };
  }
  return stages;
}

describe("weekly learning run: stage order", () => {
  it("forward data, comparisons, lessons, pre-registered (M14), challengers, rolls, ARN-076, AGT-112 buckets, robustness and rank quality (M14)", async () => {
    expect([...LEARNING_STAGES]).toEqual(ORDER);
    const calls: LearningStage[] = [];
    const tick = { t: 0 };
    const r = await runWeekly({
      now: () => tick.t,
      budgetMinutes: 30,
      done: new Set(),
      stages: fakes(calls, tick, 1000),
    });
    expect(calls).toEqual(ORDER);
    expect(r.ran).toEqual(ORDER);
    expect(r.status).toBe("complete");
    expect(r.pausedAt).toBeNull();
    expect([...r.outputs.keys()]).toEqual(ORDER);
    expect(r.timings.map((t) => t.stage)).toEqual(ORDER);
  });

  it("stage markers round-trip and forward is never a marker (it is rebuilt every run)", () => {
    expect(RESUMABLE_STAGES).not.toContain("forward");
    for (const s of RESUMABLE_STAGES) expect(stageOfMetric(stageMetric(s))).toBe(s);
    expect(stageOfMetric("stage:forward")).toBeNull();
    expect(stageOfMetric("compute_report")).toBeNull();
  });
});

describe("weekly learning run: budget stop", () => {
  const MIN = 60_000;

  it("stops at the stage that ends over budget, drops its output, records paused_budget", async () => {
    const calls: LearningStage[] = [];
    const tick = { t: 0 };
    // two minutes per stage against a five-minute budget: forward 2, comparisons 4, lessons 6 > 5
    const r = await runWeekly({
      now: () => tick.t,
      budgetMinutes: 5,
      done: new Set(),
      stages: fakes(calls, tick, 2 * MIN),
    });
    expect(r.status).toBe("paused_budget");
    expect(r.pausedAt).toBe("lessons");
    expect(calls).toEqual(["forward", "comparisons", "lessons"]);
    expect(r.ran).toEqual(["forward", "comparisons"]);
    expect([...r.outputs.keys()]).toEqual(["forward", "comparisons"]);
    expect(r.outputs.has("lessons")).toBe(false); // no partial statistics of the cut-off stage
    expect(r.totalMinutes).toBeCloseTo(6, 6);
  });

  it("resumes from the first unfinished stage and skips the finished ones", async () => {
    const calls: LearningStage[] = [];
    const tick = { t: 0 };
    const r = await runWeekly({
      now: () => tick.t,
      budgetMinutes: 30,
      done: new Set<LearningStage>(["comparisons"]),
      stages: fakes(calls, tick, MIN),
    });
    expect(r.skipped).toEqual(["comparisons"]);
    expect(calls).toEqual([
      "forward",
      "lessons",
      "preregistered",
      "challengers",
      "rolls",
      "arn076",
      "factors",
      "robustness",
      "rankIc",
      "experts",
    ]);
    expect(r.status).toBe("complete");
  });

  it("a finished week has nothing unfinished (the CLI returns before building the snapshot)", () => {
    expect(unfinishedStages(new Set(RESUMABLE_STAGES))).toEqual([]);
    expect(unfinishedStages(new Set<LearningStage>(["comparisons", "factors"]))).toEqual([
      "lessons",
      "preregistered",
      "challengers",
      "rolls",
      "arn076",
      "robustness",
      "rankIc",
      "experts",
    ]);
  });
});
