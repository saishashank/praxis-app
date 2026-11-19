// @vitest-environment node
// M20 A4 (ARN-117, D-1103, D-1150, AT-70): US-P1 costs. Hand-worked in micro-USD (US$1 = 1_000_000). Constants
// (src/lib/market/seed/us/costProfiles.mjs, all [VERIFY]): commission 0; SEC Section 31 fee on sells
// US$20.60 per million = 0.00206 % (advisory FY2026, from 2026-04-04); FINRA TAF on sells US$0.000195 per share,
// min US$0.01, max US$9.79 per trade (from 2026-01-01). Each fee rounded half-up to the cent per item, then summed.
// (The design's first figures, 27.80 per million and 0.000166 / 8.30, were superseded: D-1150.)
import { describe, expect, it } from "vitest";
import { costProfileOfMarket, costProfilesOfMarket, feeFor } from "@/lib/arena/costs";
import { staticProfile } from "@/lib/market/staticProfile.mjs";

const P = costProfilesOfMarket("US")["US-P1"]!;
const USD = (dollars: bigint) => dollars * 1_000_000n;

describe("US-P1 known answers", () => {
  it("is the profile the US cost_formula names, unverified", () => {
    expect(costProfileOfMarket(staticProfile("US"))).toBe(P);
    expect(P.verified).toBe(false);
    expect(P.rule.kind).toBe("components");
  });

  it("a buy costs nothing (commission 0, the fees are on sells)", () => {
    expect(feeFor(P, USD(5_000n), "buy", { quantity: 100n })).toBe(0n);
  });

  it("sell 100 shares at US$50 = US$0.12", () => {
    // value 5,000; SEC 5,000 x 0.0000206 = 0.103 -> 0.10; TAF 100 x 0.000195 = 0.0195 -> 0.02 (half up); total 0.12
    expect(feeFor(P, USD(5_000n), "sell", { quantity: 100n })).toBe(120_000n);
  });

  it("sell 100,000 shares at US$1 = US$11.85 (TAF capped at 9.79)", () => {
    // value 100,000; SEC 100,000 x 0.0000206 = 2.06; TAF 100,000 x 0.000195 = 19.50 -> cap 9.79; total 11.85
    expect(feeFor(P, USD(100_000n), "sell", { quantity: 100_000n })).toBe(11_850_000n);
  });

  it("TAF floor: sell 10 shares at US$5 = US$0.01", () => {
    // value 50; SEC 50 x 0.0000206 = 0.00103 -> 0.00; TAF 10 x 0.000195 = 0.00195 -> min 0.01; total 0.01
    expect(feeFor(P, USD(50n), "sell", { quantity: 10n })).toBe(10_000n);
  });

  it("an exact half cent rounds up: SEC on US$25,000 is 0.515 -> 0.52", () => {
    // value 25,000: SEC 25,000 x 0.0000206 = 0.515 exactly -> 0.52; TAF 100 x 0.000195 = 0.0195 -> 0.02; total 0.54
    expect(feeFor(P, USD(25_000n), "sell", { quantity: 100n })).toBe(540_000n);
  });

  it("a per-share item needs the quantity", () => {
    expect(() => feeFor(P, USD(5_000n), "sell")).toThrow("quantity is required");
  });
});
