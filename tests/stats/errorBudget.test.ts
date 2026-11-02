// @vitest-environment node
// VAL-112 / VAL-113 / VAL-115 known-answer tests (M14 WP4, D-226, D-229, D-230).
import { describe, expect, it } from "vitest";
import { validationLevel } from "@/lib/stats/gates";
import { validationLevelFor, wealthAfter } from "@/lib/stats/errorBudget";
import { minBacktestYears, minBtlLabel } from "@/lib/stats/minBtl";
import { normalQuantile } from "@/lib/stats/normal";
import { requiredRows } from "@/lib/stats/power";

const legacy = { alpha: 0.05, m: 20, lineages: 6 };

describe("VAL-112 error budget", () => {
  it("fixed mode is exactly the v1 level alpha / (m L)", () => {
    for (const k of [0, 1, 7]) {
      expect(validationLevelFor({ mode: "fixed", w0: 0.05, priorTests: k, legacy })).toBe(
        validationLevel(0.05, 20, 6),
      );
    }
    expect(validationLevel(0.05, 20, 6)).toBeCloseTo(0.05 / 120, 15);
  });

  it("alpha_spending: Foster-Stine with payout 0, alpha_k = W_k / (2 + W_k), W_k = W0 / 2^k", () => {
    // hand values: W0 = 0.05
    //  k=0  W=0.05      alpha = 0.05 / 2.05           = 0.024390243902439
    //  k=1  W=0.025     alpha = 0.025 / 2.025         = 0.012345679012346
    //  k=2  W=0.0125    alpha = 0.0125 / 2.0125       = 0.006211180124224
    //  k=3  W=0.00625   alpha = 0.00625 / 2.00625     = 0.003115264797508
    const level = (k: number): number =>
      validationLevelFor({ mode: "alpha_spending", w0: 0.05, priorTests: k, legacy });
    expect(level(0)).toBeCloseTo(0.024390243902439, 12);
    expect(level(1)).toBeCloseTo(0.012345679012346, 12);
    expect(level(2)).toBeCloseTo(0.006211180124224, 12);
    expect(level(3)).toBeCloseTo(0.003115264797508, 12);
    expect(wealthAfter(0.05, 3)).toBe(0.00625);
  });

  it("the levels sum to less than W0, so the family-wise error is at most 0.05", () => {
    let sum = 0;
    for (let k = 0; k < 60; k += 1) {
      sum += validationLevelFor({ mode: "alpha_spending", w0: 0.05, priorTests: k, legacy });
    }
    expect(sum).toBeLessThan(0.05);
    expect(sum).toBeGreaterThan(0.0485); // geometric tail: nearly all of W0 is spendable
  });

  it("is independent of the number of lineages and of m (no division by L)", () => {
    const a = validationLevelFor({
      mode: "alpha_spending",
      w0: 0.05,
      priorTests: 2,
      legacy: { alpha: 0.05, m: 20, lineages: 6 },
    });
    const b = validationLevelFor({
      mode: "alpha_spending",
      w0: 0.05,
      priorTests: 2,
      legacy: { alpha: 0.05, m: 5, lineages: 40 },
    });
    expect(a).toBe(b);
  });

  it("rejects a bad k or W0", () => {
    const base = { mode: "alpha_spending" as const, w0: 0.05, priorTests: 0, legacy };
    expect(() => validationLevelFor({ ...base, priorTests: -1 })).toThrow(RangeError);
    expect(() => validationLevelFor({ ...base, priorTests: 1.5 })).toThrow(RangeError);
    expect(() => validationLevelFor({ ...base, w0: 0 })).toThrow(RangeError);
  });
});

describe("VAL-113 power arithmetic", () => {
  // z(0.95) = 1.6448536, z(0.80) = 0.8416212; (2.4864748 * 1 / 0.1)^2 = 618.25 -> 619
  it("n = ceil(((z_{1-level} + z_power) sd / effect)^2 / neffRatio), floor 100", () => {
    const z = normalQuantile(0.95) + normalQuantile(0.8);
    expect(z).toBeCloseTo(2.4864748, 6);
    expect(requiredRows({ effect: 0.1, sd: 1, level: 0.05 })).toBe(619);
    expect(requiredRows({ effect: 0.1, sd: 1, level: 0.05, neffRatio: 0.5 })).toBe(1237);
    expect(requiredRows({ effect: 10, sd: 1, level: 0.05 })).toBe(100);
  });

  it("a smaller level needs more rows (the VAL-112 level feeds in)", () => {
    const at = (k: number): number =>
      validationLevelFor({ mode: "alpha_spending", w0: 0.05, priorTests: k, legacy });
    expect(requiredRows({ effect: 0.02, sd: 0.1, level: at(3) })).toBeGreaterThan(
      requiredRows({ effect: 0.02, sd: 0.1, level: at(0) }),
    );
  });

  it("rejects bad inputs", () => {
    expect(() => requiredRows({ effect: 0, sd: 1, level: 0.05 })).toThrow(RangeError);
    expect(() => requiredRows({ effect: 1, sd: 1, level: 0 })).toThrow(RangeError);
    expect(() => requiredRows({ effect: 1, sd: 1, level: 0.05, neffRatio: 1.5 })).toThrow(
      RangeError,
    );
  });
});

describe("VAL-115 MinBTL (Bailey, Borwein, Lopez de Prado, Zhu 2014)", () => {
  it("N = 45 trials at SR* = 1 needs about 5 years (the paper example)", () => {
    const years = minBacktestYears(45, 1);
    expect(years).toBeGreaterThan(4.95);
    expect(years).toBeLessThan(5.05);
    // by hand: 0.4227843 x z(1 - 1/45) + 0.5772157 x z(1 - 1/(45 e)) = 0.4227843 x 2.0100 + 0.5772157 x 2.3987
    const g = 0.5772156649015329;
    const hand =
      ((1 - g) * normalQuantile(1 - 1 / 45) + g * normalQuantile(1 - 1 / (45 * Math.E))) ** 2;
    expect(years).toBe(hand);
  });

  it("MinBTL(1) = 0, grows with N, and scales with 1 / SR*^2", () => {
    expect(minBacktestYears(1, 1)).toBe(0);
    expect(minBacktestYears(0, 1)).toBe(0);
    expect(minBacktestYears(100, 1)).toBeGreaterThan(minBacktestYears(45, 1));
    expect(minBacktestYears(45, 2)).toBeCloseTo(minBacktestYears(45, 1) / 4, 12);
  });

  it("labels 'too short' until the development length reaches MinBTL", () => {
    const need = minBacktestYears(45, 1);
    const short = minBtlLabel(45, 1, Math.floor(need * 252) - 1);
    expect(short.label).toBe("too short");
    const ok = minBtlLabel(45, 1, Math.ceil(need * 252));
    expect(ok.label).toBe("long enough");
    expect(ok.availableYears).toBeGreaterThanOrEqual(ok.minYears);
  });

  it("rejects a bad target Sharpe", () => {
    expect(() => minBacktestYears(10, 0)).toThrow(RangeError);
  });
});
