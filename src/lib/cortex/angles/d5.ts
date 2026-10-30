// D5 Sector, macro and regime: registry entries (M15 C1c; angles_D5.md; CTX-011, CTX-017, CTX-025;
// D-271, D-290, D-291). Regime, rates and calendar angles are gates (never in the score); the two
// sector-momentum angles and sector sentiment are score angles. Rules kept here:
//   - macro angles read `view.macro` and declare `inputs: ["macro"]`: measured offline, never
//     `active` live until a fetcher is registered (D-291);
//   - the US-index angle reads `view.index("GSPC" | "VIX")` under the D+1 09:00 Melbourne rule
//     (D-290), so the bar dated D is never seen at D's cut-off;
//   - sector angles read `view.industry` and carry `needsData` for the point-in-time map
//     (D-271: the offline map is the current list, so they are `candidate` in replay);
//   - market-wide angles ignore `code` and read the universe through `view.codes(t)`.
import { mean } from "@/lib/stats/bootstrap";
import { microToFloat } from "@/lib/agents/indicators";
import { eventsWithin } from "./d3";
import type { AngleDef, AsOfView } from "./types";

export const SECTOR_MAP_HISTORY = "point-in-time sector map (D-271, CTX-025)";
/** RBA F1 cash rate target and the F2 10-year government bond yield (series ids [VERIFY], DAT-101). */
export const AU_CASH_RATE_SERIES = "RBA_CASH_RATE";
export const AU_10Y_SERIES = "RBA_F2_10Y";

const PERCENT = 100; // threshold-ok: percent scale of a percentile
const BP_PER_PCT = 100; // threshold-ok: basis points per percentage point
const SECTOR_HORIZONS = [21, 63, 126] as const;

/**
 * Share of universe codes whose adjusted close is above its `window`-session SMA, over the codes
 * with at least `window` bars (exact bigint compare); undefined below `minUniverse` such codes.
 */
export function breadthAbove(
  view: AsOfView,
  t: number,
  window: number,
  minUniverse: number,
): number | undefined {
  let withData = 0;
  let above = 0;
  for (const code of view.codes(t)) {
    if (view.barCount(code, t) < window) continue;
    const closes = view.adj(code, t, window).adjClose;
    let sum = 0n;
    for (const c of closes) sum += c;
    withData += 1;
    if (closes[closes.length - 1]! * BigInt(window) > sum) above += 1;
  }
  return withData < minUniverse ? undefined : above / withData;
}

/** Adjusted-close return over `lookback` sessions ending at t; undefined in warm-up or on a bad close. */
export function lookbackReturnAt(
  view: AsOfView,
  code: string,
  t: number,
  lookback: number,
): number | undefined {
  if (view.barCount(code, t) < lookback + 1) return undefined;
  const closes = view.adj(code, t, lookback + 1).adjClose;
  const first = closes[0]!;
  const last = closes[closes.length - 1]!;
  if (first <= 0n || last <= 0n) return undefined;
  return microToFloat(last) / microToFloat(first) - 1;
}

/**
 * Equal-weight return per sector over `lookback` sessions at t from the universe codes with a known
 * industry and enough bars; sectors with fewer than `minCodes` such codes are left out.
 */
export function sectorReturns(
  view: AsOfView,
  t: number,
  lookback: number,
  minCodes: number,
): ReadonlyMap<string, number> {
  const bySector = new Map<string, number[]>();
  for (const code of view.codes(t)) {
    const sector = view.industry(code, t);
    if (sector === null) continue;
    const r = lookbackReturnAt(view, code, t, lookback);
    if (r === undefined) continue;
    const list = bySector.get(sector) ?? [];
    list.push(r);
    bySector.set(sector, list);
  }
  const out = new Map<string, number>();
  for (const sector of [...bySector.keys()].sort()) {
    const rs = bySector.get(sector)!;
    if (rs.length >= minCodes) out.set(sector, mean(rs));
  }
  return out;
}

