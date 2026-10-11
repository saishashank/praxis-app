// @vitest-environment node
// Slippage buckets, stall-floor slippage and the un-tradeable label (spec 05 ARN-032 l.65, ARN-013
// l.43; M3 design decisions 4, 9, 12). HIGH-RISK money maths: hand-computed micro-AUD literals.
import { describe, expect, it } from "vitest";
import {
  bucketBpsFor,
  isUntradeable,
  parseConfigRate,
  serializeBuckets,
  SLIPPAGE_BUCKETS,
  slippageFill,
  stallFloorSlippageMicro,
  untradeableReason,
} from "@/lib/arena/slippage";
import { makeRational, type Rational } from "@/lib/money/rational";
import { stallSlippageMicro } from "@/lib/money/tick";

const A = (dollars: bigint) => dollars * 1_000_000n;
const r = (num: bigint, den = 1n): Rational => makeRational(num, den);
const bps = (x: Rational) => `${x.num}/${x.den}`;

describe("ADV buckets: lower-inclusive edges, ADV below A$100k uses 120 bps (decision 9)", () => {
  const cases: Array<[bigint, string, string]> = [
    [A(50_000_000n), "10/1", "far above A$5M"],
    [A(5_000_000n), "10/1", "exactly A$5M"],
    [A(5_000_000n) - 1n, "25/1", "1 micro below A$5M"],
    [A(1_000_000n), "25/1", "exactly A$1M"],
    [A(1_000_000n) - 1n, "60/1", "1 micro below A$1M"],
    [A(250_000n), "60/1", "exactly A$250k"],
    [A(250_000n) - 1n, "120/1", "1 micro below A$250k"],
    [A(100_000n), "120/1", "exactly A$100k"],
    [A(100_000n) - 1n, "120/1", "1 micro below A$100k"],
    [0n, "120/1", "zero ADV"],
  ];
  for (const [adv, expected, label] of cases) {
    it(`${label} -> ${expected} bps`, () => {
      expect(bps(bucketBpsFor(adv))).toBe(expected);
    });
  }

  it("rejects negative ADV and an empty bucket list", () => {
    expect(() => bucketBpsFor(-1n)).toThrow(RangeError);
    expect(() => bucketBpsFor(1n, [])).toThrow(RangeError);
  });

  it("custom buckets: below the lowest edge takes the last bucket", () => {
    const custom = [{ fromAdvMicro: A(10n), bps: r(7n) }];
    expect(bps(bucketBpsFor(A(1n), custom))).toBe("7/1");
    expect(bps(bucketBpsFor(A(10n), custom))).toBe("7/1");
  });

  it("table is the spec's four buckets, high to low", () => {
    expect(SLIPPAGE_BUCKETS.map((b) => [b.fromAdvMicro, bps(b.bps)])).toEqual([
      [5_000_000_000_000n, "10/1"],
      [1_000_000_000_000n, "25/1"],
      [250_000_000_000n, "60/1"],
      [100_000_000_000n, "120/1"],
    ]);
  });
});

describe("slippageFill: max(bucket bps, tick bps x factor), adverse, on the tick grid", () => {
  it("A$9.80 at >= A$5M ADV: tick (10.2 bps) beats 10 bps -> buy fills A$9.81 (spec Given)", () => {
    const f = slippageFill(9_800_000n, "buy", A(6_000_000n));
    expect(f).toMatchObject({ fillMicro: 9_810_000n, slipMicro: 10_000n });
    expect(bps(f.bucketBps)).toBe("10/1");
    const s = slippageFill(9_800_000n, "sell", A(6_000_000n));
    expect(s).toMatchObject({ fillMicro: 9_790_000n, slipMicro: 10_000n });
  });

  it("A$100.00 per bucket: bps beats the tick, both sides", () => {
    // 10 bps = 100,000; 25 = 250,000; 60 = 600,000; 120 = 1,200,000 micro
    const expected: Array<[bigint, bigint]> = [
      [A(5_000_000n), 100_000n],
      [A(1_000_000n), 250_000n],
      [A(250_000n), 600_000n],
      [A(100_000n), 1_200_000n],
      [A(1_000n), 1_200_000n], // under A$100k: 120 bps bucket
    ];
    for (const [adv, slip] of expected) {
      expect(slippageFill(100_000_000n, "buy", adv)).toMatchObject({
        fillMicro: 100_000_000n + slip,
        slipMicro: slip,
      });
      expect(slippageFill(100_000_000n, "sell", adv)).toMatchObject({
        fillMicro: 100_000_000n - slip,
        slipMicro: slip,
      });
    }
  });

  it("U3 A$0.20 (120 bps bucket): tick A$0.005 = 250 bps wins -> fill 205,000 (design 2.3)", () => {
    expect(slippageFill(200_000n, "buy", A(50_000n))).toMatchObject({
      fillMicro: 205_000n,
      slipMicro: 5_000n,
    });
  });

  it("tick_cross_factor 1.5 at A$9.80: 15,000 rounds adverse onto the grid (up for buy, down for sell)", () => {
    const factor = r(3n, 2n);
    expect(slippageFill(9_800_000n, "buy", A(6_000_000n), factor)).toMatchObject({
      fillMicro: 9_820_000n,
      slipMicro: 20_000n,
    });
    expect(slippageFill(9_800_000n, "sell", A(6_000_000n), factor)).toMatchObject({
      fillMicro: 9_780_000n,
      slipMicro: 20_000n,
    });
  });

  it("tick_cross_factor 0.5 at A$100.00: the bucket dominates", () => {
    expect(slippageFill(100_000_000n, "buy", A(6_000_000n), r(1n, 2n)).fillMicro).toBe(
      100_100_000n,
    );
  });
});

