// D6 Sentiment, positioning and flows ($0 only): registry entries (M15 C1c; angles_D6.md; CTX-011,
// CTX-051). A-D6-01 reads the ASIC short reports through `view.shorts` (known as_of + the ASIC
// publication lag, knownTime.ts); A-D6-03 and A-D6-10 are gates computed from the vendor actions
// and the universe; the announcement-dependent entries (A-D6-02, -06, -07, -08) carry `needsData`
// and resolve to `candidate` (their computes serve the forward passport); options (A-D6-04), ETF
// flows (A-D6-05) and attention (A-D6-09) have no $0 source and stay `candidate`.
import { median } from "@/lib/stats/rankIc";
import { microToFloat } from "@/lib/agents/indicators";
import { volSeries } from "@/lib/agents/regime";
import type { ShortPoint } from "../pit/types";
import { ANNOUNCEMENT_ARCHIVE, eventsWithin, sessionIndexAtOrBefore } from "./d3";
import { dpsOf } from "./d4";
import { breadthAbove, lookbackReturnAt, percentileOf } from "./d5";
import type { AngleDef, AsOfView } from "./types";

const PERCENT = 100; // threshold-ok: percent scale of a grid value
const PPM_PER_PP = 10_000; // threshold-ok: short-position ppm per percentage point
const SHORT_WINDOW = 250; // threshold-ok: trailing sessions of the short-interest level percentile
export const MIN_SHORT_POINTS = 10; // threshold-ok: reports needed for a level percentile
const SPIKE_HISTORY = 60; // threshold-ok: prior sessions of 5-session counts behind the spike median
const SPIKE_BLOCK = 5; // threshold-ok: sessions per announcement-count block
const SMA200 = 200; // threshold-ok: AGT-030 long SMA
const VOL_WINDOW = 20; // threshold-ok: AGT-101 realised-volatility window
const VOL_LOOKBACK = 1260; // threshold-ok: AGT-101 volatility-percentile lookback

/** Short-position points (newest first) with as_of inside the last `window` sessions up to t. */
export function shortsWithin(
  view: AsOfView,
  code: string,
  t: number,
  window: number,
): readonly ShortPoint[] {
  const from = view.sessions[Math.max(0, t - window + 1)]!;
  return view.shorts(code, t, window).filter((p) => p.asOf >= from);
}

/**
 * Latest short position minus the newest point with as_of at or before sessions[t - lag], in ppm;
 * undefined without both points.
 */
export function shortChange(
  view: AsOfView,
  code: string,
  t: number,
  lag: number,
): number | undefined {
  if (t < lag) return undefined;
  const pts = view.shorts(code, t, SHORT_WINDOW + lag);
  const latest = pts[0];
  if (latest === undefined) return undefined;
  const ref = view.sessions[t - lag]!;
  const base = pts.find((p) => p.asOf <= ref);
  return base === undefined ? undefined : latest.ppm - base.ppm;
}

function forwardSessions(view: AsOfView, t: number, count: number): string[] {
  const d = view.sessions[t]!;
  const out: string[] = [];
  for (const row of view.calendar) {
    if (row.d <= d || row.kind === "holiday") continue;
    out.push(row.d);
    if (out.length >= count) break;
  }
  return out;
}

