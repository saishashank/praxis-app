// @vitest-environment node
// Known-answer, property, determinism and performance tests for src/lib/stats (M4 T12; design 4.8;
// decisions 24, 25, 27). The known-answer table is tests/fixtures/stats/known_answers.json; every row
// cites its source and says how its value was derived independently of the library.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as stats from "../../src/lib/stats";
import {
  bootstrapReplications,
  bootstrapSeries,
  circularBlockBootstrap,
  clopperPearson,
  deflatedSharpeRatio,
  expectedMaxSharpe,
  exactLowerBound,
  exactUpperBound,
  binomialAcceptanceRegion,
  binomialCdf,
  binomialSurvival,
  combinations,
  forwardLookLevel,
  holdoutLevel,
  insufficientEvidence,
  killSwitchLevel,
  ksPValue,
  ksStatistic,
  ksUniformityTest,
  mean,
  minimumDetectableEffect,
  normalCdf,
  normalQuantile,
  percentile,
  probabilityOfBacktestOverfitting,
  returnMoments,
  rolledTrialBudget,
  sampleSd,
  scopedPrng,
  studentisedTest,
  uniform01,
  validationLevel,
  wilsonInterval,
} from "../../src/lib/stats";

type Row = {
  id: string;
  fn: string;
  args: unknown[];
  expected: unknown;
  tol: number;
  source: string;
  method: string;
};
const table = JSON.parse(
  readFileSync(path.resolve(__dirname, "../fixtures/stats/known_answers.json"), "utf8"),
) as { rows: Row[] };

function expectClose(actual: unknown, expected: unknown, tol: number, id: string): void {
  if (typeof expected === "number") {
    expect(typeof actual, id).toBe("number");
    expect(Math.abs((actual as number) - expected), id).toBeLessThanOrEqual(tol);
  } else {
    for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
      expectClose((actual as Record<string, unknown>)[k], v, tol, `${id}.${k}`);
    }
  }
}

describe("known-answer table", () => {
  it("has a source and a method on every row", () => {
    expect(table.rows.length).toBeGreaterThanOrEqual(40);
    for (const r of table.rows) {
      expect(r.source.length, r.id).toBeGreaterThan(5);
      expect(r.method.length, r.id).toBeGreaterThan(5);
    }
  });
  for (const row of table.rows) {
    it(row.id, () => {
      const fn = (stats as unknown as Record<string, (...a: unknown[]) => unknown>)[row.fn];
      expect(fn, row.fn).toBeTypeOf("function");
      expectClose(fn!(...row.args), row.expected, row.tol, row.id);
    });
  }
});

describe("normal distribution", () => {
  it("Phi^-1(0.975) = 1.959963984540054 to 1e-9", () => {
    expect(Math.abs(normalQuantile(0.975) - 1.959963984540054)).toBeLessThan(1e-9);
  });
  it("round-trips Phi(Phi^-1(p)) = p across the range, including deep tails", () => {
    for (const p of [1e-12, 1e-9, 1e-6, 1e-3, 0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 0.999]) {
      expect(Math.abs(normalCdf(normalQuantile(p)) - p) / p).toBeLessThan(1e-9);
    }
  });
  it("is symmetric, monotone, and handles the edges", () => {
    let prev = -1;
    for (let x = -8; x <= 8; x += 0.05) {
      const v = normalCdf(x);
      expect(v).toBeGreaterThan(prev);
      prev = v;
      expect(Math.abs(v + normalCdf(-x) - 1)).toBeLessThan(1e-15);
    }
    expect(normalQuantile(0)).toBe(-Infinity);
    expect(normalQuantile(1)).toBe(Infinity);
    expect(normalQuantile(2)).toBeNaN();
  });
  it("matches Simpson integration of the density between the table points (second derivation)", () => {
    const pdf = (x: number): number => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
    for (const x of [0.3, 0.77, 1.5, 2.2, 3.1, 4.0]) {
      const n = 20_000;
      const h = x / n;
      let s = pdf(0) + pdf(x);
      for (let i = 1; i < n; i += 1) s += pdf(i * h) * (i % 2 ? 4 : 2);
      expect(Math.abs(normalCdf(x) - (0.5 + (s * h) / 3))).toBeLessThan(1e-12);
    }
  });
});

