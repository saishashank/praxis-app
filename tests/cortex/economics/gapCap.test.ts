// @vitest-environment node
// Gap-risk cap (M15 C3a; CTX-022b: stop distance + gap95 ≤ max_loss_pct, stops referenced to the fill;
// review S1: the comparison is exact, so 14 % + 4 % = 18 % passes).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENTRY_GAP_CAP,
  DEFAULT_MAX_LOSS,
  fractionToPpmRat,
  GAP_CAP_LABEL,
  gapCapTest,
  stopDistanceFraction,
  stopDistanceRat,
} from "@/lib/cortex/economics/gapCap";
import { makeRational } from "@/lib/money/rational";

const pct = (n: bigint) => makeRational(n, 100n);

describe("stop distance from the fill", () => {
  it("exact fraction and its float", () => {
    // fill A$10.80, stop A$9.72 → 1_080_000 / 10_800_000 = 1/10
    expect(stopDistanceRat(10_800_000n, 9_720_000n)).toEqual(makeRational(1n, 10n));
    expect(stopDistanceFraction(10_800_000n, 9_720_000n)).toBeCloseTo(0.1, 12);
    expect(() => stopDistanceRat(10n, 10n)).toThrow(RangeError);
    expect(() => stopDistanceRat(10n, 0n)).toThrow(RangeError);
    expect(() => stopDistanceRat(0n, 1n)).toThrow(RangeError);
  });

  it("a float gap95 becomes an exact ppm rational, rounded once", () => {
    expect(fractionToPpmRat(0.04)).toEqual(makeRational(40_000n, 1_000_000n));
    expect(fractionToPpmRat(0.0123456789)).toEqual(makeRational(12_346n, 1_000_000n));
    expect(fractionToPpmRat(0)).toEqual(makeRational(0n));
    expect(() => fractionToPpmRat(-0.1)).toThrow(RangeError);
    expect(() => fractionToPpmRat(NaN)).toThrow(RangeError);
  });
});

describe("gapCapTest", () => {
  it("defaults: max_loss 18/100, entry gap cap 8/100, exact", () => {
    expect(DEFAULT_MAX_LOSS).toEqual(makeRational(9n, 50n));
    expect(DEFAULT_ENTRY_GAP_CAP).toEqual(makeRational(2n, 25n));
  });

  it("10 % stop + 6 % gap95 = 16 % ≤ 18 % passes; 10 % + 9 % fails with the label", () => {
    expect(gapCapTest({ stopDistance: pct(10n), gap95: 0.06 })).toEqual({
      pass: true,
      total: pct(16n),
      maxLoss: pct(18n),
    });
    const fail = gapCapTest({ stopDistance: pct(10n), gap95: 0.09 });
    expect(fail.pass).toBe(false);
    if (fail.pass) return;
    expect(fail.total).toEqual(pct(19n));
    expect(fail.label).toBe(GAP_CAP_LABEL);
  });

  it("S1: 14 % stop + 4 % gap95 = 18 % passes exactly (floats would say 0.18000000000000002)", () => {
    expect(0.14 + 0.04 > 0.18).toBe(true); // the float trap the exact test avoids
    const r = gapCapTest({ stopDistance: stopDistanceRat(10_000_000n, 8_600_000n), gap95: 0.04 });
    expect(r.pass).toBe(true);
    expect(r.total).toEqual(pct(18n));
    // one ppm over the cap fails
    expect(gapCapTest({ stopDistance: pct(14n), gap95: 0.040001 }).pass).toBe(false);
  });

  it("the key moves the cap", () => {
    expect(gapCapTest({ stopDistance: pct(10n), gap95: 0.06, maxLoss: pct(12n) }).pass).toBe(false);
    expect(gapCapTest({ stopDistance: pct(10n), gap95: 0.15, maxLoss: pct(25n) }).pass).toBe(true);
  });

  it("a stop re-referenced to a worse fill can void a decision-time pass (CTX-022b at the fill)", () => {
    // Planned entry A$10.00, stop A$8.70 (13 %) with gap95 4 %: 17 % passes at decision time.
    expect(
      gapCapTest({ stopDistance: stopDistanceRat(10_000_000n, 8_700_000n), gap95: 0.04 }).pass,
    ).toBe(true);
    // Filled at A$10.80 with the stop kept at A$8.70: 19.44 % + 4 % fails → voided at the fill.
    expect(
      gapCapTest({ stopDistance: stopDistanceRat(10_800_000n, 8_700_000n), gap95: 0.04 }).pass,
    ).toBe(false);
  });

  it("rejects negative inputs and a non-positive cap", () => {
    expect(() => gapCapTest({ stopDistance: makeRational(-1n, 10n), gap95: 0 })).toThrow(
      RangeError,
    );
    expect(() => gapCapTest({ stopDistance: pct(10n), gap95: NaN })).toThrow(RangeError);
    expect(() =>
      gapCapTest({ stopDistance: pct(10n), gap95: 0, maxLoss: makeRational(0n) }),
    ).toThrow(RangeError);
  });
});
