// ASX tick sizes and tick-based slippage (spec 05 ARN-032 l.65; design §2.4; decisions 4 and 9).
import { addRat, divCeil, makeRational, maxRat, mulRat, subRat, type Rational } from "./rational";
import { roundToTick } from "./round";

export type TickBand = { readonly fromMicro: bigint; readonly tickMicro: bigint };

/**
 * [VERIFY] AU tick table exactly as written in spec 05 ARN-032 (l.65): A$0.001 below A$0.10,
 * A$0.005 for A$0.10 to below A$2.00, A$0.01 from A$2.00. Band edges are lower-inclusive.
 * Not Owner-approved yet: the Arena stays data_only until it is (REQ section 4).
 */
export const TICK_TABLE: readonly TickBand[] = [
  { fromMicro: 0n, tickMicro: 1_000n },
  { fromMicro: 100_000n, tickMicro: 5_000n },
  { fromMicro: 2_000_000n, tickMicro: 10_000n },
];
export const TICK_TABLE_VERIFIED = false;

/**
 * D-184: the lowest price on the grid (one tick of the bottom band). A sell cannot execute below
 * it, so an adverse sell fill that slippage would push to zero or below fills here instead (the
 * worst real price), rather than failing the night on a A$0.001-0.002 stock.
 */
export const MIN_PRICE_MICRO = TICK_TABLE[0].tickMicro;

/** Tick size (micro) for a reference price (micro per share); price must be positive. */
export function tickFor(priceMicro: bigint): bigint {
  if (priceMicro <= 0n) throw new RangeError("price must be positive");
  let tick = TICK_TABLE[0].tickMicro;
  for (const band of TICK_TABLE) if (priceMicro >= band.fromMicro) tick = band.tickMicro;
  return tick;
}

export type Side = "buy" | "sell";

const ONE_BP_UNIT = makeRational(1n, 10_000n);

/**
 * Exact slippage amount per share (rational micro), ARN-032:
 * max(bucket bps x price, tick x tick_cross_factor). The second term equals
 * (10 000 x tick / price) x factor bps of the price, without dividing.
 */
export function slippageAmount(
  refPriceMicro: bigint,
  bucketBps: Rational,
  tickCrossFactor: Rational,
): Rational {
  const bucket = mulRat(mulRat(makeRational(refPriceMicro), bucketBps), ONE_BP_UNIT);
  const ticks = mulRat(makeRational(tickFor(refPriceMicro)), tickCrossFactor);
  return maxRat(bucket, ticks);
}

/** Slippage in whole ticks of the reference price's band (rounded up, adverse). */
export function slippageTicks(
  refPriceMicro: bigint,
  bucketBps: Rational,
  tickCrossFactor: Rational,
): bigint {
  const amount = slippageAmount(refPriceMicro, bucketBps, tickCrossFactor);
  return divCeil(amount.num, amount.den * tickFor(refPriceMicro));
}

/**
 * Entry slippage per share for the stall floor (decision 4): max(10 bps, one tick), rounded up to
 * the tick grid. Returns micro per share.
 */
export function stallSlippageMicro(refPriceMicro: bigint): bigint {
  return slippageTicks(refPriceMicro, makeRational(10n), makeRational(1n)) * tickFor(refPriceMicro);
}

/**
 * Fill price after slippage, adverse and on the tick grid (R1): buy rounds up, sell rounds down.
 * If the fill crosses into a coarser band it is re-rounded on that band's grid (design §2.4).
 */
export function slippedFill(
  refPriceMicro: bigint,
  side: Side,
  bucketBps: Rational,
  tickCrossFactor: Rational,
): bigint {
  const slip = slippageAmount(refPriceMicro, bucketBps, tickCrossFactor);
  const ref = makeRational(refPriceMicro);
  const raw = side === "buy" ? addRat(ref, slip) : subRat(ref, slip);
  const direction = side === "buy" ? "up" : "down";
  let tick = tickFor(refPriceMicro);
  let fill = roundToTick(raw, tick, direction);
  if (fill <= 0n) {
    if (side === "sell") return MIN_PRICE_MICRO;
    throw new RangeError("slippage consumes the whole price");
  }
  for (;;) {
    const next = tickFor(fill);
    if (next <= tick) return fill;
    tick = next;
    fill = roundToTick(raw, tick, direction);
  }
}
