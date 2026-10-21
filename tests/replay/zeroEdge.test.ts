// @vitest-environment node
// Zero-edge benchmark (M4 T14; decision 32; ARN-071, PRD-020): seeded Monte-Carlo cohorts with no
// edge. Seed stability (same seed, same numbers; the pinned values change only with a deliberate
// engine change or a Node upgrade, design 2.8), limiting cases with known answers, and validation.
import { describe, expect, it } from "vitest";
import { resolveCohortParams } from "@/lib/arena/cohort";
import { zeroEdge, type ZeroEdgeInput } from "@/lib/replay/zeroEdge";

const base: ZeroEdgeInput = {
  family: "F1",
  ruleVersion: "F1.v1",
  dailyVol: 0.03,
  entryRate: 0.1,
  meanHoldSessions: 12,
  slippageBps: 25,
  params: resolveCohortParams({}),
  trials: 2000,
  seed: 20261018,
};

describe("seed stability", () => {
  const r = zeroEdge(base);

  it("the same input and seed give identical output; another seed does not", () => {
    expect(zeroEdge(base)).toEqual(r);
    expect(zeroEdge({ ...base, seed: base.seed + 1 }).probability).not.toEqual(r.probability);
  });

  it("is scoped per (family, rule version): another family draws another stream", () => {
    expect(r.scope).toBe("zeroedge:F1:F1.v1");
    expect(zeroEdge({ ...base, family: "F2", ruleVersion: "F2.v1" }).probability).not.toEqual(
      r.probability,
    );
  });

  it("pinned golden values for seed 20261018 (2,000 trials)", () => {
    expect(r.probability.target).toBe(13 / 2000);
    expect(r.probability.bust).toBe(0);
    expect(r.probability.stalled).toBe(0.7925);
    expect(r.probability.timeout).toBe(0.201);
    expect(r.meanNavMinusSeedMicro).toBeCloseTo(-73_842_925.41727136, 4);
    expect(r.meanSessions).toBe(126.152);
  });

  it("probabilities sum to one and carry their Monte-Carlo standard errors", () => {
    const sum =
      r.probability.target + r.probability.bust + r.probability.stalled + r.probability.timeout;
    expect(sum).toBeCloseTo(1, 12);
    expect(r.mcSe.stalled).toBeCloseTo(
      Math.sqrt((r.probability.stalled * (1 - r.probability.stalled)) / 2000),
      12,
    );
    expect(r.trials).toBe(2000);
    expect(r.seed).toBe(20261018);
    expect(r.navMcSeMicro).toBeGreaterThan(0);
  });
});

describe("limiting cases", () => {
  it("never an opportunity: every cohort sits in cash until the timeout", () => {
    const r = zeroEdge({ ...base, entryRate: 0, trials: 200 });
    expect(r.probability).toEqual({ target: 0, bust: 0, stalled: 0, timeout: 1 });
    expect(r.meanNavMinusSeedMicro).toBe(0);
    expect(r.meanSessions).toBe(base.params.terminal.timeoutSessions);
  });

  it("no volatility: costs only, so no cohort can reach the target", () => {
    const r = zeroEdge({ ...base, dailyVol: 0, entryRate: 1, trials: 200 });
    expect(r.probability.target).toBe(0);
    expect(r.meanNavMinusSeedMicro).toBeLessThan(0);
  });

  it("a very volatile market reaches the target and the bust level far more often", () => {
    const calm = zeroEdge({ ...base, dailyVol: 0.01, entryRate: 1, slippageBps: 0, trials: 1000 });
    const wild = zeroEdge({ ...base, dailyVol: 0.2, entryRate: 1, slippageBps: 0, trials: 1000 });
    expect(wild.probability.target + wild.probability.bust).toBeGreaterThan(
      calm.probability.target + calm.probability.bust,
    );
  });
});

describe("validation", () => {
  it("refuses impossible inputs", () => {
    expect(() => zeroEdge({ ...base, trials: 0 })).toThrow(RangeError);
    expect(() => zeroEdge({ ...base, dailyVol: -0.1 })).toThrow(RangeError);
    expect(() => zeroEdge({ ...base, entryRate: 1.5 })).toThrow(RangeError);
  });
});
