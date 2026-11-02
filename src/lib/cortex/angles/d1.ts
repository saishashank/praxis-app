// D1 Price action and technical structure: the ten angle definitions with their computes (M15 C1b;
// angles_D1.md; CTX-011, CTX-030, CTX-050; D-278, D-279). Every compute is pure: it reads the
// adjusted series through `view.adj(code, t, count)` only (CTX-050 basis known at the cut-off),
// returns undefined during warm-up or when the code has no bar on sessions[t], and never looks past
// t. Price-domain comparisons (returns' signs, SMA gates, highs) are exact bigint; ATR / RSI and
// ratios are float64 in the fixed v1 evaluation order (indicators.ts, TA-Lib parity). Per-call cost
// is O(window): one slice of the cached adjusted series plus one pass over it.
// The helpers below are shared with d2.ts (same owner, C1b).
import {
  aboveSma,
  atrSeries,
  highest,
  logReturns,
  microToFloat,
  rsiSeries,
  stdevFloat,
  wilderWarmupBars,
} from "@/lib/agents/indicators";
import { detectPatterns } from "@/lib/agents/patterns";
import type { CodeSeries } from "../pit/types";
import type { AngleDef, AngleValue, AsOfView, GridPoint } from "./types";

// ---- shared helpers ------------------------------------------------------------------------------------------

/** Wilder warm-up multiple (M4 design 2.2: 3 x period before an ATR / RSI value is used). */
export const WILDER_WARMUP_MULTIPLE = 3;
export const ATR_PERIOD = 20;
export const SMA_LONG = 200;
/** Bars an ATR(20) needs before its value is used. */
export const ATR_WARMUP = wilderWarmupBars(ATR_PERIOD, WILDER_WARMUP_MULTIPLE);
/**
 * D-317: one ATR(20) per code per session. ATR_i is the Wilder fold over exactly the ATR_HISTORY
 * bars ending at i, for every angle and every session an angle looks back to, so tonight's ATR is
 * the same number in A-D1-03/04/06/07/08/09 and a past session's ATR is the one that session had.
 */
export const ATR_HISTORY = 250;

/**
 * The last `count` adjusted bars of `code` ending on sessions[t]; undefined when the code has fewer
 * than `count` bars by t (warm-up) or no bar on sessions[t] (missing input tonight).
 */
export function seriesAt(
  view: AsOfView,
  code: string,
  t: number,
  count: number,
): CodeSeries | undefined {
  if (count < 1 || view.barCount(code, t) < count) return undefined;
  const s = view.adj(code, t, count);
  return s.d[s.d.length - 1] === view.sessions[t] ? s : undefined;
}

/** Floats of a bigint micro series (one division each, deterministic). */
export function floats(values: readonly bigint[]): number[] {
  return values.map(microToFloat);
}

/**
 * ATR(20) of session index `i` of the series: the Wilder fold over the ATR_HISTORY bars ending at
 * i (D-317). Undefined when fewer bars precede i or the value is not positive (a dead series).
 * Cost O(ATR_HISTORY) per session asked.
 */
export function atrAt(s: CodeSeries, i: number): number | undefined {
  const from = i + 1 - ATR_HISTORY;
  if (from < 0 || i >= s.adj.length) return undefined;
  const bars = s.adj.slice(from, i + 1);
  const atr = atrSeries(
    bars.map((b) => microToFloat(b.high)),
    bars.map((b) => microToFloat(b.low)),
    bars.map((b) => microToFloat(b.close)),
    ATR_PERIOD,
  );
  const v = atr[atr.length - 1];
  return v === null || v === undefined || !(v > 0) ? undefined : v;
}

/**
 * D-325: the historical comparison series of A-D1-06 / A-D1-07. One Wilder fold over the bars from
 * ATR_WARMUP - 1 before `from` (3 x 20 seasoning) to `to` (exclusive); the value for index i is
 * read from that single series. Tonight's own point is never taken from here: it is `atrOf`
 * (D-317). Undefined when the seasoning bars do not exist. Cost O(to - from + ATR_WARMUP).
 */
