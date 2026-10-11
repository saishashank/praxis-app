// Slippage and the "possibly un-tradeable" label (spec 05 ARN-032 l.65, ARN-013 l.43;
// M3 design decisions 4, 9 and 12, D-069). Pure functions over bigint micro and exact rationals;
// every rounding is delegated to src/lib/money (tick.ts slippedFill: adverse, onto the tick grid).
import { type Micro } from "@/lib/money/micro";
import {
  cmpRat,
  makeRational,
  mulRat,
  parseDecimalParts,
  parseRational,
  type Rational,
} from "@/lib/money/rational";
import { slippedFill, type Side } from "@/lib/money/tick";

export type SlippageBucket = {
  /** Lower-inclusive edge of 20-session ADV (traded value), micro-AUD. */
  readonly fromAdvMicro: Micro;
  /** Slippage in basis points of the reference price. */
  readonly bps: Rational;
};

/**
 * [VERIFY] ARN-032 (l.65) "ADV >= A$5M 10, A$1-5M 25, A$250k-1M 60, A$100-250k 120 bps"; ch.15
 * `slippage_buckets` (+/-50 %, Owner). Sorted high to low. Decision 9: edges are lower-inclusive
 * (ADV exactly A$5M is the 10 bps bucket) and ADV below A$100k uses the 120 bps bucket (the last
 * entry applies to everything under its edge too). Not Owner-approved yet.
 */
export const SLIPPAGE_BUCKETS: readonly SlippageBucket[] = [
  { fromAdvMicro: 5_000_000_000_000n, bps: makeRational(10n) },
  { fromAdvMicro: 1_000_000_000_000n, bps: makeRational(25n) },
  { fromAdvMicro: 250_000_000_000n, bps: makeRational(60n) },
  { fromAdvMicro: 100_000_000_000n, bps: makeRational(120n) },
];
export const SLIPPAGE_BUCKETS_VERIFIED = false;
export const SLIPPAGE_SPEC_REF = "spec 05 ARN-032 l.65; ch.15 slippage_buckets";

/** ARN-032 default `tick_cross_factor` (ch.15, 0.5 to 2). */
export const DEFAULT_TICK_CROSS_FACTOR: Rational = makeRational(1n);
/** Decision 4: stall-floor entry slippage is max(10 bps, one tick). */
export const DEFAULT_STALL_FLOOR_BPS: Rational = makeRational(10n);
/** Decision 12: ARN-013 threshold, 0.5 % of ADV (new key `untradeable_adv_pct`). */
export const DEFAULT_UNTRADEABLE_ADV_FRACTION: Rational = makeRational(1n, 200n);

/**
 * Bucket bps for a 20-session ADV (micro-AUD). Edges lower-inclusive; ADV under the lowest edge
 * takes the lowest bucket's bps (decision 9).
 */
export function bucketBpsFor(
  advMicro: Micro,
  buckets: readonly SlippageBucket[] = SLIPPAGE_BUCKETS,
): Rational {
  if (advMicro < 0n) throw new RangeError("ADV cannot be negative");
  if (buckets.length === 0) throw new RangeError("no slippage buckets");
  for (const bucket of buckets) if (advMicro >= bucket.fromAdvMicro) return bucket.bps;
  return buckets[buckets.length - 1].bps;
}

export type SlippedFill = {
  readonly bucketBps: Rational;
  /** Fill price per share, adverse and on the tick grid. */
  readonly fillMicro: Micro;
  /** Absolute slippage per share actually paid (|fill - reference|). */
  readonly slipMicro: Micro;
};

/**
 * ARN-032 fill price: reference +/- max(ADV bucket bps, tick bps x tick_cross_factor), rounded
 * adverse to the trader onto the tick grid (buy up, sell down) by `slippedFill`.
 */
export function slippageFill(
  refPriceMicro: Micro,
  side: Side,
  advMicro: Micro,
  tickCrossFactor: Rational = DEFAULT_TICK_CROSS_FACTOR,
  buckets: readonly SlippageBucket[] = SLIPPAGE_BUCKETS,
): SlippedFill {
  const bucketBps = bucketBpsFor(advMicro, buckets);
  const fillMicro = slippedFill(refPriceMicro, side, bucketBps, tickCrossFactor);
  const diff = fillMicro - refPriceMicro;
  return { bucketBps, fillMicro, slipMicro: diff < 0n ? -diff : diff };
}

/**
 * Stall-floor entry slippage per share (decision 4, spec 05 §5.1 l.12): max(stall_floor_bps,
 * one tick), adverse (buy) onto the tick grid. The factor is fixed at 1 tick.
 */
export function stallFloorSlippageMicro(
  refPriceMicro: Micro,
  stallFloorBps: Rational = DEFAULT_STALL_FLOOR_BPS,
): Micro {
  return (
    slippedFill(refPriceMicro, "buy", stallFloorBps, DEFAULT_TICK_CROSS_FACTOR) - refPriceMicro
  );
}

export type UntradeableReason = "u3" | "adv_pct";
export type UntradeableInput = {
  readonly tradeValueMicro: Micro;
  readonly advMicro: Micro;
  readonly tier: "U1" | "U2" | "U3";
  /** Fraction of ADV above which a trade is labelled (default 0.5 % = 1/200). */
  readonly advFraction?: Rational;
};

/**
 * ARN-013 (l.43): "Trades > 0.5% of ADV or in U3 are labelled possibly un-tradeable". Strictly
 * greater than the threshold: a trade of exactly 0.5 % of ADV is not labelled.
 */
export function untradeableReason(input: UntradeableInput): UntradeableReason | null {
  if (input.tier === "U3") return "u3";
  const fraction = input.advFraction ?? DEFAULT_UNTRADEABLE_ADV_FRACTION;
  const limit = mulRat(makeRational(input.advMicro), fraction);
  return cmpRat(makeRational(input.tradeValueMicro), limit) > 0 ? "adv_pct" : null;
}

export function isUntradeable(input: UntradeableInput): boolean {
  return untradeableReason(input) !== null;
}

/**
 * Config rate from a stored value: a plain decimal string ("0.5") or the JSON number the registry
 * stores ("0.5" via String). Never goes through floating-point arithmetic. `percent` reads the
 * value as a percentage (0.5 -> 1/200). Negative or non-plain-decimal input is rejected.
 */
export function parseConfigRate(value: unknown, options: { percent?: boolean } = {}): Rational {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError("rate must be a decimal string or number");
  }
  const text = String(value);
  if (parseDecimalParts(text).negative) throw new RangeError("rate cannot be negative");
  return parseRational(options.percent === true ? `${text}%` : text);
}

/** Buckets as JSON text for cost_profile.slippage_json (bigints and rationals as strings). */
export function serializeBuckets(buckets: readonly SlippageBucket[]): string {
  return JSON.stringify({
    buckets: buckets.map((b) => ({
      from_adv_micro: b.fromAdvMicro.toString(),
      bps_num: b.bps.num.toString(),
      bps_den: b.bps.den.toString(),
    })),
    edges: "lower-inclusive; ADV below the lowest edge uses the lowest bucket",
  });
}
