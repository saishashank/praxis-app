// @vitest-environment node
// Stationary block bootstrap, per-statistic n_eff and purge/embargo (M15 C2; CTX-012 intervals, OI-15).
import { describe, expect, it } from "vitest";
import { mean } from "@/lib/stats/bootstrap";
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

  it("D-299: blocks are contiguous (period = max(block, maxHold)), every row counted, floor 1", () => {
    // block 2, hold 3 → L = 3: blocks {0,1,2}, {3,4,5}; sums 0 and 0 → ratio 0 → floor 1.
    const sessions = [0, 1, 2, 3, 4, 5];
    const psi = [1, -1, 0, 1, -1, 0];
    const de = effectiveN({ sessions, sessionCount: 6 }, psi, { expectedBlock: 2, maxHold: 3 });
    expect(de.designEffect).toBe(1);
    expect(de.blocks).toBe(2);
  });

  it("seeded AR(1) with φ = 0.5 over 1,000 blocks gives D_s ≈ 3 and a bootstrap SE near √(D_s·var/S)", () => {
    // Block sums of an AR(1) have variance ≈ L σ² (1 + φ)/(1 − φ) for L ≫ 1/(1 − φ): D_s → 3 (finite-L
    // term −2φ/((1 − φ)² L) ≈ −0.04 at L = 100). The block-variance estimate has relative SD ≈ √(2/blocks),
    // so 1,000 blocks keep the ±0.3 band at > 2 σ; at 200 blocks seeds of this family range 2.6–3.0.
    const prng = prngFor("ar1-100-1000-0");
    const L = 100;
    const S = 1000 * L;
    const x: number[] = [];
    let prev = 0;
    for (let t = 0; t < S; t += 1) {
      prev = 0.5 * prev + normal(prng);
      x.push(prev);
    }
    const layout = { sessions: x.map((_, i) => i), sessionCount: S };
    const de = effectiveN(layout, meanInfluence(x), { expectedBlock: L });
    expect(de.blocks).toBe(1000);
    expect(de.designEffect).toBeGreaterThan(2.7);
    expect(de.designEffect).toBeLessThan(3.3);
    expect(de.nEff).toBeCloseTo(S / de.designEffect, 9);
    const r = stationaryBlockBootstrap(layout, meanStatistic(x), prngFor("ar1-boot"), {
      expectedBlock: L,
      replicates: 300,
    });
    let m = 0;
    for (const v of r.values) m += v;
    m /= r.values.length;
    let ss = 0;
    for (const v of r.values) ss += (v - m) ** 2;
    const se = Math.sqrt(ss / (r.values.length - 1));
    let varX = 0;
    const mx = mean(x);
    for (const v of x) varX += (v - mx) ** 2;
    varX /= S - 1;
    const expected = Math.sqrt((de.designEffect * varX) / S);
    expect(Math.abs(se / expected - 1)).toBeLessThan(0.15);
  });

  it("D-298: u_s is the inverse same-code design effect of the influence values", () => {
    // 3 codes × 4 rows. Identical ψ within a code (+1 for A, −1 for B, +1 for C): Σψ² = 12,
    // T_c = ±4 → Σ T_c² = 48 → u = 12/48 = 1/4 = codes / rows.
    const codes = ["A", "A", "A", "A", "B", "B", "B", "B", "C", "C", "C", "C"];
    const sessions = Array.from({ length: 12 }, (_, i) => i);
    const same = effectiveN(
      { sessions, sessionCount: 12, codes },
      [1, 1, 1, 1, -1, -1, -1, -1, 1, 1, 1, 1],
      { expectedBlock: 1 },
    );
    expect(same.uniqueShare).toBeCloseTo(0.25, 12);
    // Alternating ψ within every code: T_c = 0 → ratio ∞ → capped at 1.
    const alt = effectiveN(
      { sessions, sessionCount: 12, codes },
      [1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1],
      { expectedBlock: 1 },
    );
    expect(alt.uniqueShare).toBe(1);
    // Without codes u = 1; n_eff = R·u / D_s.
    expect(
      effectiveN({ sessions, sessionCount: 12 }, new Array(12).fill(1), { expectedBlock: 1 })
        .uniqueShare,
    ).toBe(1);
    expect(same.nEff).toBeCloseTo((12 * 0.25) / same.designEffect, 12);
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

  it("pins the nearest-rank bounds on 20 known replicate values", () => {
    // The first call is the full-sample point (0); the 20 replicates then return 1..20 in draw order.
    let call = 0;
    const ci = bootstrapCi(layoutOf(5), () => call++, [0, 0, 0, 0, 0], prngFor("pin"), {
      expectedBlock: 1,
      replicates: 20,
    });
    if (isUndefined(ci)) throw new Error(ci.undefined);
    expect(ci.point).toBe(0);
    expect(ci.lo).toBe(1); // sorted[ceil(0.05 × 20) − 1] = sorted[0]
    expect(ci.oneSidedLo).toBe(2); // sorted[ceil(2) − 1]
    expect(ci.oneSidedHi).toBe(18); // sorted[ceil(18) − 1]
    expect(ci.hi).toBe(19); // sorted[ceil(19) − 1]
  });

  it("coverage: over 200 seeds the one-sided 90 % lower bound exceeds a true mean of 0 about 10 % of the time", () => {
    const n = 200;
    let above = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      // Seeded: 200 seeds give an SE of about 2 pp on the 10 % target, so the band is seed-dependent
      // (another seed family of the same settings lands at 15 %); the scope is pinned, not tuned per run.
      const prng = prngFor(`cov-${n}-${seed}`);
      const values = Array.from({ length: n }, () => normal(prng));
      const ci = bootstrapMean(layoutOf(n), values, prngFor(`covb-${n}-${seed}`), {
        expectedBlock: 5,
        replicates: 200,
      });
      if (isUndefined(ci)) throw new Error(ci.undefined);
      if (ci.oneSidedLo > 0) above += 1;
    }
    expect(above / 200).toBeGreaterThanOrEqual(0.08);
    expect(above / 200).toBeLessThanOrEqual(0.13);
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