export function atrComparison(
  s: CodeSeries,
  from: number,
  to: number,
): readonly (number | undefined)[] | undefined {
  const start = from - (ATR_WARMUP - 1);
  if (start < 0 || to > s.adj.length) return undefined;
  const bars = s.adj.slice(start, to);
  const atr = atrSeries(
    bars.map((b) => microToFloat(b.high)),
    bars.map((b) => microToFloat(b.low)),
    bars.map((b) => microToFloat(b.close)),
    ATR_PERIOD,
  );
  const out: (number | undefined)[] = [];
  for (let i = from; i < to; i += 1) {
    const v = atr[i - start];
    out.push(v === null || v === undefined || !(v > 0) ? undefined : v);
  }
  return out;
}

/** Tonight's ATR(20): the fold over the last ATR_HISTORY bars of the series. */
export function atrOf(s: CodeSeries): number | undefined {
  return atrAt(s, s.adj.length - 1);
}

export function sumOf(values: readonly bigint[], from: number, to: number): bigint {
  let acc = 0n;
  for (let i = from; i < to; i += 1) acc += values[i]!;
  return acc;
}

export function maxOf(values: readonly bigint[], from: number, to: number): bigint {
  let best = values[from]!;
  for (let i = from + 1; i < to; i += 1) if (values[i]! > best) best = values[i]!;
  return best;
}

