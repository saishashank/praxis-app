// @vitest-environment node
// Cost per order by tier (M15 C3a; CTX-022a; D-259, D-273, D-294; AT-52 "cost per order by tier").
// HIGH-RISK money maths: every expected value is hand-computed and written as a literal.
import { describe, expect, it } from "vitest";
import { COST_PROFILES } from "@/lib/arena/costs";
import {
  ADV_FLOOR_PER_PARCEL_MICRO,
  costFraction,
  costPerOrder,
  HALF_SPREAD_PPM_BY_TIER,
  HALF_SPREAD_VERIFIED,
  halfSpreadFraction,
  halfSpreadPpm,
  LIQUIDITY_TIERS,
  PARCEL_FLOOR_MICRO,
  PARCEL_PARTICIPATION,
  tickCostRow,
} from "@/lib/cortex/economics/cost";
import { makeRational, mulRat } from "@/lib/money/rational";

const A$ = (d: number) => BigInt(d) * 1_000_000n;

describe("half-spread by tier (D-294)", () => {
  it("the floors are stated per tier and marked to verify", () => {
    expect(LIQUIDITY_TIERS).toEqual(["U1", "U2", "U3"]);
    expect(HALF_SPREAD_PPM_BY_TIER).toEqual({ U1: 500n, U2: 2_500n, U3: 7_500n });
    expect(HALF_SPREAD_VERIFIED).toBe(false);
  });

  it("max(half a tick ÷ price, floor): the half tick wins on a A$0.20 stock, the floor on a A$10 U3 stock", () => {
    // A$0.20: tick 5_000, half = 2_500 / 200_000 = 1/80 = 12_500 ppm for every tier.
    expect(halfSpreadFraction("U2", 200_000n)).toEqual(makeRational(1n, 80n));
    expect(halfSpreadPpm("U1", 200_000n)).toBe(12_500);
    expect(halfSpreadPpm("U3", 200_000n)).toBe(12_500);
    // A$10.00: tick 10_000, half = 5_000 / 10_000_000 = 500 ppm → U1 500 (tie), U2 2_500, U3 7_500.
    expect(halfSpreadPpm("U1", A$(10))).toBe(500);
    expect(halfSpreadPpm("U2", A$(10))).toBe(2_500);
    expect(halfSpreadPpm("U3", A$(10))).toBe(7_500);
    // A$0.05: tick 1_000, half = 500 / 50_000 = 10_000 ppm.
    expect(halfSpreadPpm("U2", 50_000n)).toBe(10_000);
    expect(() => halfSpreadFraction("U2", 0n)).toThrow(RangeError);
  });

  it("tickCostRow: the CTX-071 table row", () => {
    expect(tickCostRow(A$(10))).toEqual({
      priceMicro: A$(10),
      tickMicro: 10_000n,
      halfSpreadPpm: { U1: 500, U2: 2_500, U3: 7_500 },
    });
  });

  it("the ADV floor per parcel: A$500 at 1 % participation = A$50k", () => {
    expect(PARCEL_FLOOR_MICRO).toBe(500_000_000n);
    expect(mulRat(makeRational(ADV_FLOOR_PER_PARCEL_MICRO), PARCEL_PARTICIPATION)).toEqual(
      makeRational(PARCEL_FLOOR_MICRO),
    );
  });
});

