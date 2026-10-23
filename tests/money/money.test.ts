// @vitest-environment node
// Known-answer and property tests for src/lib/money (M3 T1; TST-101; D-069 decisions 4, 6, 7, 9).
import { describe, expect, it } from "vitest";
import {
  add,
  assertInt64,
  assertShares,
  fromMicro,
  fromMicroFull,
  mulInt,
  sub,
  sum,
  toMicro,
  toMicroFromVendor,
} from "@/lib/money/micro";
import { float32Decimal } from "@/lib/data/vendorDecimal";
import {
  addRat,
  cmpRat,
  divCeil,
  divFloor,
  divRat,
  divTrunc,
  eqRat,
  gcd,
  makeRational,
  maxRat,
  mulRat,
  negRat,
  parseRational,
  ratFromInt,
  subRat,
  type Rational,
} from "@/lib/money/rational";
import { bpsOf, ceilRat, floorRat, roundHalfAwayFromZero, roundToTick } from "@/lib/money/round";
import {
  TICK_TABLE_VERIFIED,
  slippageAmount,
  slippageTicks,
  slippedFill,
  stallSlippageMicro,
  tickFor,
} from "@/lib/money/tick";

const r = (s: string): Rational => parseRational(s);
const rat = (n: bigint, d = 1n): Rational => makeRational(n, d);

describe("rational", () => {
  it("normalises sign and gcd", () => {
    expect(rat(2n, -4n)).toEqual({ num: -1n, den: 2n });
    expect(rat(-6n, -9n)).toEqual({ num: 2n, den: 3n });
    expect(rat(0n, -7n)).toEqual({ num: 0n, den: 1n });
    expect(makeRational(5n)).toEqual({ num: 5n, den: 1n });
    expect(() => rat(1n, 0n)).toThrow(RangeError);
    expect(gcd(-12n, 18n)).toBe(6n);
    expect(gcd(0n, 5n)).toBe(5n);
    expect(ratFromInt(3n)).toEqual({ num: 3n, den: 1n });
  });

  it("parses decimal strings and percentages exactly", () => {
    expect(r("0.0012")).toEqual({ num: 3n, den: 2500n });
    expect(r("9%")).toEqual({ num: 9n, den: 100n });
    expect(r("0.12%")).toEqual({ num: 3n, den: 2500n });
    expect(r("1.0")).toEqual({ num: 1n, den: 1n });
    expect(r("1.5")).toEqual({ num: 3n, den: 2n });
    expect(r("-0.25")).toEqual({ num: -1n, den: 4n });
    expect(r("+2")).toEqual({ num: 2n, den: 1n });
    expect(r("0.1")).toEqual(r("0.10"));
  });

  it("rejects malformed rational input", () => {
    for (const bad of [
      "",
      "1e3",
      "NaN",
      "Infinity",
      ".5",
      "1.",
      "1,5",
      " 1",
      "1 ",
      "%",
      "9%%",
      "--1",
    ]) {
      expect(() => parseRational(bad), bad).toThrow(SyntaxError);
    }
    expect(() => parseRational(5 as unknown as string)).toThrow(SyntaxError);
  });

  it("does arithmetic exactly (0.1 + 0.2 = 0.3)", () => {
    expect(addRat(r("0.1"), r("0.2"))).toEqual(r("0.3"));
    expect(subRat(r("0.3"), r("0.1"))).toEqual(r("0.2"));
    expect(mulRat(r("0.1"), r("0.1"))).toEqual(r("0.01"));
    expect(divRat(r("1"), r("3"))).toEqual({ num: 1n, den: 3n });
    expect(divRat(r("1"), r("-4"))).toEqual({ num: -1n, den: 4n });
    expect(negRat(r("0.5"))).toEqual(r("-0.5"));
    expect(() => divRat(r("1"), r("0"))).toThrow(RangeError);
  });

  it("compares and takes maxima", () => {
    expect(cmpRat(r("0.1"), r("0.2"))).toBe(-1);
    expect(cmpRat(r("0.2"), r("0.1"))).toBe(1);
    expect(cmpRat(r("0.5"), r("50%"))).toBe(0);
    expect(eqRat(r("1"), r("1.0"))).toBe(true);
    expect(eqRat(r("1"), r("1.1"))).toBe(false);
    expect(maxRat(r("1"), r("2"))).toEqual(r("2"));
    expect(maxRat(r("2"), r("1"))).toEqual(r("2"));
    expect(maxRat(r("2"), r("2"))).toEqual(r("2"));
  });

  it("divides integers with explicit rounding", () => {
    expect(divTrunc(-7n, 2n)).toBe(-3n);
    expect(divFloor(-7n, 2n)).toBe(-4n);
    expect(divFloor(7n, 2n)).toBe(3n);
    expect(divFloor(7n, -2n)).toBe(-4n);
    expect(divFloor(8n, 2n)).toBe(4n);
    expect(divCeil(-7n, 2n)).toBe(-3n);
    expect(divCeil(7n, 2n)).toBe(4n);
    expect(divCeil(8n, 2n)).toBe(4n);
    expect(divCeil(7n, -2n)).toBe(-3n);
    for (const f of [divTrunc, divFloor, divCeil]) expect(() => f(1n, 0n)).toThrow(RangeError);
  });
});

