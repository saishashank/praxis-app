// @vitest-environment node
// Limit formula and trade-through fill (M15 C3a; spec ch. 17 CTX-028; D-288; AT-52 "+9 % open against
// an 8 % cap cancels at the open"). HIGH-RISK money maths: every expected value is hand-computed in
// micro-AUD and written as a literal. Setup: P5, ADV A$5M (10 bps bucket), tick A$0.01 from A$2.00,
// A$0.005 from A$0.10, A$0.001 below.
import { describe, expect, it } from "vitest";
import { COST_PROFILES } from "@/lib/arena/costs";
import {
  type Bar,
  type FillEnv,
  fillEntryAtOpen,
  fillEntryLimit,
  LIMIT_FILL_RULE,
  limitPriceMicro,
} from "@/lib/arena/fills";
import { FILL_RULES } from "@/lib/arena/schema";
import { makeRational } from "@/lib/money/rational";

const ADV = 5_000_000_000_000n;
const GAP_8 = makeRational(8n, 100n);
const STOP_CAP_20 = makeRational(20n, 100n);
const bar = (open: bigint, low: bigint, high?: bigint, close?: bigint): Bar => {
  const h = high ?? (open > low ? open : low);
  return {
    openMicro: open,
    highMicro: h > open ? h : open,
    lowMicro: low,
    closeMicro: close ?? open,
  };
};
const env = (b: Bar, over: Partial<FillEnv> = {}): FillEnv => ({
  bar: b,
  advMicro: ADV,
  profile: COST_PROFILES.P5,
  ...over,
});

describe("limitPriceMicro = min(close × (1 + gap cap), stop ÷ (1 − stop cap)), rounded down to the tick", () => {
  it("gap cap binds: close A$10.00, stop A$9.00, 8 % / 20 % → A$10.80 (on the A$0.01 grid)", () => {
    // 10_000_000 × 1.08 = 10_800_000; 9_000_000 ÷ 0.8 = 11_250_000; min = 10_800_000.
    expect(limitPriceMicro(10_000_000n, 9_000_000n, GAP_8, STOP_CAP_20)).toBe(10_800_000n);
  });

  it("stop cap binds: stop A$9.50 at a 5 % cap → A$10.00 exactly, below the gap limit", () => {
    // 9_500_000 ÷ 0.95 = 10_000_000; 10_000_000 × 1.08 = 10_800_000; min = 10_000_000.
    expect(limitPriceMicro(10_000_000n, 9_500_000n, GAP_8, makeRational(5n, 100n))).toBe(
      10_000_000n,
    );
  });

  it("rounds DOWN onto the grid of the band the raw limit falls in (A$0.20 × 1.08 = 0.216 → 0.215)", () => {
    // 200_000 × 1.08 = 216_000; 180_000 ÷ 0.8 = 225_000; min 216_000; tick 5_000 → floor 215_000.
    expect(limitPriceMicro(200_000n, 180_000n, GAP_8, STOP_CAP_20)).toBe(215_000n);
  });

  it("a raw limit that crosses into the coarser band rounds on that band (1.855 × 1.08 = 2.0034 → 2.00)", () => {
    // 1_855_000 × 1.08 = 2_003_400; 1_700_000 ÷ 0.8 = 2_125_000; min 2_003_400; tick at 2.0034 is
    // 10_000 → 2_000_000 (still >= the band edge).
    expect(limitPriceMicro(1_855_000n, 1_700_000n, GAP_8, STOP_CAP_20)).toBe(2_000_000n);
  });

  it("an explicit tick overrides the band tick", () => {
    expect(limitPriceMicro(10_000_000n, 9_000_000n, GAP_8, STOP_CAP_20, 1_000_000n)).toBe(
      10_000_000n,
    );
  });

  it("never rounds up: a limit exactly on the grid stays, one micro above rounds down a full tick", () => {
    // close 10_000_000 × (1 + 1/1_000_000) = 10_000_010 → 10_000_000.
    expect(
      limitPriceMicro(10_000_000n, 9_000_000n, makeRational(1n, 1_000_000n), STOP_CAP_20),
    ).toBe(10_000_000n);
  });

  it("rejects a non-positive close, a stop at or above the close, and a stop cap of 100 %", () => {
    expect(() => limitPriceMicro(0n, 1n, GAP_8, STOP_CAP_20)).toThrow(RangeError);
    expect(() => limitPriceMicro(10n, 10n, GAP_8, STOP_CAP_20)).toThrow(RangeError);
    expect(() => limitPriceMicro(10n, 5n, GAP_8, makeRational(1n))).toThrow(RangeError);
    expect(() => limitPriceMicro(10n, 5n, makeRational(-1n, 100n), STOP_CAP_20)).toThrow(
      RangeError,
    );
  });
});

