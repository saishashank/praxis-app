// D-885/D-1225: the stop in force; the real target (targetOf) or none. The 2R indicative target is retired.
import { describe, expect, it } from "vitest";
import {
  lastPriceOf,
  ruleHasTarget,
  stopTarget,
  targetDisplay,
} from "@/lib/ui/loaders/strategyViews";

const M = 1_000_000;

describe("stopTarget (D-885, D-1225)", () => {
  it("keeps the stop and no longer invents a 2R target", () => {
    const r = stopTarget(false, 10 * M, 9 * M, null, "AUD");
    expect(r).toEqual({ stop: { micro: 9 * M, currency: "AUD", simulated: true } });
    expect("target" in r).toBe(false);
  });

  it("the stop in force is the higher of the first stop and the latest recomputed one", () => {
    expect(stopTarget(false, 10 * M, 9 * M, 9.5 * M, "AUD").stop?.micro).toBe(9.5 * M);
    // a lower recomputed level never loosens the stop
    expect(stopTarget(false, 10 * M, 9 * M, 8 * M, "AUD").stop?.micro).toBe(9 * M);
  });

  it("nothing for a masked viewer or an impossible stop", () => {
    expect(stopTarget(true, 10 * M, 9 * M, null, "AUD")).toEqual({ stop: null });
    expect(stopTarget(false, 10 * M, 10 * M, null, "AUD")).toEqual({ stop: null });
    expect(stopTarget(false, 10 * M, 0, null, "AUD")).toEqual({ stop: null });
  });
});

describe("targetDisplay and ruleHasTarget (FAM-010, D-1225)", () => {
  const quote = (lastMicro: bigint) => ({
    code: "AAA",
    lastMicro,
    prevCloseMicro: 10_000_000n,
    quoteAt: "2026-11-09T00:35:00.000Z",
    quoteD: "2026-11-09",
  });
  it("a rule version with no target key has no target", () => {
    expect(ruleHasTarget("F1", { f1_atr_mult: 2 })).toBe(false);
    expect(targetDisplay(false, "F1", {}, 10 * M, 9 * M, "AUD", undefined, null)).toEqual({
      target: null,
      reached: false,
    });
  });
  it("f1_target_r = 3 shows entry + 3 x risk from targetOf", () => {
    expect(ruleHasTarget("F1", { f1_target_r: 3 })).toBe(true);
    const r = targetDisplay(false, "F1", { f1_target_r: 3 }, 10 * M, 9 * M, "AUD", undefined, null);
    expect(r.target).toEqual({ micro: 13 * M, currency: "AUD", simulated: true });
    expect(r.reached).toBe(false);
  });
  it("a percent target and a cold stop", () => {
    expect(
      targetDisplay(false, "F2", { f2_target_pct: 10 }, 10 * M, 9 * M, "AUD", undefined, null)
        .target?.micro,
    ).toBe(11 * M);
    expect(
      targetDisplay(false, "F1", { f1_target_r: 2 }, 10 * M, 0, "AUD", undefined, null).target,
    ).toBeNull();
  });
  it("the delayed price of a later day reaching the target flags it (display only)", () => {
    const p = { f1_target_r: 3 };
    const at = (q: bigint, d: string | null) =>
      targetDisplay(false, "F1", p, 10 * M, 9 * M, "AUD", quote(q), d).reached;
    expect(at(13_000_000n, "2026-11-06")).toBe(true);
    expect(at(12_999_999n, "2026-11-06")).toBe(false);
    expect(at(13_500_000n, "2026-11-09")).toBe(false); // not newer than the close
  });
  it("masked viewers and invalid stored values show no target", () => {
    expect(
      targetDisplay(true, "F1", { f1_target_r: 3 }, 10 * M, 9 * M, "AUD", undefined, null).target,
    ).toBeNull();
    expect(
      targetDisplay(false, "F1", { f1_target_r: 99 }, 10 * M, 9 * M, "AUD", undefined, null).target,
    ).toBeNull();
  });
});

describe("lastPriceOf (D-900)", () => {
  const quote = (quoteD: string) => ({
    code: "AAA",
    lastMicro: 10_600_000n,
    prevCloseMicro: 10_000_000n,
    quoteAt: `${quoteD}T00:35:00.000Z`,
    quoteD,
  });
  it("an open trade shows a delayed quote from a later day than its close, with the Melbourne time", () => {
    expect(lastPriceOf(false, false, 10.5, "2026-11-06", quote("2026-11-09"), "AUD")).toEqual({
      lastPrice: { micro: 10_600_000, currency: "AUD", simulated: true },
      lastPriceAt: "11:35",
    });
  });
  it("otherwise the stored close, without a time", () => {
    expect(lastPriceOf(false, false, 10.5, "2026-11-09", quote("2026-11-09"), "AUD")).toEqual({
      lastPrice: { micro: 10_500_000, currency: "AUD", simulated: true },
      lastPriceAt: null,
    });
    expect(lastPriceOf(false, false, 10.5, "2026-11-09", undefined, "AUD").lastPriceAt).toBeNull();
    expect(lastPriceOf(false, false, null, null, undefined, "AUD")).toEqual({
      lastPrice: null,
      lastPriceAt: null,
    });
  });
  it("closed trades and masked viewers show none", () => {
    const none = { lastPrice: null, lastPriceAt: null };
    expect(lastPriceOf(false, true, 10.5, null, quote("2026-11-09"), "AUD")).toEqual(none);
    expect(lastPriceOf(true, false, 10.5, null, quote("2026-11-09"), "AUD")).toEqual(none);
  });
});
