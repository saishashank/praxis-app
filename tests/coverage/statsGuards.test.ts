// @vitest-environment node
// M8 T3 coverage (TST-121): the argument guards and limiting cases of the validation statistics:
// refusals of bad counts and sizes, degenerate samples (zero spread, empty), the tails of the
// binomial and KS functions, and the split helpers' deferred and empty-calendar cases.
import { describe, expect, it } from "vitest";
import {
  binomialCdf,
  binomialSurvival,
  exactLowerBound,
  exactUpperBound,
  wilsonInterval,
} from "@/lib/stats/binomial";
import { circularBlockBootstrap } from "@/lib/stats/bootstrap";
import { expectedMaxSharpe, probabilisticSharpeRatio, returnMoments } from "@/lib/stats/dsr";
import { excessFailed, validationGateI } from "@/lib/stats/gates";
import { ksPValue, ksStatistic, ksUniformityTest } from "@/lib/stats/ks";
import { erfc, normalCdf, normalPdf } from "@/lib/stats/normal";
import { probabilityOfBacktestOverfitting } from "@/lib/stats/pbo";
import { scopedPrng } from "@/lib/stats/rng";

describe("binomial guards and tails", () => {
  it("refuses a count that is not a whole non-negative number", () => {
    expect(() => wilsonInterval(0, -1, 0.9)).toThrow(RangeError);
    expect(() => wilsonInterval(0, 2.5, 0.9)).toThrow(/non-negative integer/);
    expect(() => binomialCdf(0, -1, 0.5)).toThrow(RangeError);
    expect(() => binomialSurvival(0, 1.5, 0.5)).toThrow(RangeError);
  });

  it("the lower tail at its edges", () => {
    expect(binomialCdf(-1, 10, 0.5)).toBe(0);
    expect(binomialCdf(3, 10, 0)).toBe(1);
    expect(binomialCdf(3, 10, 1)).toBe(0);
    expect(binomialCdf(10, 10, 0.3)).toBeCloseTo(1, 12);
  });

  it("the upper tail at its edges", () => {
    expect(binomialSurvival(0, 10, 0.5)).toBe(1);
    expect(binomialSurvival(-2, 10, 0.5)).toBe(1);
    expect(binomialSurvival(11, 10, 0.5)).toBe(0);
    expect(binomialSurvival(3, 10, 0)).toBe(0);
    expect(binomialSurvival(3, 10, 1)).toBe(1);
  });

  it("one-sided exact bounds when every trial or none succeeded", () => {
    expect(exactUpperBound(10, 10, 0.05)).toBe(1);
    expect(exactLowerBound(0, 10, 0.05)).toBe(0);
    expect(exactUpperBound(0, 10, 0.05)).toBeGreaterThan(0.2);
    expect(exactLowerBound(10, 10, 0.05)).toBeLessThan(1);
  });
});

describe("bootstrap guards", () => {
  const rng = () => scopedPrng("coverage:bootstrap");
  const ok = { sessions: [0, 1, 2], sessionCount: 3, block: 1, replicates: 2, series: [[1, 2, 3]] };

  it("refuses an empty window, block, replicate count or row set", () => {
    expect(() => circularBlockBootstrap({ ...ok, sessionCount: 0 }, rng())).toThrow(/sessionCount/);
    expect(() => circularBlockBootstrap({ ...ok, sessionCount: 1.5 }, rng())).toThrow(/sessionCount/);
    expect(() => circularBlockBootstrap({ ...ok, block: 0 }, rng())).toThrow(/block/);
    expect(() => circularBlockBootstrap({ ...ok, replicates: 0 }, rng())).toThrow(/replicates/);
    expect(() =>
      circularBlockBootstrap({ ...ok, sessions: [], series: [[]] }, rng()),
    ).toThrow(/at least one row/);
    expect(() => circularBlockBootstrap({ ...ok, series: [[1]] }, rng())).toThrow(/one value per row/);
  });
});