/** 1-based rank of `sector` by descending return (ties by name), over `returns`; undefined when absent. */
export function sectorRank(
  returns: ReadonlyMap<string, number>,
  sector: string,
): { readonly rank: number; readonly n: number } | undefined {
  if (!returns.has(sector)) return undefined;
  const order = [...returns.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  return { rank: order.findIndex(([s]) => s === sector) + 1, n: order.length };
}

/** Indices i < t of the last session of a calendar month inside sessions[0..t], newest first. */
export function completedMonthEnds(sessions: readonly string[], t: number): number[] {
  const out: number[] = [];
  for (let i = t - 1; i >= 0; i -= 1) {
    if (sessions[i]!.slice(0, 7) !== sessions[i + 1]!.slice(0, 7)) out.push(i);
  }
  return out;
}

/** Share (0..100) of `values` at or below `x`. */
export function percentileOf(values: readonly number[], x: number): number {
  let n = 0;
  for (const v of values) if (v <= x) n += 1;
  return (n * PERCENT) / values.length;
}

function pearson(x: readonly number[], y: readonly number[]): number | undefined {
  const n = x.length;
  if (n < 2) return undefined;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return undefined;
  return sxy / Math.sqrt(sxx * syy);
}

const MACRO_FETCH = 400; // threshold-ok: observations read to align 60 session pairs with a lag

function ratesBucket(level: number, changeBp: number, g: Readonly<Record<string, number>>): string {
  const levelVote = level < g.level_lo! ? 1 : level > g.level_hi! ? -1 : 0;
  const changeVote = changeBp <= -g.change_bp! ? 1 : changeBp >= g.change_bp! ? -1 : 0;
  const s = levelVote + changeVote;
  return s > 0 ? "supportive" : s < 0 ? "restrictive" : "neutral";
}

export const D5_ANGLES: readonly AngleDef[] = [
  {
    id: "A-D5-01",
    version: 1,
    domain: 5,
    title: "Market regime (AGT-101, unchanged for v1)",
    definition:
      "The AGT-101 state of the benchmark at the cut-off: close vs SMA200, 20-session volatility percentile over 1,260 sessions, SHOCK on a 5-session fall > shock_fall_pct or volatility percentile > shock_vol_pct, 3-session exit hysteresis; applied only through the CTX-017 table. The grid names the challengers; the compute returns the incumbent's state.",
    kind: "gate",
    cluster: "regime",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 1281,
    inputs: ["index_au"],
    grid: { shock_fall_pct: [7, 5, 6, 8, 9], shock_vol_pct: [95, 90, 92, 98] },
    historyFields: ["the O'Neil follow-through challenger needs ASX 200 index volume (needs_data)"],
    existing: ["AGT-101", "CTX-017", "src/lib/agents/regime.ts", "G07_regime"],
    compute: (view, _code, t) => {
      const r = view.regime(t);
      return r === "unknown" ? undefined : { bucket: r };
    },
  },
  {
    id: "A-D5-02",
    version: 1,
    domain: 5,
    title: "Market breadth confirmation (point-in-time universe)",
    definition:
      "breadth200 = share of universe codes with an adjusted close above their SMA200, over codes with 200 bars; a logged gate input (narrow flag when the index is at a 250-session high but breadth200 < narrow_threshold); undefined below min_universe codes with data.",
    kind: "gate",
    cluster: "regime",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 250,
    inputs: ["bar_au", "index_au"],
    grid: { min_universe: [300, 200, 400, 500], narrow_threshold: [0.4, 0.3, 0.5] },
    historyFields: ["offline universe = the point-in-time tier rows of the extract (DAT-130)"],
    existing: ["K-044", "AGT-030"],
    compute: (view, _code, t, grid) => breadthAbove(view, t, 200, grid.min_universe!),
  },
  {
    id: "A-D5-03",
    version: 1,
    domain: 5,
    title: "Sector relative strength and rotation (1 / 3 / 6 months)",
    definition:
      "Equal-weight return of the code's GICS industry group over 21, 63 and 126 sessions, each ranked across sectors with >= min_codes codes (1 = best); value = 1 - (mean rank - 1) / (sectors - 1), so the leading sector is 1 and the lagging 0; shadow tilt only (CTX-025).",
    kind: "score",
    cluster: "momentum",
    orientation: 1,
    horizonSessions: 21,
    warmupSessions: 127,
    inputs: ["sector_map", "bar_au"],
    grid: { min_codes: [5, 3, 4, 6, 8] },
    needsData: SECTOR_MAP_HISTORY,
    historyFields: ["the offline map is the current list, labelled (D-271): candidate in replay"],
    existing: ["K-018", "K-044", "CTX-025"],
    compute: (view, code, t, grid) => {
      const sector = view.industry(code, t);
      if (sector === null) return undefined;
      const ranks: number[] = [];
      let n = Number.POSITIVE_INFINITY;
      for (const h of SECTOR_HORIZONS) {
        const r = sectorRank(sectorReturns(view, t, h, grid.min_codes!), sector);
        if (r === undefined) return undefined;
        ranks.push(r.rank);
        n = Math.min(n, r.n);
      }
      if (n < 2) return undefined;
      const v = 1 - (mean(ranks) - 1) / (n - 1);
      return v <= 0 ? 0 : v;
    },
  },
  {
    id: "A-D5-04",
    version: 1,
    domain: 5,
    title: "Sector momentum persistence (consecutive months in the top third)",
    definition:
      "Count of consecutive completed month-ends (newest first, up to lookback) at which the code's sector ranked in the top third on the 126-session equal-weight return; persistent when the count reaches lookback; undefined with fewer than lookback month-ends.",
    kind: "score",
    cluster: "momentum",
    orientation: 1,
    horizonSessions: 21,
    warmupSessions: 127,
    inputs: ["sector_map", "bar_au"],
    grid: { lookback: [3, 2, 4, 5, 6], min_codes: [5] },
    needsData: SECTOR_MAP_HISTORY,
    historyFields: ["incremental over A-D5-03 is tested by partial IC (CTX-033)"],
    existing: ["K-019", "K-018", "CTX-025"],
    compute: (view, code, t, grid) => {
      const sector = view.industry(code, t);
      if (sector === null) return undefined;
      const ends = completedMonthEnds(view.sessions, t).slice(0, grid.lookback!);
      if (ends.length < grid.lookback!) return undefined;
      let count = 0;
      for (const i of ends) {
        const r = sectorRank(sectorReturns(view, i, 126, grid.min_codes!), sector);
        if (r === undefined || r.rank * 3 > r.n) break;
        count += 1;
      }
      return count;
    },
  },
  {
    id: "A-D5-05",
    version: 1,
    domain: 5,
    title: "Rates regime (cash rate direction, 10-year level and change)",
    definition:
      "Bucket {supportive, neutral, restrictive} from the AU 10-year yield: a vote +1 below level_lo / -1 above level_hi, plus +1 when the change over the last change_obs observations is <= -change_bp / -1 when >= +change_bp; every value is usable from its publication (CTX-010).",
    kind: "gate",
    cluster: "regime",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 60,
    inputs: ["macro"],
    grid: { level_lo: [4, 4.5], level_hi: [5, 5.5], change_bp: [25, 15, 40], change_obs: [60] },
    historyFields: [
      "no live fetcher (D-291): measured offline, never active",
      "RBA F2 series id and the 3-month bill series for the slope [VERIFY]; revisions not modelled",
    ],
    existing: ["K-039", "K-040", "P-07-3"],
    compute: (view, _code, t, grid) => {
      const n = grid.change_obs! + 1;
      const pts = view.macro(AU_10Y_SERIES, t, n);
      if (pts.length < n) return undefined;
      const level = pts[pts.length - 1]!.value;
      const changeBp = (level - pts[0]!.value) * BP_PER_PCT;
      return { bucket: ratesBucket(level, changeBp, grid) };
    },
  },
  {
    id: "A-D5-06",
    version: 1,
    domain: 5,
    title: "AUD/USD and commodity proxies (gold, oil, iron ore)",
    definition:
      "AUD trend (close vs SMA50 and 63-session return), commodity breadth = share of proxies above their SMA200 (80 % rule), oil_shock when oil is up >= 20 % over 21 sessions; a logged gate input, no veto until a counted trial passes.",
    kind: "gate",
    cluster: "regime",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 200,
    inputs: ["macro"],
    grid: { commodity_breadth_pct: [80], oil_shock_pct: [20] },
    needsData:
      "gold, oil and iron-ore daily series (Yahoo futures terms [VERIFY]; no free iron-ore series)",
    historyFields: ["AUD/USD from RBA F11.1 is a macro series (no live fetcher, D-291)"],
    existing: ["K-042", "K-043"],
  },
  {
    id: "A-D5-07",
    version: 1,
    domain: 5,
    title: "Scheduled central-bank and macro-release timing veto",
    definition:
      "flag {none, pre, day0}: day0 = an RBA decision, FOMC or key ABS release day, pre = the pre_window sessions before it; the CTX-013 step 8 event-date veto on entries, exits unaffected; capped at 10 % of sessions.",
    kind: "gate",
    cluster: "calendar",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 0,
    inputs: ["calendar"],
    grid: { pre_window: [1, 0, 2] },
    needsData: "RBA board, FOMC and ABS release calendars (free; terms [VERIFY])",
    historyFields: ["the trading calendar carries no release dates: a dated list is the gap"],
    existing: ["K-026", "CTX-013 step 8"],
  },
  {
    id: "A-D5-08",
    version: 1,
    domain: 5,
    title: "Global risk-on/off (S&P 500 trend and VIX percentile)",
    definition:
      "state {risk_off, neutral, risk_on} from the last US session known at the cut-off (the bar dated D-1; D's bar is known D+1 09:00 Melbourne): risk_off = GSPC close < SMA200 and VIX percentile over 1,260 sessions > vix_pct_off; risk_on = close > SMA200 and VIX percentile < vix_pct_on.",
    kind: "gate",
    cluster: "regime",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 1260,
    inputs: ["index_us"],
    grid: { vix_pct_off: [70, 60, 80], vix_pct_on: [50, 40, 60] },
    historyFields: [
      "at most `measured` until 60 live sessions exist (D-290, enforced by the P6 evaluator, D-305)",
      "the extract's index/ rows are re-dated by the D+1 09:00 rule before any read",
    ],
    existing: ["K-041", "K-044", "AGT-101"],
    compute: (view, _code, t, grid) => {
      const gspc = view.index("GSPC", t, 200);
      const vix = view.index("VIX", t, 1260);
      if (gspc.length < 200 || vix.length < 1260) return undefined;
      let sum = 0n;
      for (const b of gspc) sum += b.close;
      const last = gspc[gspc.length - 1]!.close * 200n;
      const vixValues = vix.map((b) => microToFloat(b.close));
      const pct = percentileOf(vixValues, vixValues[vixValues.length - 1]!);
      if (last < sum && pct > grid.vix_pct_off!) return { bucket: "risk_off" };
      if (last > sum && pct < grid.vix_pct_on!) return { bucket: "risk_on" };
      return { bucket: "neutral" };
    },
  },
  {
    id: "A-D5-09",
    version: 1,
    domain: 5,
    title: "Equity-bond correlation regime",
    definition:
      "Pearson correlation over the last window aligned session pairs between ASX 200 daily returns and the sign-flipped change of the AU 10-year yield (a pair needs the yield on both sessions, published by the cut-off); bucket co_moving above co_threshold, offsetting below off_threshold, else neutral.",
    kind: "gate",
    cluster: "regime",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 61,
    inputs: ["index_au", "macro"],
    grid: { window: [60], co_threshold: [0.3, 0.1, 0.2, 0.4, 0.5], off_threshold: [-0.1] },
    historyFields: ["no live fetcher for the yield (D-291); frequency of RBA F2 [VERIFY]"],
    existing: ["K-039", "K-044", "P-07-5"],
    compute: (view, _code, t, grid) => {
      const w = grid.window!;
      const yields = new Map<string, number>();
      for (const p of view.macro(AU_10Y_SERIES, t, MACRO_FETCH)) yields.set(p.obsD, p.value);
      const bars = view.index("AXJO", t, MACRO_FETCH);
      const x: number[] = [];
      const y: number[] = [];
      for (let i = bars.length - 1; i >= 1 && x.length < w; i -= 1) {
        const cur = bars[i]!;
        const prev = bars[i - 1]!;
        const yc = yields.get(cur.d);
        const yp = yields.get(prev.d);
        if (yc === undefined || yp === undefined || prev.close <= 0n) continue;
        x.push(microToFloat(cur.close) / microToFloat(prev.close) - 1);
        y.push(-(yc - yp));
      }
      if (x.length < w) return undefined;
      const rho = pearson(x, y);
      if (rho === undefined) return undefined;
      const bucket =
        rho > grid.co_threshold!
          ? "co_moving"
          : rho < grid.off_threshold!
            ? "offsetting"
            : "neutral";
      return { bucket };
    },
  },
  {
    id: "A-D5-10",
    version: 1,
    domain: 5,
    title: "Sector sentiment from announcement polarity (5- and 20-session aggregate)",
    definition:
      "sum of AGT-020 polarity over price-sensitive events of the code's sector with day 0 inside window sessions, divided by (count + k) (shrunk toward 0); rules polarity only, no LLM; shadow only (CTX-025).",
    kind: "score",
    cluster: "sentiment",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 0,
    inputs: ["announcement", "sector_map"],
    grid: { k: [3, 1, 2, 4, 5], window: [20, 5] },
    needsData: "announcement archive (CTX-051) and the point-in-time sector map (D-271)",
    historyFields: ["small counts per sector: the shrinkage parameter is a charged cell"],
    existing: ["AGT-020", "CTX-025"],
    compute: (view, code, t, grid) => {
      const sector = view.industry(code, t);
      if (sector === null) return undefined;
      let sum = 0;
      let count = 0;
      for (const c of view.codes(t)) {
        if (view.industry(c, t) !== sector) continue;
        for (const e of eventsWithin(view, c, t, grid.window!)) {
          if (!e.priceSensitive) continue;
          sum += e.polarity;
          count += 1;
        }
      }
      const v = sum / (count + grid.k!);
      return v === 0 ? 0 : v;
    },
  },
];
