// @vitest-environment node
// Platt map, Brier skill, calibration slope/intercept and ECE with intervals (M15 C2; CTX-012 map,
// CTX-053, CTX-082, AT-51 statistics rows).
import { describe, expect, it } from "vitest";
import {
  brier,
  brierSkill,
  brierSkillCi,
  calibrationSlope,
  calibrationSlopeCi,
  DEFAULT_SLOPE_HIDE_UB,
  ece,
  eceCi,
  logistic,
  logisticFit,
  logit,
  PLATT_MIN_OUTCOMES,
  PLATT_POOL_GROUPS,
  plattApply,
  plattFit,
  plattFitPooled,
  plattPoolGroup,
  plattTargets,
  SEPARATION_COEF_LIMIT,
  SLOPE_MAX_NON_FINITE_SHARE,
  slopeHidden,
  solveLinear,
  standardise,
} from "@/lib/stats/calibration";
import { effectiveN, isUndefined } from "@/lib/stats/stationaryBootstrap";
import { layoutOf, plantedOutcomes, prngFor, TEST_BOOT } from "./helpers";

describe("linear algebra and logistic fit", () => {
  it("solveLinear known answer: 2x + y = 5, x + 3y = 10 → x = 1, y = 3", () => {
    const x = solveLinear(
      [
        [2, 1],
        [1, 3],
      ],
      [5, 10],
    )!;
    expect(x[0]).toBeCloseTo(1, 12);
    expect(x[1]).toBeCloseTo(3, 12);
    expect(
      solveLinear(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toBeNull();
  });

  it("logistic fit known answer: a 2×2 table gives intercept = log odds(x=0), slope = log odds ratio", () => {
    // x = 0: 30 successes of 50 (odds 1.5); x = 1: 40 of 50 (odds 4). Slope = ln(4 / 1.5).
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      X.push([0, 1]);
      y.push(i < 30 ? 1 : 0);
      X.push([1, 1]);
      y.push(i < 40 ? 1 : 0);
    }
    const fit = logisticFit(X, y)!;
    expect(fit.converged).toBe(true);
    expect(fit.coef[1]).toBeCloseTo(Math.log(1.5), 8);
    expect(fit.coef[0]).toBeCloseTo(Math.log(4 / 1.5), 8);
  });

  it("D-300: a separated sample returns null, a steep but separable-free fit converges by step-halving", () => {
    // Perfect separation: y = 1 exactly when x > 0 → the MLE diverges → null.
    const sep = logisticFit(
      [-3, -2, -1, 1, 2, 3].map((v) => [v, 1]),
      [0, 0, 0, 1, 1, 1],
    );
    expect(sep).toBeNull();
    // Steep inputs (x scaled by 200) with noisy outcomes: the first Newton step overshoots; the fit
    // still converges with a finite slope about 1/200 of the unit-scale answer.
    const d = plantedOutcomes(400, 1.0, prngFor("steep"));
    const unit = logisticFit(
      d.z.map((v) => [v, 1]),
      d.y,
    )!;
    const steep = logisticFit(
      d.z.map((v) => [200 * v, 1]),
      d.y,
    )!;
    expect(unit.converged && steep.converged).toBe(true);
    expect(steep.coef[0]! * 200).toBeCloseTo(unit.coef[0]!, 6);
    expect(SEPARATION_COEF_LIMIT).toBe(50);
  });

  it("slopeHidden: hidden when the monitor says so and when the slope is undefined", () => {
    expect(slopeHidden({ undefined: "calibration fit did not converge" })).toBe(true);
    const n = 300;
    const d = plantedOutcomes(n, 1.0, prngFor("hidden"));
    const ci = calibrationSlopeCi(d.pTrue, d.y, layoutOf(n), prngFor("hidden-boot"), {
      expectedBlock: 10,
      replicates: 40,
    });
    if (isUndefined(ci)) throw new Error(ci.undefined);
    expect(slopeHidden(ci)).toBe(ci.pHidden);
    expect(ci.nonFiniteReplicates).toBe(0);
    expect(SLOPE_MAX_NON_FINITE_SHARE).toBe(0.005);
  });

  it("logit and logistic are inverses and logit clips the ends", () => {
    expect(logistic(logit(0.3))).toBeCloseTo(0.3, 12);
    expect(Number.isFinite(logit(0))).toBe(true);
    expect(Number.isFinite(logit(1))).toBe(true);
  });
});

describe("Platt map", () => {
  it("pool groups are {F1, F4}, {F2, F3, F5, F6}, F7 alone", () => {
    expect(PLATT_POOL_GROUPS).toEqual([["F1", "F4"], ["F2", "F3", "F5", "F6"], ["F7"]]);
    expect(plattPoolGroup("F3")).toEqual(["F2", "F3", "F5", "F6"]);
    expect(plattPoolGroup("F7")).toEqual(["F7"]);
  });

  it("smoothed targets: 3 positives of 5 → t+ = 4/5, t− = 1/4", () => {
    expect(plattTargets([1, 1, 1, 0, 0])).toEqual([0.8, 0.8, 0.8, 0.25, 0.25]);
  });

  it("standardise: mean 0, sample sd 1", () => {
    const s = standardise([1, 2, 3, 4, 5]);
    expect(s.mean).toBe(3);
    expect(s.sd).toBeCloseTo(Math.sqrt(2.5), 12);
    expect(s.z[0]).toBeCloseTo(-2 / Math.sqrt(2.5), 12);
  });

  it("fits a planted slope on standardised S and applies it", () => {
    const { z, y } = plantedOutcomes(2000, 1.2, prngFor("platt"));
    const s = z.map((v) => 10 + 3 * v); // raw S with its own scale
    const map = plattFit(s, y);
    if (isUndefined(map)) throw new Error(map.undefined);
    // z is standard normal, so the fitted slope on standardised S is about 1.2.
    expect(map.a).toBeGreaterThan(1.0);
    expect(map.a).toBeLessThan(1.4);
    expect(Math.abs(map.b)).toBeLessThan(0.15);
    expect(map.sMean).toBeCloseTo(10, 0);
    expect(plattApply(map, map.sMean)).toBeCloseTo(logistic(map.b), 12);
    expect(plattApply(map, map.sMean + map.sSd)).toBeCloseTo(logistic(map.a + map.b), 12);
  });

  it(`needs ${PLATT_MIN_OUTCOMES} outcomes and a non-constant score`, () => {
    const r = plattFit([1, 2, 3], [1, 0, 1]);
    expect(isUndefined(r)).toBe(true);
    const c = plattFit(
      new Array(60).fill(1),
      new Array(60).fill(0).map((_, i) => (i % 2) as 0 | 1),
    );
    expect(isUndefined(c) && c.undefined).toBe("constant score");
  });

  it("pooled fit: one slope, own intercepts, short families excluded", () => {
    const a = plantedOutcomes(800, 1.0, prngFor("pool-a"));
    const b = plantedOutcomes(800, 1.0, prngFor("pool-b"));
    // family B has a higher base rate: flip extra outcomes to 1
    const yB = b.y.map((v, i) => (i % 3 === 0 ? 1 : v)) as (0 | 1)[];
    const r = plattFitPooled([
      { family: "F1", s: a.z, y: a.y },
      { family: "F4", s: b.z, y: yB },
      { family: "F7", s: [1, 2, 3], y: [1, 0, 1] },
    ]);
    if (isUndefined(r)) throw new Error(r.undefined);
    expect(r.excluded.get("F7")).toMatch(/fewer than 60/);
    expect(r.maps.size).toBe(2);
    expect(r.a).toBeGreaterThan(0.6);
    expect(r.maps.get("F1")!.a).toBe(r.a);
    expect(r.maps.get("F4")!.a).toBe(r.a);
    expect(r.maps.get("F4")!.b).toBeGreaterThan(r.maps.get("F1")!.b);
    expect(r.poolNEff).toBeUndefined();
  });

  it("pooled fit with a layout reports the pool n_eff and refuses a pool below 100", () => {
    // 25 codes, 12 rows each, outcomes uncorrelated within a code: u_s ≈ 1 → n_eff ≈ 300 / D_s (D-298).
    const a = plantedOutcomes(300, 1.0, prngFor("pool-neff"));
    const ok = plattFitPooled([{ family: "F1", s: a.z, y: a.y }], layoutOf(300, 25), {
      expectedBlock: 10,
    });
    if (isUndefined(ok)) throw new Error(ok.undefined);
    expect(ok.poolNEff).toBeGreaterThanOrEqual(100);
    expect(ok.poolNEff).toBeLessThanOrEqual(300);
    // The same 25 codes with identical outcomes within each code (12 copies of one row): the slope
    // influence values repeat within a code → u_s = 25/300 exactly → n_eff ≈ 25 / D_s < 100.
    const base = plantedOutcomes(25, 1.0, prngFor("pool-neff-copies"));
    const s: number[] = [];
    const y: (0 | 1)[] = [];
    const codes: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const c = i % 25;
      s.push(base.z[c]!);
      y.push(base.y[c]!);
      codes.push(`ZZ${String(c).padStart(2, "0")}`);
    }
    const copies = { ...layoutOf(300, 25), codes };
    const small = plattFitPooled([{ family: "F1", s, y }], copies, { expectedBlock: 10 });
    expect(isUndefined(small) && small.undefined).toMatch(/pool n_eff below 100/);
    expect(
      effectiveN(
        copies,
        new Array(300).fill(0).map((_, i) => (i % 25) - 12),
        { expectedBlock: 10 },
      ).uniqueShare,
    ).toBeCloseTo(25 / 300, 12);
  });
});

