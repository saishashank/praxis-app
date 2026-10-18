// A4 indicators (M4 T5; AGT-030/032; design 2.1, 2.2, 2.8, decision 8). Pure and deterministic:
// no clock, no randomness, no I/O. Every period and threshold is a parameter; nothing below
// hard-codes one. Two number domains:
//   - price-domain rule inputs (SMA, highs, returns, ratios, ADV, range position): exact bigint
//     micro prices and exact Rationals, so `close > SMA200` is `200 * close > sum`;
//   - Wilder ATR / RSI, EMA, stdev: IEEE float64 in a fixed evaluation order (TA-Lib parity,
//     AGT-032), with the ATR converted to micro once (`atrToMicro`).
// Callers pass series already adjusted with factors whose ex-date <= D (DAT-126) except where a
// function says "raw" (ADV). Series are oldest first; the last element is session D.
import { toMicro } from "@/lib/money/micro";
import { cmpRat, makeRational, type Rational } from "@/lib/money/rational";

/** One session bar in integer micro prices (adjusted unless stated). Volume in shares. */
export type Bar = {
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
  readonly volume: bigint;
};

/** Parameters of the A4 row. Wire to config keys later (fixed registry keys, design decision 10). */
export type IndicatorParams = {
  readonly atrPeriod: number;
  readonly rsiShortPeriod: number;
  readonly rsiLongPeriod: number;
  readonly smaShortPeriod: number;
  readonly smaLongPeriod: number;
  readonly returnLookback: number;
  readonly highLookback: number;
  readonly volumeWindow: number;
  readonly advWindow: number;
  /** Wilder warm-up multiple (design 2.2: 3 x period before a value is used). */
  readonly warmupMultiple: number;
};

/** Values from spec 07 AGT-030 / M4 design 2.2; key names are the proposed fixed registry keys. */
export const DEFAULT_INDICATOR_PARAMS: IndicatorParams = {
  atrPeriod: 20, // ind_atr_period (AGT-030 ATR(20))
  rsiShortPeriod: 2, // ind_rsi_short_period (RSI(2))
  rsiLongPeriod: 14, // ind_rsi_long_period (RSI(14))
  smaShortPeriod: 5, // ind_sma_short_period (F4 exit close > SMA5)
  smaLongPeriod: 200, // ind_sma_long_period (F4 entry close > SMA200)
  returnLookback: 126, // ind_return_lookback (6-month return, 126 sessions)
  highLookback: 250, // F1 high_lookback (250-session high)
  volumeWindow: 20, // ind_volume_window (volume ratio over previous 20 sessions)
  advWindow: 20, // ind_adv_window (ADV over previous 20 sessions)
  warmupMultiple: 3, // ind_warmup_multiple (design 2.2)
};

function assertPeriod(n: number, min = 1): void {
  if (!Number.isSafeInteger(n) || n < min)
    throw new RangeError(`period must be an integer >= ${min}`);
}

// ---------------------------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------------------------

/** Micro price to float64 (deterministic: one division). Float domain only. */
export function microToFloat(value: bigint): number {
  return Number(value) / 1e6;
}

/**
 * ATR (float) to micro, once: round half away from zero of the shortest decimal string of the
 * double (as `toMicroFromVendor`, but rounding instead of rejecting more than 6 dp).
 */
export function atrToMicro(atr: number): bigint {
  if (!Number.isFinite(atr)) throw new RangeError("ATR is not finite");
  const text = String(atr).includes("e") ? atr.toFixed(12) : String(atr);
  return toMicro(text, { rounding: "half-away-from-zero" });
}

// ---------------------------------------------------------------------------------------------
// Exact price-domain functions (bigint / Rational)
// ---------------------------------------------------------------------------------------------

function sumLast(values: readonly bigint[], n: number, end = values.length): bigint | null {
  if (end < n || end > values.length) return null;
  let sum = 0n;
  for (let i = end - n; i < end; i++) sum += values[i]!;
  return sum;
}

/** SMA(n) including the last element, exact. null until n values exist (warm-up). */
export function smaExact(values: readonly bigint[], n: number): Rational | null {
  assertPeriod(n);
  const sum = sumLast(values, n);
  return sum === null ? null : makeRational(sum, BigInt(n));
}

