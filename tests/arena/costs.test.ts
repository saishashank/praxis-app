// @vitest-environment node
// Cost profiles P0-P5b (spec 05 ARN-031 l.64; M3 design 4.4, decisions 6, 7, 10; TST-101 P5 at each
// tier boundary on both sides). HIGH-RISK money maths: every expected value is hand-computed in
// micro-AUD (A$1.00 = 1_000_000) and written as a literal, never derived from the code under test.
import { afterEach, describe, expect, it } from "vitest";
import {
  COST_PROFILE_CODES,
  COST_PROFILES,
  costProfileRow,
  feeFor,
  getCostProfile,
  isCostProfileCode,
  parseProfileRule,
  serializeProfileRule,
  type CostProfileCode,
} from "@/lib/arena/costs";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const fee = (code: CostProfileCode, notional: bigint, side: "buy" | "sell" = "buy", ctx = {}) =>
  feeFor(COST_PROFILES[code], notional, side, ctx);

describe("profile table", () => {
  it("has exactly P0..P5b, version 1, flagged [VERIFY] and unverified, with spec line refs", () => {
    expect(COST_PROFILE_CODES).toEqual(["P0", "P1", "P2", "P3", "P4", "P5", "P5b"]);
    for (const code of COST_PROFILE_CODES) {
      const p = COST_PROFILES[code];
      expect(p.code).toBe(code);
      expect(p.version).toBe(1);
      expect(p.verify).toBe(true);
      expect(p.verified).toBe(false);
      expect(p.specRef).toContain("ARN-031");
      expect(p.specRef).toContain("l.64");
      expect(p.name.length).toBeGreaterThan(3);
    }
  });

  it("lookup helpers", () => {
    expect(getCostProfile("P5")).toBe(COST_PROFILES.P5);
    expect(() => getCostProfile("P6")).toThrow(/unknown cost profile/);
    expect(isCostProfileCode("P5b")).toBe(true);
    expect(isCostProfileCode("p5")).toBe(false);
    expect(isCostProfileCode(5)).toBe(false);
  });
});

describe("input guard", () => {
  it("rejects zero, negative and non-bigint order values", () => {
    expect(() => fee("P5", 0n)).toThrow(RangeError);
    expect(() => fee("P5", -1n)).toThrow(RangeError);
    expect(() => feeFor(COST_PROFILES.P5, 1000 as unknown as bigint, "buy")).toThrow(RangeError);
  });
});

describe("P5 (default) tier boundaries, both sides (TST-101)", () => {
  // [order value micro, fee micro]. Upper bounds are INCLUSIVE; one micro above moves up a tier.
  const cases: Array<[bigint, bigint, string]> = [
    [1n, 5_000_000n, "A$0.000001 (smallest order)"],
    [999_999_999n, 5_000_000n, "just below A$1,000.00"],
    [1_000_000_000n, 5_000_000n, "A$1,000.00"],
    [1_000_000_001n, 10_000_000n, "1 micro above A$1,000.00"],
    [1_000_010_000n, 10_000_000n, "A$1,000.01"],
    [2_999_999_999n, 10_000_000n, "just below A$3,000.00"],
    [3_000_000_000n, 10_000_000n, "A$3,000.00"],
    [3_000_000_001n, 19_950_000n, "1 micro above A$3,000.00"],
    [3_000_010_000n, 19_950_000n, "A$3,000.01"],
    [9_999_999_999n, 19_950_000n, "just below A$10,000.00"],
    [10_000_000_000n, 19_950_000n, "A$10,000.00"],
    [10_000_000_001n, 29_950_000n, "1 micro above A$10,000.00"],
    [10_000_010_000n, 29_950_000n, "A$10,000.01"],
    [24_999_999_999n, 29_950_000n, "just below A$25,000.00"],
    [25_000_000_000n, 29_950_000n, "A$25,000.00"],
    // 25,000,000,001 x 12 / 10,000 = 30,000,000.0012 -> 30,000,000
    [25_000_000_001n, 30_000_000n, "1 micro above A$25,000.00 (percentage tier, rounds down)"],
    // 25,000,010,000 x 12 / 10,000 = 30,000,012 exactly (A$30.000012, not A$30.00012)
    [25_000_010_000n, 30_000_012n, "A$25,000.01"],
    // 100,000,000,000 x 12 / 10,000 = 120,000,000
    [100_000_000_000n, 120_000_000n, "A$100,000.00"],
  ];
  for (const [value, expected, label] of cases) {
    it(`${label}: buy and sell pay ${expected} micro`, () => {
      expect(fee("P5", value, "buy")).toBe(expected);
      expect(fee("P5", value, "sell")).toBe(expected);
    });
  }

  it("is non-decreasing in order value (ARN-024a sizing relies on it)", () => {
    let last = 0n;
    for (const [value] of cases) {
      const f = fee("P5", value);
      expect(f >= last).toBe(true);
      last = f;
    }
  });
});

