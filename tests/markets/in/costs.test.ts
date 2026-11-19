// @vitest-environment node
// M20 A4 (ARN-116, D-1102, AT-69): IN-P1 delivery costs. HIGH-RISK money maths: every expected value is worked by hand
// from the seeded constants and written as a literal in micro-INR (Rs 1 = 1_000_000), never derived from the engine.
// Constants (src/lib/market/seed/in/costProfiles.mjs, all [VERIFY]): brokerage min(Rs 20, 0.03 %) both sides;
// STT 0.1 % both; exchange 0.00297 % both; SEBI 0.0001 % both (Rs 10 per crore); stamp 0.015 % buy;
// GST 18 % of (brokerage + exchange + SEBI) both; DP Rs 17.70 per sell order. One half-up rounding of the TOTAL
// to the paisa (10_000 micro).
import { describe, expect, it } from "vitest";
import {
  costProfileOfMarket,
  costProfilesOfMarket,
  feeFor,
  serializeProfileRule,
  type CostProfile,
} from "@/lib/arena/costs";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import { parseRational } from "@/lib/money/rational";

const P = costProfilesOfMarket("IN")["IN-P1"]!;
const INR = (rupees: bigint) => rupees * 1_000_000n;

describe("IN-P1 known answers", () => {
  it("is the profile the IN cost_formula names, unverified, one version", () => {
    expect(costProfileOfMarket(staticProfile("IN"))).toBe(P);
    expect(P.version).toBe(1);
    expect(P.verified).toBe(false);
    expect(P.rule.kind).toBe("components");
  });

  it("buy Rs 10,000 = Rs 15.40", () => {
    // brokerage min(20, 3.00) = 3.00; STT 10.00; exchange 10,000 x 0.0000297 = 0.297; SEBI 10,000 x 0.000001 = 0.01;
    // stamp 10,000 x 0.00015 = 1.50; GST 0.18 x (3 + 0.297 + 0.01) = 0.18 x 3.307 = 0.59526
    // total 3 + 10 + 0.297 + 0.01 + 1.5 + 0.59526 = 15.40226 -> 15.40
    expect(feeFor(P, INR(10_000n), "buy")).toBe(15_400_000n);
  });

  it("sell Rs 10,000 = Rs 31.60 (no stamp, DP 17.70)", () => {
    // 3 + 10 + 0.297 + 0.01 + 0.59526 + 17.70 = 31.60226 -> 31.60
    expect(feeFor(P, INR(10_000n), "sell")).toBe(31_600_000n);
  });

  it("buy Rs 100,000 = Rs 142.22 (brokerage capped at Rs 20)", () => {
    // brokerage min(20, 30) = 20; STT 100; exchange 2.97; SEBI 0.10; stamp 15; GST 0.18 x (20 + 2.97 + 0.10) = 4.1526
    // total 20 + 100 + 2.97 + 0.1 + 15 + 4.1526 = 142.2226 -> 142.22
    expect(feeFor(P, INR(100_000n), "buy")).toBe(142_220_000n);
  });

  it("sell Rs 100,000 = Rs 144.92", () => {
    // 20 + 100 + 2.97 + 0.1 + 4.1526 + 17.70 = 144.9226 -> 144.92
    expect(feeFor(P, INR(100_000n), "sell")).toBe(144_920_000n);
  });

  it("brokerage is 0.03 % below Rs 66,666.67 and the Rs 20 cap above", () => {
    // Rs 60,000: brokerage 18.00 (< 20); STT 60; exch 1.782; SEBI 0.06; stamp 9;
    // GST 0.18 x (18 + 1.782 + 0.06) = 0.18 x 19.842 = 3.57156
    // buy total 18 + 60 + 1.782 + 0.06 + 9 + 3.57156 = 92.41356 -> 92.41
    expect(feeFor(P, INR(60_000n), "buy")).toBe(92_410_000n);
    // Rs 70,000: brokerage min(20, 21) = 20; STT 70; exch 2.079; SEBI 0.07; stamp 10.5;
    // GST 0.18 x (20 + 2.079 + 0.07) = 0.18 x 22.149 = 3.98682
    // buy total 20 + 70 + 2.079 + 0.07 + 10.5 + 3.98682 = 106.63582 -> 106.64
    expect(feeFor(P, INR(70_000n), "buy")).toBe(106_640_000n);
  });

  it("a fee is a whole number of paise", () => {
    for (const v of [1_234_567_890n, 98_765_432_100n, 5_000_000_001n]) {
      expect(feeFor(P, v, "buy") % 10_000n).toBe(0n);
      expect(feeFor(P, v, "sell") % 10_000n).toBe(0n);
    }
  });

  it("rejects a zero or negative order value", () => {
    expect(() => feeFor(P, 0n, "buy")).toThrow("positive");
  });

  it("serialises as a components rule (cost_profile.tiers_json)", () => {
    const json = JSON.parse(serializeProfileRule(P)) as {
      kind: string;
      round: string;
      items: { name: string; rate_num: string; rate_den: string }[];
    };
    expect(json.kind).toBe("components");
    expect(json.round).toBe("total_half_up_cent");
    expect(json.items.map((i) => i.name)).toEqual([
      "brokerage",
      "stt",
      "exchange",
      "sebi",
      "stamp",
      "gst",
      "dp",
    ]);
    // 0.00297 % = 297 / 10_000_000
    expect(json.items[2]).toMatchObject({ rate_num: "297", rate_den: "10000000" });
  });
});

describe("rounding of the total", () => {
  const custom = (
    round: "total_half_up_cent" | "per_item_half_up_cent",
    amounts: readonly string[],
  ): CostProfile => ({
    ...P,
    rule: {
      kind: "components",
      round,
      items: amounts.map((a, i) => ({
        name: `i${i}`,
        side: "both" as const,
        basis: "per_order" as const,
        of: [],
        rate: parseRational(a),
        minMicro: null,
        maxMicro: null,
      })),
    },
  });

  it("a total ending in exactly .005 rounds up", () => {
    expect(feeFor(custom("total_half_up_cent", ["0.005"]), 1_000_000n, "buy")).toBe(10_000n);
    expect(feeFor(custom("total_half_up_cent", ["1.004999"]), 1_000_000n, "buy")).toBe(1_000_000n);
    expect(feeFor(custom("total_half_up_cent", ["12.345"]), 1_000_000n, "buy")).toBe(12_350_000n);
  });

  it("rounds the total once: 0.004 + 0.004 = 0.008 -> 0.01, where per item it would be 0.00", () => {
    expect(feeFor(custom("total_half_up_cent", ["0.004", "0.004"]), 1_000_000n, "buy")).toBe(
      10_000n,
    );
    expect(feeFor(custom("per_item_half_up_cent", ["0.004", "0.004"]), 1_000_000n, "buy")).toBe(0n);
    expect(feeFor(custom("per_item_half_up_cent", ["0.005", "0.005"]), 1_000_000n, "buy")).toBe(
      20_000n,
    );
  });
});
