// Money as integer micro-AUD (M3 design §2.1): 1 unit = A$0.000001, held as bigint.
// No JS `number` is accepted as money. Share counts may be safe-integer numbers.
import {
  divTrunc,
  hasNonZeroDigit,
  makeRational,
  parseDecimalParts,
  trimTrailingZeros,
} from "./rational";
import { float32Decimal } from "@/lib/data/vendorDecimal";
import { roundHalfAwayFromZero } from "./round";

export type Micro = bigint;

export const MICRO_PER_DOLLAR = 1_000_000n;
const INT64_MAX = 9_223_372_036_854_775_807n;
const INT64_MIN = -9_223_372_036_854_775_808n;

export type ToMicroOptions = { readonly rounding?: "half-away-from-zero" };

/**
 * Exact parse of a decimal string (A$ units) into micro. More than 6 decimal places is rejected
 * (extra digits that are all zero are exact and allowed) unless rounding is explicitly
 * requested, in which case the value is rounded half away from zero once.
 */
export function toMicro(text: string, options: ToMicroOptions = {}): Micro {
  const { negative, intDigits, fracDigits } = parseDecimalParts(text);
  const kept = fracDigits.slice(0, 6).padEnd(6, "0");
  const dropped = fracDigits.slice(6);
  let magnitude = BigInt(intDigits + kept);
  if (hasNonZeroDigit(dropped)) {
    if (options.rounding !== "half-away-from-zero") {
      throw new RangeError(`more than 6 decimal places: ${JSON.stringify(text)}`);
    }
    if (dropped.charCodeAt(0) >= 53) magnitude += 1n; // first dropped digit >= "5"
  }
  return negative ? -magnitude : magnitude;
}

/**
 * The single place a vendor REAL (price_bar column) becomes money. Goes through the shortest
 * decimal string of the double, so there is no float arithmetic; a value with more than 6 dp
 * (or one printed in exponent form) is rejected, never silently rounded. One exception (D-172): a
 * value that is exactly a float32 encoding of a short decimal (0.119999997317791 = 0.12 as float32)
 * is read as that decimal; it must then fit in 6 dp like any other price.
 */
export function toMicroFromVendor(value: number): Micro {
  if (!Number.isFinite(value)) throw new RangeError("vendor price is not finite");
  try {
    return toMicro(String(value));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const decimal = float32Decimal(value);
    if (decimal === null) throw error;
    return toMicro(decimal);
  }
}

/** Share counts only: a bigint, or a JS number that is a safe integer. */
export function assertShares(shares: number | bigint): bigint {
  if (typeof shares === "bigint") return shares;
  if (!Number.isSafeInteger(shares)) throw new TypeError("share count must be a safe integer");
  return BigInt(shares);
}

export function assertInt64(value: Micro): Micro {
  if (typeof value !== "bigint" || value > INT64_MAX || value < INT64_MIN) {
    throw new RangeError("amount outside the SQLite INTEGER (int64) range");
  }
  return value;
}

export function add(a: Micro, b: Micro): Micro {
  return a + b;
}

export function sub(a: Micro, b: Micro): Micro {
  return a - b;
}

/** Micro x whole number (shares). */
export function mulInt(a: Micro, n: number | bigint): Micro {
  return a * assertShares(n);
}

export function sum(values: Iterable<Micro>): Micro {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

function groupDecimal(magnitude: bigint, fracDigits: number, scale: bigint): string {
  const whole = divTrunc(magnitude, scale).toString();
  return `${whole}.${(magnitude % scale).toString().padStart(fracDigits, "0")}`;
}

/** Full-precision decimal string (A$): at least 2 dp, at most 6, trailing zeros trimmed. */
export function fromMicroFull(value: Micro): string {
  const negative = value < 0n;
  const [whole, frac] = groupDecimal(negative ? -value : value, 6, MICRO_PER_DOLLAR).split(".");
  return `${negative ? "-" : ""}${whole}.${trimTrailingZeros(frac).padEnd(2, "0")}`;
}

/** Display string with exactly 2 dp, half away from zero (display only; never written back). */
export function fromMicro(value: Micro): string {
  const cents = roundHalfAwayFromZero(makeRational(value, 10_000n));
  const negative = cents < 0n;
  return `${negative ? "-" : ""}${groupDecimal(negative ? -cents : cents, 2, 100n)}`;
}
