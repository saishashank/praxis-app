// ASX tick sizes and tick-based slippage (spec 05 ARN-032 l.65; design §2.4; decisions 4 and 9).
import { homeProfile } from "@/lib/market/staticProfile.mjs";
import { addRat, divCeil, makeRational, maxRat, mulRat, subRat, type Rational } from "./rational";
import { roundToTick } from "./round";

export type TickBand = { readonly fromMicro: bigint; readonly tickMicro: bigint };

/**
 * The home market's tick table, from its profile (`tick_table`, CXA-002 d; M19 B2): the [VERIFY] figures of
 * spec 05 ARN-032 (l.65) live in seed/au/tickTable.mjs, byte for byte. Band edges are lower-inclusive. Every
 * function below takes the table of the market it works for as its last argument; the default is this one.
 */
export const TICK_TABLE: readonly TickBand[] = homeProfile().tickTable!;
export const TICK_TABLE_VERIFIED = false;

/**
 * D-184: the lowest price on the grid (one tick of the bottom band). A sell cannot execute below
 * it, so an adverse sell fill that slippage would push to zero or below fills here instead (the
 * worst real price), rather than failing the night on a very low-priced stock.
 */
export const MIN_PRICE_MICRO = TICK_TABLE[0].tickMicro;

/** Tick size (micro) for a reference price (micro per share); price must be positive. */
export function tickFor(priceMicro: bigint, table: readonly TickBand[] = TICK_TABLE): bigint {
  if (priceMicro <= 0n) throw new RangeError("price must be positive");
  let tick = table[0]!.tickMicro;
  for (const band of table) if (priceMicro >= band.fromMicro) tick = band.tickMicro;
  return tick;
}

export type Side = "buy" | "sell";

const ONE_BP_UNIT = makeRational(1n, 10_000n);
/** Decision 4: the stall-floor entry slippage is max(stall_floor_bps, one tick); the home market's figure. */
const STALL_FLOOR_BPS: Rational = makeRational(BigInt(homeProfile().slippage!.stall_floor_bps));

/**
 * Exact slippage amount per share (rational micro), ARN-032:
 * max(bucket bps x price, tick x tick_cross_factor). The second term equals
 * (10 000 x tick / price) x factor bps of the price, without dividing.
 */
export function slippageAmount(
  refPriceMicro: bigint,
  bucketBps: Rational,
  tickCrossFactor: Rational,
  table: readonly TickBand[] = TICK_TABLE,
): Rational {
  const bucket = mulRat(mulRat(makeRational(refPriceMicro), bucketBps), ONE_BP_UNIT);
  const ticks = mulRat(makeRational(tickFor(refPriceMicro, table)), tickCrossFactor);
  return maxRat(bucket, ticks);
}

/** Slippage in whole ticks of the reference price's band (rounded up, adverse). */
export function slippageTicks(
  refPriceMicro: bigint,
  bucketBps: Rational,
  tickCrossFactor: Rational,
  table: readonly TickBand[] = TICK_TABLE,
): bigint {
  const amount = slippageAmount(refPriceMicro, bucketBps, tickCrossFactor, table);
  return divCeil(amount.num, amount.den * tickFor(refPriceMicro, table));
}

/**
 * Entry slippage per share for the stall floor (decision 4): max(10 bps, one tick), rounded up to
 * the tick grid. Returns micro per share.
 */
export function stallSlippageMicro(
  refPriceMicro: bigint,
  table: readonly TickBand[] = TICK_TABLE,
  stallFloorBps: Rational = STALL_FLOOR_BPS,
): bigint {
  return (
    slippageTicks(refPriceMicro, stallFloorBps, makeRational(1n), table) *
    tickFor(refPriceMicro, table)
  );
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
  table: readonly TickBand[] = TICK_TABLE,
): bigint {
  const slip = slippageAmount(refPriceMicro, bucketBps, tickCrossFactor, table);
  const ref = makeRational(refPriceMicro);
  const raw = side === "buy" ? addRat(ref, slip) : subRat(ref, slip);
  const direction = side === "buy" ? "up" : "down";
  let tick = tickFor(refPriceMicro, table);
  let fill = roundToTick(raw, tick, direction);
  if (fill <= 0n) {
    if (side === "sell") return table[0]!.tickMicro;
    throw new RangeError("slippage consumes the whole price");
  }
  for (;;) {
    const next = tickFor(fill, table);
    if (next <= tick) return fill;
    tick = next;
    fill = roundToTick(raw, tick, direction);
  }
}
