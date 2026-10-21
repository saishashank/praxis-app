// @vitest-environment node
// A4 indicators (M4 T5; AGT-030/032; design 2.2, 2.8, decisions 8 and 9): hand-verified known
// answers, incremental == batch, warm-up nulls, determinism, TA-Lib-format fixture loader.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INDICATOR_PARAMS,
  TALIB_FIXTURE_TOLERANCE,
  aboveSma,
  advPrevious,
  atrInit,
  atrSeries,
  atrStep,
  atrToMicro,
  bollinger,
  compareToFixture,
  computeIndicatorRow,
  dayRangePosition,
  emaSeries,
  highest,
  initWilderStates,
  isNSessionHigh,
  isWarm,
  logReturns,
  lookbackReturn,
  lowest,
  microToFloat,
  parseTaLibFixture,
  priceChannel,
  rsiSeries,
  smaExact,
  smaSeries,
  stdevFloat,
  tierPercentile,
  volumeRatio,
  wilderWarmupBars,
  type Bar,
  type IndicatorParams,
} from "@/lib/agents/indicators";
import { makeRational } from "@/lib/money/rational";

const M = 1_000_000n;
const mi = (x: number): bigint => BigInt(Math.round(x * 1_000_000));
const ints = (xs: number[]): bigint[] => xs.map((x) => BigInt(x) * M);
const rat = (n: bigint, d: bigint) => makeRational(n, d);

const FIXTURE_DIR = path.join(import.meta.dirname, "..", "fixtures", "agents", "indicators");
function loadFixture(file: string) {
  return parseTaLibFixture(JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), "utf8")));
}

// Deterministic pseudo-random bars (LCG), prices in micro, always high >= max(o,c), low <= min(o,c).
function makeBars(n: number, seed = 12345): Bar[] {
  let s = seed >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const bars: Bar[] = [];
  let price = 50_000_000; // A$50
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = Math.max(1_000_000, Math.round(open * (1 + (next() - 0.5) * 0.06)));
    const high = Math.round(Math.max(open, close) * (1 + next() * 0.02));
    const low = Math.round(Math.min(open, close) * (1 - next() * 0.02));
    bars.push({
      open: BigInt(open),
      high: BigInt(high),
      low: BigInt(low),
      close: BigInt(close),
      volume: BigInt(1000 + Math.floor(next() * 9000)),
    });
    price = close;
  }
  return bars;
}

