// A4 candle patterns (M4 T5; AGT-031; design 2.2): bullish engulfing, hammer, morning star,
// piercing line, following the TA-Lib CDL* definitions including its candle-average settings
// (10-session averages of body / shadow sizes). Pure, deterministic, exact: prices are integer
// micro and every threshold is a Rational, so comparisons are exact integer cross-multiplication
// (TA-Lib's double arithmetic can differ only on exact ties, where the exact result is used).
// Outputs are informational booleans until a pattern PASSES validation (AGT-031).
import {
  addRat,
  cmpRat,
  makeRational,
  mulRat,
  ratFromInt,
  type Rational,
} from "@/lib/money/rational";

/** Prices in micro; only OHLC is needed here. */
export type CandleBar = {
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
};

export type RangeType = "realbody" | "highlow" | "shadows";

/** TA-Lib candle setting: factor x average of `range` over the previous `period` candles. */
export type CandleSetting = {
  readonly range: RangeType;
  /** 0 = use the candle's own range (no averaging). */
  readonly period: number;
  readonly factor: Rational;
};

export type PatternSettings = {
  readonly bodyLong: CandleSetting;
  readonly bodyShort: CandleSetting;
  readonly shadowLong: CandleSetting;
  readonly shadowVeryShort: CandleSetting;
  readonly near: CandleSetting;
  /** Morning-star penetration of the first candle's body (TA-Lib default 0.3). */
  readonly morningStarPenetration: Rational;
  /** Piercing-line penetration of the first candle's body (TA-Lib fixes 0.5). */
  readonly piercingPenetration: Rational;
};

/** TA-Lib default settings (ta_global.c); proposed fixed registry keys pat_* (decision 10). */
export const DEFAULT_PATTERN_SETTINGS: PatternSettings = {
  bodyLong: { range: "realbody", period: 10, factor: ratFromInt(1n) }, // threshold-ok: TA-Lib default (pat_body_long)
  bodyShort: { range: "realbody", period: 10, factor: ratFromInt(1n) }, // threshold-ok: TA-Lib default (pat_body_short)
  shadowLong: { range: "realbody", period: 0, factor: ratFromInt(1n) }, // threshold-ok: TA-Lib default (pat_shadow_long)
  shadowVeryShort: { range: "highlow", period: 10, factor: makeRational(1n, 10n) }, // threshold-ok: TA-Lib default (pat_shadow_very_short)
  near: { range: "highlow", period: 5, factor: makeRational(1n, 5n) }, // threshold-ok: TA-Lib default (pat_near)
  morningStarPenetration: makeRational(3n, 10n), // threshold-ok: TA-Lib default (pat_morning_star_penetration)
  piercingPenetration: makeRational(1n, 2n), // pat_piercing_penetration
};

export type PatternName = "bullishEngulfing" | "hammer" | "morningStar" | "piercingLine";

/** null = not enough history for that pattern's averages (warm-up). */
export type PatternFlags = Readonly<Record<PatternName, boolean | null>>;

const abs = (x: bigint): bigint => (x < 0n ? -x : x);
const bodyOf = (b: CandleBar): bigint => abs(b.close - b.open);
const upperShadow = (b: CandleBar): bigint => b.high - (b.close > b.open ? b.close : b.open);
const lowerShadow = (b: CandleBar): bigint => (b.close < b.open ? b.close : b.open) - b.low;
const isWhite = (b: CandleBar): boolean => b.close >= b.open; // TA-Lib: close >= open is white
const isBlack = (b: CandleBar): boolean => b.close < b.open;
const bodyTop = (b: CandleBar): bigint => (b.close > b.open ? b.close : b.open);
const bodyBottom = (b: CandleBar): bigint => (b.close < b.open ? b.close : b.open);

function rangeOf(type: RangeType, b: CandleBar): bigint {
  switch (type) {
    case "realbody":
      return bodyOf(b);
    case "highlow":
      return b.high - b.low;
    case "shadows":
      return upperShadow(b) + lowerShadow(b);
  }
}

/**
 * TA-Lib CandleAverage for the candle at `idx`: factor x (mean range of the `period` candles
 * before idx, or the candle's own range when period = 0) / (2 for shadows). Exact. The caller
 * guarantees idx >= period.
 */
export function candleAverage(
  bars: readonly CandleBar[],
  idx: number,
  setting: CandleSetting,
): Rational {
  let base: Rational;
  if (setting.period === 0) {
    base = ratFromInt(rangeOf(setting.range, bars[idx]!));
  } else {
    let sum = 0n;
    for (let j = idx - setting.period; j < idx; j++) sum += rangeOf(setting.range, bars[j]!);
    base = makeRational(sum, BigInt(setting.period));
  }
  const scaled = mulRat(setting.factor, base);
  return setting.range === "shadows" ? mulRat(scaled, makeRational(1n, 2n)) : scaled;
}

const gt = (a: bigint, r: Rational): boolean => cmpRat(ratFromInt(a), r) > 0;
const lt = (a: bigint, r: Rational): boolean => cmpRat(ratFromInt(a), r) < 0;
const lte = (a: bigint, r: Rational): boolean => cmpRat(ratFromInt(a), r) <= 0;