describe("binomial", () => {
  it("tails sum to one and the Clopper-Pearson bounds solve their defining equations", () => {
    expect(binomialCdf(3, 10, 0.4) + binomialSurvival(4, 10, 0.4)).toBeCloseTo(1, 12);
    const { lower, upper } = clopperPearson(13, 40, 0.1);
    expect(binomialSurvival(13, 40, lower)).toBeCloseTo(0.05, 10);
    expect(binomialCdf(13, 40, upper)).toBeCloseTo(0.05, 10);
  });
  it("Wilson is inside [0, 1], contains the point estimate and narrows with n", () => {
    let prev = Infinity;
    for (const n of [10, 40, 160, 640]) {
      const w = wilsonInterval(n * 0.3, n, 0.9);
      expect(w.lower).toBeGreaterThanOrEqual(0);
      expect(w.upper).toBeLessThanOrEqual(1);
      expect(w.lower).toBeLessThan(0.3);
      expect(w.upper).toBeGreaterThan(0.3);
      expect(w.upper - w.lower).toBeLessThan(prev);
      prev = w.upper - w.lower;
    }
    expect(wilsonInterval(0, 0, 0.9)).toEqual({ lower: 0, upper: 1 });
  });
  it("exact bounds are monotone in k and in alpha", () => {
    expect(exactUpperBound(2, 50, 0.05)).toBeLessThan(exactUpperBound(3, 50, 0.05));
    expect(exactUpperBound(2, 50, 0.01)).toBeGreaterThan(exactUpperBound(2, 50, 0.05));
    expect(exactLowerBound(10, 50, 0.01)).toBeLessThan(exactLowerBound(10, 50, 0.05));
  });
  it("acceptance region brackets n*p and the size is at most alpha", () => {
    const r = binomialAcceptanceRegion(2000, 0.05, 0.01);
    expect(r.lo).toBeLessThan(100);
    expect(r.hi).toBeGreaterThan(100);
    const size = binomialCdf(r.lo - 1, 2000, 0.05) + binomialSurvival(r.hi + 1, 2000, 0.05);
    expect(size).toBeLessThanOrEqual(0.01);
  });
  it("rejects invalid counts", () => {
    expect(() => wilsonInterval(11, 10, 0.9)).toThrow(RangeError);
  });
});

describe("Kolmogorov-Smirnov", () => {
  it("statistic on a hand-worked sample", () => {
    // sorted 0.1, 0.4, 0.5: D+ = max(1/3-0.1, 2/3-0.4, 1-0.5) = 0.5; D- = max(0.1, 0.4-1/3, 0.5-2/3) = 0.1
    expect(ksStatistic([0.5, 0.1, 0.4])).toBeCloseTo(0.5, 12);
  });
  it("exact and asymptotic p-values agree near the switch-over (n = 140 vs 141)", () => {
    const d140 = ksPValue(140, 0.09);
    const d141 = ksPValue(141, 0.09);
    expect(Math.abs(d140 - d141)).toBeLessThan(0.01);
  });
  it("p is monotone decreasing in d and a regular grid is not rejected", () => {
    let prev = 2;
    for (let d = 0.02; d < 0.6; d += 0.02) {
      const p = ksPValue(60, d);
      expect(p).toBeLessThanOrEqual(prev);
      prev = p;
    }
    const grid = Array.from({ length: 200 }, (_, i) => (i + 0.5) / 200);
    expect(ksUniformityTest(grid).p).toBeGreaterThan(0.99);
    expect(ksUniformityTest(Array.from({ length: 200 }, () => 0.01)).p).toBeLessThan(1e-6);
  });
  it("uniform draws from the PRNG are not rejected at 0.01 (fixed seed)", () => {
    const rng = scopedPrng("test:ks");
    const sample = Array.from({ length: 300 }, () => uniform01(rng));
    expect(ksUniformityTest(sample).p).toBeGreaterThan(0.01);
  });
});