describe("exact price-domain functions (known answers)", () => {
  it("SMA is exact and null during warm-up", () => {
    // (3 + 4 + 8) / 3 = 5; as rational 5/1
    expect(smaExact(ints([1, 3, 4, 8]), 3)).toEqual(rat(5n * M, 1n));
    // (1 + 2) / 2 = 3/2 exactly (no float)
    expect(smaExact(ints([1, 2]), 2)).toEqual(rat(3n * M, 2n));
    expect(smaExact(ints([1, 2]), 3)).toBeNull();
  });

  it("close > SMA(n) is n*close > sum, exact at the boundary", () => {
    // SMA(3) of 1,2,3 = 2; close 3 > 2 true. SMA(3) of 3,3,3 = 3; close 3 > 3 false (strict).
    expect(aboveSma(ints([1, 2, 3]), 3)).toBe(true);
    expect(aboveSma(ints([3, 3, 3]), 3)).toBe(false);
    // 1 micro above a 3-bar mean that is not representable in decimal: 2/3 vs 1/3 mean
    expect(aboveSma([0n, 0n, 1n], 3)).toBe(true);
    expect(aboveSma(ints([1, 2]), 3)).toBeNull();
  });

  it("highest / lowest / channel", () => {
    expect(highest(ints([5, 9, 2, 7]), 3)).toBe(9n * M); // window 9,2,7
    expect(lowest(ints([5, 9, 2, 7]), 3)).toBe(2n * M);
    expect(highest(ints([5, 9, 2, 7]), 2)).toBe(7n * M); // window 2,7
    expect(highest(ints([5]), 2)).toBeNull();
    const bars: Bar[] = [
      { open: M, high: 5n * M, low: 2n * M, close: 3n * M, volume: 1n },
      { open: M, high: 4n * M, low: 1n * M, close: 3n * M, volume: 1n },
      { open: M, high: 9n * M, low: 3n * M, close: 3n * M, volume: 1n },
    ];
    expect(priceChannel(bars, 2)).toEqual({ upper: 9n * M, lower: 1n * M });
    expect(priceChannel(bars, 4)).toBeNull();
  });

  it("N-session high: close >= max of previous n-1 closes (ties count)", () => {
    expect(isNSessionHigh(ints([5, 3, 5]), 3)).toBe(true); // 5 >= max(5,3)
    expect(isNSessionHigh(ints([5, 3, 4]), 3)).toBe(false);
    expect(isNSessionHigh(ints([9, 5, 3, 6]), 3)).toBe(true); // only the previous 2 closes: 5,3 -> 6 >= 5
    expect(isNSessionHigh(ints([5, 3]), 3)).toBeNull();
  });

  it("lookback return = C_D / C_{D-n} - 1 exactly", () => {
    // 121 / 100 - 1 = 21/100
    expect(lookbackReturn(ints([100, 110, 121]), 2)).toEqual(rat(21n, 100n));
    expect(lookbackReturn(ints([100, 110]), 2)).toBeNull();
    expect(lookbackReturn([0n, 1n], 1)).toBeNull(); // zero base
  });

  it("tier percentile: (lower + 0.5 ties) / (size - 1)", () => {
    const self = rat(1n, 10n);
    const others = [rat(1n, 20n), rat(1n, 10n), rat(1n, 5n), rat(3n, 10n)];
    // lower 1, ties 1 -> (1 + 0.5) / 4 = 3/8
    expect(tierPercentile(self, others)).toEqual(rat(3n, 8n));
    expect(tierPercentile(self, [])).toBeNull();
  });

  it("volume ratio uses the PREVIOUS n sessions and is exact", () => {
    // volumes 100,200,300,600; n=3 -> 600 / mean(100,200,300)=200 -> 3
    expect(volumeRatio([100n, 200n, 300n, 600n], 3)).toEqual(rat(3n, 1n));
    // 5 / mean(1,2)=1.5 -> 10/3
    expect(volumeRatio([1n, 2n, 5n], 2)).toEqual(rat(10n, 3n));
    expect(volumeRatio([0n, 0n, 5n], 2)).toBeNull(); // mean 0
    expect(volumeRatio([1n, 2n], 2)).toBeNull();
  });

  it("ADV is the mean of close x volume over the previous n sessions (excludes D)", () => {
    // closes 10,20,30 (micro), volumes 1,2,100; n=2 -> previous two are (10*1 + 20*2)/2 = 25
    expect(advPrevious(ints([10, 20, 30]), [1n, 2n, 100n], 2)).toEqual(rat(25n * M, 1n));
    expect(advPrevious(ints([10, 20]), [1n, 2n], 2)).toBeNull();
    expect(() => advPrevious(ints([10, 20]), [1n], 1)).toThrow();
  });

  it("day-range position is (C-L)/(H-L), 1/2 when flat", () => {
    const b = (low: number, high: number, close: number): Bar => ({
      open: mi(low),
      high: mi(high),
      low: mi(low),
      close: mi(close),
      volume: 1n,
    });
    expect(dayRangePosition(b(10, 20, 13))).toEqual(rat(3n, 10n));
    expect(dayRangePosition(b(10, 10, 10))).toEqual(rat(1n, 2n));
  });

  it("ATR to micro rounds half away once, including exponent-form doubles", () => {
    expect(atrToMicro(2.375)).toBe(2_375_000n);
    expect(atrToMicro(2.7500000000000004)).toBe(2_750_000n);
    expect(atrToMicro(0.0000005)).toBe(1n); // "5e-7": half away from zero
    expect(atrToMicro(1e-7)).toBe(0n);
    expect(() => atrToMicro(Number.NaN)).toThrow();
  });
});

