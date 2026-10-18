// @vitest-environment node
// A4 candle patterns (M4 T5; AGT-031): TA-Lib CDL* definitions with exact thresholds.
// Every case is hand-built; the comments show the arithmetic. Prices are in A$ for readability.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PATTERN_SETTINGS,
  candleAverage,
  detectPatterns,
  isBullishEngulfing,
  isHammer,
  isMorningStar,
  isPiercingLine,
  type CandleBar,
} from "@/lib/agents/patterns";
import { makeRational } from "@/lib/money/rational";

const mi = (x: number): bigint => BigInt(Math.round(x * 1_000_000));
const c = (o: number, h: number, l: number, cl: number): CandleBar => ({
  open: mi(o),
  high: mi(h),
  low: mi(l),
  close: mi(cl),
});
// Filler candle: body 2 (100 -> 102), range 4 (99..103). Averages over fillers: body 2, range 4.
const filler = (): CandleBar => c(100, 103, 99, 102);
const fillers = (n: number): CandleBar[] => Array.from({ length: n }, filler);

describe("candle average (TA-Lib CandleAverage)", () => {
  it("averages the previous period candles, factor applied, exact", () => {
    const bars = [...fillers(10), c(1, 2, 0, 1)];
    // real body: mean 2, factor 1 -> 2
    expect(candleAverage(bars, 10, DEFAULT_PATTERN_SETTINGS.bodyLong)).toEqual(
      makeRational(2_000_000n),
    );
    // high-low: mean 4, factor 1/10 -> 2/5
    expect(candleAverage(bars, 10, DEFAULT_PATTERN_SETTINGS.shadowVeryShort)).toEqual(
      makeRational(400_000n),
    );
  });

  it("period 0 uses the candle's own range; shadows are halved", () => {
    // O100 C102 H105 L98: own body 2; shadows 3 + 2 = 5, halved 5/2
    const bars = [c(100, 105, 98, 102)];
    expect(candleAverage(bars, 0, DEFAULT_PATTERN_SETTINGS.shadowLong)).toEqual(
      makeRational(2_000_000n),
    );
    expect(
      candleAverage(bars, 0, { range: "shadows", period: 0, factor: makeRational(1n) }),
    ).toEqual(makeRational(5_000_000n, 2n));
  });
});

describe("bullish engulfing", () => {
  const base = fillers(2);
  it("white candle engulfing a black one", () => {
    // black 102 -> 100; white 99 -> 103: close 103 >= 102 and open 99 < 100
    expect(isBullishEngulfing([...base, c(102, 103, 99, 100), c(99, 104, 98, 103)], 3)).toBe(true);
  });
  it("boundary: open == prior close with close > prior open still engulfs", () => {
    expect(isBullishEngulfing([...base, c(102, 103, 99, 100), c(100, 104, 99, 103)], 3)).toBe(true);
  });
  it("not engulfing: close below prior open, or prior candle white", () => {
    expect(isBullishEngulfing([...base, c(102, 103, 99, 100), c(99, 104, 98, 101.5)], 3)).toBe(
      false,
    );
    expect(isBullishEngulfing([...base, c(100, 103, 99, 102), c(99, 104, 98, 103)], 3)).toBe(false);
  });
  it("opens above the prior close: no engulf", () => {
    expect(
      isBullishEngulfing([...base, c(102, 103, 99, 100), c(100.000001, 104, 99, 103)], 3),
    ).toBe(false);
  });
  it("null in warm-up", () => {
    expect(isBullishEngulfing([c(102, 103, 99, 100), c(99, 104, 98, 103)], 1)).toBeNull();
  });
});

describe("hammer", () => {
  // 11 fillers (indices 0..10); the previous candle (10) has low 99.
  // body avg 2 -> need body < 2; near avg = 1/5 x 4 = 0.8 -> body bottom <= 99 + 0.8 = 99.8;
  // very-short upper shadow avg = 1/10 x 4 = 0.4 -> upper shadow < 0.4 (strict).
  const hist = fillers(11);
  it("small body, long lower shadow, tiny upper shadow, near/below the prior low", () => {
    // O99 C99.5 H99.6 L97.5: body .5 < 2; lower 1.5 > .5; upper .1 < .4; 99 <= 99.8
    expect(isHammer([...hist, c(99, 99.6, 97.5, 99.5)], 11)).toBe(true);
  });
  it("upper shadow exactly 0.4 fails (strict)", () => {
    expect(isHammer([...hist, c(99, 99.9, 97.5, 99.5)], 11)).toBe(false);
    expect(isHammer([...hist, c(99, 99.899999, 97.5, 99.5)], 11)).toBe(true);
  });
  it("body bottom exactly at prior low + near average passes; one micro above fails", () => {
    // O99.8 C100 -> body .2, lower must exceed .2: low 97.5; upper 0
    expect(isHammer([...hist, c(99.8, 100, 97.5, 100)], 11)).toBe(true);
    expect(isHammer([...hist, c(99.800001, 100, 97.5, 100)], 11)).toBe(false);
  });
  it("lower shadow not longer than the body fails", () => {
    // body 0.5, lower shadow 0.5 (not >)
    expect(isHammer([...hist, c(99, 99.2, 98.5, 99.5)], 11)).toBe(false);
  });
  it("null before 11 prior candles", () => {
    expect(isHammer([...fillers(10), c(99, 99.6, 97.5, 99.5)], 10)).toBeNull();
  });
});

