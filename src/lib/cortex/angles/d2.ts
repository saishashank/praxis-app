// D2 Volume, liquidity and EOD microstructure proxies: the ten angle definitions (M15 C1b;
// angles_D2.md; CTX-011, CTX-030, CTX-044, CTX-050; D-278, D-279, D-292). Volume is the split-
// adjusted series (`adjVolume`, CTX-050: volume x split ratio, so traded value is unchanged).
// A-D2-07 (announcement archive) and A-D2-08 (shares on issue, free float) are candidates with no
// compute; A-D2-09 is the existing cost model (ARN-032 / ARN-024, C3a economics) cited, not
// re-implemented. The CTX-044 promotion flag zeroes positive volume-cluster contributions in the
// score layer, never inside an angle. Per-call cost is O(window) (a median sort of 60 for A-D2-03
// and A-D2-10).
import { highest, microToFloat } from "@/lib/agents/indicators";
import { clamp, noNegZero, ratio, seriesAt, sumOf } from "./d1";
import type { AngleDef, AngleValue, AsOfView, GridPoint } from "./types";

const int = (g: GridPoint, k: string): number => Math.trunc(g[k]!);

/** Median of bigints (the lower-middle mean, floored, for an even count). */
function medianBig(values: readonly bigint[]): bigint {
  const v = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2n;
}