/** `last > SMA(n)` exactly, as `n * last > sum`. null during warm-up. */
export function aboveSma(values: readonly bigint[], n: number): boolean | null {
  assertPeriod(n);
  const sum = sumLast(values, n);
  if (sum === null) return null;
  return BigInt(n) * values[values.length - 1]! > sum;
}

/** Highest value of the last n elements (inclusive of the last); null in warm-up. */
export function highest(values: readonly bigint[], n: number): bigint | null {
  assertPeriod(n);
  if (values.length < n) return null;
  let best = values[values.length - n]!;
  for (let i = values.length - n + 1; i < values.length; i++)
    if (values[i]! > best) best = values[i]!;
  return best;
}

/** Lowest value of the last n elements (inclusive of the last); null in warm-up. */
export function lowest(values: readonly bigint[], n: number): bigint | null {
  assertPeriod(n);
  if (values.length < n) return null;
  let best = values[values.length - n]!;
  for (let i = values.length - n + 1; i < values.length; i++)
    if (values[i]! < best) best = values[i]!;
  return best;
}

/** Highest-high / lowest-low channel over the last n bars (Donchian), exact. */
export function priceChannel(
  bars: readonly Bar[],
  n: number,
): { readonly upper: bigint; readonly lower: bigint } | null {
  assertPeriod(n);
  if (bars.length < n) return null;
  const window = bars.slice(bars.length - n);
  return {
    upper: highest(
      window.map((b) => b.high),
      n,
    )!,
    lower: lowest(
      window.map((b) => b.low),
      n,
    )!,
  };
}

/**
 * N-session high: last close >= max of the previous (lookback - 1) closes (AGT-030). Needs
 * `lookback` closes in total, else null.
 */
export function isNSessionHigh(closes: readonly bigint[], lookback: number): boolean | null {
  assertPeriod(lookback, 2);
  if (closes.length < lookback) return null;
  const last = closes[closes.length - 1]!;
  const prior = highest(closes.slice(0, closes.length - 1), lookback - 1)!;
  return last >= prior;
}

/** Return over `lookback` sessions: C_D / C_{D-lookback} - 1, exact. null if too short or base 0. */
export function lookbackReturn(closes: readonly bigint[], lookback: number): Rational | null {
  assertPeriod(lookback);
  if (closes.length < lookback + 1) return null;
  const base = closes[closes.length - 1 - lookback]!;
  if (base === 0n) return null;
  return makeRational(closes[closes.length - 1]! - base, base);
}

/**
 * Percentile within a tier (AGT-030, design 2.2): (codes with a lower return + 0.5 x ties
 * excluding self) / (tier size - 1). `others` excludes self. Empty tier -> null.
 */
export function tierPercentile(self: Rational, others: readonly Rational[]): Rational | null {
  if (others.length === 0) return null;
  let lower = 0n;
  let ties = 0n;
  for (const o of others) {
    const c = cmpRat(o, self);
    if (c < 0) lower += 1n;
    else if (c === 0) ties += 1n;
  }
  return makeRational(2n * lower + ties, 2n * BigInt(others.length));
}

/** Volume ratio = V_D / mean(V of the previous n sessions); mean 0 or short history -> null. */
export function volumeRatio(volumes: readonly bigint[], n: number): Rational | null {
  assertPeriod(n);
  if (volumes.length < n + 1) return null;
  const sum = sumLast(volumes, n, volumes.length - 1)!;
  if (sum === 0n) return null;
  return makeRational(volumes[volumes.length - 1]! * BigInt(n), sum);
}

/**
 * ADV(prev n): mean of close x volume over the previous n sessions, excluding D (AGT-030).
 * Pass RAW closes (DAT-126). The result is micro-AUD, exact.
 */
export function advPrevious(
  rawCloses: readonly bigint[],
  volumes: readonly bigint[],
  n: number,
): Rational | null {
  assertPeriod(n);
  if (rawCloses.length !== volumes.length) throw new RangeError("close/volume length mismatch");
  if (rawCloses.length < n + 1) return null;
  let sum = 0n;
  for (let i = rawCloses.length - 1 - n; i < rawCloses.length - 1; i++)
    sum += rawCloses[i]! * volumes[i]!;
  return makeRational(sum, BigInt(n));
}