describe("piercing line", () => {
  // idx 0..9 fillers, idx 10 long black 110 -> 100 (low 99), idx 11 the piercing candle.
  // body-long avg at 10 = 2 (10 > 2); at 11 = (9 x 2 + 10) / 10 = 2.8.
  // threshold = close_first + 0.5 x body_first = 100 + 5 = 105.
  const hist = [...fillers(10), c(110, 111, 99, 100)];
  it("white long candle opens below the low, closes above the midpoint, below the open", () => {
    // O98 C107: body 9 > 2.8; 98 < 99; 107 < 110; 107 > 105
    expect(isPiercingLine([...hist, c(98, 108, 97, 107)], 11)).toBe(true);
  });
  it("close exactly at the midpoint fails (strict)", () => {
    expect(isPiercingLine([...hist, c(98, 108, 97, 105)], 11)).toBe(false);
  });
  it("close at or above the first open fails; open not below the low fails", () => {
    expect(isPiercingLine([...hist, c(98, 112, 97, 110)], 11)).toBe(false);
    expect(isPiercingLine([...hist, c(99, 108, 97, 107)], 11)).toBe(false);
  });
  it("first candle white fails; null in warm-up", () => {
    expect(isPiercingLine([...fillers(10), c(100, 111, 99, 110), c(98, 108, 97, 107)], 11)).toBe(
      false,
    );
    expect(
      isPiercingLine([...fillers(9), c(110, 111, 99, 100), c(98, 108, 97, 107)], 10),
    ).toBeNull();
  });
});

describe("morning star", () => {
  // idx 0..9 fillers, 10 long black 110 -> 100, 11 star, 12 white.
  // first body 10 > avg(10) = 2; star body <= avg(11) = (9 x 2 + 10) / 10 = 2.8;
  // third body > avg(12) = (8 x 2 + 10 + star body) / 10; threshold = 100 + 0.3 x 10 = 103.
  const first = c(110, 111, 99, 100);
  const hist = [...fillers(10), first];
  it("long black, gapped-down small body, white closing above 30% of the first body", () => {
    // star O97 C98 (body 1, top 98 < first bottom 100); third O99 C104: body 5 > 2.7; 104 > 103
    expect(isMorningStar([...hist, c(97, 99, 96, 98), c(99, 105, 98, 104)], 12)).toBe(true);
  });
  it("third close exactly at the penetration level fails (strict)", () => {
    expect(isMorningStar([...hist, c(97, 99, 96, 98), c(99, 105, 98, 103)], 12)).toBe(false);
  });
  it("no real-body gap (star top == first body bottom) fails", () => {
    expect(isMorningStar([...hist, c(99, 101, 98, 100), c(99, 105, 98, 104)], 12)).toBe(false);
  });
  it("custom penetration changes the outcome (parameterised, not hard-coded)", () => {
    const bars = [...hist, c(97, 99, 96, 98), c(99, 105, 98, 104)];
    const strict = { ...DEFAULT_PATTERN_SETTINGS, morningStarPenetration: makeRational(1n, 2n) };
    // threshold 105 now: 104 fails
    expect(isMorningStar(bars, 12, strict)).toBe(false);
  });
  it("null in warm-up", () => {
    expect(
      isMorningStar([...fillers(9), first, c(97, 99, 96, 98), c(99, 105, 98, 104)], 11),
    ).toBeNull();
  });
});

describe("detectPatterns", () => {
  it("reports flags for the last candle, null where history is short", () => {
    const flags = detectPatterns([...fillers(2), c(102, 103, 99, 100), c(99, 104, 98, 103)]);
    expect(flags).toEqual({
      bullishEngulfing: true,
      hammer: null,
      morningStar: null,
      piercingLine: null,
    });
  });

  it("finds the piercing line at the end of a long history and is deterministic", () => {
    const bars = [...fillers(10), c(110, 111, 99, 100), c(98, 108, 97, 107)];
    const a = detectPatterns(bars);
    expect(a.piercingLine).toBe(true);
    expect(a.morningStar).toBeNull(); // needs 13 bars
    expect(detectPatterns(bars)).toEqual(a);
  });

  it("rejects an empty series", () => {
    expect(() => detectPatterns([])).toThrow();
  });
});
