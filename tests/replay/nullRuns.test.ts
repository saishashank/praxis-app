// @vitest-environment node
// AT-17 engine checks on synthetic rows (M4 T16, decision 31): a 200-run size check (random-signal
// null with permuted returns keeps the rejection rates at 0.05 and 0.01 inside the exact 99 %
// binomial acceptance region, lower-tail p-values uniform), an injected-edge detection test at the
// stated power, the committed-seed run at the working level (0.000417, B = 48,000) and the
// "insufficient independent blocks" window. Each test stays well under 60 s.
import { describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import {
  DEFAULT_SPEC,
  detectionReport,
  fewBlocksCheck,
  INJECTED_SPEC,
  sizeReport,
  syntheticBatch,
  syntheticRows,
  testRows,
  workingLevel,
} from "@/lib/replay/nullRuns";
import { POWER } from "@/lib/stats/gates";

const params = defaultAgentParams();

describe("null runs (size)", () => {
  it("200 runs: rejection rates inside the binomial bounds, lower-tail p-values uniform", () => {
    const batch = syntheticBatch("null", {
      runs: 200,
      B: params.stats.bootstrapSizeCheckReplications,
    });
    expect(batch.tests).toHaveLength(200);
    expect(batch.pausedBudget).toBe(false);
    const r = sizeReport(batch.tests, params);
    for (const l of r.levels) expect(l.within, JSON.stringify(l)).toBe(true);
    expect(r.uniformity.pass, JSON.stringify(r.uniformity)).toBe(true);
    expect(r.pass).toBe(true);
    expect(r.extrapolated.map((x) => x.level)).toEqual([0.0025, 0.05 / 120]);
  }, 60_000);

  it("is deterministic and the null rows have no built-in edge", () => {
    const a = syntheticRows("null", 3, DEFAULT_SPEC, 0);
    const b = syntheticRows("null", 3, DEFAULT_SPEC, 0);
    expect(a).toEqual(b);
    expect(syntheticRows("null", 4, DEFAULT_SPEC, 0)).not.toEqual(a);
  });

  it("a stop request pauses the batch cleanly", () => {
    let calls = 0;
    const batch = syntheticBatch("null", { runs: 50, B: 200, shouldStop: () => ++calls > 3 });
    expect(batch.tests).toHaveLength(3);
    expect(batch.pausedBudget).toBe(true);
  });
});

describe("injected edge", () => {
  it("is detected at the stated power (80 %) at the validation level", () => {
    const batch = syntheticBatch("injected", {
      runs: 30,
      B: params.stats.bootstrapSizeCheckReplications,
    });
    const d = detectionReport(batch.tests, 0.0025, POWER);
    expect(d.rate, JSON.stringify(d)).toBeGreaterThanOrEqual(POWER);
    expect(d.pass).toBe(true);
    expect(d.medianMean!).toBeGreaterThan(0.01);
  }, 60_000);

  it("the committed seed rejects at 0.000417 with B = 48,000", () => {
    const { level, B } = workingLevel(params);
    expect(B).toBe(48_000);
    const rows = syntheticRows("injected", 0, INJECTED_SPEC, 0.015);
    const t = testRows("injected", 0, rows, INJECTED_SPEC.sessions, INJECTED_SPEC.block, B);
    expect(t.p).toBeLessThanOrEqual(level);
  }, 60_000);

  it("a window with fewer than 15 blocks is insufficient", () => {
    const t = fewBlocksCheck();
    expect(t.insufficientBlocks).toBe(true);
    expect(t.blocks).toBeLessThan(15);
  });
});
