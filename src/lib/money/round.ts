// Rounding (M3 design §2.2, decision 7): ONE mode, applied once per quantity, on an exact rational.
import { divCeil, divFloor, makeRational, mulRat, type Rational } from "./rational";

/** Round half away from zero to an integer: x.5 -> x+1 for x >= 0, -x.5 -> -(x+1). */
export function roundHalfAwayFromZero(value: Rational): bigint {
  const magnitude = value.num < 0n ? -value.num : value.num;
  const rounded = divFloor(2n * magnitude + value.den, 2n * value.den);
  return value.num < 0n ? -rounded : rounded;
}

export function floorRat(value: Rational): bigint {
  return divFloor(value.num, value.den);
}

export function ceilRat(value: Rational): bigint {
  return divCeil(value.num, value.den);
}

/**
 * Round a price (rational micro per share) onto the tick grid, adverse to the trader:
 * buy -> "up", sell -> "down". Result is a whole multiple of tickMicro.
 */
export function roundToTick(price: Rational, tickMicro: bigint, direction: "up" | "down"): bigint {
  if (tickMicro <= 0n) throw new RangeError("tick must be positive");
  const ticks = mulRat(price, makeRational(1n, tickMicro));
  return (direction === "up" ? ceilRat(ticks) : floorRat(ticks)) * tickMicro;
}

/** amount x bps / 10 000, rounded half away from zero once. bps is an integer or a Rational. */
export function bpsOf(amountMicro: bigint, bps: bigint | number | Rational): bigint {
  let rate: Rational;
  if (typeof bps === "number") {
    if (!Number.isSafeInteger(bps)) throw new TypeError("bps must be a safe integer");
    rate = makeRational(BigInt(bps), 10_000n);
  } else if (typeof bps === "bigint") {
    rate = makeRational(bps, 10_000n);
  } else {
    rate = mulRat(bps, makeRational(1n, 10_000n));
  }
  return roundHalfAwayFromZero(mulRat(makeRational(amountMicro), rate));
}
