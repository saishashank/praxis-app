// @vitest-environment node
// Stationary block bootstrap, per-statistic n_eff and purge/embargo (M15 C2; CTX-012 intervals, OI-15).
import { describe, expect, it } from "vitest";
import {
  bootstrapCi,
  bootstrapCiMany,
  bootstrapMean,
  effectiveN,
  isUndefined,
  meanInfluence,
  meanStatistic,
  MIN_BLOCKS_FOR_NEFF,
  purgeEmbargo,
  stationaryBlockBootstrap,
  DEFAULT_BLOCK_SESSIONS,
  DEFAULT_REPLICATES,
} from "@/lib/stats/stationaryBootstrap";
import { layoutOf, normal, prngFor, TEST_BOOT } from "./helpers";

describe("effectiveN (R·u / D_s)", () => {
  it("known answer: independent-looking rows give D_s = 1 and n_eff = R·u", () => {
    // 4 blocks of 1 session (block = 1, maxHold 0), one row each; ψ = (1, -1, 1, -1): Σψ² = 4,
    // block sums = ψ themselves so Σ T_b² = 4 → D = 1. Below 10 blocks → n_eff undefined.
    const de = effectiveN(
      { sessions: [0, 1, 2, 3], sessionCount: 4, codes: ["A", "B", "A", "B"] },
      [1, -1, 1, -1],
      { expectedBlock: 1 },
    );
    expect(de.designEffect).toBe(1);
    expect(de.blocks).toBe(4);
    expect(de.uniqueShare).toBe(0.5);
    expect(de.nEff).toBeUndefined();
  });

  it("known answer: same-sign rows in one block inflate D_s (hand-computed 2.0)", () => {
    // 12 blocks of 2 sessions; rows in sessions (0,1), (2,3), ... with ψ = +1, +1 in each block and
    // −1, −1 in the next: Σψ² = 24; each block sum is ±2 → Σ T_b² = 12 × 4 = 48 → D = 2.
    const sessions: number[] = [];
    const psi: number[] = [];
    for (let b = 0; b < 12; b += 1) {
      const sign = b % 2 === 0 ? 1 : -1;
      sessions.push(2 * b, 2 * b + 1);
      psi.push(sign, sign);
    }
    const de = effectiveN({ sessions, sessionCount: 24 }, psi, { expectedBlock: 2 });
    expect(de.designEffect).toBeCloseTo(2, 12);
    expect(de.blocks).toBe(12);
    expect(de.nEff).toBeCloseTo(24 / 2, 12);
  });

  it("purges the embargo tail of each block from D_s and floors D_s at 1", () => {
    // block 2 + hold 1: period 3; sessions 2, 5, 8 ... are embargo and do not count.
    const sessions = [0, 1, 2, 3, 4, 5];
    const psi = [1, -1, 100, 1, -1, 100];
    const de = effectiveN({ sessions, sessionCount: 6 }, psi, { expectedBlock: 2, maxHold: 1 });
    // Block sums: (1 − 1) = 0 twice → Σ T² = 0 → ratio 0 → floor 1.
    expect(de.designEffect).toBe(1);
    expect(de.blocks).toBe(2);
  });

  it(`n_eff is undefined below ${MIN_BLOCKS_FOR_NEFF} populated blocks and defined at it`, () => {
    const nine = effectiveN(layoutOf(9), new Array(9).fill(1), { expectedBlock: 1 });
    expect(nine.blocks).toBe(9);
    expect(nine.nEff).toBeUndefined();
    const ten = effectiveN(layoutOf(10), new Array(10).fill(1), { expectedBlock: 1 });
    expect(ten.blocks).toBe(10);
    expect(ten.nEff).toBeDefined();
  });
});