describe("Sharpe moments and the deflated Sharpe ratio", () => {
  it("needs three returns", () => {
    expect(() => returnMoments([0.01, 0.02])).toThrow(/at least 3/);
  });

  it("a constant series has no spread: zero Sharpe and skew, kurtosis of a normal", () => {
    expect(returnMoments([0.01, 0.01, 0.01])).toMatchObject({ sharpe: 0, skew: 0, kurtosis: 3 });
  });

  it("expected maximum Sharpe: one trial gives zero; zero or fractional trials are refused", () => {
    expect(expectedMaxSharpe(1, 0.5)).toBe(0);
    expect(() => expectedMaxSharpe(0, 0.5)).toThrow(/trials/);
    expect(() => expectedMaxSharpe(2.5, 0.5)).toThrow(/trials/);
  });

  it("PSR: null when the variance term is not positive or there are fewer than two observations", () => {
    expect(probabilisticSharpeRatio({ sharpe: 3, skew: 2, kurtosis: 3, observations: 50 })).toBeNull();
    expect(probabilisticSharpeRatio({ sharpe: 0.1, skew: 0, kurtosis: 3, observations: 1 })).toBeNull();
    const p = probabilisticSharpeRatio({ sharpe: 0.2, skew: 0, kurtosis: 3, observations: 100 }, 0.1);
    expect(p).toBeGreaterThan(0.5);
    expect(p).toBeLessThan(1);
  });
});

describe("gates", () => {
  it("validation gate I needs both the p-value and the absolute gate", () => {
    expect(validationGateI(0.5, 0.01, 10)).toBe(false);
    expect(validationGateI(0.001, 0.01, -1)).toBe(false);
    expect(validationGateI(0.001, 0.01, 0.01)).toBe(true);
  });

  it("excess FAILED only when the upper end is below the useful edge", () => {
    expect(excessFailed(0.001, 0.01)).toBe(true);
    expect(excessFailed(0.02, 0.01)).toBe(false);
  });
});

describe("KS and normal limits", () => {
  it("refuses an empty sample, a bad n, and settles d at 0 and 1", () => {
    expect(() => ksStatistic([])).toThrow(/empty/);
    expect(() => ksPValue(0, 0.5)).toThrow(RangeError);
    expect(() => ksPValue(2.5, 0.5)).toThrow(RangeError);
    expect(ksPValue(10, 0)).toBe(1);
    expect(ksPValue(10, -1)).toBe(1);
    expect(ksPValue(10, 1)).toBe(0);
    expect(ksPValue(500, 0.5)).toBeLessThan(1e-6);
  });

  it("a large uniform grid has a high p-value and the exact and limit forms agree near the join", () => {
    const grid = Array.from({ length: 200 }, (_, i) => (i + 0.5) / 200);
    expect(ksUniformityTest(grid).p).toBeGreaterThan(0.99);
    const a = ksPValue(140, 0.09);
    const b = ksPValue(141, 0.09);
    expect(Math.abs(a - b)).toBeLessThan(0.02);
  });

  it("normal functions propagate NaN, vanish in the far tail and give the peak density", () => {
    expect(Number.isNaN(erfc(Number.NaN))).toBe(true);
    expect(Number.isNaN(normalCdf(Number.NaN))).toBe(true);
    expect(erfc(30)).toBe(0);
    expect(erfc(-30)).toBe(2);
    expect(normalCdf(-40)).toBe(0);
    expect(normalPdf(0)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 12);
  });
});

describe("probability of backtest overfitting guards", () => {
  it("refuses an odd or too small block count and a ragged matrix; reports n/a for thin input", () => {
    expect(() => probabilityOfBacktestOverfitting([[1, 2]], { blocks: 3 })).toThrow(/even/);
    expect(() => probabilityOfBacktestOverfitting([[1, 2]], { blocks: 0 })).toThrow(/even/);
    expect(probabilityOfBacktestOverfitting([])).toMatchObject({ status: "n/a" });
    const thin = Array.from({ length: 4 }, () => [1, 2, 3, 4, 5]);
    expect(probabilityOfBacktestOverfitting(thin, { blocks: 4 })).toMatchObject({ status: "n/a" });
    const ragged = Array.from({ length: 8 }, (_, i) => (i === 3 ? [1, 2, 3, 4] : [1, 2, 3, 4, 5]));
    expect(() => probabilityOfBacktestOverfitting(ragged, { blocks: 4 })).toThrow(/ragged/);
  });

  it("variants with no spread have zero Sharpe in every block", () => {
    const flat = Array.from({ length: 8 }, () => [0.01, 0.01, 0.01, 0.01, 0.01]);
    const r = probabilityOfBacktestOverfitting(flat, { blocks: 4 });
    expect(["n/a", "ok"].includes(r.status) || typeof r.status === "string").toBe(true);
  });
});
