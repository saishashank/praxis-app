// @vitest-environment node
// Gap-risk cap (M15 C3a; CTX-022b: stop distance + gap95 ≤ max_loss_pct, stops referenced to the fill).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENTRY_GAP_CAP,
  DEFAULT_MAX_LOSS,
  GAP_CAP_LABEL,
  gapCapTest,
  stopDistanceFraction,
  stopDistanceRat,
} from "@/lib/cortex/economics/gapCap";
import { makeRational } from "@/lib/money/rational";

describe("stop distance from the fill", () => {
  it("exact fraction and its float", () => {
    // fill A$10.80, stop A$9.72 → 1_080_000 / 10_800_000 = 1/10
    expect(stopDistanceRat(10_800_000n, 9_720_000n)).toEqual(makeRational(1n, 10n));
    expect(stopDistanceFraction(10_800_000n, 9_720_000n)).toBeCloseTo(0.1, 12);
    expect(() => stopDistanceRat(10n, 10n)).toThrow(RangeError);
    expect(() => stopDistanceRat(10n, 0n)).toThrow(RangeError);
    expect(() => stopDistanceRat(0n, 1n)).toThrow(RangeError);
  });
});

describe("gapCapTest", () => {
  it("defaults: max_loss 18 %, entry gap cap 8/100 exact", () => {
    expect(DEFAULT_MAX_LOSS).toBe(0.18);
    expect(DEFAULT_ENTRY_GAP_CAP).toEqual(makeRational(2n, 25n));
  });

  it("10 % stop + 6 % gap95 = 16 % ≤ 18 % passes; 10 % + 9 % fails with the label", () => {
    expect(gapCapTest({ stopDistance: 0.1, gap95: 0.06 })).toEqual({
      pass: true,
      total: 0.16,
      maxLoss: 0.18,
    });
    const fail = gapCapTest({ stopDistance: 0.1, gap95: 0.09 });
    expect(fail.pass).toBe(false);
    if (fail.pass) return;
    expect(fail.total).toBeCloseTo(0.19, 12);
    expect(fail.label).toBe(GAP_CAP_LABEL);
  });

  it("equality passes; the key moves the cap", () => {
    expect(gapCapTest({ stopDistance: 0.12, gap95: 0.06 }).pass).toBe(true);
    expect(gapCapTest({ stopDistance: 0.1, gap95: 0.06, maxLoss: 0.12 }).pass).toBe(false);
    expect(gapCapTest({ stopDistance: 0.1, gap95: 0.15, maxLoss: 0.25 }).pass).toBe(true);
  });

  it("a stop re-referenced to a worse fill can void a decision-time pass (CTX-022b at the fill)", () => {
    // Planned entry A$10.00, stop A$8.70 (13 %) with gap95 4 %: 17 % passes at decision time.
    expect(
      gapCapTest({ stopDistance: stopDistanceFraction(10_000_000n, 8_700_000n), gap95: 0.04 }).pass,
    ).toBe(true);
    // Filled at A$10.80 with the stop kept at A$8.70: 19.44 % + 4 % fails → voided at the fill.
    expect(
      gapCapTest({ stopDistance: stopDistanceFraction(10_800_000n, 8_700_000n), gap95: 0.04 }).pass,
    ).toBe(false);
  });

  it("rejects negative inputs and a non-positive cap", () => {
    expect(() => gapCapTest({ stopDistance: -0.1, gap95: 0 })).toThrow(RangeError);
    expect(() => gapCapTest({ stopDistance: 0.1, gap95: NaN })).toThrow(RangeError);
    expect(() => gapCapTest({ stopDistance: 0.1, gap95: 0, maxLoss: 0 })).toThrow(RangeError);
  });
});
