// @vitest-environment node
// M20 A4 (D-1104, AT-69/70): the IN and US tick tables as engine arguments, hand-worked in micro units.
import { describe, expect, it } from "vitest";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import { makeRational } from "@/lib/money/rational";
import { slippedFill, stallSlippageMicro, tickFor, TICK_TABLE } from "@/lib/money/tick";

const IN_TABLE = staticProfile("IN").tickTable!;
const US_TABLE = staticProfile("US").tickTable!;

describe("IN tick table (Rs 0.01 below Rs 250, Rs 0.05 from Rs 250)", () => {
  it("bands", () => {
    expect(tickFor(249_990_000n, IN_TABLE)).toBe(10_000n);
    expect(tickFor(250_000_000n, IN_TABLE)).toBe(50_000n);
    expect(tickFor(1n, IN_TABLE)).toBe(10_000n);
    expect(tickFor(3_000_000_000n, IN_TABLE)).toBe(50_000n);
  });

  it("a buy at Rs 249.99 with 120 bps crosses into the Rs 0.05 band and is re-rounded there", () => {
    // slip = max(249.99 x 0.012 = 2.99988, 0.01) = 2.99988; raw 252.98988; band of the ref: 0.01 -> 252.99;
    // 252.99 is in the 0.05 band: ceil(252.98988 / 0.05) = ceil(5059.7976) = 5060 -> Rs 253.00
    expect(slippedFill(249_990_000n, "buy", makeRational(120n), makeRational(1n), IN_TABLE)).toBe(
      253_000_000n,
    );
  });

  it("a sell at Rs 250 with 120 bps lands on Rs 247.00", () => {
    // slip 250 x 0.012 = 3.00; raw 247.00; ref band tick 0.05 -> floor(247.00 / 0.05) = 4940 -> 247.00;
    // 247.00 is in the finer 0.01 band (tick <= 0.05), so it stands
    expect(slippedFill(250_000_000n, "sell", makeRational(120n), makeRational(1n), IN_TABLE)).toBe(
      247_000_000n,
    );
  });

  it("the stall floor is max(10 bps, one tick) on the market's grid", () => {
    // Rs 100: 10 bps = 0.10 -> ceil(0.10 / 0.01) = 10 ticks of 0.01 = 0.10
    expect(stallSlippageMicro(100_000_000n, IN_TABLE)).toBe(100_000n);
    // Rs 10: 10 bps = 0.01 = one tick of 0.01
    expect(stallSlippageMicro(10_000_000n, IN_TABLE)).toBe(10_000n);
  });
});

describe("US tick table (US$0.0001 below US$1, US$0.01 from US$1)", () => {
  it("bands", () => {
    expect(tickFor(999_900n, US_TABLE)).toBe(100n);
    expect(tickFor(1_000_000n, US_TABLE)).toBe(10_000n);
  });

  it("a buy at US$0.50, 10 bps: fill 0.5005 on the 0.0001 grid (the AU grid would give 0.505)", () => {
    // slip = max(0.50 x 0.001 = 0.0005, 0.0001) = 0.0005; raw 0.5005 sits exactly on a 0.0001 tick
    expect(slippedFill(500_000n, "buy", makeRational(10n), makeRational(1n), US_TABLE)).toBe(
      500_500n,
    );
    // AU table (tick 0.005 in 0.10..2.00): ceil(0.5005 / 0.005) = 101 ticks = 0.505
    expect(slippedFill(500_000n, "buy", makeRational(10n), makeRational(1n), TICK_TABLE)).toBe(
      505_000n,
    );
  });
});