describe("costPerOrder = 2 × (fee + half-spread + slippage per fill)", () => {
  it("AT-52: a A$0.20 U2 stock, A$600 round trip, P5, ADV A$300k", () => {
    // fees: P5 A$5.00 each side → 10_000_000 / 600_000_000 = 1/60 (1.6667 %)
    // half-spread: 1/80 each side → 2/80 = 1/40 (2.5 %)
    // slippage: ARN-032 max(60 bps × 200_000 = 1_200, one tick 5_000) = 5_000 per fill;
    //           buy 205_000, sell 195_000 → 5_000 / 200_000 = 1/40 each (2.5 % + 2.5 %)
    // C = 1/60 + 1/40 + 1/40 + 1/40 = 2/120 + 9/120 = 11/120 = 9.1667 % → 91_667 ppm.
    //
    // Computed figure: 9.17 % round trip. The chapter text says "about 7 %" (CTX-022a) and AT-52 says
    // "≈ 4.5–5 %"; D-259 makes the formula the requirement and the band informational. The gap is the
    // one-tick slippage floor charged on each fill (2 × 2.5 %) on top of the half tick each side: at
    // A$0.20 a tick is 2.5 % of the price. The economic gate (CTX-021) nets this cost, so such a
    // candidate is mostly rejected — the honest answer at this account size (spec wording).
    const c = costPerOrder({
      profile: COST_PROFILES.P5,
      notionalMicro: A$(600),
      priceMicro: 200_000n,
      tier: "U2",
      advMicro: A$(300_000),
    });
    expect(c.parts.fees).toEqual(makeRational(1n, 60n));
    expect(c.parts.halfSpread).toEqual(makeRational(1n, 40n));
    expect(c.parts.slipBuy).toEqual(makeRational(1n, 40n));
    expect(c.parts.slipSell).toEqual(makeRational(1n, 40n));
    expect(c.fraction).toEqual(makeRational(11n, 120n));
    expect(c.ppm).toBe(91_667);
    expect(costFraction(c)).toBeCloseTo(0.091667, 6);
    // Informational comparison with the AT-52 band (D-259): the formula figure is above it.
    expect(c.ppm).toBeGreaterThan(50_000);
  });

  it("the same stock on P1 (A$3 flat) is 8.5 %: only the fee term moves", () => {
    // fees 6_000_000 / 600_000_000 = 1/100; C = 1/100 + 3/40 = 2/200 + 15/200 = 17/200 = 8.5 %.
    const c = costPerOrder({
      profile: COST_PROFILES.P1,
      notionalMicro: A$(600),
      priceMicro: 200_000n,
      tier: "U2",
      advMicro: A$(300_000),
    });
    expect(c.fraction).toEqual(makeRational(17n, 200n));
    expect(c.ppm).toBe(85_000);
  });

  it("a A$10 U1 stock, A$5M ADV, A$600 on P5: 1/60 + 2 × 500 ppm + 2 × 10 bps = 2.0667 %", () => {
    // half-spread: half tick 5_000 / 10_000_000 = 1/2000 = 500 ppm = the U1 floor (tie) → 2/2000
    // slippage: max(10 bps × 10_000_000 = 10_000, tick 10_000) = 10_000 → 1/1000 each fill
    // C = 1/60 + 1/1000 + 2/1000 = 1/60 + 3/1000 = (50 + 9)/3000 = 59/3000 → 19_666.67 → 19_667 ppm
    const c = costPerOrder({
      profile: COST_PROFILES.P5,
      notionalMicro: A$(600),
      priceMicro: A$(10),
      tier: "U1",
      advMicro: A$(5_000_000),
    });
    expect(c.fraction).toEqual(makeRational(59n, 3000n));
    expect(c.ppm).toBe(19_667);
  });

  it("the U3 floor raises a A$10 stock's half-spread term to 2 × 7_500 ppm", () => {
    // C = 1/60 + 15/1000 + 2/1000 = 1/60 + 17/1000 = (50 + 51)/3000 = 101/3000 = 33_666.67 → 33_667
    const c = costPerOrder({
      profile: COST_PROFILES.P5,
      notionalMicro: A$(600),
      priceMicro: A$(10),
      tier: "U3",
      advMicro: A$(5_000_000),
    });
    expect(c.fraction).toEqual(makeRational(101n, 3000n));
    expect(c.ppm).toBe(33_667);
  });

  it("the fee follows the notional (P5 A$10 above A$1,000.00), the rest the price", () => {
    // A$2,000 on P5: 2 × 10_000_000 / 2_000_000_000 = 1/100; C = 1/100 + 3/1000 = 13/1000.
    const c = costPerOrder({
      profile: COST_PROFILES.P5,
      notionalMicro: A$(2_000),
      priceMicro: A$(10),
      tier: "U1",
      advMicro: A$(5_000_000),
    });
    expect(c.fraction).toEqual(makeRational(13n, 1000n));
    expect(c.ppm).toBe(13_000);
  });

  it("rejects a non-positive notional or price", () => {
    const base = { profile: COST_PROFILES.P5, tier: "U1" as const, advMicro: A$(5_000_000) };
    expect(() => costPerOrder({ ...base, notionalMicro: 0n, priceMicro: 1n })).toThrow(RangeError);
    expect(() => costPerOrder({ ...base, notionalMicro: 1n, priceMicro: 0n })).toThrow(RangeError);
  });
});