describe("rounding: one half-away-from-zero step on the exact rational", () => {
  it("rounds a tie up (30,000,001.5 -> 30,000,002)", () => {
    // 25,000,001,250 x 12 / 10,000 = 30,000,001.5
    expect(fee("P5", 25_000_001_250n)).toBe(30_000_002n);
  });
  it("rounds below a tie down (30,000,000.48 -> 30,000,000)", () => {
    // 25,000,000,400 x 12 / 10,000 = 30,000,000.48
    expect(fee("P5", 25_000_000_400n)).toBe(30_000_000n);
  });
  it("rounds above a tie up (30,000,000.6 -> 30,000,001)", () => {
    // 25,000,000,500 x 12 / 10,000 = 30,000,000.6
    expect(fee("P5", 25_000_000_500n)).toBe(30_000_001n);
  });
});

describe("P5b: A$2.00 up to A$1,000.00, then 0.20% of the whole value", () => {
  it("below, at and above the single boundary", () => {
    expect(fee("P5b", 999_999_999n)).toBe(2_000_000n);
    expect(fee("P5b", 1_000_000_000n)).toBe(2_000_000n);
    // 1,000,000,001 x 2 / 1,000 = 2,000,000.002 -> 2,000,000
    expect(fee("P5b", 1_000_000_001n)).toBe(2_000_000n);
    // 1,000,010,000 x 0.002 = 2,000,020
    expect(fee("P5b", 1_000_010_000n)).toBe(2_000_020n);
    // 10,000,000,000 x 0.002 = 20,000,000
    expect(fee("P5b", 10_000_000_000n)).toBe(20_000_000n);
  });
  it("buy equals sell", () => {
    expect(fee("P5b", 5_000_000_000n, "sell")).toBe(fee("P5b", 5_000_000_000n, "buy"));
  });
});

describe("P1 A$3.00 and P3 A$6.50 flat", () => {
  it("do not depend on value or side", () => {
    for (const v of [1n, 600_000_000n, 99_000_000_000n]) {
      expect(fee("P1", v, "buy")).toBe(3_000_000n);
      expect(fee("P1", v, "sell")).toBe(3_000_000n);
      expect(fee("P3", v, "buy")).toBe(6_500_000n);
      expect(fee("P3", v, "sell")).toBe(6_500_000n);
    }
  });
});