/** Day-range position (C - L) / (H - L); exactly 1/2 when H = L. */
export function dayRangePosition(bar: Bar): Rational {
  const range = bar.high - bar.low;
  return range === 0n ? makeRational(1n, 2n) : makeRational(bar.close - bar.low, range);
}

// ---------------------------------------------------------------------------------------------
// Float-domain helpers
// ---------------------------------------------------------------------------------------------

/** Mean of the last n numbers; fixed left-to-right summation. null in warm-up. */
export function smaFloat(values: readonly number[], n: number): number | null {
  assertPeriod(n);
  if (values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) sum += values[i]!;
  return sum / n;
}

/** Standard deviation of the last n numbers (ddof 0 = population, as TA-Lib BBANDS). */
export function stdevFloat(values: readonly number[], n: number, ddof = 0): number | null {
  assertPeriod(n);
  if (ddof < 0 || ddof >= n) throw new RangeError("ddof out of range");
  if (values.length < n) return null;
  const mean = smaFloat(values, n)!;
  let acc = 0;
  for (let i = values.length - n; i < values.length; i++) {
    const d = values[i]! - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / (n - ddof));
}

/** Bollinger bands over the last n values: middle = SMA, +/- k x population stdev. */
export function bollinger(
  values: readonly number[],
  n: number,
  k: number,
): { readonly middle: number; readonly upper: number; readonly lower: number } | null {
  const middle = smaFloat(values, n);
  const sd = stdevFloat(values, n, 0);
  if (middle === null || sd === null) return null;
  return { middle, upper: middle + k * sd, lower: middle - k * sd };
}

/** ln(C_t / C_{t-1}) for t >= 1 (float). */
export function logReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i]! / closes[i - 1]!));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Incremental Wilder-family state (plain JSON-serialisable; stored as the indicator_daily state)
// ---------------------------------------------------------------------------------------------

export type EmaState = {
  readonly period: number;
  readonly bars: number;
  readonly sum: number;
  readonly value: number | null;
};

export function emaInit(period: number): EmaState {
  assertPeriod(period);
  return { period, bars: 0, sum: 0, value: null };
}

/** EMA step, TA-Lib style: seeded with the SMA of the first n values, k = 2 / (n + 1). */
export function emaStep(state: EmaState, x: number): EmaState {
  const bars = state.bars + 1;
  if (state.value === null) {
    const sum = state.sum + x;
    return {
      period: state.period,
      bars,
      sum,
      value: bars === state.period ? sum / state.period : null,
    };
  }
  const k = 2 / (state.period + 1);
  return { period: state.period, bars, sum: state.sum, value: (x - state.value) * k + state.value };
}

export type AtrState = {
  readonly period: number;
  readonly bars: number;
  readonly prevClose: number | null;
  readonly trCount: number;
  readonly trSum: number;
  readonly value: number | null;
};

export function atrInit(period: number): AtrState {
  assertPeriod(period);
  return { period, bars: 0, prevClose: null, trCount: 0, trSum: 0, value: null };
}

/**
 * Wilder ATR step: TR_t = max(H-L, |H-C_{t-1}|, |L-C_{t-1}|); seed = mean of the first `period`
 * TRs (first available at the (period+1)-th bar), then ATR_t = ((p-1) ATR_{t-1} + TR_t) / p.
 */
export function atrStep(state: AtrState, high: number, low: number, close: number): AtrState {
  const bars = state.bars + 1;
  if (state.prevClose === null) return { ...state, bars, prevClose: close };
  const tr = Math.max(
    high - low,
    Math.abs(high - state.prevClose),
    Math.abs(low - state.prevClose),
  );
  if (state.value === null) {
    const trCount = state.trCount + 1;
    const trSum = state.trSum + tr;
    return {
      period: state.period,
      bars,
      prevClose: close,
      trCount,
      trSum,
      value: trCount === state.period ? trSum / state.period : null,
    };
  }
  const p = state.period;
  return { ...state, bars, prevClose: close, value: (state.value * (p - 1) + tr) / p };
}