describe("float-domain known answers", () => {
  it("Bollinger / stdev on the classic 8-point series", () => {
    // mean 5, population variance (9+1+1+1+0+0+4+16)/8 = 4 -> sd 2
    const v = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(stdevFloat(v, 8)).toBe(2);
    expect(bollinger(v, 8, 2)).toEqual({ middle: 5, upper: 9, lower: 1 });
    expect(stdevFloat(v, 8, 1)).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(bollinger(v, 9, 2)).toBeNull();
  });

  it("log returns", () => {
    const r = logReturns([1, Math.E, Math.E * Math.E]);
    expect(r[0]).toBeCloseTo(1, 12);
    expect(r[1]).toBeCloseTo(1, 12);
  });

  it("Wilder ATR(2) by hand", () => {
    // H,L,C: (11,9,10) (13,10,12) (12,10,11) (14,11,13) (13,11,12)
    // TR1 = max(3, |13-10|, |10-10|) = 3; TR2 = max(2, 0, |10-12|=2) = 2 -> seed (3+2)/2 = 2.5
    // TR3 = max(3, |14-11|=3, 0) = 3 -> (2.5 + 3)/2 = 2.75
    // TR4 = max(2, |13-13|=0, |11-13|=2) = 2 -> (2.75 + 2)/2 = 2.375
    const atr = atrSeries([11, 13, 12, 14, 13], [9, 10, 10, 11, 11], [10, 12, 11, 13, 12], 2);
    expect(atr).toEqual([null, null, 2.5, 2.75, 2.375]);
  });

  it("Wilder RSI(2) by hand", () => {
    // closes 10,12,11,13,12,14: changes +2,-1,+2,-1,+2
    // seed avgG=(2+0)/2=1 avgL=(0+1)/2=0.5 -> RSI=100*1/1.5=66.667
    // +2: avgG=(1+2)/2=1.5 avgL=0.25 -> 100*1.5/1.75=85.714
    const rsi = rsiSeries([10, 12, 11, 13, 12, 14], 2);
    expect(rsi.slice(0, 2)).toEqual([null, null]);
    expect(rsi[2]).toBeCloseTo(200 / 3, 12);
    expect(rsi[3]).toBeCloseTo(600 / 7, 12);
    expect(rsi[4]).toBeCloseTo(600 / 11, 12);
    expect(rsi[5]).toBeCloseTo(2200 / 27, 12);
  });

  it("RSI is 100 with no losses and 0 for a flat series (TA-Lib parity)", () => {
    expect(rsiSeries([1, 2, 3, 4], 2)).toEqual([null, null, 100, 100]);
    expect(rsiSeries([5, 5, 5, 5], 2)).toEqual([null, null, 0, 0]);
  });

  it("EMA(3) seeds with the SMA then k = 0.5", () => {
    // seed (10+12+11)/3 = 11; +0.5*(13-11) = 12; +0.5*(12-12) = 12; +0.5*(14-12) = 13
    expect(emaSeries([10, 12, 11, 13, 12, 14], 3)).toEqual([null, null, 11, 12, 12, 13]);
  });

  it("warm-up bar count is multiple x period", () => {
    expect(wilderWarmupBars(20, 3)).toBe(60);
    const s = atrInit(2);
    expect(isWarm({ ...s, bars: 5 }, 3)).toBe(false);
    expect(isWarm({ ...s, bars: 6 }, 3)).toBe(true);
  });

  it("rejects bad periods", () => {
    expect(() => smaExact([1n], 0)).toThrow();
    expect(() => atrInit(0)).toThrow();
    expect(() => rsiSeries([1, 2], 1)).toThrow();
  });
});

describe("TA-Lib-format fixture loader", () => {
  it("hand-verified fixture matches within the AGT-032 tolerance", () => {
    const fx = loadFixture("handverified_6bars.json");
    expect(fx.generator).toBe("hand-verified");
    expect(fx.tolerance).toBe(TALIB_FIXTURE_TOLERANCE);
    const diffs = compareToFixture(fx);
    expect(Object.keys(diffs).sort()).toEqual(["ATR_2", "EMA_3", "RSI_2", "SMA_3"]);
    for (const [id, d] of Object.entries(diffs)) expect(d, id).toBeLessThanOrEqual(fx.tolerance);
  });

  it("flags a lookback (null) mismatch as infinite", () => {
    const fx = loadFixture("handverified_6bars.json");
    const broken = {
      ...fx,
      expected: { SMA_3: { fn: "sma" as const, period: 3, values: [1, 1, 11, 12, 12, 13] } },
    };
    expect(compareToFixture(broken).SMA_3).toBe(Infinity);
  });

  it("rejects malformed fixtures", () => {
    const good = JSON.parse(
      readFileSync(path.join(FIXTURE_DIR, "handverified_6bars.json"), "utf8"),
    );
    expect(() => parseTaLibFixture({ ...good, format: "other" })).toThrow(/format/);
    expect(() => parseTaLibFixture({ ...good, input: { ...good.input, high: [1] } })).toThrow(
      /length/,
    );
    expect(() =>
      parseTaLibFixture({ ...good, expected: { X: { fn: "macd", period: 3, values: [] } } }),
    ).toThrow(/fn/);
    expect(() => parseTaLibFixture(null)).toThrow();
  });
});