function medianFloat(values: readonly number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

const ADV_WINDOW = 20;
const ADV_MEDIAN_WINDOW = 60;

/** Traded value per bar in micro-dollars x shares (exact), adjusted basis. */
function tradedValues(close: readonly bigint[], volume: readonly bigint[]): bigint[] {
  return close.map((c, i) => c * volume[i]!);
}

/**
 * ADV20 (mean of the 20 traded values before `idx`, as 20 x mean to stay exact) over the 60-session
 * median ending at `idx`, as a float; undefined when the median is zero.
 */
function liquidityRatioAt(tv: readonly bigint[], idx: number): number | undefined {
  const median = medianBig(tv.slice(idx + 1 - ADV_MEDIAN_WINDOW, idx + 1));
  if (median <= 0n) return undefined;
  const sum20 = sumOf(tv, idx - ADV_WINDOW, idx);
  return ratio(sum20, median * BigInt(ADV_WINDOW));
}

// ---- A-D2-01 ---------------------------------------------------------------------------------------------------

const VOL_SHORT = 5;
const VOL_LONG = 20;

function volumeTrend(view: AsOfView, code: string, t: number): AngleValue {
  const s = seriesAt(view, code, t, VOL_LONG);
  if (!s) return undefined;
  const v = s.adjVolume;
  const n = v.length;
  const sumLong = sumOf(v, n - VOL_LONG, n);
  if (sumLong <= 0n) return undefined;
  const sumShort = sumOf(v, n - VOL_SHORT, n);
  const r = ratio(sumShort * BigInt(VOL_LONG), sumLong * BigInt(VOL_SHORT));
  return noNegZero(clamp(Math.log2(r), -1, 1));
}

// ---- A-D2-02 ---------------------------------------------------------------------------------------------------

function upDownVolume(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const l = int(g, "udv");
  const s = seriesAt(view, code, t, l + 1);
  if (!s) return undefined;
  const c = s.adjClose;
  const v = s.adjVolume;
  const n = c.length;
  let up = 0n;
  let down = 0n;
  for (let i = n - l; i < n; i += 1) {
    if (c[i]! > c[i - 1]!) up += v[i]!;
    else if (c[i]! < c[i - 1]!) down += v[i]!;
  }
  if (down <= 0n || up <= 0n) return undefined;
  return noNegZero(Math.tanh(Math.log(ratio(up, down))));
}

// ---- A-D2-03 ---------------------------------------------------------------------------------------------------

function liquidityTier(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const s = seriesAt(view, code, t, ADV_MEDIAN_WINDOW + 1);
  if (!s) return undefined;
  const tv = tradedValues(s.adjClose, s.adjVolume);
  const n = tv.length;
  const median = medianBig(tv.slice(n - ADV_MEDIAN_WINDOW, n));
  if (median <= 0n) return undefined;
  const stability = liquidityRatioAt(tv, n - 1);
  if (stability === undefined) return undefined;
  if (stability < g.stability_lo! || stability > g.stability_hi!) return { flag: "unstable" };
  return Math.log10(microToFloat(median));
}

// ---- A-D2-04 ---------------------------------------------------------------------------------------------------

function spreadProxy(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const w = int(g, "window");
  const s = seriesAt(view, code, t, w);
  if (!s) return undefined;
  const rel: number[] = [];
  for (const b of s.adj) {
    if (b.close <= 0n) return undefined;
    rel.push(ratio(b.high - b.low, b.close));
  }
  return noNegZero(1 - Math.min(medianFloat(rel), 1));
}

// ---- A-D2-05 ---------------------------------------------------------------------------------------------------

function amihud(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const w = int(g, "window");
  const s = seriesAt(view, code, t, w + 1);
  if (!s) return undefined;
  const c = s.adjClose;
  const v = s.adjVolume;
  const n = c.length;
  let acc = 0;
  let days = 0;
  for (let i = n - w; i < n; i += 1) {
    if (v[i]! <= 0n || c[i - 1]! <= 0n) continue; // zero-volume days are excluded and counted
    const r = Math.abs(ratio(c[i]!, c[i - 1]!) - 1);
    const valueDollars = microToFloat(c[i]!) * Number(v[i]!);
    acc += (r / valueDollars) * 1e6;
    days += 1;
  }
  if (days === 0) return undefined;
  const illiq = acc / days;
  return illiq > 0 ? -Math.log(illiq) : undefined;
}

// ---- A-D2-06 ---------------------------------------------------------------------------------------------------

const BREAKOUT_HIGH_WINDOW = 250;
const REFERENCE_VOLUME_WINDOW = 120;

function breakoutVolume(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const base = int(g, "base");
  const need = Math.max(BREAKOUT_HIGH_WINDOW + 1, base + REFERENCE_VOLUME_WINDOW + 1);
  const s = seriesAt(view, code, t, need);
  if (!s) return undefined;
  const c = s.adjClose;
  const v = s.adjVolume;
  const n = c.length;
  const priorHigh = highest(c.slice(n - 1 - BREAKOUT_HIGH_WINDOW, n - 1), BREAKOUT_HIGH_WINDOW);
  if (priorHigh === null) return undefined;
  if (!(c[n - 1]! > priorHigh)) return 0; // not a breakout night
  const baseSum = sumOf(v, n - 1 - base, n - 1);
  if (baseSum <= 0n) return undefined;
  const bvr = ratio(v[n - 1]! * BigInt(base), baseSum);
  return noNegZero(Math.tanh(bvr - 1));
}

// ---- A-D2-10 ---------------------------------------------------------------------------------------------------

function liquidityExit(view: AsOfView, code: string, t: number, g: GridPoint): AngleValue {
  const run = int(g, "sessions");
  const s = seriesAt(view, code, t, ADV_MEDIAN_WINDOW + run);
  if (!s) return undefined;
  const tv = tradedValues(s.adjClose, s.adjVolume);
  const n = tv.length;
  for (let k = 0; k < run; k += 1) {
    const r = liquidityRatioAt(tv, n - 1 - k);
    if (r === undefined) return undefined;
    if (!(r < g.ratio!)) return { flag: "intact" };
  }
  return { flag: "liquidity_exit" };
}

// ---- the registry entries ----------------------------------------------------------------------------------------

export const D2_ANGLES: readonly AngleDef[] = [
  {
    id: "A-D2-01",
    version: 1,
    domain: 2,
    title: "Volume ratio and volume trend",
    definition:
      "clip(log2(mean split-adjusted volume of the last 5 sessions / mean of the last 20), -1, 1); positive = expanding volume. The vr20 / vr5_20 grid thresholds are the card buckets of the same ratios.",
    kind: "score",
    cluster: "liquidity",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 20,
    inputs: ["bar_au"],
    grid: { vr20_min: [1.5, 1, 2, 3], vr5_20_min: [1, 0.8, 1.2, 1.5] },
    compute: volumeTrend,
  },
  {
    id: "A-D2-02",
    version: 1,
    domain: 2,
    title: "Up-volume vs down-volume (pocket-pivot style)",
    definition:
      "tanh(ln(sum of volume on up-close sessions / sum on down-close sessions over the last `udv` sessions)); undefined when either side is zero (unstable). The pocket-pivot flag over `pp` sessions is a card flag.",
    kind: "score",
    cluster: "liquidity",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 51,
    inputs: ["bar_au"],
    grid: { udv: [50, 20, 60], pp: [10, 5, 20] },
    compute: upDownVolume,
  },
  {
    id: "A-D2-03",
    version: 1,
    domain: 2,
    title: "Average daily value and liquidity tier",
    definition:
      "log10 of the 60-session median traded value (close x split-adjusted volume, A$); the `unstable` flag when ADV20 (previous 20 sessions) / ADV60med is below stability_lo or above stability_hi. The tier bucket is ARN-010's.",
    kind: "score",
    cluster: "liquidity",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 61,
    inputs: ["bar_au"],
    grid: { stability_lo: [0.5, 0.4, 0.6], stability_hi: [2, 1.6, 2.5] },
    compute: liquidityTier,
  },
  {
    id: "A-D2-04",
    version: 1,
    domain: 2,
    title: "Spread proxy (high-low range vs close)",
    definition:
      "1 - min(median over `window` sessions of (high - low) / close, 1), in [0, 1]; a narrow range scores high. The two-day estimator stays a hypothesis.",
    kind: "score",
    cluster: "low_volatility",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 20,
    inputs: ["bar_au"],
    grid: { window: [20] },
    compute: spreadProxy,
  },
  {
    id: "A-D2-05",
    version: 1,
    domain: 2,
    title: "Amihud illiquidity",
    definition:
      "-ln(mean over `window` sessions of |daily return| / traded value (A$) x 1e6), zero-volume sessions excluded; liquid names score high, undefined with no traded session or a zero mean.",
    kind: "score",
    cluster: "liquidity",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 21,
    inputs: ["bar_au"],
    grid: { window: [20, 40, 60] },
    compute: amihud,
  },
  {
    id: "A-D2-06",
    version: 1,
    domain: 2,
    title: "Volume at breakout vs base",
    definition:
      "On a night whose close is above the prior 250-session close high: tanh(bvr - 1) with bvr = volume / mean volume of the `base` sessions before it (confirmation sign fixed, CTX-011; the Bulkowski reading is a separate counted trial); 0 on other nights. Dry-up over 120 sessions is a card diagnostic.",
    kind: "score",
    cluster: "liquidity",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 251,
    inputs: ["bar_au"],
    grid: { base: [20, 10, 30], bvr_min: [1, 2, 3], dryup_max: [1, 0.5, 0.75] },
    compute: breakoutVolume,
  },
  {
    id: "A-D2-07",
    version: 1,
    domain: 2,
    title: "Abnormal volume without news (information leakage)",
    definition:
      "Flag when vr20 >= 3, |AR| >= 2 % and no announcement of the code was published on D-1 to D (known at the close of D); the next-5-session price-sensitive label is evaluation-only. Candidate until the announcement archive is registered (CTX-051).",
    kind: "score",
    cluster: "event",
    orientation: 1,
    horizonSessions: 5,
    warmupSessions: 20,
    inputs: ["bar_au", "announcement"],
    grid: { vr20_min: [3], ar_min_pct: [2] },
    needsData: "announcement archive",
    historyFields: ["the extract has no announcement rows: no history value until CTX-051 is met"],
  },
  {
    id: "A-D2-08",
    version: 1,
    domain: 2,
    title: "Turnover vs free float",
    definition:
      "20-session mean of volume / (shares on issue x free float share), with a stale-data flag after 120 sessions without a share-count update. Candidate: no registered source for shares on issue or free float.",
    kind: "score",
    cluster: "liquidity",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 20,
    inputs: ["bar_au"],
    grid: { window: [20] },
    needsData: "shares on issue and free float",
    historyFields: ["no share-count series in the extract; placements and buy-backs undated"],
  },
  {
    id: "A-D2-09",
    version: 1,
    domain: 2,
    title: "Price-impact estimate for a A$600 order",
    definition:
      "Gate: all-in round-trip cost of the A$600 parcel (2 x (brokerage + the ARN-032 bucket slippage of its ADV20 bucket), participation <= 1 % of ADV20) and its break-even move; infeasible when the cost is above 2 x the expected gross move. The existing cost model (C3a economics) computes it; a diagnostic on the card, the binding test is the economic gate (CTX-021).",
    kind: "gate",
    cluster: "risk",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 20,
    inputs: ["bar_au"],
    grid: { cost_gate_k: [2, 1.5, 2.5] },
    existing: [
      "ARN-032",
      "ARN-024",
      "CTX-022a",
      "src/lib/agents/costGate.ts",
      "src/lib/cortex/economics",
      "G05_cost",
    ],
  },
  {
    id: "A-D2-10",
    version: 1,
    domain: 2,
    title: "Liquidity deterioration as an exit veto",
    definition:
      "Gate: liquidity_exit when ADV20 / ADV60med is below `ratio` on each of the last `sessions` sessions (a close-signal exit at the next open and an add-on block, CTX-024); intact otherwise. The tier-floor leg is ARN-010's stored tier; ILLIQ is a logged diagnostic.",
    kind: "gate",
    cluster: "risk",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 65,
    inputs: ["bar_au"],
    grid: { ratio: [0.5, 0.4, 0.6], sessions: [5, 3, 10] },
    existing: ["ARN-010", "ARN-024", "K-054"],
    compute: liquidityExit,
  },
];