describe("P4: 0.03% with minimum A$3.00 and maximum A$9.99", () => {
  it("minimum applies below A$10,000.00 and exactly at it", () => {
    expect(fee("P4", 10_000_000n)).toBe(3_000_000n); // A$10 -> 3,000 micro -> min
    expect(fee("P4", 9_999_000_000n)).toBe(3_000_000n); // 2,999,700 < min
    expect(fee("P4", 10_000_000_000n)).toBe(3_000_000n); // exactly 3,000,000
  });
  it("percentage applies strictly between the clamps", () => {
    expect(fee("P4", 20_000_000_000n)).toBe(6_000_000n); // A$20,000 -> A$6.00
    // 10,000,010,000 x 3 / 10,000 = 3,000,003
    expect(fee("P4", 10_000_010_000n)).toBe(3_000_003n);
  });
  it("maximum applies from A$33,300.00 upward", () => {
    expect(fee("P4", 33_299_990_000n)).toBe(9_989_997n); // 33,299.99 x 0.0003
    expect(fee("P4", 33_300_000_000n)).toBe(9_990_000n); // exactly the cap
    expect(fee("P4", 33_300_010_000n)).toBe(9_990_000n); // 9,990,003 -> capped
    expect(fee("P4", 400_000_000_000n)).toBe(9_990_000n);
  });
  it("buy equals sell", () => {
    expect(fee("P4", 20_000_000_000n, "sell")).toBe(6_000_000n);
  });
});

describe("P2: first buy < A$1,000 per security per day free, else greater of A$11.00 or 0.10%", () => {
  const first = { firstBuyOfSecurityToday: true };
  it("first buy of the day strictly below A$1,000 is free", () => {
    expect(fee("P2", 1n, "buy", first)).toBe(0n);
    expect(fee("P2", 999_999_999n, "buy", first)).toBe(0n);
  });
  it("A$1,000.00 exactly is not below A$1,000 (operator < as written): pays the A$11.00 minimum", () => {
    expect(fee("P2", 1_000_000_000n, "buy", first)).toBe(11_000_000n);
    expect(fee("P2", 1_000_000_001n, "buy", first)).toBe(11_000_000n);
  });
  it("a sell, a later buy and an unknown history all pay (the free rule is first-buy only)", () => {
    expect(fee("P2", 500_000_000n, "sell", first)).toBe(11_000_000n);
    expect(fee("P2", 500_000_000n, "buy", { firstBuyOfSecurityToday: false })).toBe(11_000_000n);
    expect(fee("P2", 500_000_000n, "buy")).toBe(11_000_000n);
  });
  it("0.10% overtakes A$11.00 above A$11,000.00", () => {
    expect(fee("P2", 10_999_000_000n)).toBe(11_000_000n); // 10,999,000 < min
    expect(fee("P2", 11_000_000_000n)).toBe(11_000_000n); // equal
    expect(fee("P2", 11_000_010_000n)).toBe(11_000_010n);
    expect(fee("P2", 20_000_000_000n, "sell")).toBe(20_000_000n);
    // 11,000,000,500 / 1,000 = 11,000,000.5 -> tie rounds away from zero
    expect(fee("P2", 11_000_000_500n)).toBe(11_000_001n);
  });
});

describe("P0: zero-fee list, else P1 (list empty until supplied)", () => {
  it("empty or absent list pays P1", () => {
    expect(fee("P0", 600_000_000n)).toBe(3_000_000n);
    expect(fee("P0", 600_000_000n, "sell", { code: "ZZAA", zeroFeeCodes: new Set() })).toBe(
      3_000_000n,
    );
  });
  it("a listed code pays nothing, an unlisted one pays P1, a missing code pays P1", () => {
    const zeroFeeCodes = new Set(["ZZAA"]);
    expect(fee("P0", 600_000_000n, "buy", { code: "ZZAA", zeroFeeCodes })).toBe(0n);
    expect(fee("P0", 600_000_000n, "sell", { code: "ZZAA", zeroFeeCodes })).toBe(0n);
    expect(fee("P0", 600_000_000n, "buy", { code: "ZZBB", zeroFeeCodes })).toBe(3_000_000n);
    expect(fee("P0", 600_000_000n, "buy", { zeroFeeCodes })).toBe(3_000_000n);
  });
});