describe("Brier skill", () => {
  it("known answer: p = (0.8, 0.2, 0.7, 0.3), y = (1, 0, 1, 0) → BS 0.065, BSS 0.74", () => {
    const p = [0.8, 0.2, 0.7, 0.3];
    const y: (0 | 1)[] = [1, 0, 1, 0];
    expect(brier(p, y)).toBeCloseTo(0.065, 12);
    expect(brierSkill(p, y)).toBeCloseTo(0.74, 12);
    expect(Number.isNaN(brierSkill([0.5, 0.5], [1, 1]))).toBe(true);
    expect(() => brier([1.2], [1])).toThrow(RangeError);
  });

  it("planted calibrated predictor: lower bound > 0; null predictor: lower bound <= 0", () => {
    const n = 600;
    const good = plantedOutcomes(n, 1.5, prngFor("bss-good"));
    const ci = brierSkillCi(good.pTrue, good.y, layoutOf(n), prngFor("bss-good-boot"), TEST_BOOT);
    if (isUndefined(ci)) throw new Error(ci.undefined);
    expect(ci.point).toBeGreaterThan(0);
    expect(ci.oneSidedLo).toBeGreaterThan(0);
    expect(ci.nEff).toBeDefined();

    // Null: the same p, but outcomes drawn independently of it.
    const other = plantedOutcomes(n, 1.5, prngFor("bss-null-y"));
    const nullCi = brierSkillCi(
      good.pTrue,
      other.y,
      layoutOf(n),
      prngFor("bss-null-boot"),
      TEST_BOOT,
    );
    if (isUndefined(nullCi)) throw new Error(nullCi.undefined);
    expect(nullCi.oneSidedLo).toBeLessThanOrEqual(0);
  });
});