/** TA-Lib CDLENGULFING, bullish side: white candle whose body engulfs the prior black body. */
export function isBullishEngulfing(bars: readonly CandleBar[], i: number): boolean | null {
  if (i < 2) return null; // TA-Lib lookback 2
  const c = bars[i]!;
  const p = bars[i - 1]!;
  return (
    isWhite(c) &&
    isBlack(p) &&
    ((c.close >= p.open && c.open < p.close) || (c.close > p.open && c.open <= p.close))
  );
}

/**
 * TA-Lib CDLHAMMER: small real body, long lower shadow (> own body), very short upper shadow, and
 * the body at or below the previous low plus the "near" average.
 */
export function isHammer(
  bars: readonly CandleBar[],
  i: number,
  s: PatternSettings = DEFAULT_PATTERN_SETTINGS,
): boolean | null {
  const lookback =
    Math.max(s.bodyShort.period, s.shadowLong.period, s.shadowVeryShort.period, s.near.period) + 1;
  if (i < lookback) return null;
  const c = bars[i]!;
  const prev = bars[i - 1]!;
  return (
    lt(bodyOf(c), candleAverage(bars, i, s.bodyShort)) &&
    gt(lowerShadow(c), candleAverage(bars, i, s.shadowLong)) &&
    lt(upperShadow(c), candleAverage(bars, i, s.shadowVeryShort)) &&
    lte(bodyBottom(c), addRat(ratFromInt(prev.low), candleAverage(bars, i - 1, s.near)))
  );
}

/**
 * TA-Lib CDLMORNINGSTAR: long black candle, small real body gapping down below it, then a
 * non-small white candle closing above the first body by the penetration fraction.
 */
export function isMorningStar(
  bars: readonly CandleBar[],
  i: number,
  s: PatternSettings = DEFAULT_PATTERN_SETTINGS,
): boolean | null {
  const lookback = Math.max(s.bodyLong.period, s.bodyShort.period) + 2;
  if (i < lookback) return null;
  const first = bars[i - 2]!;
  const star = bars[i - 1]!;
  const third = bars[i]!;
  const threshold = addRat(
    ratFromInt(first.close),
    mulRat(s.morningStarPenetration, ratFromInt(bodyOf(first))),
  );
  return (
    gt(bodyOf(first), candleAverage(bars, i - 2, s.bodyLong)) &&
    isBlack(first) &&
    lte(bodyOf(star), candleAverage(bars, i - 1, s.bodyShort)) &&
    bodyTop(star) < bodyBottom(first) && // real-body gap down
    gt(bodyOf(third), candleAverage(bars, i, s.bodyShort)) &&
    isWhite(third) &&
    gt(third.close, threshold)
  );
}

/**
 * TA-Lib CDLPIERCING: long black candle, then a long white candle opening below its low and
 * closing inside its body above the midpoint (penetration), but below its open.
 */
export function isPiercingLine(
  bars: readonly CandleBar[],
  i: number,
  s: PatternSettings = DEFAULT_PATTERN_SETTINGS,
): boolean | null {
  const lookback = s.bodyLong.period + 1;
  if (i < lookback) return null;
  const first = bars[i - 1]!;
  const second = bars[i]!;
  const threshold = addRat(
    ratFromInt(first.close),
    mulRat(s.piercingPenetration, ratFromInt(bodyOf(first))),
  );
  return (
    isBlack(first) &&
    gt(bodyOf(first), candleAverage(bars, i - 1, s.bodyLong)) &&
    isWhite(second) &&
    gt(bodyOf(second), candleAverage(bars, i, s.bodyLong)) &&
    second.open < first.low &&
    second.close < first.open &&
    gt(second.close, threshold)
  );
}

/**
 * TA-Lib CDLHARAMI, bullish side (VAL-113, D-229): a long black candle, then a short white candle
 * whose real body lies strictly inside the first body. A pure detector only: it is NOT in
 * `PatternName`/`PatternFlags`/`detectPatterns`, so no card, family or indicator changes until M15
 * publishes the sample sizes for it.
 */
export function isBullishHarami(
  bars: readonly CandleBar[],
  i: number,
  s: PatternSettings = DEFAULT_PATTERN_SETTINGS,
): boolean | null {
  const lookback = Math.max(s.bodyLong.period, s.bodyShort.period) + 1;
  if (i < lookback) return null;
  const first = bars[i - 1]!;
  const second = bars[i]!;
  return (
    isBlack(first) &&
    gt(bodyOf(first), candleAverage(bars, i - 1, s.bodyLong)) &&
    isWhite(second) &&
    lte(bodyOf(second), candleAverage(bars, i, s.bodyShort)) &&
    bodyTop(second) < bodyTop(first) &&
    bodyBottom(second) > bodyBottom(first)
  );
}

/** All four pattern flags for the last candle of `bars` (session D). */
export function detectPatterns(
  bars: readonly CandleBar[],
  settings: PatternSettings = DEFAULT_PATTERN_SETTINGS,
): PatternFlags {
  if (bars.length === 0) throw new RangeError("no bars");
  const i = bars.length - 1;
  return {
    bullishEngulfing: isBullishEngulfing(bars, i),
    hammer: isHammer(bars, i, settings),
    morningStar: isMorningStar(bars, i, settings),
    piercingLine: isPiercingLine(bars, i, settings),
  };
}
