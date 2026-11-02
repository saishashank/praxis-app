// Cost per order by liquidity tier (M15 C3a; spec ch. 17 CTX-022a; design 3c "Cost per order", D-259,
// D-260, D-273, D-294).
//
//   C = Σ_{buy, sell} ( fee + max(ARN-032 slippage per fill, half-spread floor by tier) )     (D-311)
//
// as a fraction of the order notional, exact (Rational over micro-dollars) until the ppm figure for the
// card. The fee is the cost profile's brokerage on each side (`feeFor`, no GST: D-273). Slippage is
// charged on EACH fill as v1 does: the buy fill's and the sell fill's `slippageFill` amount at the
// reference price (grid-rounded, adverse), as a fraction of the price; ARN-032's tick term already
// models paying through the touch, so the spread is not added on top (review D-311: the simulator
// charges fee + ARN-032 per fill only). The half-spread has no intraday source at $0 (D-294): it is
// max(half a tick ÷ price, the tier floor) and acts as a FLOOR on each fill's cost — the floors below
// are stated here, marked "to verify" in the V2 PR, and shown in the CTX-071 tick/cost table.
// AT-52's "≈ 4.5–5 %" for a A$0.20 U2 stock is a stale pre-slippage figure superseded by CTX-022a's
// "about 7 %" (D-312); the formula gives 7.0 % at the A$500 spec parcel.
//
// `roundTripCost` (agents/costGate.ts, FAM-005 at the fixed A$600) stays for the v1 path (D-260): once a
// family is allowed, CTX-021 binds and this figure × `cost_gate_k` is a card diagnostic (G05, informational).
import { feeFor, type CostProfile, type FeeContext } from "@/lib/arena/costs";
import {
  DEFAULT_TICK_CROSS_FACTOR,
  SLIPPAGE_BUCKETS,
  slippageFill,
  type SlippageBucket,
} from "@/lib/arena/slippage";
import type { Micro } from "@/lib/money/micro";
import { addRat, cmpRat, makeRational, maxRat, mulRat, type Rational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { tickFor } from "@/lib/money/tick";

/** Universe liquidity tiers (ARN-010; the same literals as `Tier` in agents/families/types.ts). */
export type LiquidityTier = "U1" | "U2" | "U3";
export const LIQUIDITY_TIERS: readonly LiquidityTier[] = ["U1", "U2", "U3"];

const PPM = 1_000_000n;

/**
 * [VERIFY] Half-spread floors by liquidity tier in parts per million of the price (D-294): U1 5 bps,
 * U2 25 bps, U3 75 bps. No measured intraday spread exists at $0; these are the placeholders the
 * design asks for, to be verified by the Owner against a quoted-spread source before the V2 merge.
 * The half-tick term dominates for low-priced stocks (a A$0.20 stock: half a tick = 1.25 %).
 */
export const HALF_SPREAD_PPM_BY_TIER: Readonly<Record<LiquidityTier, bigint>> = {
  U1: 500n, // threshold-ok: D-294 placeholder floor, to verify
  U2: 2_500n, // threshold-ok: D-294 placeholder floor, to verify
  U3: 7_500n, // threshold-ok: D-294 placeholder floor, to verify
};
export const HALF_SPREAD_VERIFIED = false;

/**
 * CTX-022a "ADV floor per parcel": a A$500 parcel at 1 % participation needs ≈ A$50k ADV (the tier
 * table states it; `untradeableReason` in slippage.ts applies the ARN-013 0.5 % rule separately).
 */
export const PARCEL_FLOOR_MICRO: Micro = 500_000_000n; // threshold-ok: CTX-027 A$500 parcel floor
export const PARCEL_PARTICIPATION: Rational = makeRational(1n, 100n); // threshold-ok: CTX-022a 1 %
export const ADV_FLOOR_PER_PARCEL_MICRO: Micro = 50_000_000_000n; // threshold-ok: CTX-022a ≈ A$50k ADV

/** Half-spread as a fraction of the price: max(tick(price) / 2 ÷ price, tier floor). Exact. */
export function halfSpreadFraction(tier: LiquidityTier, priceMicro: Micro): Rational {
  if (priceMicro <= 0n) throw new RangeError("price must be positive");
  const floor = HALF_SPREAD_PPM_BY_TIER[tier];
  if (floor === undefined) throw new RangeError(`unknown liquidity tier: ${String(tier)}`);
  const halfTick = makeRational(tickFor(priceMicro), 2n * priceMicro);
  return maxRat(halfTick, makeRational(floor, PPM));
}

/** Half-spread in ppm of the price, rounded half away from zero (the CTX-071 table figure). */
export function halfSpreadPpm(tier: LiquidityTier, priceMicro: Micro): number {
  return Number(
    roundHalfAwayFromZero(mulRat(halfSpreadFraction(tier, priceMicro), makeRational(PPM))),
  );
}

export type CostPerOrderInput = {
  readonly profile: CostProfile;
  /** Order notional (qty × price), micro-dollars, > 0: the fee's base. */
  readonly notionalMicro: Micro;
  /** Reference price per share, micro-dollars, > 0: the slippage and half-spread base. */
  readonly priceMicro: Micro;
  readonly tier: LiquidityTier;
  /** 20-session ADV as traded value, micro-dollars (ARN-032 bucket). */
  readonly advMicro: Micro;
  readonly feeContext?: FeeContext;
  readonly tickCrossFactor?: Rational;
  readonly buckets?: readonly SlippageBucket[];
};

export type CostPerOrder = {
  /** C as an exact fraction of the notional. */
  readonly fraction: Rational;
  /** C in parts per million, rounded half away from zero (`CardFields.costPerOrderPpm`). */
  readonly ppm: number;
  readonly parts: {
    /** (buy fee + sell fee) ÷ notional. */
    readonly fees: Rational;
    /** Buy-fill cost ÷ price: max(ARN-032 slippage, grid-rounded adverse, tier half-spread floor). */
    readonly slipBuy: Rational;
    /** Sell-fill cost ÷ price: the same max on the sell fill. */
    readonly slipSell: Rational;
    /** True when the tier half-spread floor exceeded the ARN-032 slippage on at least one fill. */
    readonly halfSpreadFloorApplied: boolean;
  };
};

/**
 * CTX-022a round-trip cost per order, exact (D-311):
 *   C = Σ_{buy, sell} ( fee(notional) + max(ARN-032 slippage per fill, tier half-spread floor) ) ÷ base
 * ARN-032's tick term (`tick_cross_factor`) already models paying through the touch, so the D-294
 * half-spread is a FLOOR inside the per-fill max, never an additive term (the simulator charges
 * fee + ARN-032 per fill only; adding the spread would double-count it).
 */
export function costPerOrder(input: CostPerOrderInput): CostPerOrder {
  const { profile, notionalMicro, priceMicro, tier, advMicro } = input;
  if (notionalMicro <= 0n) throw new RangeError("notional must be positive");
  if (priceMicro <= 0n) throw new RangeError("price must be positive");
  const factor = input.tickCrossFactor ?? DEFAULT_TICK_CROSS_FACTOR;
  const buckets = input.buckets ?? SLIPPAGE_BUCKETS;
  const feeMicro =
    feeFor(profile, notionalMicro, "buy", input.feeContext) +
    feeFor(profile, notionalMicro, "sell", input.feeContext);
  const fees = makeRational(feeMicro, notionalMicro);
  const floor = halfSpreadFraction(tier, priceMicro);
  let halfSpreadFloorApplied = false;
  const perFill = (side: "buy" | "sell"): Rational => {
    const slip = makeRational(
      slippageFill(priceMicro, side, advMicro, factor, buckets).slipMicro,
      priceMicro,
    );
    if (cmpRat(floor, slip) > 0) {
      halfSpreadFloorApplied = true;
      return floor;
    }
    return slip;
  };
  const slipBuy = perFill("buy");
  const slipSell = perFill("sell");
  const fraction = addRat(fees, addRat(slipBuy, slipSell));
  const ppm = Number(roundHalfAwayFromZero(mulRat(fraction, makeRational(PPM))));
  return { fraction, ppm, parts: { fees, slipBuy, slipSell, halfSpreadFloorApplied } };
}

/** The float view of C for the statistics (p_be, the `cost_gate_k` diagnostic): ppm ÷ 10⁶. */
export function costFraction(cost: CostPerOrder): number {
  return cost.ppm / 1_000_000;
}

/** One row of the CTX-071 tick/cost table: the half-spread and tick at a price for each tier. */
export function tickCostRow(priceMicro: Micro): {
  readonly priceMicro: Micro;
  readonly tickMicro: bigint;
  readonly halfSpreadPpm: Readonly<Record<LiquidityTier, number>>;
} {
  const out = {} as Record<LiquidityTier, number>;
  for (const tier of LIQUIDITY_TIERS) out[tier] = halfSpreadPpm(tier, priceMicro);
  return { priceMicro, tickMicro: tickFor(priceMicro), halfSpreadPpm: out };
}