describe("circular block bootstrap", () => {
  const rng0 = () => scopedPrng("test:boot");
  const sessions = Array.from({ length: 500 }, (_, i) => i);
  const iid = (() => {
    const r = scopedPrng("test:data");
    // Irwin-Hall(12) - 6 + 0.5: mean 0.5, variance 1.
    return sessions.map(() => {
      let s = 0;
      for (let j = 0; j < 12; j += 1) s += uniform01(r);
      return s - 6 + 0.5;
    });
  })();

  it("replicate means centre on the sample mean with SD about sigma/sqrt(n) for iid data (block 1)", () => {
    const r = circularBlockBootstrap(
      { sessions, sessionCount: 500, block: 1, replicates: 2000, series: [iid] },
      rng0(),
    );
    const m = r.replicateMeans[0]!;
    expect(Math.abs(mean(m) - mean(iid))).toBeLessThan(0.01);
    const expectedSe = sampleSd(iid) / Math.sqrt(500);
    expect(Math.abs(sampleSd(m) / expectedSe - 1)).toBeLessThan(0.08);
  });
  it("a larger block inflates the standard error for positively dependent data", () => {
    const dep = iid.map((_, i) => iid[Math.floor(i / 10) * 10]!); // piecewise constant
    const se = (block: number): number =>
      sampleSd(
        circularBlockBootstrap(
          { sessions, sessionCount: 500, block, replicates: 1000, series: [dep] },
          rng0(),
        ).replicateMeans[0]!,
      );
    expect(se(10)).toBeGreaterThan(1.8 * se(1));
  });
  it("p-values for a null mean are valid-ish: the rejection rate at 0.10 is near 0.10", () => {
    const r = scopedPrng("test:size");
    let rejected = 0;
    const runs = 120;
    for (let i = 0; i < runs; i += 1) {
      const xs = Array.from({ length: 80 }, () => uniform01(r) - 0.5);
      const s = bootstrapSeries(
        xs.map((_, j) => j),
        xs,
        80,
        2,
        300,
        r,
      );
      if (s.test.p <= 0.1) rejected += 1;
    }
    expect(rejected / runs).toBeGreaterThan(0.02);
    expect(rejected / runs).toBeLessThan(0.22);
  });
  it("detects a clear edge and gives the observed-mean p floor 1/(B+1)", () => {
    const xs = iid.map((v) => v + 1);
    const s = bootstrapSeries(sessions, xs, 500, 5, 1999, rng0());
    expect(s.test.p).toBe(1 / 2000);
    expect(s.lower90).toBeGreaterThan(0);
    expect(s.interval90.lower).toBeLessThan(s.interval90.upper);
    expect(s.insufficientBlocks).toBe(false);
  });
  it("flags fewer than 15 independent blocks and counts redraws of empty replicates", () => {
    const s = bootstrapSeries([0, 0, 1], [1, 2, 3], 400, 40, 50, rng0());
    expect(s.blocks).toBe(10);
    expect(s.insufficientBlocks).toBe(true);
    expect(s.redraws).toBeGreaterThanOrEqual(0);
    const sparse = circularBlockBootstrap(
      { sessions: [3], sessionCount: 400, block: 1, replicates: 20, series: [[1]] },
      rng0(),
    );
    expect(sparse.redraws).toBeGreaterThan(0);
  });
  it("percentile is nearest-rank and studentisedTest uses (1 + #{t* >= t}) / (B + 1)", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.4)).toBe(2);
    expect(percentile([5, 1, 3, 2, 4], 1)).toBe(5);
    // Observed mean 2, replicate means 1..10: t* = (rep - 2)/se >= t = 2/se iff rep >= 4.
    const reps = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const t = studentisedTest(2, reps); // t* >= t for replicate means 4..10
    expect(t.p).toBeCloseTo((1 + 7) / 11, 12);
  });
  it("rejects bad inputs", () => {
    const base = { sessions: [0], sessionCount: 1, block: 1, replicates: 1, series: [[1]] };
    expect(() => circularBlockBootstrap({ ...base, block: 0 }, rng0())).toThrow(RangeError);
    expect(() => circularBlockBootstrap({ ...base, sessions: [5] }, rng0())).toThrow(RangeError);
    expect(() => circularBlockBootstrap({ ...base, series: [[1, 2]] }, rng0())).toThrow(RangeError);
  });
});