export const D6_ANGLES: readonly AngleDef[] = [
  {
    id: "A-D6-01",
    version: 1,
    domain: 6,
    title: "Short interest level and change (refines F6 class d)",
    definition:
      "-(p - 0.5) x 2 where p = share of the code's ASIC short-position reports (as_of inside the last 250 sessions, published by the cut-off) at or below the latest one; crowded short at p >= crowded_pct; covering when the 10-session change <= -2 pp; undefined with fewer than 10 reports.",
    kind: "score",
    cluster: "sentiment",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 250,
    inputs: ["asic_short"],
    grid: { crowded_pct: [0.9, 0.8, 0.85, 0.95] },
    historyFields: [
      "ppm = reported short shares per million shares on issue as ASIC publishes it (DAT-125a)",
      "archive depth may not cover the development split: unknown, not zero",
    ],
    existing: ["F6 class d", "DAT-125a", "src/lib/data/backfill/rules.mjs asicPublishedAt"],
    compute: (view, code, t) => {
      const pts = shortsWithin(view, code, t, SHORT_WINDOW);
      if (pts.length < MIN_SHORT_POINTS) return undefined;
      const latest = pts[0]!.ppm;
      const p = percentileOf(
        pts.map((x) => x.ppm),
        latest,
      );
      const v = -(p / PERCENT - 0.5) * 2;
      return v === 0 ? 0 : v;
    },
  },
  {
    id: "A-D6-02",
    version: 1,
    domain: 6,
    title: "Index-inclusion and index-change flows",
    definition:
      "For an announced S&P/ASX add (+) or delete (-) whose effective date is still ahead: sign x min(1, |abnormal return| / ar_scale_pct), the abnormal return from the announcement session's close to tonight = stock return minus ASX 200 return; undefined without an open window; fail closed when the list is missing.",
    kind: "score",
    cluster: "event",
    orientation: 1,
    horizonSessions: 10,
    warmupSessions: 1,
    inputs: ["index_change", "announcement", "bar_au", "index_au"],
    grid: { ar_scale_pct: [10], window: [5, 1, 2, 3, 4, 6, 7, 8, 9, 10] },
    needsData: ANNOUNCEMENT_ARCHIVE,
    historyFields: ["the DAT-234 list is manual: membership history before it is needs_data"],
    existing: ["P-06-4", "DAT-234", "D-302", "G08_event_state"],
    compute: (view, code, t, grid) => {
      if (!view.indexChangesLoaded) return undefined;
      const d = view.sessions[t]!;
      const open = view
        .indexChanges(code, t)
        .filter((c) => c.announced !== null && c.effective > d)
        .sort((a, b) => (a.announced! < b.announced! ? 1 : a.announced! > b.announced! ? -1 : 0));
      const c = open[0];
      if (c === undefined) return undefined;
      const i = sessionIndexAtOrBefore(view.sessions, t, c.announced!);
      if (i < 0 || i === t) return undefined;
      const n = t - i + 1;
      const closes = view.adj(code, t, n).adjClose;
      const bench = view.index("AXJO", t, n);
      if (closes.length < n || bench.length < n) return undefined;
      const r = microToFloat(closes[n - 1]!) / microToFloat(closes[0]!) - 1;
      const b = microToFloat(bench[n - 1]!.close) / microToFloat(bench[0]!.close) - 1;
      const sign = c.kind === "add" ? 1 : -1;
      const v = sign * Math.min(1, Math.abs(r - b) / (grid.ar_scale_pct! / PERCENT));
      return v === 0 ? 0 : v;
    },
  },
  {
    id: "A-D6-03",
    version: 1,
    domain: 6,
    title: "Dividend-capture flows around ex-dates",
    definition:
      "flag capture_candidate when a cash dividend known at the cut-off goes ex within the next entry_k sessions with yield = dividend / tonight's close >= yield_pct; a gate flag and yield bucket only (Lane B under FAM-101), never a score.",
    kind: "gate",
    cluster: "calendar",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 1,
    inputs: ["corp_action", "bar_au", "calendar"],
    grid: { yield_pct: [4, 2, 3, 5, 6], entry_k: [1, 2, 3] },
    historyFields: [
      "franking excluded; price-only series mislead, total-return closes (DAT-235) for the test",
    ],
    existing: ["K-056", "P-06-5", "FAM-101", "src/lib/arena/exDividend.ts"],
    compute: (view, code, t, grid) => {
      const last = view.bars(code, t, 1)[0];
      if (last === undefined || last.close <= 0n) return undefined;
      const ahead = new Set(forwardSessions(view, t, grid.entry_k!));
      const close = microToFloat(last.close);
      for (const a of view.corpActions(code, t)) {
        if (a.type !== "cash_dividend" || !ahead.has(a.exDate)) continue;
        const dps = dpsOf(a.payload);
        if (dps !== null && dps / close >= grid.yield_pct! / PERCENT)
          return { flag: "capture_candidate" };
      }
      return { flag: "none" };
    },
  },
  {
    id: "A-D6-04",
    version: 1,
    domain: 6,
    title: "Options-implied sentiment (put-call and implied-volatility skew)",
    definition:
      "-(percentile - 0.5) x 2 of the put-call volume ratio over pc_window sessions and the 25-delta put-call IV skew against the trailing 250 sessions; BLOCKED-DATA under FAM-102 at $0.",
    kind: "score",
    cluster: "sentiment",
    orientation: 1,
    horizonSessions: 10,
    warmupSessions: 250,
    inputs: [],
    grid: { pc_window: [10, 5, 20] },
    needsData:
      "ASX equity option quotes (open interest, volume, implied volatility); no free source",
    historyFields: ["no test at $0"],
    existing: ["K-049", "FAM-102"],
  },
  {
    id: "A-D6-05",
    version: 1,
    domain: 6,
    title: "ETF volume fund-flow proxy",
    definition:
      "10-session mean of (ETF volume / mean volume of the prior 60 sessions x sign of the ETF's 5-session return) for the broad-market and sector ETFs, as a percentile over 250 sessions mapped to [-1, 1].",
    kind: "score",
    cluster: "sentiment",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 250,
    inputs: ["bar_au"],
    grid: { flow_window: [10] },
    needsData:
      "the ASX ETF code list and Yahoo terms for ETF bars [VERIFY]; true flow data is not free",
    historyFields: ["volume is not net creation or redemption: a proxy labelled as such"],
    existing: ["K-022"],
  },
  {
    id: "A-D6-06",
    version: 1,
    domain: 6,
    title: "Announcement-tone aggregate sentiment (validated text feature)",
    definition:
      "Mean enumerated tone over the code's price-sensitive announcements of the last 20 sessions, shrunk toward 0 with prior count 3; only once the CTX-040 entry conditions hold (golden set >= 500 items); an unlabelled announcement is undefined, never neutral.",
    kind: "score",
    cluster: "sentiment",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 0,
    inputs: ["announcement"],
    grid: { prior_count: [3] },
    needsData: "announcement archive (CTX-051) and the Owner-labelled title set (CTX-040, P-10-10)",
    historyFields: ["the classifier licence is checked per model (C-05: FinBERT blocked)"],
    existing: ["CTX-040", "AGT-011a", "src/lib/llm/textLabels.ts"],
  },
  {
    id: "A-D6-07",
    version: 1,
    domain: 6,
    title: "Announcement and news volume spike",
    definition:
      "spike ratio = events with day 0 in the last 5 sessions / median of the 5-session counts over the prior 60 sessions (floor 1); a spike at ratio >= spike_ratio with a price-sensitive item; value = the polarity of the newest price-sensitive event in the window when spiking, else 0; promotion_flag zeroes positive values (CTX-044).",
    kind: "score",
    cluster: "event",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 65,
    inputs: ["announcement"],
    grid: { spike_ratio: [3, 2, 4] },
    needsData: ANNOUNCEMENT_ARCHIVE,
    historyFields: [
      "routine periodic reports are not excluded by category in the event fact: counted",
    ],
    existing: ["K-024", "CTX-044", "P-06-6"],
    compute: (view, code, t, grid) => {
      if (t + 1 < SPIKE_BLOCK + SPIKE_HISTORY) return undefined;
      const rows = eventsWithin(view, code, t, SPIKE_BLOCK + SPIKE_HISTORY);
      const blocks = new Array<number>(SPIKE_HISTORY / SPIKE_BLOCK).fill(0);
      let recent = 0;
      for (const e of rows) {
        if (e.age < SPIKE_BLOCK) recent += 1;
        else blocks[Math.floor((e.age - SPIKE_BLOCK) / SPIKE_BLOCK)]! += 1;
      }
      const base = Math.max(1, median(blocks) ?? 1);
      const ps = rows.find((e) => e.age < SPIKE_BLOCK && e.priceSensitive);
      if (recent / base < grid.spike_ratio! || ps === undefined) return 0;
      return ps.polarity;
    },
  },
  {
    id: "A-D6-08",
    version: 1,
    domain: 6,
    title: "Crowdedness composite (momentum, volume surge and short covering)",
    definition:
      "3 - crowd_count, crowd_count = conditions met of: 126-session return percentile within the tier >= ret_pct; mean of the last 5 sessions' volume ratios (volume / mean of the prior 20) >= vol_ratio; 10-session short-interest change <= -2 pp (unknown counts as not met); crowded when >= 2 with the first met.",
    kind: "score",
    cluster: "momentum",
    orientation: 1,
    horizonSessions: 10,
    warmupSessions: 127,
    inputs: ["bar_au", "asic_short", "announcement"],
    grid: { ret_pct: [0.8, 0.7, 0.9], vol_ratio: [1.5, 1.2, 2] },
    needsData: ANNOUNCEMENT_ARCHIVE,
    historyFields: [
      "components are correlated (momentum and volume): a composite, tested against C-13 continuation",
    ],
    existing: ["AGT-030", "K-011", "K-035"],
    compute: (view, code, t, grid) => {
      const mine = lookbackReturnAt(view, code, t, 126);
      if (mine === undefined) return undefined;
      const tier = view.tier(code, t);
      const peers: number[] = [];
      for (const c of view.codes(t)) {
        if (view.tier(c, t) !== tier) continue;
        const r = lookbackReturnAt(view, c, t, 126);
        if (r !== undefined) peers.push(r);
      }
      let count = 0;
      const cond1 = percentileOf(peers, mine) / PERCENT >= grid.ret_pct!;
      if (cond1) count += 1;
      const vols = view.adj(code, t, 25).adjVolume;
      if (vols.length === 25) {
        let s = 0;
        let ok = true;
        for (let i = 20; i < 25; i += 1) {
          let prior = 0n;
          for (let j = i - 20; j < i; j += 1) prior += vols[j]!;
          if (prior === 0n) {
            ok = false;
            break;
          }
          s += Number(vols[i]!) / (Number(prior) / 20); // money-float-ok: a volume ratio, not money
        }
        if (ok && s / 5 >= grid.vol_ratio!) count += 1;
      }
      const ch = shortChange(view, code, t, 10);
      if (ch !== undefined && ch <= -2 * PPM_PER_PP) count += 1;
      return 3 - count;
    },
  },
  {
    id: "A-D6-09",
    version: 1,
    domain: 6,
    title: "Investor attention proxy (search and reference-page attention)",
    definition:
      "clip(-(ratio - 1) / 2, -1, 1) with ratio = 4-week mean attention / trailing 52-week median; +1 = low attention, fixed before testing; missing coverage = unknown.",
    kind: "score",
    cluster: "sentiment",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 0,
    inputs: [],
    grid: { attention_ratio: [2, 1.5, 3] },
    needsData: "an attention series (Google Trends or Wikipedia pageviews; terms [VERIFY])",
    historyFields: ["small ASX names rarely have coverage"],
    existing: ["K-035"],
  },
  {
    id: "A-D6-10",
    version: 1,
    domain: 6,
    title: "Contrarian extremes (breadth and volatility percentiles)",
    definition:
      "flag extreme_low when breadth200 (A-D5-02) <= breadth_low and the benchmark's 20-session realised volatility sits at or above vol_pct over the trailing 1,260 sessions; applies to the F4 row of the CTX-017 table only; none otherwise. The breadth leg is a level, not a percentile (a 1,260-session breadth history is not a nightly input).",
    kind: "gate",
    cluster: "regime",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 1281,
    inputs: ["bar_au", "index_au"],
    grid: { breadth_low: [0.1, 0.05, 0.2], vol_pct: [90, 85, 95], min_universe: [300] },
    historyFields: [
      "few independent episodes on the ASX; the breadth level stands in for its percentile",
    ],
    existing: ["AGT-101", "CTX-017", "K-035", "K-038"],
    compute: (view, _code, t, grid) => {
      const closes = view.index("AXJO", t, VOL_LOOKBACK + VOL_WINDOW + 1).map((b) => b.close);
      if (closes.length < VOL_LOOKBACK + VOL_WINDOW + 1) return undefined;
      const vols = volSeries(closes, VOL_WINDOW).filter((v): v is number => v !== null);
      if (vols.length < VOL_LOOKBACK) return undefined;
      const recent = vols.slice(-VOL_LOOKBACK);
      const breadth = breadthAbove(view, t, SMA200, grid.min_universe!);
      if (breadth === undefined) return undefined;
      const volPct = percentileOf(recent, recent[recent.length - 1]!);
      return breadth <= grid.breadth_low! && volPct >= grid.vol_pct!
        ? { flag: "extreme_low" }
        : { flag: "none" };
    },
  },
];
