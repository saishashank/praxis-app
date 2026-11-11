// D-885: the stop in force and the indicative target of a trade (shown only, never an exit rule).
import { describe, expect, it } from "vitest";
import { lastPriceOf, stopTarget } from "@/lib/ui/loaders/strategyViews";

const M = 1_000_000;

describe("stopTarget (D-885)", () => {
  it("target is the buy price plus twice the distance to the first stop", () => {
    const r = stopTarget(false, 10 * M, 9 * M, null, "AUD");
    expect(r.stop?.micro).toBe(9 * M);
    expect(r.target?.micro).toBe(12 * M);
  });

  it("the stop in force is the higher of the first stop and the latest recomputed one", () => {
    expect(stopTarget(false, 10 * M, 9 * M, 9.5 * M, "AUD").stop?.micro).toBe(9.5 * M);
    // a lower recomputed level never loosens the stop; the target stays on the first stop
    const r = stopTarget(false, 10 * M, 9 * M, 8 * M, "AUD");
    expect(r.stop?.micro).toBe(9 * M);
    expect(r.target?.micro).toBe(12 * M);
  });

  it("nothing for a masked viewer or an impossible stop", () => {
    expect(stopTarget(true, 10 * M, 9 * M, null, "AUD")).toEqual({ stop: null, target: null });
    expect(stopTarget(false, 10 * M, 10 * M, null, "AUD")).toEqual({ stop: null, target: null });
    expect(stopTarget(false, 10 * M, 0, null, "AUD")).toEqual({ stop: null, target: null });
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