describe("determinism", () => {
  it("two runs of every seeded statistic are byte-identical", () => {
    const run = (): string => {
      const rng = scopedPrng("boot:determinism");
      const xs = Array.from({ length: 300 }, () => uniform01(rng) - 0.45);
      const idx = xs.map((_, i) => i);
      const b = bootstrapSeries(idx, xs, 300, 6, 500, rng);
      const weekly = Array.from({ length: 60 }, () =>
        Array.from({ length: 8 }, () => uniform01(rng) - 0.5),
      );
      const pbo = probabilityOfBacktestOverfitting(weekly);
      const ks = ksUniformityTest(xs.map((x) => x + 0.45));
      const dsr = deflatedSharpeRatio({
        ...returnMoments(xs),
        observations: 300,
        trials: 12,
        srVariance: 0.001,
      });
      return JSON.stringify({ b, pbo, ks, dsr, q: normalQuantile(0.999) });
    };
    expect(run()).toBe(run());
  });
  it("different scopes give different streams; the same scope the same stream", () => {
    expect(scopedPrng("a").nextU64()).toBe(scopedPrng("a").nextU64());
    expect(scopedPrng("a").nextU64()).not.toBe(scopedPrng("b").nextU64());
  });
});

describe("performance", () => {
  it("B = 2,000 resamples of 750 points run in under 2 s", () => {
    const rng = scopedPrng("test:perf");
    const xs = Array.from({ length: 750 }, () => uniform01(rng) - 0.5);
    const idx = xs.map((_, i) => i);
    const t0 = performance.now();
    const s = bootstrapSeries(idx, xs, 750, 5, 2000, rng);
    const ms = performance.now() - t0;
    expect(s.test.replicates).toBe(2000);
    expect(ms).toBeLessThan(2000);
  });
});

describe("gates and levels", () => {
  it("alpha / (m L), holdout alpha / L, B = 48,000 at the default level", () => {
    expect(validationLevel(0.05, 20, 6)).toBeCloseTo(0.000416667, 9);
    expect(validationLevel(0.05, 20, 3)).toBeCloseTo(0.000416667, 9); // L = max(6, lineages)
    expect(validationLevel(0.05, 20, 8)).toBeCloseTo(0.05 / 160, 12);
    expect(holdoutLevel(0.05, 6)).toBeCloseTo(0.05 / 6, 12);
    expect(bootstrapReplications(validationLevel(0.05, 20, 6))).toBe(48000);
    expect(bootstrapReplications(0.05)).toBe(1000);
    expect(forwardLookLevel(2, 6)).toBeCloseTo(0.1 / 6 / 4, 12);
    expect(killSwitchLevel(1)).toBeCloseTo(0.05 / 3 / 2, 12);
  });
  it("MDE = (z_{1-level} + z_{0.8}) se and is monotone", () => {
    const m = minimumDetectableEffect(0.05, 1);
    expect(Math.abs(m - (1.6448536269514722 + 0.8416212335729143))).toBeLessThan(1e-9);
    expect(minimumDetectableEffect(0.001, 1)).toBeGreaterThan(m);
    expect(minimumDetectableEffect(0.05, 2)).toBeCloseTo(2 * m, 12);
  });
  it("evidence floors and trial budget roll", () => {
    expect(insufficientEvidence(80, 40)).toBe(true);
    expect(insufficientEvidence(120, 14)).toBe(true);
    expect(insufficientEvidence(120, 15)).toBe(false);
    expect(rolledTrialBudget(20, 6, 252, 504)).toBe(17);
    expect(rolledTrialBudget(20, 25, 504, 504)).toBe(0);
  });
});