export function minOf(values: readonly bigint[], from: number, to: number): bigint {
  let best = values[from]!;
  for (let i = from + 1; i < to; i += 1) if (values[i]! < best) best = values[i]!;
  return best;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Never returns -0 (same bytes either way, AT-50). */
export function noNegZero(x: number): number {
  return x === 0 ? 0 : x;
}

/** `bigint / bigint` as a float ratio. */
export function ratio(num: bigint, den: bigint): number {
  return Number(num) / Number(den);
}

/**
 * Confirmed 5-session fractal pivots of `values[from..to)`: index i is a pivot high (`kind` "high")
 * when values[i] is strictly above the two on each side, confirmed only once two later bars exist
 * within the range (so a pivot is known two sessions after it forms; angles_D1.md A-D1-09).
 */
export function fractalPivots(
  values: readonly bigint[],
  from: number,
  to: number,
  kind: "high" | "low",
): number[] {
  const out: number[] = [];
  const better = (a: bigint, b: bigint): boolean => (kind === "high" ? a > b : a < b);
  for (let i = from + 2; i + 2 < to; i += 1) {
    const v = values[i]!;
    if (
      better(v, values[i - 1]!) &&
      better(v, values[i - 2]!) &&
      better(v, values[i + 1]!) &&
      better(v, values[i + 2]!)
    )
      out.push(i);
  }
  return out;
}

const int = (g: GridPoint, k: string): number => Math.trunc(g[k]!);

// ---- A5 young-listing variant (CR-MOV-A5, D-748) ----------------------------------------------------------------

/** The grid value of an optional dimension; an absent key reads as 0 (= the variant is off). */
const intOr0 = (g: GridPoint, k: string): number => Math.trunc(g[k] ?? 0);

/**
 * The lookback a code with `bars` sessions of history can use: the grid lookback when it has that many
 * bars; with `floor` > 0 and at least `floor` bars, the bars it has; undefined (warm-up) otherwise.
 * `floor` 0 is the registered default and returns the lookback unchanged for every code that has it.
 */
export function youngLookback(lookback: number, bars: number, floor: number): number | undefined {
  if (bars >= lookback) return lookback;
  return floor > 0 && bars >= floor ? bars : undefined;
}

// ---- A-D1-01 ---------------------------------------------------------------------------------------------------

function trendMomentum(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  let lMid = int(g, "mid");
  let lLong = int(g, "long");
  let smaN = SMA_LONG;
  const skip = int(g, "skip");
  let need = Math.max(lLong, lMid + skip, smaN) + 1;
  const floor = intOr0(g, "young_floor");
  const bars = view.barCount(code, t);
  if (floor > 0 && bars >= floor && bars < need) {
    // A5: horizons and the SMA are capped at the history the code has (at least `floor` sessions)
    const cap = bars - 1 - skip;
    if (cap < 1) return undefined;
    lMid = Math.min(lMid, cap);
    lLong = Math.min(lLong, cap);
    smaN = Math.min(smaN, bars - 1);
    need = Math.max(lLong, lMid + skip, smaN) + 1;
  }
  const s = seriesAt(view, code, t, need);
  if (!s) return undefined;
  const c = s.adjClose;
  const n = c.length;
  const last = c[n - 1]!;
  const above = aboveSma(c, smaN) === true;
  const state = (up: boolean): number => (up && above ? 1 : -1);
  const sMid = state(last > c[n - 1 - lMid]!);
  const sLong = state(last > c[n - 1 - lLong]!);
  const sSkip = state(c[n - 1 - skip]! > c[n - 1 - skip - lMid]!);
  return noNegZero((sMid + sLong + sSkip) / 3);
}

// ---- A-D1-02 ---------------------------------------------------------------------------------------------------

function highProximity(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const l = youngLookback(int(g, "lookback"), view.barCount(code, t), intOr0(g, "young_floor"));
  if (l === undefined) return undefined;
  const s = seriesAt(view, code, t, l);
  if (!s) return undefined;
  const top = highest(s.adjClose, l);
  if (top === null || top <= 0n) return undefined;
  return ratio(s.adjClose[s.adjClose.length - 1]!, top);
}

// ---- A-D1-03 ---------------------------------------------------------------------------------------------------

function breakoutQuality(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const l = int(g, "lookback");
  const need = Math.max(l + 1, ATR_HISTORY);
  const s = seriesAt(view, code, t, need);
  if (!s) return undefined;
  const n = s.adjClose.length;
  const atr = atrOf(s);
  if (atr === undefined) return undefined;
  const c = s.adjClose;
  const prevClose = c[n - 2]!;
  if (prevClose <= 0n) return undefined;
  const pivot = maxOf(c, n - 1 - l, n - 1); // the prior l closes, today excluded
  if (!(c[n - 1]! > pivot)) return 0; // not a breakout night
  const ext = microToFloat(c[n - 1]! - pivot) / atr;
  const gapPct = (ratio(s.adj[n - 1]!.open, prevClose) - 1) * 100;
  if (ext > g.ext_veto! || gapPct >= g.gap_cap_pct!) return { flag: "veto" };
  return noNegZero(1 - Math.min(ext, 1));
}

// ---- A-D1-04 ---------------------------------------------------------------------------------------------------

const SMA_MID = 50;
const SMA_MID_AGO = 20;
const PULLBACK_HIGH_WINDOW = 20;
const PULLBACK_LOW_WINDOW = 10;

function pullbackResumption(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const need = Math.max(SMA_MID + SMA_MID_AGO, ATR_HISTORY);
  const s = seriesAt(view, code, t, need);
  if (!s) return undefined;
  const c = s.adjClose;
  const n = c.length;
  const atr = atrOf(s);
  if (atr === undefined) return undefined;
  const smaNow = sumOf(c, n - SMA_MID, n);
  const smaAgo = sumOf(c, n - SMA_MID_AGO - SMA_MID, n - SMA_MID_AGO);
  const trend = aboveSma(c, SMA_MID) === true && smaNow > smaAgo;
  const depth =
    microToFloat(maxOf(c, n - PULLBACK_HIGH_WINDOW, n) - minOf(c, n - PULLBACK_LOW_WINDOW, n)) /
    atr;
  const resumed = c[n - 1]! > s.adj[n - 2]!.high;
  return trend && depth >= g.depth_min! && depth <= g.depth_max! && resumed ? 1 : 0;
}

// ---- A-D1-05 ---------------------------------------------------------------------------------------------------

const SMA_SHORT = 20;
const STDEV_WINDOW = 20;
const RSI_SHORT = 2;
const RSI_LONG = 14;

function meanReversion(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const need = Math.max(
    SMA_LONG,
    STDEV_WINDOW + 1,
    wilderWarmupBars(RSI_LONG, WILDER_WARMUP_MULTIPLE),
  );
  const s = seriesAt(view, code, t, need);
  if (!s) return undefined;
  const c = s.adjClose;
  const n = c.length;
  const cf = floats(c);
  const sd = stdevFloat(logReturns(cf), STDEV_WINDOW, 1);
  if (sd === null || !(sd > 0)) return undefined;
  const rsi2 = rsiSeries(cf, RSI_SHORT)[n - 1];
  const rsi14 = rsiSeries(cf, RSI_LONG)[n - 1];
  if (rsi2 === null || rsi14 === null || rsi2 === undefined || rsi14 === undefined)
    return undefined;
  const sma20 = microToFloat(sumOf(c, n - SMA_SHORT, n)) / SMA_SHORT;
  const dist = (cf[n - 1]! / sma20 - 1) / sd;
  const oversold = rsi2 < g.rsi2_max! || rsi14 < g.rsi14_max!;
  if (!(aboveSma(c, SMA_LONG) === true && oversold)) return 0;
  return noNegZero(-dist);
}

// ---- A-D1-06 ---------------------------------------------------------------------------------------------------

function volatilityRegime(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const l = int(g, "lookback");
  const need = Math.max(l + ATR_WARMUP, ATR_HISTORY);
  const s = seriesAt(view, code, t, need);
  if (!s) return undefined;
  const n = s.adjClose.length;
  const hist = atrComparison(s, n - 1 - l, n - 1); // D-325: one fold for the prior sessions
  const tonight = atrOf(s); // D-317: the 250-bar value
  if (hist === undefined || tonight === undefined) return undefined;
  const pct = (i: number): number | undefined => {
    const a = i === n - 1 ? tonight : hist[i - (n - 1 - l)];
    const c = s.adjClose[i]!;
    return a === undefined || c <= 0n ? undefined : a / microToFloat(c);
  };
  const today = pct(n - 1);
  if (today === undefined) return undefined;
  // AGT-030 tierPercentile convention: (lower + 0.5 x ties) / count.
  let lower = 0;
  let ties = 0;
  for (let i = n - 1 - l; i < n - 1; i += 1) {
    const p = pct(i);
    if (p === undefined) return undefined;
    if (p < today) lower += 1;
    else if (p === today) ties += 1;
  }
  return noNegZero(1 - (2 * lower + ties) / l);
}

// ---- A-D1-07 ---------------------------------------------------------------------------------------------------

const CONTRACTION_SESSIONS = 10;
const MEDIAN_WINDOW = 250;

function medianFloat(values: readonly number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

function rangeContraction(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const pivotWindow = int(g, "pivot");
  const need = Math.max(
    MEDIAN_WINDOW - 1 + ATR_WARMUP,
    ATR_HISTORY,
    2 * CONTRACTION_SESSIONS,
    pivotWindow,
  );
  const s = seriesAt(view, code, t, need);
  if (!s) return undefined;
  const n = s.adjClose.length;
  const hist = atrComparison(s, n - MEDIAN_WINDOW, n - 1); // D-325: one fold for the prior sessions
  const tonight = atrOf(s); // D-317
  if (hist === undefined || tonight === undefined) return undefined;
  const pcts: number[] = [];
  for (let i = n - MEDIAN_WINDOW; i < n; i += 1) {
    const a = i === n - 1 ? tonight : hist[i - (n - MEDIAN_WINDOW)];
    const c = s.adjClose[i]!;
    if (a === undefined || c <= 0n) return undefined;
    pcts.push(a / microToFloat(c));
  }
  const median = medianFloat(pcts);
  const today = pcts[pcts.length - 1]!;
  let contracted = true;
  for (let k = 1; k <= CONTRACTION_SESSIONS; k += 1)
    if (!(pcts[pcts.length - k]! < g.contraction! * median)) contracted = false;
  const rangeOf = (from: number, to: number): bigint => {
    let hi = s.adj[from]!.high;
    let lo = s.adj[from]!.low;
    for (let i = from + 1; i < to; i += 1) {
      if (s.adj[i]!.high > hi) hi = s.adj[i]!.high;
      if (s.adj[i]!.low < lo) lo = s.adj[i]!.low;
    }
    return hi - lo;
  };
  const recent = rangeOf(n - CONTRACTION_SESSIONS, n);
  const prior = rangeOf(n - 2 * CONTRACTION_SESSIONS, n - CONTRACTION_SESSIONS);
  if (!(microToFloat(recent) < g.range_ratio! * microToFloat(prior))) contracted = false;
  if (!contracted) return 0;
  let pivot = s.adj[n - pivotWindow]!.high;
  for (let i = n - pivotWindow + 1; i < n; i += 1)
    if (s.adj[i]!.high > pivot) pivot = s.adj[i]!.high;
  const dist =
    Math.max(0, microToFloat(pivot - s.adjClose[n - 1]!)) /
    (today * microToFloat(s.adjClose[n - 1]!));
  return noNegZero(1 - Math.min(dist, 2) / 2);
}

// ---- A-D1-08 ---------------------------------------------------------------------------------------------------

const PIVOT_LOW_WINDOW = 60;
const PATTERN_CONTEXT = 15; // bars the TA-Lib candle averages read (10) plus the three-bar patterns

function candleReversal(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const need = Math.max(SMA_LONG + 1, ATR_HISTORY + 1, PIVOT_LOW_WINDOW + 1);
  const s = seriesAt(view, code, t, need);
  if (!s) return undefined;
  const n = s.adjClose.length;
  const sig = n - 2; // the signal bar is D-1; D confirms it
  const atr = atrAt(s, sig);
  if (atr === undefined) return undefined;
  const bar = s.adj[sig]!;
  const flags = detectPatterns(s.adj.slice(sig + 1 - PATTERN_CONTEXT, sig + 1));
  const pattern = Object.values(flags).some((f) => f === true);
  if (!pattern) return 0;
  const range = bar.high - bar.low;
  const body = bar.close > bar.open ? bar.close - bar.open : bar.open - bar.close;
  if (range <= 0n || microToFloat(body) < g.body_min! * microToFloat(range)) return 0;
  if (aboveSma(s.adjClose.slice(0, sig + 1), SMA_LONG) !== true) return 0;
  const lows = s.adj.map((b) => b.low);
  const tolerance = g.level! * atr;
  const atLevel = fractalPivots(lows, sig - PIVOT_LOW_WINDOW, sig + 1, "low").some(
    (i) => Math.abs(microToFloat(bar.low - lows[i]!)) <= tolerance,
  );
  if (!atLevel) return 0;
  return s.adjClose[n - 1]! > bar.high ? 1 : 0;
}

// ---- A-D1-09 ---------------------------------------------------------------------------------------------------

const RESISTANCE_WINDOW = 250;

function resistanceRoom(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const need = Math.max(RESISTANCE_WINDOW, ATR_HISTORY);
  const s = seriesAt(view, code, t, need);
  if (!s) return undefined;
  const n = s.adjClose.length;
  const atr = atrOf(s);
  if (atr === undefined) return undefined;
  const close = s.adjClose[n - 1]!;
  const highs = s.adj.map((b) => b.high);
  let nearest: bigint | null = null;
  for (const i of fractalPivots(highs, n - RESISTANCE_WINDOW, n, "high")) {
    const h = highs[i]!;
    if (h > close && (nearest === null || h < nearest)) nearest = h;
  }
  if (nearest === null) return { flag: "clear" };
  return microToFloat(nearest - close) / atr < g.near! ? { flag: "near_res" } : { flag: "clear" };
}

// ---- A-D1-10 ---------------------------------------------------------------------------------------------------

const MIN_SECTOR_MEMBERS = 5;

/** Per view and night: industry -> mean lookback return of its universe members (>= 5 with data). */
const sectorMeans = new WeakMap<AsOfView, Map<string, ReadonlyMap<string, number>>>();

function lookbackReturnAt(
  view: AsOfView,
  code: string,
  t: number,
  l: number,
  skip: number,
): number | undefined {
  const s = seriesAt(view, code, t, l + skip + 1);
  if (!s) return undefined;
  const n = s.adjClose.length;
  const base = s.adjClose[n - 1 - skip - l]!;
  return base <= 0n ? undefined : ratio(s.adjClose[n - 1 - skip]!, base) - 1;
}

function sectorMeansAt(
  view: AsOfView,
  t: number,
  l: number,
  skip: number,
): ReadonlyMap<string, number> {
  let byKey = sectorMeans.get(view);
  if (!byKey) {
    byKey = new Map();
    sectorMeans.set(view, byKey);
  }
  const key = `${t}|${l}|${skip}`;
  const cached = byKey.get(key);
  if (cached) return cached;
  const sums = new Map<string, { sum: number; n: number }>();
  for (const code of view.codes(t)) {
    const industry = view.industry(code, t);
    if (industry === null) continue;
    const r = lookbackReturnAt(view, code, t, l, skip);
    if (r === undefined) continue;
    const acc = sums.get(industry) ?? { sum: 0, n: 0 };
    acc.sum += r;
    acc.n += 1;
    sums.set(industry, acc);
  }
  const out = new Map<string, number>();
  for (const [industry, acc] of sums)
    if (acc.n >= MIN_SECTOR_MEMBERS) out.set(industry, acc.sum / acc.n);
  byKey.set(key, out);
  return out;
}

function relativeStrength(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const l = int(g, "lookback");
  const skip = int(g, "skip");
  const r = lookbackReturnAt(view, code, t, l, skip);
  if (r === undefined) return undefined;
  const industry = view.industry(code, t);
  if (industry === null) return undefined;
  const mean = sectorMeansAt(view, t, l, skip).get(industry);
  if (mean === undefined) return undefined;
  return noNegZero(r - mean);
}

// ---- the registry entries ----------------------------------------------------------------------------------------

export const D1_ANGLES: readonly AngleDef[] = [
  {
    id: "A-D1-01",
    version: 2,
    domain: 1,
    title: "Multi-horizon trend and momentum state",
    definition:
      "Mean of three horizon signs: +1 when the lookback return (mid, long, and mid with a skip) is positive and the close is above SMA(200), else -1; in {-1, -1/3, 1/3, 1}. Exact bigint comparisons on adjusted closes. With skip 0 the skipped sign duplicates the mid sign (two of three votes). Version 2 (A5, D-748): the grid point young_floor > 0 caps the horizons and the SMA at the history of a code with at least young_floor sessions (0 = off, the version 1 value).",
    kind: "score",
    cluster: "momentum",
    orientation: 1,
    horizonSessions: 60,
    warmupSessions: 253,
    inputs: ["bar_au"],
    grid: { mid: [126, 100, 140], long: [252, 200, 260], skip: [0, 21], young_floor: [0, 60] },
    compute: trendMomentum,
  },
  {
    id: "A-D1-02",
    version: 2,
    domain: 1,
    title: "52-week-high proximity",
    definition:
      "Close divided by the highest adjusted close of the last `lookback` sessions including today, in (0, 1]. Version 2 (A5, D-748): the grid point young_floor > 0 lets a code with at least young_floor sessions use the sessions it has (0 = off, the version 1 value).",
    kind: "score",
    cluster: "momentum",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 250,
    inputs: ["bar_au"],
    grid: { lookback: [250, 200, 225], young_floor: [0, 60] },
    historyFields: ["card threshold: at_high when the ratio is >= 0.98 (file range 0.95-1.00)"],
    compute: highProximity,
  },
  {
    id: "A-D1-03",
    version: 1,
    domain: 1,
    title: "Breakout quality and gap behaviour",
    definition:
      "On a breakout night (close above the prior `lookback`-session close high): quality = 1 - min(ext, 1) with ext = (close - that high) / ATR(20); 0 on other nights. The veto flag (ext > ext_veto, or an open gap over the prior close at or above gap_cap_pct, CTX-022b) is a null feature for the night: the code is ineligible (CTX-012, D-316), not neutral. Close location is logged by the card, not scored (R-06).",
    kind: "score",
    cluster: "momentum",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 251,
    inputs: ["bar_au"],
    grid: { lookback: [250], ext_veto: [1, 0.75, 1.25], gap_cap_pct: [8] },
    compute: breakoutQuality,
  },
  {
    id: "A-D1-04",
    version: 1,
    domain: 1,
    title: "Pullback-in-trend resumption",
    definition:
      "1 when close > SMA(50), SMA(50) is above its value 20 sessions ago, the pullback depth (20-session close high minus 10-session close low, in ATR(20) units) is inside [depth_min, depth_max] and the close is above the prior bar's high; else 0. Resumption is H1 only (the prior bar's high); the file's H2 and SMA(20) options are not computed.",
    kind: "score",
    cluster: "momentum",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 250,
    inputs: ["bar_au"],
    grid: { depth_min: [1, 1.5], depth_max: [3, 2, 2.5] },
    compute: pullbackResumption,
  },
  {
    id: "A-D1-05",
    version: 1,
    domain: 1,
    title: "Mean-reversion extremes (RSI(2), RSI(14), distance from SMA)",
    definition:
      "-(close / SMA(20) - 1) / stdev20 when the close is above SMA(200) and RSI(2) < rsi2_max or RSI(14) < rsi14_max (oversold inside an uptrend, the F4 gate); 0 otherwise. stdev20 is the sample (ddof 1) standard deviation of the last 20 log returns, as v1 vol20; -dist is returned only inside the gate. Positive = stretched below its short average.",
    kind: "score",
    cluster: "sentiment",
    orientation: 1,
    horizonSessions: 5,
    warmupSessions: 200,
    inputs: ["bar_au"],
    grid: { rsi2_max: [10, 5, 15], rsi14_max: [30, 35] },
    compute: meanReversion,
  },
  {
    id: "A-D1-06",
    version: 1,
    domain: 1,
    title: "Stock volatility regime (ATR percentile)",
    definition:
      "1 - 2 x percentile of ATR(20) / close against its own prior `lookback` sessions ((lower + 0.5 x ties) / lookback, the AGT-030 convention), in [-1, 1]; low volatility against its own history scores high. Tonight's point is the 250-bar ATR (D-317); the prior sessions' ATRs are read from one Wilder fold that starts 60 bars (3 x 20 seasoning) before the window (D-325). The LOW / MID / HIGH / EXTREME bucket is the card's reading of the same percentile.",
    kind: "score",
    cluster: "low_volatility",
    orientation: 1,
    warmupSessions: 312,
    horizonSessions: 20,
    inputs: ["bar_au"],
    grid: { lookback: [252, 504, 1260] },
    compute: volatilityRegime,
  },
  {
    id: "A-D1-07",
    version: 1,
    domain: 1,
    title: "Range contraction before breakout (VCP-style, proxy only)",
    definition:
      "When ATR(20) / close is below `contraction` x its 250-session median on each of the last 10 sessions and the 10-session high-low range is below `range_ratio` x the prior 10 sessions' range: 1 - min(distance, 2) / 2 with distance = (highest high of the last `pivot` sessions - close) / ATR(20); else 0. Tonight's ATR is the 250-bar fold (D-317); the 249 prior ratios read one Wilder fold that starts 60 bars before the median window (D-325).",
    kind: "score",
    cluster: "low_volatility",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 309,
    inputs: ["bar_au"],
    grid: { contraction: [0.7, 0.6, 0.8], range_ratio: [0.8, 0.6, 0.9], pivot: [20, 10, 30] },
    compute: rangeContraction,
  },
  {
    id: "A-D1-08",
    version: 1,
    domain: 1,
    title: "Candlestick reversal at a level, in trend (PASSED patterns only)",
    definition:
      "1 when the D-1 bar is a bullish AGT-031 pattern (engulfing, hammer, morning star, piercing) with body / range >= body_min, its low within `level` x ATR(20) of a confirmed 5-session pivot low of the prior 60 sessions, its close above SMA(200), and D's close is above the D-1 high (confirmation; entry at the D+1 open, M-05a); else 0.",
    kind: "score",
    cluster: "sentiment",
    orientation: 1,
    horizonSessions: 5,
    warmupSessions: 251,
    inputs: ["bar_au"],
    grid: { body_min: [0.6, 0.5, 0.7], level: [0.5, 0.25, 1] },
    historyFields: [
      "ARN-074: a pattern counts only once PASSED; the registry status, not the compute, enforces it",
    ],
    compute: candleReversal,
  },
  {
    id: "A-D1-09",
    version: 1,
    domain: 1,
    title: "Support and resistance proximity (swings and round numbers)",
    definition:
      "Gate: near_res when the nearest confirmed 5-session fractal swing high above the close within 250 sessions is closer than `near` x ATR(20); clear otherwise (no swing high above = room to run). Round-number distance is a logged card input only.",
    kind: "gate",
    cluster: "risk",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 250,
    inputs: ["bar_au"],
    grid: { near: [0.5, 0.25, 1] },
    compute: resistanceRoom,
  },
  {
    id: "A-D1-10",
    version: 1,
    domain: 1,
    title: "Relative strength vs sector and index",
    definition:
      "The code's `lookback` return (ending `skip` sessions ago) minus the mean of the same return over the universe members of its GICS industry group that night (at least 5 with data); undefined without a sector or with fewer members (CTX-025).",
    kind: "score",
    cluster: "momentum",
    orientation: 1,
    horizonSessions: 60,
    warmupSessions: 127,
    inputs: ["bar_au", "sector_map"],
    grid: { lookback: [126, 63, 252], skip: [0, 21] },
    historyFields: [
      "D-271: the offline sector map is the current list, labelled; not point-in-time",
    ],
    compute: relativeStrength,
  },
];