describe("fillEntryLimit (D-288)", () => {
  const LIMIT = limitPriceMicro(10_000_000n, 9_000_000n, GAP_8, STOP_CAP_20); // 10_800_000

  it("AT-52: +9 % open against an 8 % cap, low above the limit → unfilled (both arms record unfilled)", () => {
    // open 1.09 × 10_000_000 = 10_900_000 > 10_800_000; low 10_850_000 > limit.
    const out = fillEntryLimit(env(bar(10_900_000n, 10_850_000n, 11_000_000n)), 60n, LIMIT);
    expect(out).toEqual({ status: "unfilled", reason: "limit_not_reached" });
  });

  it("open ≤ limit: the v1 fill (open + slippage) when it stays under the limit, rule `open`", () => {
    const b = bar(10_000_000n, 9_900_000n, 10_200_000n, 10_100_000n);
    const out = fillEntryLimit(env(b), 60n, LIMIT);
    expect(out.status).toBe("filled");
    if (out.status !== "filled") return;
    // 10 bps of 10_000_000 = 10_000 = one tick -> 10_010_000, as fillEntryAtOpen.
    expect(out.fill).toEqual(fillEntryAtOpen(env(b), 60n));
    expect(out.fill.rule).toBe("open");
    expect(out.fill.fillPriceMicro).toBe(10_010_000n);
    expect(out.fill.slipMicro).toBe(10_000n);
    expect(out.fill.valueMicro).toBe(600_600_000n);
    expect(out.fill.brokerageMicro).toBe(5_000_000n);
  });

  it("open ≤ limit but open + slippage above it: the fill is capped AT the limit (slippage up to the limit only)", () => {
    // open 10_790_000: 10 bps = 10_790 → raw 10_800_790 → ceil on the 10_000 grid = 10_810_000 > limit.
    const out = fillEntryLimit(env(bar(10_790_000n, 10_700_000n, 11_000_000n)), 60n, LIMIT);
    expect(out.status).toBe("filled");
    if (out.status !== "filled") return;
    expect(out.fill.rule).toBe("open");
    expect(out.fill.refPriceMicro).toBe(10_790_000n);
    expect(out.fill.fillPriceMicro).toBe(10_800_000n);
    expect(out.fill.slipMicro).toBe(10_000n);
    expect(out.fill.valueMicro).toBe(648_000_000n); // 60 × 10_800_000
    expect(out.fill.brokerageMicro).toBe(5_000_000n); // P5, A$648.00 <= A$1,000.00
    expect(out.fill.costProfile).toBe("P5");
  });

  it("open at the limit exactly fills at the limit (slippage capped to 0)", () => {
    const out = fillEntryLimit(env(bar(10_800_000n, 10_700_000n, 11_000_000n)), 1n, LIMIT);
    expect(out.status).toBe("filled");
    if (out.status !== "filled") return;
    expect(out.fill.rule).toBe("open");
    expect(out.fill.fillPriceMicro).toBe(10_800_000n);
    expect(out.fill.slipMicro).toBe(0n);
  });

  it("trade-through: open above, low ≤ limit → filled at the limit EXACTLY, rule `limit`, no slippage", () => {
    const b = bar(10_900_000n, 10_700_000n, 11_000_000n, 10_750_000n);
    const out = fillEntryLimit(env(b), 60n, LIMIT);
    expect(out.status).toBe("filled");
    if (out.status !== "filled") return;
    expect(out.fill.rule).toBe(LIMIT_FILL_RULE);
    expect(out.fill.side).toBe("buy");
    expect(out.fill.qty).toBe(60n);
    expect(out.fill.refPriceMicro).toBe(10_800_000n);
    expect(out.fill.fillPriceMicro).toBe(10_800_000n);
    expect(out.fill.slipMicro).toBe(0n);
    expect(out.fill.valueMicro).toBe(648_000_000n);
    expect(out.fill.brokerageMicro).toBe(5_000_000n);
    expect(out.fill.bar).toEqual(b);
  });

  it("low exactly at the limit is a trade-through fill; one micro above is unfilled", () => {
    expect(fillEntryLimit(env(bar(10_900_000n, 10_800_000n)), 1n, LIMIT).status).toBe("filled");
    expect(fillEntryLimit(env(bar(10_900_000n, 10_800_001n)), 1n, LIMIT).status).toBe("unfilled");
  });

  it("the limit rule is NOT one of the 0007 `fill.rule` values (P2 maps it before writing a row)", () => {
    expect((FILL_RULES as readonly string[]).includes(LIMIT_FILL_RULE)).toBe(false);
  });

  it("rejects an invalid bar, a non-positive limit and a non-positive quantity", () => {
    expect(() => fillEntryLimit(env(bar(10n, 20n)), 1n, LIMIT)).toThrow(RangeError);
    expect(() => fillEntryLimit(env(bar(10_000_000n, 9_000_000n)), 1n, 0n)).toThrow(RangeError);
    expect(() => fillEntryLimit(env(bar(10_000_000n, 9_000_000n)), 0n, LIMIT)).toThrow(RangeError);
  });

  it("the v1 entry fill is unchanged by the addition (same bytes as before)", () => {
    const f = fillEntryAtOpen(env(bar(12_000_000n, 11_900_000n)), 1n);
    expect(f.fillPriceMicro).toBe(12_020_000n);
    expect(f.slipMicro).toBe(20_000n);
    expect(f.rule).toBe("open");
  });
});
