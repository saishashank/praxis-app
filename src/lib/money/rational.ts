// Exact rationals over bigint (M3 design §2.1: rates, factors, haircuts are exact {num, den}).
// This file is the ONLY place in the money library that uses the `/` operator and regular
// expressions; every other module divides through divTrunc / divFloor / divCeil below. That
// keeps the CI float-ban (tests/money/noFloatMoney.test.ts) simple and strict.

export type Rational = { readonly num: bigint; readonly den: bigint };

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function assertNonZero(b: bigint): void {
  if (b === 0n) throw new RangeError("division by zero");
}

/** Integer division truncating toward zero (bigint `/`). */
export function divTrunc(a: bigint, b: bigint): bigint {
  assertNonZero(b);
  return a / b;
}

/** Integer division rounding toward negative infinity. */
export function divFloor(a: bigint, b: bigint): bigint {
  assertNonZero(b);
  const q = a / b;
  const r = a % b;
  return r !== 0n && r < 0n !== b < 0n ? q - 1n : q;
}

/** Integer division rounding toward positive infinity. */
export function divCeil(a: bigint, b: bigint): bigint {
  assertNonZero(b);
  const q = a / b;
  const r = a % b;
  return r !== 0n && r < 0n === b < 0n ? q + 1n : q;
}

/** Build a normalised rational: den > 0, gcd(num, den) = 1, zero is 0/1. */
export function makeRational(num: bigint, den: bigint = 1n): Rational {
  assertNonZero(den);
  if (num === 0n) return { num: 0n, den: 1n };
  const sign = den < 0n ? -1n : 1n;
  const g = gcd(num, den);
  return { num: (sign * num) / g, den: (sign * den) / g };
}

export function ratFromInt(n: bigint): Rational {
  return { num: n, den: 1n };
}

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/;

export type DecimalParts = {
  readonly negative: boolean;
  readonly intDigits: string;
  readonly fracDigits: string;
};

/** Strict decimal parser: optional sign, digits, optional ".digits". No exponent, no spaces. */
export function parseDecimalParts(text: string): DecimalParts {
  const m = typeof text === "string" ? DECIMAL.exec(text) : null;
  if (!m) throw new SyntaxError(`not a plain decimal string: ${JSON.stringify(text)}`);
  return { negative: m[1] === "-", intDigits: m[2], fracDigits: m[3] ?? "" };
}

/** True when the string has a non-zero digit (used to detect digits beyond 6 dp). */
export function hasNonZeroDigit(digits: string): boolean {
  return /[1-9]/.test(digits);
}

/** Remove trailing zeros from a digit string. */
export function trimTrailingZeros(digits: string): string {
  return digits.replace(/0+$/, "");
}

/** "0.0012" -> 12/10000 -> 3/2500; "9%" -> 9/100; "1.5" -> 3/2. Exact; never goes via Number. */
export function parseRational(text: string): Rational {
  const percent = typeof text === "string" && text.endsWith("%");
  const parts = parseDecimalParts(percent ? text.slice(0, -1) : text);
  const magnitude = BigInt(parts.intDigits + parts.fracDigits);
  const den = 10n ** BigInt(parts.fracDigits.length) * (percent ? 100n : 1n);
  return makeRational(parts.negative ? -magnitude : magnitude, den);
}

export function negRat(a: Rational): Rational {
  return makeRational(-a.num, a.den);
}

export function addRat(a: Rational, b: Rational): Rational {
  return makeRational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function subRat(a: Rational, b: Rational): Rational {
  return makeRational(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function mulRat(a: Rational, b: Rational): Rational {
  return makeRational(a.num * b.num, a.den * b.den);
}

export function divRat(a: Rational, b: Rational): Rational {
  assertNonZero(b.num);
  return makeRational(a.num * b.den, a.den * b.num);
}

export function cmpRat(a: Rational, b: Rational): -1 | 0 | 1 {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
}

export function eqRat(a: Rational, b: Rational): boolean {
  return cmpRat(a, b) === 0;
}

export function maxRat(a: Rational, b: Rational): Rational {
  return cmpRat(a, b) >= 0 ? a : b;
}