describe("calibration slope and intercept", () => {
  it("a perfectly calibrated p gives slope ≈ 1, intercept ≈ 0; over-confident gives slope < 1", () => {
    const n = 4000;
    const d = plantedOutcomes(n, 1.5, prngFor("slope"));
    const fit = calibrationSlope(d.pTrue, d.y);
    if (isUndefined(fit)) throw new Error(fit.undefined);
    expect(fit.slope).toBeGreaterThan(0.85);
    expect(fit.slope).toBeLessThan(1.15);
    expect(Math.abs(fit.intercept)).toBeLessThan(0.15);
    // Over-confident: report logistic(3 × logit(p_true)) → slope about 1/3.
    const over = d.pTrue.map((p) => logistic(3 * logit(p)));
    const fo = calibrationSlope(over, d.y);
    if (isUndefined(fo)) throw new Error(fo.undefined);
    expect(fo.slope).toBeGreaterThan(0.25);
    expect(fo.slope).toBeLessThan(0.45);
  });

  it("intervals: calibrated covers 1 and 0, over-confident upper bound < 1 hides p (D-257)", () => {
    const n = 600;
    const d = plantedOutcomes(n, 1.5, prngFor("slope-ci"));
    const ci = calibrationSlopeCi(d.pTrue, d.y, layoutOf(n), prngFor("slope-ci-boot"), TEST_BOOT);
    if (isUndefined(ci)) throw new Error(ci.undefined);
    expect(ci.slope.lo).toBeLessThan(1);
    expect(ci.slope.hi).toBeGreaterThan(1);
    expect(ci.intercept.lo).toBeLessThan(0);
    expect(ci.intercept.hi).toBeGreaterThan(0);
    expect(ci.pHidden).toBe(false);
    expect(DEFAULT_SLOPE_HIDE_UB).toBe(1.0);

    const over = d.pTrue.map((p) => logistic(3 * logit(p)));
    const oc = calibrationSlopeCi(over, d.y, layoutOf(n), prngFor("slope-over-boot"), TEST_BOOT);
    if (isUndefined(oc)) throw new Error(oc.undefined);
    expect(oc.slope.oneSidedHi).toBeLessThan(1);
    expect(oc.slope.hi).toBeLessThan(1);
    expect(oc.pHidden).toBe(true);
    // The key is a parameter: with hideUb 0.2 the same family is not hidden.
    const lax = calibrationSlopeCi(over, d.y, layoutOf(n), prngFor("slope-over-boot"), {
      ...TEST_BOOT,
      hideUb: 0.2,
    });
    if (isUndefined(lax)) throw new Error(lax.undefined);
    expect(lax.pHidden).toBe(false);
    expect(lax.slope.point).toBe(oc.slope.point);
  });

  it("is deterministic for a seed", () => {
    const n = 300;
    const d = plantedOutcomes(n, 1.0, prngFor("slope-det"));
    const a = calibrationSlopeCi(d.pTrue, d.y, layoutOf(n), prngFor("slope-det-boot"), {
      expectedBlock: 10,
      replicates: 40,
    });
    const b = calibrationSlopeCi(d.pTrue, d.y, layoutOf(n), prngFor("slope-det-boot"), {
      expectedBlock: 10,
      replicates: 40,
    });
    expect(a).toEqual(b);
  });
});