describe("round", () => {
  it("rounds half away from zero (decision 7)", () => {
    const cases: Array<[Rational, bigint]> = [
      [rat(1n, 2n), 1n],
      [rat(-1n, 2n), -1n],
      [rat(3n, 2n), 2n],
      [rat(-3n, 2n), -2n],
      [rat(5n, 2n), 3n],
      [rat(-5n, 2n), -3n],
      [rat(49n, 100n), 0n],
      [rat(-49n, 100n), 0n],
      [rat(51n, 100n), 1n],
      [rat(-51n, 100n), -1n],
      [rat(0n), 0n],
      [rat(7n), 7n],
      [rat(-7n), -7n],
      [rat(1999n, 1000n), 2n],
    ];
    for (const [value, expected] of cases) expect(roundHalfAwayFromZero(value)).toBe(expected);
  });

  it("floors and ceils rationals", () => {
    expect(floorRat(rat(-1n, 2n))).toBe(-1n);
    expect(ceilRat(rat(-1n, 2n))).toBe(0n);
    expect(floorRat(rat(7n, 2n))).toBe(3n);
    expect(ceilRat(rat(7n, 2n))).toBe(4n);
  });

  it("rounds to the tick grid, adverse to the trader", () => {
    expect(roundToTick(rat(9_809_800n), 10_000n, "up")).toBe(9_810_000n);
    expect(roundToTick(rat(9_809_800n), 10_000n, "down")).toBe(9_800_000n);
    expect(roundToTick(rat(9_810_000n), 10_000n, "up")).toBe(9_810_000n);
    expect(roundToTick(rat(9_810_000n), 10_000n, "down")).toBe(9_810_000n);
    expect(roundToTick(rat(100_001n), 5_000n, "up")).toBe(105_000n);
    expect(roundToTick(rat(104_999n), 5_000n, "down")).toBe(100_000n);
    expect(roundToTick(rat(1n, 2n), 1_000n, "up")).toBe(1_000n);
    expect(roundToTick(rat(1n, 2n), 1_000n, "down")).toBe(0n);
    expect(() => roundToTick(rat(1n), 0n, "up")).toThrow(RangeError);
  });

  it("bpsOf rounds once, half away from zero", () => {
    expect(bpsOf(9_800_000n, 10)).toBe(9_800n);
    expect(bpsOf(9_800_000n, 10n)).toBe(9_800n);
    expect(bpsOf(5_000n, 1)).toBe(1n); // 0.5 -> 1
    expect(bpsOf(5n, 1000)).toBe(1n); // 0.5 -> 1
    expect(bpsOf(-5n, 1000)).toBe(-1n); // -0.5 -> -1
    expect(bpsOf(4n, 1000)).toBe(0n);
    expect(bpsOf(1_000_000n, r("12.5"))).toBe(1_250n);
    expect(() => bpsOf(1n, 1.5)).toThrow(TypeError);
  });
});