describe("PBO", () => {
  const noise = (seed: string, T: number, N: number, drift: (n: number) => number): number[][] => {
    const r = scopedPrng(seed);
    return Array.from({ length: T }, () =>
      Array.from({ length: N }, (_, n) => uniform01(r) - 0.5 + drift(n)),
    );
  };
  it("enumerates C(10,5) = 252 lexicographic splits", () => {
    const c = combinations(10, 5);
    expect(c.length).toBe(252);
    expect(c[0]).toEqual([0, 1, 2, 3, 4]);
    expect(c[251]).toEqual([5, 6, 7, 8, 9]);
  });
  it("lies in [0, 1]; pure noise gives a middling value; a persistent winner gives 0", () => {
    const noisy = probabilityOfBacktestOverfitting(noise("pbo:noise", 200, 12, () => 0));
    expect(noisy.status).toBe("ok");
    if (noisy.status === "ok") {
      expect(noisy.pbo).toBeGreaterThanOrEqual(0);
      expect(noisy.pbo).toBeLessThanOrEqual(1);
      expect(noisy.pbo).toBeGreaterThan(0.2);
      expect(noisy.splits).toBe(252);
    }
    const persistent = probabilityOfBacktestOverfitting(noise("pbo:drift", 200, 8, (n) => n * 0.2));
    expect(persistent.status === "ok" && persistent.pbo).toBe(0);
  });
  it("is n/a below the minimum variant count or with too few weeks", () => {
    expect(probabilityOfBacktestOverfitting(noise("x", 100, 4, () => 0)).status).toBe("n/a");
    expect(probabilityOfBacktestOverfitting(noise("x", 15, 8, () => 0)).status).toBe("n/a");
  });
  it("is invariant to variant order (ties aside) and to adding a constant to all returns' scale", () => {
    const a = noise("pbo:perm", 120, 7, () => 0);
    const b = a.map((row) => [...row].reverse());
    const ra = probabilityOfBacktestOverfitting(a);
    const rb = probabilityOfBacktestOverfitting(b);
    expect(ra.status === "ok" && rb.status === "ok" && ra.pbo).toBe(
      rb.status === "ok" ? rb.pbo : -1,
    );
    const scaled = a.map((row) => row.map((v) => v * 3));
    const rs = probabilityOfBacktestOverfitting(scaled);
    expect(rs.status === "ok" && rs.pbo).toBe(ra.status === "ok" ? ra.pbo : -1);
  });
});

describe("Deflated Sharpe Ratio", () => {
  const base = {
    sharpe: 0.1,
    skew: 0,
    kurtosis: 3,
    observations: 500,
    trials: 10,
    srVariance: 0.0004,
  };
  it("N = 1 gives SR0 = 0 (decision 27)", () => {
    expect(expectedMaxSharpe(1, 0.5)).toBe(0);
    expect(deflatedSharpeRatio({ ...base, trials: 1 }).sr0).toBe(0);
  });
  it("is monotone: falls with more trials and with a larger variance, rises with Sharpe and T", () => {
    expect(expectedMaxSharpe(50, 0.01)).toBeGreaterThan(expectedMaxSharpe(10, 0.01));
    const d = (o: Partial<typeof base>): number => deflatedSharpeRatio({ ...base, ...o }).dsr!;
    expect(d({ trials: 100 })).toBeLessThan(d({ trials: 10 }));
    expect(d({ srVariance: 0.002 })).toBeLessThan(d({ srVariance: 0.0004 }));
    expect(d({ sharpe: 0.15 })).toBeGreaterThan(d({}));
    expect(d({ observations: 1000 })).toBeGreaterThan(d({}));
    expect(d({})).toBeGreaterThan(0);
    expect(d({})).toBeLessThan(1);
  });
  it("negative skew and fat tails lower it for a positive Sharpe", () => {
    const d = (o: Partial<typeof base>): number => deflatedSharpeRatio({ ...base, ...o }).dsr!;
    expect(d({ skew: -1, kurtosis: 8 })).toBeLessThan(d({}));
  });
  it("returns null when the variance term is not positive", () => {
    expect(deflatedSharpeRatio({ ...base, sharpe: 5, skew: 3, kurtosis: 1 }).dsr).toBeNull();
  });
  it("sample moments of a symmetric sample", () => {
    const m = returnMoments([-2, -1, 0, 1, 2]);
    expect(m.mean).toBe(0);
    expect(m.skew).toBeCloseTo(0, 12);
    // population variance 2, fourth central moment (16+1+0+1+16)/5 = 6.8 -> kurtosis 6.8 / 4 = 1.7
    expect(m.kurtosis).toBeCloseTo(1.7, 12);
  });
});

describe("scope of the money float ban", () => {
  it("noFloatMoney scans only src/lib/money and src/lib/arena, not src/lib/stats", () => {
    const text = readFileSync(path.resolve(__dirname, "../money/noFloatMoney.test.ts"), "utf8");
    const line = text.split("\n").find((l) => l.startsWith("const SCAN_DIRS"));
    expect(line).toBeDefined();
    expect(line).not.toContain("stats");
  });
});