// Independent reference implementation (direct loops, no shared state code) for cross-checking.
function refAtr(bars: Bar[], p: number): (number | null)[] {
  const h = bars.map((b) => microToFloat(b.high));
  const l = bars.map((b) => microToFloat(b.low));
  const c = bars.map((b) => microToFloat(b.close));
  const tr = [NaN];
  for (let i = 1; i < bars.length; i++) {
    tr.push(Math.max(h[i]! - l[i]!, Math.abs(h[i]! - c[i - 1]!), Math.abs(l[i]! - c[i - 1]!)));
  }
  const out: (number | null)[] = bars.map(() => null);
  let prev = 0;
  for (let i = 1; i <= p; i++) prev += tr[i]!;
  prev /= p;
  out[p] = prev;
  for (let i = p + 1; i < bars.length; i++) {
    prev = (prev * (p - 1) + tr[i]!) / p;
    out[i] = prev;
  }
  return out;
}

function refRsi(bars: Bar[], p: number): (number | null)[] {
  const c = bars.map((b) => microToFloat(b.close));
  const out: (number | null)[] = bars.map(() => null);
  let g = 0;
  let ls = 0;
  for (let i = 1; i <= p; i++) {
    const d = c[i]! - c[i - 1]!;
    if (d > 0) g += d;
    else ls -= d;
  }
  g /= p;
  ls /= p;
  out[p] = g + ls === 0 ? 0 : (100 * g) / (g + ls);
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i]! - c[i - 1]!;
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
    ls = (ls * (p - 1) + (d < 0 ? -d : 0)) / p;
    out[i] = g + ls === 0 ? 0 : (100 * g) / (g + ls);
  }
  return out;
}

describe("incremental == batch (property)", () => {
  const params: IndicatorParams = DEFAULT_INDICATOR_PARAMS;
  const rawFor = (bars: Bar[]): bigint[] => bars.map((b) => b.close); // no corporate actions here

  it("one-step update from the stored (JSON round-tripped) state equals a full recompute", () => {
    for (const seed of [1, 7, 99]) {
      const bars = makeBars(320, seed);
      let carried = initWilderStates(params);
      for (let n = 1; n <= bars.length; n++) {
        const slice = bars.slice(0, n);
        const raw = rawFor(slice);
        const full = computeIndicatorRow(slice, raw, params);
        // incremental: state produced for D-1, serialised as it would be in indicator_daily
        const prior = n === 1 ? undefined : (JSON.parse(JSON.stringify(carried)) as typeof carried);
        const inc = computeIndicatorRow(slice, raw, params, prior);
        if (n % 17 === 0 || n === bars.length || n < 30) expect(inc).toEqual(full);
        carried = full.state;
      }
    }
  });

  it("matches an independent reference implementation of ATR(20), RSI(2), RSI(14)", () => {
    const bars = makeBars(400, 5);
    const atr = refAtr(bars, 20);
    const rsi2 = refRsi(bars, 2);
    const rsi14 = refRsi(bars, 14);
    let st = initWilderStates(params);
    for (let i = 0; i < bars.length; i++) {
      const row = computeIndicatorRow(
        bars.slice(0, i + 1),
        rawFor(bars.slice(0, i + 1)),
        params,
        i === 0 ? undefined : st,
      );
      st = row.state;
      for (const [got, want] of [
        [row.atr, atr[i]],
        [row.rsiShort, rsi2[i]],
        [row.rsiLong, rsi14[i]],
      ] as const) {
        if (want === null || want === undefined) expect(got).toBeNull();
        else expect(Math.abs(got! - want)).toBeLessThanOrEqual(1e-9);
      }
    }
  });

  it("series helpers are folds of the step functions", () => {
    const bars = makeBars(120, 3);
    const h = bars.map((b) => microToFloat(b.high));
    const l = bars.map((b) => microToFloat(b.low));
    const c = bars.map((b) => microToFloat(b.close));
    const series = atrSeries(h, l, c, 14);
    let s = atrInit(14);
    c.forEach((x, i) => {
      s = atrStep(s, h[i]!, l[i]!, x);
      expect(s.value).toBe(series[i]);
    });
    expect(smaSeries(c, 5)[10]).toBe((c[6]! + c[7]! + c[8]! + c[9]! + c[10]!) / 5);
  });

  it("rejects a prior state that is not for D-1", () => {
    const bars = makeBars(10);
    const row = computeIndicatorRow(
      bars.slice(0, 5),
      bars.slice(0, 5).map((b) => b.close),
      DEFAULT_INDICATOR_PARAMS,
    );
    expect(() =>
      computeIndicatorRow(
        bars,
        bars.map((b) => b.close),
        DEFAULT_INDICATOR_PARAMS,
        row.state,
      ),
    ).toThrow();
  });
});