export type RsiState = {
  readonly period: number;
  readonly bars: number;
  readonly prevClose: number | null;
  readonly changes: number;
  readonly gainSum: number;
  readonly lossSum: number;
  readonly avgGain: number | null;
  readonly avgLoss: number | null;
  readonly value: number | null;
};

export function rsiInit(period: number): RsiState {
  assertPeriod(period, 2);
  return {
    period,
    bars: 0,
    prevClose: null,
    changes: 0,
    gainSum: 0,
    lossSum: 0,
    avgGain: null,
    avgLoss: null,
    value: null,
  };
}

function rsiValue(avgGain: number, avgLoss: number): number {
  // TA-Lib: 100 * G / (G + L), and 0 when both averages are 0 (flat series; parity choice).
  const total = avgGain + avgLoss;
  return total === 0 ? 0 : 100 * (avgGain / total);
}

/** Wilder RSI step: averages seeded by the simple mean of the first n changes, then Wilder. */
export function rsiStep(state: RsiState, close: number): RsiState {
  const bars = state.bars + 1;
  if (state.prevClose === null) return { ...state, bars, prevClose: close };
  const diff = close - state.prevClose;
  const gain = diff > 0 ? diff : 0;
  const loss = diff < 0 ? -diff : 0;
  const p = state.period;
  if (state.avgGain === null || state.avgLoss === null) {
    const changes = state.changes + 1;
    const gainSum = state.gainSum + gain;
    const lossSum = state.lossSum + loss;
    if (changes < p) return { ...state, bars, prevClose: close, changes, gainSum, lossSum };
    const avgGain = gainSum / p;
    const avgLoss = lossSum / p;
    return {
      ...state,
      bars,
      prevClose: close,
      changes,
      gainSum,
      lossSum,
      avgGain,
      avgLoss,
      value: rsiValue(avgGain, avgLoss),
    };
  }
  const avgGain = (state.avgGain * (p - 1) + gain) / p;
  const avgLoss = (state.avgLoss * (p - 1) + loss) / p;
  return { ...state, bars, prevClose: close, avgGain, avgLoss, value: rsiValue(avgGain, avgLoss) };
}

/** Bars needed before a Wilder value is used (design 2.2: unstable period = multiple x period). */
export function wilderWarmupBars(period: number, multiple: number): number {
  assertPeriod(period);
  assertPeriod(multiple);
  return period * multiple;
}

/** True when the state has seen enough bars for its value to be used by a rule. */
export function isWarm(
  state: { readonly bars: number; readonly period: number },
  multiple: number,
): boolean {
  return state.bars >= wilderWarmupBars(state.period, multiple);
}

// ---------------------------------------------------------------------------------------------
// Series (batch) helpers: fold of the same steps, so batch == incremental by construction
// ---------------------------------------------------------------------------------------------

export function emaSeries(values: readonly number[], period: number): (number | null)[] {
  let s = emaInit(period);
  return values.map((x) => (s = emaStep(s, x)).value);
}

export function atrSeries(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  period: number,
): (number | null)[] {
  if (high.length !== low.length || high.length !== close.length)
    throw new RangeError("length mismatch");
  let s = atrInit(period);
  return close.map((c, i) => (s = atrStep(s, high[i]!, low[i]!, c)).value);
}

export function rsiSeries(close: readonly number[], period: number): (number | null)[] {
  let s = rsiInit(period);
  return close.map((c) => (s = rsiStep(s, c)).value);
}

export function smaSeries(values: readonly number[], period: number): (number | null)[] {
  assertPeriod(period);
  return values.map((_, i) => smaFloat(values.slice(0, i + 1), period));
}

// ---------------------------------------------------------------------------------------------
// The A4 row for one (code, D)
// ---------------------------------------------------------------------------------------------

export type WilderStates = {
  readonly atr: AtrState;
  readonly rsiShort: RsiState;
  readonly rsiLong: RsiState;
};