describe("ECE", () => {
  it("known answer on two bins: p = (0.1, 0.1, 0.9, 0.9), y = (0, 1, 1, 1) → 0.25", () => {
    // bin [0, 0.5): p̄ 0.1, ȳ 0.5 → |gap| 0.4 × 2/4; bin [0.5, 1]: p̄ 0.9, ȳ 1 → 0.1 × 2/4 → 0.2 + 0.05.
    const r = ece([0.1, 0.1, 0.9, 0.9], [0, 1, 1, 1], 2);
    expect(r.ece).toBeCloseTo(0.25, 12);
    expect(r.bins[0]!.n).toBe(2);
    expect(r.bins[1]!.meanY).toBe(1);
    expect(ece([1, 1], [1, 1], 10).bins[9]!.n).toBe(2);
  });

  it("has an interval and is lower for a calibrated predictor than an over-confident one", () => {
    const n = 600;
    const d = plantedOutcomes(n, 1.5, prngFor("ece"));
    const good = eceCi(d.pTrue, d.y, layoutOf(n), prngFor("ece-good"), TEST_BOOT);
    const over = eceCi(
      d.pTrue.map((p) => logistic(3 * logit(p))),
      d.y,
      layoutOf(n),
      prngFor("ece-over"),
      TEST_BOOT,
    );
    if (isUndefined(good) || isUndefined(over)) throw new Error("undefined");
    expect(good.point).toBeLessThan(over.point);
    expect(good.lo).toBeLessThanOrEqual(good.point);
    expect(good.hi).toBeGreaterThanOrEqual(good.point);
    expect(good.level).toBe(0.9);
  });
});