describe("warm-up and the A4 row", () => {
  it("everything is null / not warm on a short history", () => {
    const bars = makeBars(5);
    const row = computeIndicatorRow(
      bars,
      bars.map((b) => b.close),
      DEFAULT_INDICATOR_PARAMS,
    );
    expect(row.smaLong).toBeNull();
    expect(row.closeAboveSmaLong).toBeNull();
    expect(row.smaShort).not.toBeNull(); // SMA(5) needs exactly 5 bars
    expect(row.atr).toBeNull();
    expect(row.atrMicro).toBeNull();
    expect(row.rsiLong).toBeNull();
    expect(row.returnLookback).toBeNull();
    expect(row.isHigh).toBeNull();
    expect(row.volumeRatio).toBeNull(); // needs 21 bars
    expect(row.adv).toBeNull();
    expect(row.atrWarm).toBe(false);
  });

  it("volume ratio / ADV appear at bar 21; ATR value at bar 21 but warm only at bar 60", () => {
    const bars = makeBars(80, 11);
    const at = (n: number) =>
      computeIndicatorRow(
        bars.slice(0, n),
        bars.slice(0, n).map((b) => b.close),
        DEFAULT_INDICATOR_PARAMS,
      );
    expect(at(20).adv).toBeNull();
    expect(at(21).adv).not.toBeNull();
    expect(at(20).atr).toBeNull();
    expect(at(21).atr).not.toBeNull();
    expect(at(21).atrMicro).not.toBeNull();
    expect(at(59).atrWarm).toBe(false);
    expect(at(60).atrWarm).toBe(true);
    expect(at(5).rsiShortWarm).toBe(false);
    expect(at(6).rsiShortWarm).toBe(true);
  });

  it("row values agree with the standalone functions with a custom parameter set", () => {
    const params: IndicatorParams = {
      ...DEFAULT_INDICATOR_PARAMS,
      atrPeriod: 3,
      smaShortPeriod: 2,
      smaLongPeriod: 4,
      returnLookback: 3,
      highLookback: 4,
      volumeWindow: 2,
      advWindow: 2,
    };
    const bars = makeBars(12, 21);
    const raw = bars.map((b) => b.close + 1000n); // pretend raw differs from adjusted
    const row = computeIndicatorRow(bars, raw, params);
    const closes = bars.map((b) => b.close);
    const volumes = bars.map((b) => b.volume);
    expect(row.smaShort).toEqual(smaExact(closes, 2));
    expect(row.closeAboveSmaLong).toBe(aboveSma(closes, 4));
    expect(row.returnLookback).toEqual(lookbackReturn(closes, 3));
    expect(row.isHigh).toBe(isNSessionHigh(closes, 4));
    expect(row.volumeRatio).toEqual(volumeRatio(volumes, 2));
    expect(row.adv).toEqual(advPrevious(raw, volumes, 2));
    expect(row.atrMicro).toBe(atrToMicro(row.atr!));
  });

  it("is deterministic: identical inputs give byte-identical output", () => {
    const bars = makeBars(300, 8);
    const raw = bars.map((b) => b.close);
    const run = () =>
      JSON.stringify(computeIndicatorRow(bars, raw, DEFAULT_INDICATOR_PARAMS), (_k, v) =>
        typeof v === "bigint" ? `${v}n` : v,
      );
    expect(run()).toBe(run());
  });

  it("default params carry the spec values", () => {
    expect(DEFAULT_INDICATOR_PARAMS).toMatchObject({
      atrPeriod: 20,
      rsiShortPeriod: 2,
      rsiLongPeriod: 14,
      smaShortPeriod: 5,
      smaLongPeriod: 200,
      returnLookback: 126,
      highLookback: 250,
      volumeWindow: 20,
      advWindow: 20,
    });
  });
});
