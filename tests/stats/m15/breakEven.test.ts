// @vitest-environment node
// Break-even probability (M15 C2; CTX-021, CTX-022a; AT-52 "p_be fixture G 10, L 6, C 2.5 → 53.1 %").
import { describe, expect, it } from "vitest";
import {
  breakEvenCi,
  breakEvenLine,
  breakEvenP,
  CARD_COST_LEVELS,
  conditionalGainLoss,
  grossReturnFromMicro,
} from "@/lib/stats/breakEven";
import { isUndefined } from "@/lib/stats/stationaryBootstrap";
import { layoutOf, normal, prngFor, TEST_BOOT } from "./helpers";

describe("breakEvenP", () => {
  it("AT-52: G 10, L 6, C 2.5 → 53.1 %", () => {
    const p = breakEvenP(10, 6, 2.5);
    expect(p).toBeCloseTo(0.53125, 12);
    expect(Math.round(p * 1000) / 10).toBe(53.1);
  });

  it("is the same in fractions and validates its inputs", () => {
    expect(breakEvenP(0.1, 0.06, 0.025)).toBeCloseTo(0.53125, 12);
    expect(breakEvenP(10, 6, 0)).toBeCloseTo(0.375, 12);
    expect(() => breakEvenP(-1, 6, 2.5)).toThrow(RangeError);
    expect(() => breakEvenP(0, 0, 1)).toThrow(RangeError);
  });

  it("the card line shows p_be at 2.5 %, 5 % and 7.5 %", () => {
    expect(CARD_COST_LEVELS).toEqual([0.025, 0.05, 0.075]);
    const line = breakEvenLine(0.1, 0.06);
    expect(line.map((l) => l.c)).toEqual([0.025, 0.05, 0.075]);
    expect(line[0]!.pBe).toBeCloseTo(0.53125, 12);
    expect(line[1]!.pBe).toBeCloseTo(0.11 / 0.16, 12);
    expect(line[2]!.pBe).toBeCloseTo(0.135 / 0.16, 12);
  });
});

describe("conditionalGainLoss", () => {
  it("known answer over all outcomes, flat exits on the loss side", () => {
    // gains 0.10, 0.20 → G 0.15; losses −0.06, 0 → L 0.03
    const gl = conditionalGainLoss([0.1, -0.06, 0.2, 0]);
    expect(gl.gain).toBeCloseTo(0.15, 12);
    expect(gl.loss).toBeCloseTo(0.03, 12);
    expect(gl.nGain).toBe(2);
    expect(gl.nLoss).toBe(2);
    expect(conditionalGainLoss([0.1]).loss).toBe(0);
    expect(() => conditionalGainLoss([NaN])).toThrow(RangeError);
  });

  it("converts micro-dollars at the boundary", () => {
    expect(grossReturnFromMicro(100_000_000n, 1_000_000_000n)).toBeCloseTo(0.1, 12);
    expect(grossReturnFromMicro(-60_000_000n, 1_000_000_000n)).toBeCloseTo(-0.06, 12);
    expect(() => grossReturnFromMicro(1n, 0n)).toThrow(RangeError);
  });
});

describe("breakEvenCi", () => {
  it("brackets the planted G, L and p_be and is deterministic", () => {
    const prng = prngFor("be-gross");
    const n = 600;
    // Gains around +0.10, losses around −0.06, 40 % gains.
    const gross = Array.from({ length: n }, (_, i) =>
      i % 5 < 2 ? 0.1 + 0.02 * normal(prng) : -0.06 + 0.01 * normal(prng),
    );
    const r = breakEvenCi(gross, 0.025, layoutOf(n), prngFor("be-boot"), TEST_BOOT);
    if (isUndefined(r)) throw new Error(r.undefined);
    expect(r.gain.lo).toBeLessThan(0.1);
    expect(r.gain.hi).toBeGreaterThan(0.1);
    expect(r.loss.lo).toBeLessThan(0.06);
    expect(r.loss.hi).toBeGreaterThan(0.06);
    expect(r.pBe.point).toBeCloseTo(breakEvenP(r.gain.point, r.loss.point, 0.025), 12);
    expect(r.pBe.lo).toBeLessThan(0.53125);
    expect(r.pBe.hi).toBeGreaterThan(0.53125);
    const again = breakEvenCi(gross, 0.025, layoutOf(n), prngFor("be-boot"), TEST_BOOT);
    expect(again).toEqual(r);
  });

  it("is undefined without both gains and losses", () => {
    const r = breakEvenCi([0.1, 0.2, 0.3], 0.025, layoutOf(3), prngFor("be-one"), {
      expectedBlock: 1,
      replicates: 5,
    });
    expect(isUndefined(r) && r.undefined).toMatch(/both gains and losses/);
  });
});