describe("stationaryBlockBootstrap", () => {
  it("defaults match the spec: block 120 sessions, R 2,000", () => {
    expect(DEFAULT_BLOCK_SESSIONS).toBe(120);
    expect(DEFAULT_REPLICATES).toBe(2000);
  });

  it("is byte-identical for the same seed and differs for another", () => {
    const layout = layoutOf(200);
    const values = Array.from({ length: 200 }, (_, i) => Math.sin(i));
    const a = stationaryBlockBootstrap(layout, meanStatistic(values), prngFor("boot-a"), TEST_BOOT);
    const b = stationaryBlockBootstrap(layout, meanStatistic(values), prngFor("boot-a"), TEST_BOOT);
    const c = stationaryBlockBootstrap(layout, meanStatistic(values), prngFor("boot-b"), TEST_BOOT);
    expect(Array.from(a.values)).toEqual(Array.from(b.values));
    expect(Array.from(a.values)).not.toEqual(Array.from(c.values));
    expect(a.block).toBe(TEST_BOOT.expectedBlock);
  });

  it("uses the max hold as the block floor (embargo)", () => {
    const layout = layoutOf(50);
    const r = stationaryBlockBootstrap(layout, meanStatistic(new Array(50).fill(1)), prngFor("f"), {
      expectedBlock: 5,
      maxHold: 30,
      replicates: 3,
    });
    expect(r.block).toBe(30);
    expect(Array.from(r.values)).toEqual([1, 1, 1]);
  });

  it("redraws a replicate that collects no row", () => {
    // Rows only in session 0 of a 3-session window: some replicates miss it.
    const r = stationaryBlockBootstrap(
      { sessions: [0, 0], sessionCount: 3 },
      meanStatistic([2, 4]),
      prngFor("redraw"),
      { expectedBlock: 1, replicates: 20 },
    );
    expect(Array.from(r.values).every((v) => v === 3)).toBe(true);
    expect(r.redraws).toBeGreaterThan(0);
  });

  it("validates its inputs", () => {
    expect(() =>
      stationaryBlockBootstrap({ sessions: [], sessionCount: 1 }, () => 0, prngFor("v")),
    ).toThrow(RangeError);
    expect(() =>
      stationaryBlockBootstrap({ sessions: [5], sessionCount: 3 }, () => 0, prngFor("v")),
    ).toThrow(RangeError);
    expect(() =>
      stationaryBlockBootstrap({ sessions: [0], sessionCount: 1 }, () => 0, prngFor("v"), {
        replicates: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe("bootstrapMean / bootstrapCi", () => {
  it("planted positive mean: interval contains the truth and the one-sided bound is below the mean", () => {
    const prng = prngFor("mean-planted");
    const n = 600;
    const values = Array.from({ length: n }, () => 0.5 + normal(prng));
    const ci = bootstrapMean(layoutOf(n), values, prngFor("mean-boot"), TEST_BOOT);
    expect(isUndefined(ci)).toBe(false);
    if (isUndefined(ci)) return;
    expect(ci.level).toBe(0.9);
    expect(ci.lo).toBeLessThan(0.5);
    expect(ci.hi).toBeGreaterThan(0.5);
    expect(ci.oneSidedLo).toBeGreaterThan(ci.lo);
    expect(ci.oneSidedLo).toBeLessThan(ci.point);
    expect(ci.oneSidedHi).toBeLessThan(ci.hi);
    expect(ci.oneSidedLo).toBeGreaterThan(0);
    expect(ci.blocks).toBe(30);
    expect(ci.nEff).toBeDefined();
    expect(ci.nEff!).toBeLessThanOrEqual(n);
    expect(ci.replicates).toBe(TEST_BOOT.replicates);
  });

  it("null mean: the one-sided 90 % lower bound is not above zero", () => {
    const prng = prngFor("mean-null");
    const n = 600;
    const values = Array.from({ length: n }, () => normal(prng));
    const ci = bootstrapMean(layoutOf(n), values, prngFor("mean-null-boot"), TEST_BOOT);
    if (isUndefined(ci)) throw new Error(ci.undefined);
    expect(ci.oneSidedLo).toBeLessThanOrEqual(0.15);
    expect(ci.lo).toBeLessThan(0);
  });

  it("reports n_eff undefined (with the interval) below 10 blocks", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    const ci = bootstrapMean(layoutOf(8), values, prngFor("few"), {
      expectedBlock: 2,
      replicates: 20,
    });
    if (isUndefined(ci)) throw new Error(ci.undefined);
    expect(ci.nEff).toBeUndefined();
    expect(ci.blocks).toBe(4);
    expect(ci.point).toBe(4.5);
  });

  it("returns a reason when the statistic is not finite", () => {
    const ci = bootstrapCi(layoutOf(4), () => NaN, [0, 0, 0, 0], prngFor("nan"), {
      expectedBlock: 1,
      replicates: 5,
    });
    expect(isUndefined(ci)).toBe(true);
    if (isUndefined(ci)) expect(ci.undefined).toMatch(/not finite/);
  });

  it("bootstrapCiMany evaluates several statistics on the same draws", () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    const [a, b] = bootstrapCiMany(
      layoutOf(100),
      (rows) => [meanStatistic(values)(rows), 2 * meanStatistic(values)(rows)],
      [meanInfluence(values), meanInfluence(values)],
      prngFor("many"),
      { expectedBlock: 5, replicates: 50 },
    );
    if (isUndefined(a!) || isUndefined(b!)) throw new Error("undefined");
    expect(b.point).toBeCloseTo(2 * a.point, 12);
    expect(b.lo).toBeCloseTo(2 * a.lo, 12);
    expect(b.hi).toBeCloseTo(2 * a.hi, 12);
  });
});

describe("purgeEmbargo", () => {
  it("known answer: drops rows straddling a boundary and rows within the hold after it", () => {
    // boundary at 10, hold 3: sessions 7, 8, 9 straddle (s + 3 >= 10); 10, 11, 12 are embargoed.
    const sessions = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    expect(purgeEmbargo(sessions, [10], 3)).toEqual([0, 1, 8, 9]);
    expect(purgeEmbargo(sessions, [10], 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(purgeEmbargo(sessions, [], 3)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(() => purgeEmbargo(sessions, [10], -1)).toThrow(RangeError);
  });
});