describe("micro", () => {
  it("parses decimal strings exactly", () => {
    expect(toMicro("0")).toBe(0n);
    expect(toMicro("1")).toBe(1_000_000n);
    expect(toMicro("9.80")).toBe(9_800_000n);
    expect(toMicro("30.000012")).toBe(30_000_012n);
    expect(toMicro("-0.000001")).toBe(-1n);
    expect(toMicro("+25000.01")).toBe(25_000_010_000n);
    expect(toMicro("0.1000000")).toBe(100_000n); // trailing zeros past 6 dp are exact
  });

  it("rejects more than 6 dp unless rounding is explicitly requested", () => {
    expect(() => toMicro("0.0000001")).toThrow(RangeError);
    expect(() => toMicro("1.2345675")).toThrow(RangeError);
    const half = { rounding: "half-away-from-zero" } as const;
    expect(toMicro("1.2345675", half)).toBe(1_234_568n);
    expect(toMicro("-1.2345675", half)).toBe(-1_234_568n);
    expect(toMicro("1.2345674", half)).toBe(1_234_567n);
    expect(toMicro("-1.2345674", half)).toBe(-1_234_567n);
    expect(toMicro("0.0000005", half)).toBe(1n);
    expect(toMicro("0.0000004999", half)).toBe(0n);
    expect(toMicro("0.5000000", half)).toBe(500_000n);
  });

  it("rejects exponents, NaN, junk and non-strings", () => {
    for (const bad of [
      "1e3",
      "1E-6",
      "NaN",
      "Infinity",
      "",
      " 1",
      "1 ",
      ".5",
      "1.",
      "$1",
      "1,000",
      "0x10",
    ]) {
      expect(() => toMicro(bad), bad).toThrow(SyntaxError);
    }
    expect(() => toMicro(1 as unknown as string)).toThrow(SyntaxError);
  });

  it("converts vendor doubles only when they are exactly representable in 6 dp", () => {
    expect(toMicroFromVendor(9.8)).toBe(9_800_000n);
    expect(toMicroFromVendor(0.001)).toBe(1_000n);
    expect(toMicroFromVendor(25000.01)).toBe(25_000_010_000n);
    expect(toMicroFromVendor(12)).toBe(12_000_000n);
    expect(() => toMicroFromVendor(0.1 + 0.2)).toThrow(RangeError);
    expect(() => toMicroFromVendor(1.0000001)).toThrow(RangeError);
    expect(() => toMicroFromVendor(1e-7)).toThrow(SyntaxError);
    expect(() => toMicroFromVendor(1e21)).toThrow(SyntaxError);
    expect(() => toMicroFromVendor(Number.NaN)).toThrow(RangeError);
    expect(() => toMicroFromVendor(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("reads a float32-encoded vendor price as the decimal it encodes (D-172)", () => {
    // Production 2026-10-23: Yahoo's A$0.12 stored as 0.119999997317791 crashed batch 2b.
    expect(toMicroFromVendor(0.119999997317791)).toBe(120_000n);
    expect(toMicroFromVendor(Math.fround(0.12))).toBe(120_000n);
    expect(toMicroFromVendor(Math.fround(1.235))).toBe(1_235_000n);
    expect(toMicroFromVendor(Math.fround(0.005))).toBe(5_000n);
    expect(toMicroFromVendor(Math.fround(43.21))).toBe(43_210_000n);
    expect(float32Decimal(0.119999997317791)).toBe("0.12");
    // not a float32 artefact: still rejected, never rounded
    expect(float32Decimal(0.1 + 0.2)).toBeNull();
    expect(float32Decimal(1.0000001)).toBeNull();
    expect(float32Decimal(0)).toBeNull();
    expect(float32Decimal(Number.NaN)).toBeNull();
    // a float32 whose shortest decimal needs more than 6 dp is still rejected
    expect(() => toMicroFromVendor(Math.fround(0.0012345))).toThrow(RangeError);
  });

  it("accepts only integer share counts", () => {
    expect(assertShares(60)).toBe(60n);
    expect(assertShares(-3)).toBe(-3n);
    expect(assertShares(7n)).toBe(7n);
    expect(() => assertShares(1.5)).toThrow(TypeError);
    expect(() => assertShares(Number.NaN)).toThrow(TypeError);
    expect(() => assertShares(2 ** 53)).toThrow(TypeError);
    expect(mulInt(9_810_000n, 60)).toBe(588_600_000n);
    expect(mulInt(9_810_000n, 60n)).toBe(588_600_000n);
    expect(() => mulInt(1n, 0.5)).toThrow(TypeError);
  });

  it("checks the int64 range", () => {
    expect(assertInt64(9_223_372_036_854_775_807n)).toBe(9_223_372_036_854_775_807n);
    expect(assertInt64(-9_223_372_036_854_775_808n)).toBe(-9_223_372_036_854_775_808n);
    expect(() => assertInt64(9_223_372_036_854_775_808n)).toThrow(RangeError);
    expect(() => assertInt64(-9_223_372_036_854_775_809n)).toThrow(RangeError);
    expect(() => assertInt64(5 as unknown as bigint)).toThrow(RangeError);
  });

  it("adds, subtracts and sums with no drift", () => {
    expect(add(1n, 2n)).toBe(3n);
    expect(sub(1n, 2n)).toBe(-1n);
    expect(sum([])).toBe(0n);
    const dime = toMicro("0.1");
    const many = Array.from({ length: 1_000_000 }, () => dime);
    expect(sum(many)).toBe(toMicro("100000")); // a double accumulator would drift here
    expect(sum([toMicro("0.1"), toMicro("0.2")])).toBe(toMicro("0.3"));
  });

  it("formats for display at 2 dp, half away from zero", () => {
    expect(fromMicro(0n)).toBe("0.00");
    expect(fromMicro(593_600_000n)).toBe("593.60");
    expect(fromMicro(30_000_012n)).toBe("30.00");
    expect(fromMicro(4_999n)).toBe("0.00");
    expect(fromMicro(5_000n)).toBe("0.01"); // half cent -> away
    expect(fromMicro(-5_000n)).toBe("-0.01");
    expect(fromMicro(-4_999n)).toBe("0.00"); // no negative zero
    expect(fromMicro(14_999n)).toBe("0.01");
    expect(fromMicro(15_000n)).toBe("0.02");
    expect(fromMicro(-1_234_567_890n)).toBe("-1234.57");
    expect(fromMicro(999_999n)).toBe("1.00");
  });

  it("formats full precision (min 2 dp, max 6, trimmed)", () => {
    expect(fromMicroFull(0n)).toBe("0.00");
    expect(fromMicroFull(30_000_012n)).toBe("30.000012");
    expect(fromMicroFull(9_810_000n)).toBe("9.81");
    expect(fromMicroFull(600_000_000n)).toBe("600.00");
    expect(fromMicroFull(-1n)).toBe("-0.000001");
    expect(fromMicroFull(1_500_000n)).toBe("1.50");
    for (const s of ["0.000001", "123456.789012", "-9.5", "100.00"]) {
      expect(toMicro(fromMicroFull(toMicro(s)))).toBe(toMicro(s));
    }
  });
});

describe("TST-101 known answers", () => {
  const P5_RATE = r("0.12%");
  const feeAbove25k = (valueMicro: bigint): bigint =>
    roundHalfAwayFromZero(mulRat(rat(valueMicro), P5_RATE));

  it("P5 at A$25,000.01 is exactly 30_000_012 micro = A$30.000012 (D-069 decision 6)", () => {
    const fee = feeAbove25k(toMicro("25000.01"));
    expect(fee).toBe(30_000_012n);
    expect(fromMicroFull(fee)).toBe("30.000012");
    expect(fromMicro(fee)).toBe("30.00");
    expect(mulRat(rat(toMicro("25000.01")), P5_RATE)).toEqual(rat(30_000_012n)); // no rounding needed
    expect(feeAbove25k(toMicro("25000"))).toBe(30_000_000n);
  });

  it("A$9.80 candidate: fill 9.81, 60 shares, A$593.60", () => {
    const nav = toMicro("600");
    const buffer = bpsOf(nav, 100); // 1% of NAV
    expect(buffer).toBe(6_000_000n);
    const price = toMicro("9.80");
    expect(tickFor(price)).toBe(10_000n);
    const fill = slippedFill(price, "buy", r("10"), r("1.0"));
    expect(fill).toBe(9_810_000n);
    expect(fromMicroFull(fill)).toBe("9.81");
    const estBrokerage = toMicro("5");
    const deployable = nav - buffer - estBrokerage;
    expect(deployable).toBe(589_000_000n);
    const shares = divFloor(deployable, fill);
    expect(shares).toBe(60n);
    expect(divFloor(deployable, fill) + 1n).toBe(61n); // 61 x 9.81 = 598.41 > 589
    expect(mulInt(fill, 61)).toBe(598_410_000n);
    const cost = mulInt(fill, shares);
    expect(fromMicroFull(cost)).toBe("588.60");
    const total = cost + toMicro("5");
    expect(fromMicro(total)).toBe("593.60");
    expect(total <= nav - buffer).toBe(true); // 593.60 <= 594
  });

  it("U3 case A$0.20: tick 0.005 = 250 bps, fill 0.205", () => {
    const price = toMicro("0.20");
    expect(tickFor(price)).toBe(5_000n);
    expect(slippedFill(price, "buy", r("120"), r("1.0"))).toBe(205_000n);
    expect(slippageTicks(price, r("120"), r("1.0"))).toBe(1n);
  });

  it("stall floor (decision 4): max(10 bps, one tick), rounded up", () => {
    expect(stallSlippageMicro(toMicro("9.80"))).toBe(10_000n); // tick 10.2 bps beats 10 bps
    expect(stallSlippageMicro(toMicro("50"))).toBe(50_000n); // 10 bps = 0.05 = 5 ticks
    expect(stallSlippageMicro(toMicro("50.01"))).toBe(60_000n); // 50.01 x 10 bps = 0.05001 -> 6 ticks
    expect(stallSlippageMicro(toMicro("0.20"))).toBe(5_000n);
    expect(stallSlippageMicro(toMicro("2"))).toBe(10_000n);
  });
});

describe("tick table (ARN-032, spec 05 l.65) [VERIFY]", () => {
  it("is flagged unverified", () => {
    expect(TICK_TABLE_VERIFIED).toBe(false);
  });

  it("every band boundary is lower-inclusive", () => {
    const cases: Array<[string, bigint]> = [
      ["0.000001", 1_000n],
      ["0.001", 1_000n],
      ["0.0999", 1_000n],
      ["0.099999", 1_000n],
      ["0.10", 5_000n],
      ["0.100001", 5_000n],
      ["1.995", 5_000n],
      ["1.999999", 5_000n],
      ["2.00", 10_000n],
      ["2.000001", 10_000n],
      ["9.80", 10_000n],
      ["1000", 10_000n],
    ];
    for (const [price, tick] of cases) expect(tickFor(toMicro(price)), price).toBe(tick);
  });

  it("rejects non-positive prices", () => {
    expect(() => tickFor(0n)).toThrow(RangeError);
    expect(() => tickFor(-1n)).toThrow(RangeError);
  });

  it("buy rounds up and sell rounds down at band edges", () => {
    // buy: 0.0999 + max(10 bps = 99.9 micro, 1 tick = 1000) -> 100_900 up to the 0.10 band grid (5000)
    expect(slippedFill(99_900n, "buy", r("10"), r("1.0"))).toBe(105_000n);
    // buy crossing into the 2.00 band: 1.995 + 5000 = 2.000 exactly -> stays on the grid
    expect(slippedFill(1_995_000n, "buy", r("10"), r("1.0"))).toBe(2_000_000n);
    expect(slippedFill(1_996_000n, "buy", r("10"), r("1.0"))).toBe(2_010_000n);
    // sell at the 2.00 edge: 2.00 - 0.01 = 1.99, a valid 0.005 grid point
    expect(slippedFill(2_000_000n, "sell", r("10"), r("1.0"))).toBe(1_990_000n);
    // sell off-grid rounds down
    expect(slippedFill(100_000n, "sell", r("120"), r("1.0"))).toBe(95_000n);
    // sell that would go to zero is rejected
    expect(() => slippedFill(1_000n, "sell", r("10"), r("1.0"))).toThrow(RangeError);
  });

  it("slippage amount uses the larger of bucket bps and tick x factor, non-integer factor", () => {
    expect(slippageAmount(9_800_000n, r("10"), r("1.0"))).toEqual(rat(10_000n));
    expect(slippageAmount(100_000_000n, r("10"), r("1.0"))).toEqual(rat(100_000n));
    expect(slippageAmount(9_800_000n, r("10"), r("1.5"))).toEqual(rat(15_000n));
    // 1.5 ticks of 5000 = 7500 micro -> fill on the 5000 grid rounds up
    expect(slippedFill(200_000n, "buy", r("10"), r("1.5"))).toBe(210_000n);
    expect(slippageTicks(200_000n, r("10"), r("1.5"))).toBe(2n);
  });
});

// ---------------------------------------------------------------------------------------
// Property test: rational arithmetic vs an independent reference built from scaled BigInt
// strings (digit shifting by string slicing, no shared code with src/lib/money).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Scaled = { value: bigint; scale: number }; // value / 10^scale

function randomDecimal(rand: () => number): string {
  const dp = Math.floor(rand() * 7);
  const intLen = 1 + Math.floor(rand() * 7);
  let int = "";
  for (let i = 0; i < intLen; i++) int += String(Math.floor(rand() * 10));
  let frac = "";
  for (let i = 0; i < dp; i++) frac += String(Math.floor(rand() * 10));
  const sign = rand() < 0.4 ? "-" : "";
  return `${sign}${int}${dp ? "." + frac : ""}`;
}

function refParse(s: string): Scaled {
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [i, f = ""] = body.split(".");
  const digits = BigInt(i + f);
  return { value: neg ? -digits : digits, scale: f.length };
}

const pow10 = (n: number): bigint => BigInt("1" + "0".repeat(n));

function refAdd(a: Scaled, b: Scaled): Scaled {
  const scale = Math.max(a.scale, b.scale);
  return {
    value: a.value * pow10(scale - a.scale) + b.value * pow10(scale - b.scale),
    scale,
  };
}

function refMul(a: Scaled, b: Scaled): Scaled {
  return { value: a.value * b.value, scale: a.scale + b.scale };
}

const sameAs = (x: Rational, ref: Scaled): boolean =>
  x.num * pow10(ref.scale) === ref.value * x.den;

describe("property: rational vs scaled-BigInt reference (10 000 pairs)", () => {
  it("matches on parse, add, sub, mul, div, compare and micro conversion", () => {
    const rand = mulberry32(20261011);
    for (let n = 0; n < 10_000; n++) {
      const sa = randomDecimal(rand);
      const sb = randomDecimal(rand);
      const a = refParse(sa);
      const b = refParse(sb);
      const x = parseRational(sa);
      const y = parseRational(sb);
      expect(sameAs(x, a), sa).toBe(true);
      expect(sameAs(addRat(x, y), refAdd(a, b)), `${sa}+${sb}`).toBe(true);
      expect(sameAs(subRat(x, y), refAdd(a, { ...b, value: -b.value })), `${sa}-${sb}`).toBe(true);
      expect(sameAs(mulRat(x, y), refMul(a, b)), `${sa}*${sb}`).toBe(true);
      if (b.value !== 0n) {
        // (a/b) * b == a
        expect(eqRat(mulRat(divRat(x, y), y), x), `${sa}/${sb}`).toBe(true);
      }
      const lhs = a.value * pow10(b.scale);
      const rhs = b.value * pow10(a.scale);
      const expected = lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
      expect(cmpRat(x, y)).toBe(expected);
      // normal form
      expect(x.den > 0n && gcd(x.num, x.den) <= 1n).toBe(true);
      // micro conversion matches the scaled reference when dp <= 6
      expect(toMicro(sa)).toBe(a.value * pow10(6 - a.scale));
    }
  });

  it("round-half-away agrees with a string-based reference on x/10", () => {
    const rand = mulberry32(7);
    for (let n = 0; n < 10_000; n++) {
      const v = BigInt(Math.floor(rand() * 2_000_001) - 1_000_000);
      // value v/10 -> reference: look at the last digit of |v|
      const mag = v < 0n ? -v : v;
      let q = mag / 10n;
      if (mag % 10n >= 5n) q += 1n;
      expect(roundHalfAwayFromZero(rat(v, 10n))).toBe(v < 0n ? -q : q);
    }
  });
});