export type IndicatorRow = {
  readonly smaShort: Rational | null;
  readonly smaLong: Rational | null;
  readonly closeAboveSmaShort: boolean | null;
  readonly closeAboveSmaLong: boolean | null;
  readonly atr: number | null;
  /** ATR in micro, converted once; null in warm-up. */
  readonly atrMicro: bigint | null;
  readonly rsiShort: number | null;
  readonly rsiLong: number | null;
  readonly returnLookback: Rational | null;
  readonly isHigh: boolean | null;
  readonly volumeRatio: Rational | null;
  readonly adv: Rational | null;
  readonly dayRangePosition: Rational;
  /** Warm-up flags: Wilder values are usable by rules only when true (design 2.2). */
  readonly atrWarm: boolean;
  readonly rsiShortWarm: boolean;
  readonly rsiLongWarm: boolean;
  /** State to store for tomorrow's incremental update. */
  readonly state: WilderStates;
};

export function initWilderStates(params: IndicatorParams): WilderStates {
  return {
    atr: atrInit(params.atrPeriod),
    rsiShort: rsiInit(params.rsiShortPeriod),
    rsiLong: rsiInit(params.rsiLongPeriod),
  };
}

function stepWilder(states: WilderStates, bar: Bar): WilderStates {
  const h = microToFloat(bar.high);
  const l = microToFloat(bar.low);
  const c = microToFloat(bar.close);
  return {
    atr: atrStep(states.atr, h, l, c),
    rsiShort: rsiStep(states.rsiShort, c),
    rsiLong: rsiStep(states.rsiLong, c),
  };
}

/**
 * Compute D's indicator row. `adjusted` is the adjusted bar history up to and including D
 * (oldest first); `rawCloses` are the raw closes aligned with it (for ADV). With `prior` (the
 * states stored for D-1) only the last bar is stepped (incremental); without it the states are
 * rebuilt from the full history. Both give identical results (tested). `prior` must have seen
 * exactly adjusted.length - 1 bars.
 */
export function computeIndicatorRow(
  adjusted: readonly Bar[],
  rawCloses: readonly bigint[],
  params: IndicatorParams,
  prior?: WilderStates,
): IndicatorRow {
  if (adjusted.length === 0) throw new RangeError("no bars");
  if (rawCloses.length !== adjusted.length) throw new RangeError("rawCloses length mismatch");
  let states: WilderStates;
  if (prior) {
    if (prior.atr.bars !== adjusted.length - 1) throw new RangeError("prior state is not for D-1");
    states = stepWilder(prior, adjusted[adjusted.length - 1]!);
  } else {
    states = initWilderStates(params);
    for (const bar of adjusted) states = stepWilder(states, bar);
  }
  const closes = adjusted.map((b) => b.close);
  const volumes = adjusted.map((b) => b.volume);
  const last = adjusted[adjusted.length - 1]!;
  const atr = states.atr.value;
  return {
    smaShort: smaExact(closes, params.smaShortPeriod),
    smaLong: smaExact(closes, params.smaLongPeriod),
    closeAboveSmaShort: aboveSma(closes, params.smaShortPeriod),
    closeAboveSmaLong: aboveSma(closes, params.smaLongPeriod),
    atr,
    atrMicro: atr === null ? null : atrToMicro(atr),
    rsiShort: states.rsiShort.value,
    rsiLong: states.rsiLong.value,
    returnLookback: lookbackReturn(closes, params.returnLookback),
    isHigh: isNSessionHigh(closes, params.highLookback),
    volumeRatio: volumeRatio(volumes, params.volumeWindow),
    adv: advPrevious(rawCloses, volumes, params.advWindow),
    dayRangePosition: dayRangePosition(last),
    atrWarm: states.atr.value !== null && isWarm(states.atr, params.warmupMultiple),
    rsiShortWarm: states.rsiShort.value !== null && isWarm(states.rsiShort, params.warmupMultiple),
    rsiLongWarm: states.rsiLong.value !== null && isWarm(states.rsiLong, params.warmupMultiple),
    state: states,
  };
}

// ---------------------------------------------------------------------------------------------
// TA-Lib reference fixture format (design decision 9). Parsing only; file reading is the caller's.
// ---------------------------------------------------------------------------------------------

