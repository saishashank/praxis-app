// @vitest-environment node
// VAL-113 (D-229): the bullish harami detector exists and the test order is fixed, but harami is not
// wired into PatternFlags, cards or families until M15 publishes its sample size.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PATTERN_SETTINGS,
  detectPatterns,
  isBullishHarami,
  type CandleBar,
} from "@/lib/agents/patterns";
import { PATTERN_NAMES, PATTERN_TEST_ORDER } from "@/lib/replay/scorecards";

const U = 1_000_000n;
const bar = (open: bigint, close: bigint): CandleBar => ({
  open: open * U,
  close: close * U,
  high: (open > close ? open : close) * U + U / 2n,
  low: (open < close ? open : close) * U - U / 2n,
});

/** Ten small candles of body 1, then a long black candle (120 -> 110) and a candidate second candle. */
const history = (second: CandleBar): CandleBar[] => [
  ...Array.from({ length: 10 }, () => bar(100n, 101n)),
  bar(120n, 110n),
  second,
];

describe("bullish harami", () => {
  it("fires for a short white body strictly inside a long black body", () => {
    const bars = history(bar(112n, 113n));
    expect(isBullishHarami(bars, bars.length - 1)).toBe(true);
  });

  it("does not fire when the second body is not inside, is black, or the first is not long", () => {
    const outside = history(bar(108n, 113n));
    expect(isBullishHarami(outside, outside.length - 1)).toBe(false);
    const black = history(bar(113n, 112n));
    expect(isBullishHarami(black, black.length - 1)).toBe(false);
    const short = [...Array.from({ length: 11 }, () => bar(100n, 99n)), bar(99n, 99n + 0n)];
    expect(isBullishHarami(short, short.length - 1)).toBe(false);
  });

  it("is null during warm-up", () => {
    const bars = history(bar(112n, 113n)).slice(-5);
    expect(isBullishHarami(bars, bars.length - 1)).toBeNull();
    expect(DEFAULT_PATTERN_SETTINGS.bodyLong.period).toBe(10);
  });

  it("is not part of the pattern flags or the pattern names (nothing else changes)", () => {
    const bars = history(bar(112n, 113n));
    expect(Object.keys(detectPatterns(bars)).sort()).toEqual([...PATTERN_NAMES].sort());
    expect(PATTERN_NAMES).not.toContain("bullishHarami");
  });
});

describe("pattern test order (VAL-113)", () => {
  it("is engulfing, piercing, harami, morning star, hammer", () => {
    expect(PATTERN_TEST_ORDER).toEqual([
      "bullishEngulfing",
      "piercingLine",
      "bullishHarami",
      "morningStar",
      "hammer",
    ]);
  });
});
