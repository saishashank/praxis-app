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

describe("costPerOrder = Σ_{buy,sell} (fee + max(ARN-032 slippage per fill, tier half-spread floor)) (D-311)", () => {
  it("AT-52: a A$0.20 U2 stock, A$500 spec parcel, P5, ADV A$300k → 7.0 % (CTX-022a 'about 7 %')", () => {
    // fees: P5 A$5.00 each side → 10_000_000 / 500_000_000 = 1/50 (2 %)
    // per fill: ARN-032 max(60 bps × 200_000 = 1_200, one tick 5_000) = 5_000 → 5_000 / 200_000 = 1/40
    //           (2.5 %) vs the half-spread floor half a tick ÷ price = 1/80 (1.25 %) → 1/40 wins;
    //           buy 205_000 and sell 195_000 both slip 5_000.
    // C = 1/50 + 1/40 + 1/40 = 4/200 + 10/200 = 14/200 = 7/100 = 7.0 % → 70_000 ppm.
    //
    // The spread is NOT added on top of the ARN-032 tick term (D-311: the tick term already models
    // paying through the touch; the simulator charges fee + ARN-032 per fill only). AT-52's "≈ 4.5–5 %"
    // is a stale pre-slippage figure superseded by CTX-022a's "about 7 %" (D-312); D-259 keeps the
    // formula as the requirement. The economic gate (CTX-021) nets this cost, so such a candidate is
    // mostly rejected — the honest answer at this account size (spec wording).
    const c = costPerOrder({
      profile: COST_PROFILES.P5,
      notionalMicro: A$(500),
      priceMicro: 200_000n,
      tier: "U2",
      advMicro: A$(300_000),
    });
    expect(c.parts.fees).toEqual(makeRational(1n, 50n));
    expect(c.parts.slipBuy).toEqual(makeRational(1n, 40n));
    expect(c.parts.slipSell).toEqual(makeRational(1n, 40n));
    expect(c.parts.halfSpreadFloorApplied).toBe(false);
    expect(c.fraction).toEqual(makeRational(7n, 100n));
    expect(c.ppm).toBe(70_000);
    expect(costFraction(c)).toBeCloseTo(0.07, 12);
  });

  it("the same stock on P1 (A$3 flat) is 6.2 %: only the fee term moves", () => {
    // fees 6_000_000 / 500_000_000 = 3/250 (1.2 %); C = 3/250 + 1/20 = 6/500 + 25/500 = 31/500 = 6.2 %.
    const c = costPerOrder({
      profile: COST_PROFILES.P1,
      notionalMicro: A$(500),
      priceMicro: 200_000n,
      tier: "U2",
      advMicro: A$(300_000),
    });
    expect(c.fraction).toEqual(makeRational(31n, 500n));
    expect(c.ppm).toBe(62_000);
  });

  it("a A$10 U1 stock, A$500 on P5: 22_000 ppm at ADV ≥ A$5M and 25_000 ppm at A$1–5M", () => {
    // fees 1/50 (2 %). ADV A$5M: slip max(10 bps × 10_000_000 = 10_000, tick 10_000) = 10_000 → 1/1000
    // each fill; the U1 floor is 500 ppm = half a tick → the slippage wins. C = 1/50 + 2/1000 = 22/1000.
    const liquid = costPerOrder({
      profile: COST_PROFILES.P5,
      notionalMicro: A$(500),
      priceMicro: A$(10),
      tier: "U1",
      advMicro: A$(5_000_000),
    });
    expect(liquid.fraction).toEqual(makeRational(11n, 500n));
    expect(liquid.ppm).toBe(22_000);
    expect(liquid.parts.halfSpreadFloorApplied).toBe(false);
    // ADV A$2M: 25 bps × 10_000_000 = 25_000 (2.5 ticks → buy 10_030_000, sell 9_970_000: 30_000 each,
    // the adverse grid rounding) → 3/1000 each fill. C = 1/50 + 6/1000 = 26/1000 → 26_000 ppm.
    // (The reviewer's 25_000 is the pre-rounding figure; the fills pay the grid-rounded amount, as v1.)
    const mid = costPerOrder({
      profile: COST_PROFILES.P5,
      notionalMicro: A$(500),
      priceMicro: A$(10),
      tier: "U1",
      advMicro: A$(2_000_000),
    });
    expect(mid.fraction).toEqual(makeRational(13n, 500n));
    expect(mid.ppm).toBe(26_000);
  });

  it("the U3 floor (7_500 ppm) applies when it exceeds the ARN-032 slippage on a A$10 stock", () => {
    // per fill max(1/1000, 7_500/1_000_000 = 3/400) = 3/400; C = 1/50 + 6/400 = 8/400 + 6/400 = 7/200.
    const c = costPerOrder({
      profile: COST_PROFILES.P5,
      notionalMicro: A$(500),
      priceMicro: A$(10),
      tier: "U3",
      advMicro: A$(5_000_000),
    });
    expect(c.parts.halfSpreadFloorApplied).toBe(true);
    expect(c.parts.slipBuy).toEqual(makeRational(3n, 400n));
    expect(c.fraction).toEqual(makeRational(7n, 200n));
    expect(c.ppm).toBe(35_000);
  });

  it("the fee follows the notional (P5 A$10 above A$1,000.00), the rest the price", () => {
    // A$2,000 on P5: 2 × 10_000_000 / 2_000_000_000 = 1/100; C = 1/100 + 2/1000 = 12/1000.
    const c = costPerOrder({
      profile: COST_PROFILES.P5,
      notionalMicro: A$(2_000),
      priceMicro: A$(10),
      tier: "U1",
      advMicro: A$(5_000_000),
    });
    expect(c.fraction).toEqual(makeRational(3n, 250n));
    expect(c.ppm).toBe(12_000);
  });

  it("rejects a non-positive notional or price", () => {
    const base = { profile: COST_PROFILES.P5, tier: "U1" as const, advMicro: A$(5_000_000) };
    expect(() => costPerOrder({ ...base, notionalMicro: 0n, priceMicro: 1n })).toThrow(RangeError);
    expect(() => costPerOrder({ ...base, notionalMicro: 1n, priceMicro: 0n })).toThrow(RangeError);
  });
});