describe("cost_profile rows (verified = 0, append-only, versioned)", () => {
  it("round-trips every profile through tiers_json", () => {
    for (const code of COST_PROFILE_CODES) {
      const p = COST_PROFILES[code];
      const back = parseProfileRule(code, 1, serializeProfileRule(p), false);
      expect(back).toEqual(p);
      expect(feeFor(back, 25_000_010_000n, "buy")).toBe(feeFor(p, 25_000_010_000n, "buy"));
    }
  });

  it("builds an unverified row per profile that the migration accepts", async () => {
    const db = await freshDb("main");
    for (const code of COST_PROFILE_CODES) {
      const row = costProfileRow(COST_PROFILES[code], "2026-10-11T00:00:00.000Z");
      expect(row.verified).toBe(0);
      expect(row.source).toContain("[VERIFY]");
      expect(row.source).toContain("l.64");
      expect(() => JSON.parse(row.slippage_json)).not.toThrow();
      await db.execute({
        sql: `INSERT INTO cost_profile (code, version, tiers_json, slippage_json, source, verified, effective_from)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          row.code,
          row.version,
          row.tiers_json,
          row.slippage_json,
          row.source,
          row.verified,
          row.effective_from,
        ],
      });
    }
    const rows = await db.execute("SELECT count(*) AS n FROM cost_profile WHERE verified = 0");
    expect(Number(rows.rows[0].n)).toBe(7);
  });

  it("an approved profile is a new higher-version row, flagged verified", () => {
    const approved = { ...COST_PROFILES.P5, version: 2, verified: true };
    const row = costProfileRow(approved, "2026-11-01T00:00:00.000Z");
    expect(row).toMatchObject({ code: "P5", version: 2, verified: 1 });
  });

  it("pins min/max/free-first-buy fields in the stored form", () => {
    expect(JSON.parse(serializeProfileRule(COST_PROFILES.P4))).toEqual({
      kind: "pct",
      rate_num: "3",
      rate_den: "10000",
      min_micro: "3000000",
      max_micro: "9990000",
      free_first_buy_below_micro: null,
    });
    expect(JSON.parse(serializeProfileRule(COST_PROFILES.P2))).toMatchObject({
      max_micro: null,
      free_first_buy_below_micro: "1000000000",
    });
  });

  it("rejects malformed stored rules", () => {
    const parse = (json: string) => parseProfileRule("P5", 1, json, false);
    expect(() => parseProfileRule("P9", 1, "{}", false)).toThrow(/unknown cost profile/);
    expect(() => parse("not json")).toThrow();
    expect(() => parse("[]")).toThrow(/expected an object/);
    expect(() => parse("null")).toThrow(/expected an object/);
    expect(() => parse('"x"')).toThrow(/expected an object/);
    expect(() => parse('{"kind":"nope"}')).toThrow(/unknown fee rule kind/);
    expect(() => parse('{"kind":"flat","fee_micro":5}')).toThrow(/decimal integer string/);
    expect(() => parse('{"kind":"flat","fee_micro":"5.5"}')).toThrow(/whole number/);
    expect(() => parse('{"kind":"flat","fee_micro":"abc"}')).toThrow(SyntaxError);
    expect(parse('{"kind":"flat","fee_micro":"-5"}').rule).toEqual({ kind: "flat", feeMicro: -5n });
    expect(() => parse('{"kind":"tiered","tiers":"x","above":{}}')).toThrow(/tiers must be a list/);
    expect(() => parse('{"kind":"tiered","tiers":[1],"above":{}}')).toThrow(/expected an object/);
    expect(() =>
      parse('{"kind":"zeroFeeListElse","otherwise":{"kind":"flat","fee_micro":"1"}}'),
    ).not.toThrow();
    expect(() =>
      parse(
        '{"kind":"pct","rate_num":"1","rate_den":"0","min_micro":"0","max_micro":null,"free_first_buy_below_micro":null}',
      ),
    ).toThrow(/division by zero/);
  });
});