export const TALIB_FIXTURE_FORMAT = "praxis-talib-ref/1";
export const TALIB_FIXTURE_TOLERANCE = 1e-6; // AGT-032

export type TaLibFn = "sma" | "ema" | "rsi" | "atr";

export type TaLibFixture = {
  readonly format: typeof TALIB_FIXTURE_FORMAT;
  readonly name: string;
  /** "hand-verified" or e.g. "ta-lib==0.4.28" (set by the one-off reference workflow). */
  readonly generator: string;
  readonly tolerance: number;
  readonly input: {
    readonly open: readonly number[];
    readonly high: readonly number[];
    readonly low: readonly number[];
    readonly close: readonly number[];
    readonly volume: readonly number[];
  };
  /** Expected series by id; null = TA-Lib lookback (NaN). Same length as the input. */
  readonly expected: Readonly<
    Record<
      string,
      { readonly fn: TaLibFn; readonly period: number; readonly values: readonly (number | null)[] }
    >
  >;
};

function isNumArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

/** Validate parsed JSON as a TA-Lib reference fixture; throws a descriptive error otherwise. */
export function parseTaLibFixture(raw: unknown): TaLibFixture {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new TypeError("fixture must be an object");
  if (o.format !== TALIB_FIXTURE_FORMAT)
    throw new TypeError(`unknown fixture format ${String(o.format)}`);
  if (typeof o.name !== "string" || typeof o.generator !== "string") {
    throw new TypeError("name/generator missing");
  }
  const tol = o.tolerance === undefined ? TALIB_FIXTURE_TOLERANCE : o.tolerance;
  if (typeof tol !== "number" || !(tol > 0)) throw new TypeError("bad tolerance");
  const input = o.input as Record<string, unknown> | undefined;
  if (!input) throw new TypeError("input missing");
  for (const k of ["open", "high", "low", "close", "volume"]) {
    if (!isNumArray(input[k])) throw new TypeError(`input.${k} must be a number array`);
  }
  const n = (input.close as number[]).length;
  for (const k of ["open", "high", "low", "volume"]) {
    if ((input[k] as number[]).length !== n)
      throw new TypeError(`input.${k} length differs from close`);
  }
  const expected = o.expected as Record<string, Record<string, unknown>> | undefined;
  if (!expected || typeof expected !== "object") throw new TypeError("expected missing");
  for (const [id, e] of Object.entries(expected)) {
    if (!["sma", "ema", "rsi", "atr"].includes(e.fn as string))
      throw new TypeError(`${id}: bad fn`);
    if (!Number.isSafeInteger(e.period)) throw new TypeError(`${id}: bad period`);
    const values = e.values;
    if (!Array.isArray(values) || values.length !== n) throw new TypeError(`${id}: values length`);
    if (!values.every((v) => v === null || (typeof v === "number" && Number.isFinite(v)))) {
      throw new TypeError(`${id}: values must be finite numbers or null`);
    }
  }
  return { ...(o as unknown as TaLibFixture), tolerance: tol };
}

/** Compute a fixture series with this module's implementation. */
export function computeFixtureSeries(
  fn: TaLibFn,
  period: number,
  input: TaLibFixture["input"],
): (number | null)[] {
  switch (fn) {
    case "sma":
      return smaSeries(input.close, period);
    case "ema":
      return emaSeries(input.close, period);
    case "rsi":
      return rsiSeries(input.close, period);
    case "atr":
      return atrSeries(input.high, input.low, input.close, period);
  }
}

/** Largest absolute difference per series id; Infinity when null/non-null positions differ. */
export function compareToFixture(fixture: TaLibFixture): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, e] of Object.entries(fixture.expected)) {
    const got = computeFixtureSeries(e.fn, e.period, fixture.input);
    let worst = 0;
    for (let i = 0; i < got.length; i++) {
      const g = got[i]!;
      const x = e.values[i]!;
      if ((g === null) !== (x === null)) worst = Infinity;
      else if (g !== null && x !== null) worst = Math.max(worst, Math.abs(g - x));
    }
    out[id] = worst;
  }
  return out;
}