describe("stall-floor slippage = max(10 bps, one tick), adverse (decision 4)", () => {
  it("10 bps below one tick -> one tick", () => {
    expect(stallFloorSlippageMicro(5_000_000n)).toBe(10_000n); // 10 bps = 5,000 < tick 10,000
    expect(stallFloorSlippageMicro(9_800_000n)).toBe(10_000n); // 10 bps = 9,800 < tick
    expect(stallFloorSlippageMicro(500_000n)).toBe(5_000n); // A$0.50: 500 < tick 5,000
    expect(stallFloorSlippageMicro(50_000n)).toBe(1_000n); // A$0.05: 50 < tick 1,000
  });
  it("10 bps above one tick -> bps, rounded up to the grid", () => {
    expect(stallFloorSlippageMicro(100_000_000n)).toBe(100_000n); // exactly 10 bps
    expect(stallFloorSlippageMicro(20_000_000n)).toBe(20_000n);
    expect(stallFloorSlippageMicro(10_010_000n)).toBe(20_000n); // 10,010 -> next tick multiple
  });
  it("exactly one tick of 10 bps stays one tick (A$10.00: 10,000)", () => {
    expect(stallFloorSlippageMicro(10_000_000n)).toBe(10_000n);
  });
  it("agrees with the money library helper away from band edges", () => {
    for (const p of [50_000n, 500_000n, 5_000_000n, 10_010_000n, 100_000_000n]) {
      expect(stallFloorSlippageMicro(p)).toBe(stallSlippageMicro(p));
    }
  });
  it("honours a different configured bps", () => {
    expect(stallFloorSlippageMicro(100_000_000n, r(25n))).toBe(250_000n);
  });
});

describe("untradeable label (ARN-013, decision 12): > 0.5% of ADV or U3", () => {
  const adv = A(1_000_000n); // 0.5% = A$5,000 = 5_000_000_000 micro
  it("exactly 0.5% of ADV is not labelled; 1 micro more is", () => {
    expect(untradeableReason({ tradeValueMicro: 5_000_000_000n, advMicro: adv, tier: "U1" })).toBe(
      null,
    );
    expect(untradeableReason({ tradeValueMicro: 5_000_000_001n, advMicro: adv, tier: "U1" })).toBe(
      "adv_pct",
    );
    expect(isUntradeable({ tradeValueMicro: 4_999_999_999n, advMicro: adv, tier: "U2" })).toBe(
      false,
    );
  });
  it("U3 is always labelled, and takes precedence", () => {
    expect(untradeableReason({ tradeValueMicro: 1n, advMicro: adv, tier: "U3" })).toBe("u3");
    expect(untradeableReason({ tradeValueMicro: A(999_999n), advMicro: adv, tier: "U3" })).toBe(
      "u3",
    );
  });
  it("zero ADV with any trade is labelled", () => {
    expect(isUntradeable({ tradeValueMicro: 1n, advMicro: 0n, tier: "U1" })).toBe(true);
  });
  it("a configured fraction moves the line (1% = 1/100)", () => {
    const advFraction = r(1n, 100n);
    expect(
      isUntradeable({ tradeValueMicro: 10_000_000_000n, advMicro: adv, tier: "U1", advFraction }),
    ).toBe(false);
    expect(
      isUntradeable({ tradeValueMicro: 10_000_000_001n, advMicro: adv, tier: "U1", advFraction }),
    ).toBe(true);
  });
});

describe("parseConfigRate (decimal strings, never Number maths)", () => {
  it("parses strings and plain numbers exactly", () => {
    expect(bps(parseConfigRate("0.0012"))).toBe("3/2500");
    expect(bps(parseConfigRate("0.5", { percent: true }))).toBe("1/200");
    expect(bps(parseConfigRate(0.5, { percent: true }))).toBe("1/200");
    expect(bps(parseConfigRate(10))).toBe("10/1");
    expect(bps(parseConfigRate("1.5"))).toBe("3/2");
  });
  it("rejects negatives, junk, exponent forms and non-numeric types", () => {
    expect(() => parseConfigRate("-1")).toThrow(RangeError);
    expect(() => parseConfigRate("abc")).toThrow(SyntaxError);
    expect(() => parseConfigRate(1e21)).toThrow(SyntaxError);
    expect(() => parseConfigRate(Number.NaN)).toThrow(SyntaxError);
    expect(() => parseConfigRate(true)).toThrow(TypeError);
    expect(() => parseConfigRate(null)).toThrow(TypeError);
  });
});

describe("serializeBuckets", () => {
  it("writes bigints and rationals as strings", () => {
    const parsed = JSON.parse(serializeBuckets(SLIPPAGE_BUCKETS));
    expect(parsed.buckets[0]).toEqual({
      from_adv_micro: "5000000000000",
      bps_num: "10",
      bps_den: "1",
    });
    expect(parsed.buckets).toHaveLength(4);
  });
});
