// The learning Cortex's nightly scorecard (design C.7 "scorecard.ts", B.2 tier "Observation"; D-923…).
// Pure: no database, no clock, no randomness. For night D it scores every scored angle the Cortex
// stored on two evenings, on EVERY liquid share (never only the picks, D-930):
//   horizon 1   features of the evening before D (session D-1), return close(D-1) -> close(D);
//   horizon 20  features of session D-21, return close(D-21) -> close(D-1) (20 sessions, one-session
//               embargo, design C.6/C.8).
// Per angle and horizon: Spearman rank correlation of the stored (rank-standardised, oriented) value
// with the forward return, the top and bottom tenth's mean return minus the liquid base, and (horizon 1)
// the population stability of the angle's values against the reference of the prior 60 sessions. Shares
// that moved on company news published before the open of D are left out of every angle's horizon-1
// result (nothing in prices could know) but stay in the base. Nothing after D is read: the bars handed
// in may run later, only closes on the two window ends are used (LRN-AT-2).
// Also the mover coverage: how many of the night's biggest gainers and losers sat in the Cortex's top
// tenth the evening before (equal-cluster score over the stored features, as the fixed Cortex scores).
import { angleById } from "../angles/registry";
import { mean } from "@/lib/stats/bootstrap";
import { RANK_IC_MIN_CODES, spearman } from "@/lib/stats/rankIc";

export const PPM = 1_000_000; // threshold-ok: parts per million
export const HORIZONS = [1, 20] as const; // threshold-ok: design C.6 horizons (sessions)
export type Horizon = (typeof HORIZONS)[number];
/** Fewer scored shares than this and an angle-night has no result (same floor as the daily rank IC). */
export const MIN_CODES = RANK_IC_MIN_CODES;
/** The top / bottom tenth (design C.6 "decile"; Owner words say "top tenth"). */
export const TENTH = 10; // threshold-ok: tenths of the scored shares
/** Equal-width bins of a value in [-1, 1] for the population check, plus one bin for "no value". */
export const HIST_BINS = 10; // threshold-ok: population-stability bins over the rank range
const PSI_FLOOR = 1e-4; // threshold-ok: share floor so an empty bin does not divide by zero
/** A population shift at or above this (PSI 0.25) is a data break, not learning (C.9 learn_psi_break). */
export const PSI_BREAK_PPM = 250_000; // threshold-ok: learn_psi_break default 0.25 (design C.9)

export type MoverCause = string;

export type FeatureNightRow = {
  readonly code: string;
  /** {angle_id: value} as stored in cortex_feature_daily (number, flag/bucket object or null). */
  readonly features: Readonly<Record<string, unknown>>;
  readonly activeSetHash: string;
  readonly manifestId: string;
};

export type FeatureNight = { readonly d: string; readonly rows: readonly FeatureNightRow[] };

export type CloseBar = { readonly d: string; readonly c: number };

export type Mover = {
  readonly code: string;
  readonly side: "gainer" | "loser";
  readonly cause: MoverCause;
};

/** One angle's value counts: HIST_BINS bins over [-1, 1], then the "no value" bin. */
export type Histogram = readonly number[];

export type ScorecardInput = {
  readonly market: string;
  readonly d: string;
  /** Feature night of session D-1 (null when the Cortex stored none). */
  readonly featuresPrev: FeatureNight | null;
  /** Feature night of session D-21 (null when the Cortex stored none). */
  readonly featuresBack20: FeatureNight | null;
  /** Session D-1: the end of the 20-session window. */
  readonly end20: string;
  /** Closes of the liquid shares, any order, may run past D (ignored). */
  readonly bars: ReadonlyMap<string, readonly CloseBar[]>;
  readonly liquidCodes: readonly string[];
  /** The night's explained movers (daily learning); only `news_before_open` matters here. */
  readonly movers: readonly Mover[];
  /** Market regime of a feature evening (regime_daily); absent = "unknown". */
  readonly regimes: ReadonlyMap<string, string>;
  /** Results-season flag of a feature evening. */
  readonly resultsSeason: (featureD: string) => boolean;
  /** Reference histograms of the prior 60 sessions per angle; null = use the D-21 night. */
  readonly prior60: ReadonlyMap<string, Histogram> | null;
};

export type AngleDayRow = {
  readonly market: string;
  readonly d: string;
  readonly angleId: string;
  readonly angleVersion: number;
  readonly horizon: Horizon;
  readonly featureD: string;
  readonly n: number;
  readonly ic: number | null;
  readonly topExcessPpm: number | null;
  readonly bottomExcessPpm: number | null;
  readonly basePpm: number | null;
  readonly regime: string;
  readonly resultsSeason: 0 | 1;
  readonly psiPpm: number | null;
  readonly excludedNews: number;
  readonly activeSetHash: string;
  readonly manifestId: string;
};

export type MoverCoverage = {
  readonly gainers: number;
  /** Gainers in the top tenth the evening before, news-before-open movers not counted. */
  readonly gainersInTop: number;
  readonly losers: number;
  readonly losersInTop: number;
  /** Movers (either side) that moved on company news published before the open. */
  readonly newsBeforeOpen: number;
  readonly newsInTop: number;
  /** Shares the Cortex could score the evening before. */
  readonly scored: number;
};

export type ScorecardNight = {
  readonly rows: readonly AngleDayRow[];
  /** Histograms of the D-1 feature night per scored angle (kept in the scorecard event, the next
   *  nights' prior-60 reference). */
  readonly histograms: Readonly<Record<string, Histogram>>;
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const NEWS_BEFORE_OPEN = "news_before_open";

/** Score angles present in a feature night, registry order by id. */
export function scoredAngles(night: FeatureNight | null): string[] {
  if (night === null) return [];
  const ids = new Set<string>();
  for (const r of night.rows) for (const k of Object.keys(r.features)) ids.add(k);
  return [...ids].filter((id) => angleById(id)?.kind === "score").sort(byText);
}

const numeric = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function closeIndex(
  bars: ReadonlyMap<string, readonly CloseBar[]>,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [code, list] of bars) {
    const m = new Map<string, number>();
    for (const b of list) if (b.c > 0) m.set(b.d, b.c);
    out.set(code, m);
  }
  return out;
}

/** Forward return from the close of `from` to the close of `to`; null without both closes. */
function forward(
  closes: Map<string, Map<string, number>>,
  code: string,
  from: string,
  to: string,
): number | null {
  const m = closes.get(code);
  const a = m?.get(from);
  const b = m?.get(to);
  return a === undefined || b === undefined ? null : b / a - 1;
}

/** Value counts of one angle over the given codes (HIST_BINS bins over [-1, 1], then "no value"). */
export function histogramOf(
  night: FeatureNight,
  angleId: string,
  codes: ReadonlySet<string>,
): number[] {
  const h = new Array<number>(HIST_BINS + 1).fill(0);
  for (const r of night.rows) {
    if (!codes.has(r.code)) continue;
    const v = numeric(r.features[angleId]);
    if (v === null) h[HIST_BINS] += 1;
    else {
      const clipped = Math.min(1, Math.max(-1, v));
      h[Math.min(HIST_BINS - 1, Math.floor(((clipped + 1) / 2) * HIST_BINS))] += 1;
    }
  }
  return h;
}

/** Population stability index of `now` against `ref` (counts); null when either is empty. */
export function psi(now: Histogram, ref: Histogram): number | null {
  const tn = now.reduce((a, x) => a + x, 0);
  const tr = ref.reduce((a, x) => a + x, 0);
  if (tn === 0 || tr === 0 || now.length !== ref.length) return null;
  let s = 0;
  for (let i = 0; i < now.length; i += 1) {
    const p = Math.max(PSI_FLOOR, now[i]! / tn);
    const q = Math.max(PSI_FLOOR, ref[i]! / tr);
    s += (p - q) * Math.log(p / q);
  }
  return s;
}

const ppm = (x: number): number => {
  const v = Math.round(x * PPM);
  return v === 0 ? 0 : v; // never -0
};

type Leg = {
  readonly night: FeatureNight;
  readonly horizon: Horizon;
  readonly to: string;
};

function legRows(
  o: ScorecardInput,
  leg: Leg,
  closes: Map<string, Map<string, number>>,
  liquid: readonly string[],
  newsCodes: ReadonlySet<string>,
  reference: ReadonlyMap<string, Histogram> | null,
  histograms: Record<string, Histogram>,
): AngleDayRow[] {
  const featureD = leg.night.d;
  const rets = new Map<string, number>();
  for (const code of liquid) {
    const r = forward(closes, code, featureD, leg.to);
    if (r !== null) rets.set(code, r);
  }
  const base = rets.size === 0 ? null : mean([...rets.values()]);
  const byCode = new Map(leg.night.rows.map((r) => [r.code, r]));
  const head = [...leg.night.rows].sort((a, b) => byText(a.code, b.code))[0];
  const liquidSet = new Set(liquid);
  const out: AngleDayRow[] = [];
  for (const angleId of scoredAngles(leg.night)) {
    const pairs: { code: string; v: number; r: number }[] = [];
    let excluded = 0;
    for (const code of liquid) {
      const v = numeric(byCode.get(code)?.features[angleId]);
      const r = rets.get(code);
      if (v === null || r === undefined) continue;
      if (leg.horizon === 1 && newsCodes.has(code)) {
        excluded += 1;
        continue;
      }
      pairs.push({ code, v, r });
    }
    const n = pairs.length;
    let ic: number | null = null;
    let top: number | null = null;
    let bottom: number | null = null;
    if (n >= MIN_CODES && base !== null) {
      ic = spearman(
        pairs.map((p) => p.v),
        pairs.map((p) => p.r),
      );
      const sorted = [...pairs].sort((a, b) => b.v - a.v || byText(a.code, b.code));
      const k = Math.max(1, Math.floor(n / TENTH));
      top = ppm(mean(sorted.slice(0, k).map((p) => p.r)) - base);
      bottom = ppm(mean(sorted.slice(-k).map((p) => p.r)) - base);
    }
    let psiPpm: number | null = null;
    if (leg.horizon === 1) {
      const h = histogramOf(leg.night, angleId, liquidSet);
      histograms[angleId] = h;
      const ref = reference?.get(angleId);
      const p = ref === undefined ? null : psi(h, ref);
      psiPpm = p === null ? null : Math.max(0, Math.round(p * PPM));
    }
    out.push({
      market: o.market,
      d: o.d,
      angleId,
      angleVersion: angleById(angleId)!.version,
      horizon: leg.horizon,
      featureD,
      n,
      ic: ic === null ? null : ic === 0 ? 0 : ic,
      topExcessPpm: top,
      bottomExcessPpm: bottom,
      basePpm: base === null ? null : ppm(base),
      regime: o.regimes.get(featureD) ?? "unknown",
      resultsSeason: o.resultsSeason(featureD) ? 1 : 0,
      psiPpm,
      excludedNews: excluded,
      activeSetHash: head!.activeSetHash,
      manifestId: head!.manifestId,
    });
  }
  return out;
}

/** The night's scorecard rows (sorted by angle id, then horizon) and the D-1 histograms. */
export function scorecardNight(o: ScorecardInput): ScorecardNight {
  const closes = closeIndex(o.bars);
  const liquid = [...new Set(o.liquidCodes)].sort(byText);
  const newsCodes = new Set(
    o.movers.filter((m) => m.cause === NEWS_BEFORE_OPEN).map((m) => m.code),
  );
  const histograms: Record<string, Histogram> = {};
  // the prior-60 reference, else the D-21 night's own distribution (cold start)
  let reference: ReadonlyMap<string, Histogram> | null = o.prior60;
  if (reference === null && o.featuresBack20 !== null && o.featuresBack20.rows.length > 0) {
    const set = new Set(liquid);
    const back = o.featuresBack20;
    reference = new Map(scoredAngles(back).map((id) => [id, histogramOf(back, id, set)]));
  }
  const rows: AngleDayRow[] = [];
  const legs: Leg[] = [];
  if (o.featuresPrev !== null && o.featuresPrev.rows.length > 0 && o.featuresPrev.d < o.d)
    legs.push({ night: o.featuresPrev, horizon: 1, to: o.d });
  if (
    o.featuresBack20 !== null &&
    o.featuresBack20.rows.length > 0 &&
    o.featuresBack20.d < o.end20 &&
    o.end20 < o.d
  )
    legs.push({ night: o.featuresBack20, horizon: 20, to: o.end20 }); // threshold-ok: the 20-session horizon (C.6)
  for (const leg of legs)
    rows.push(...legRows(o, leg, closes, liquid, newsCodes, reference, histograms));
  rows.sort((a, b) => byText(a.angleId, b.angleId) || a.horizon - b.horizon);
  return { rows, histograms };
}

/**
 * The Cortex's evening score of every code it could score: the mean over the clusters present of the
 * mean contribution of the cluster's scored angles (a number as is, a flag or bucket as 0), equal
 * cluster weights as the fixed Cortex (score/score.ts). A code with any scored angle undefined is not
 * eligible and has no score.
 */
export function eveningScores(night: FeatureNight): Map<string, number> {
  const angles = scoredAngles(night).map((id) => ({ id, cluster: angleById(id)!.cluster }));
  const clusters = [...new Set(angles.map((a) => a.cluster))].sort(byText);
  const out = new Map<string, number>();
  if (angles.length === 0) return out;
  for (const r of night.rows) {
    let ok = true;
    let s = 0;
    for (const c of clusters) {
      let sum = 0;
      let n = 0;
      for (const a of angles) {
        if (a.cluster !== c) continue;
        const v = r.features[a.id];
        if (v === null || v === undefined) ok = false;
        sum += numeric(v) ?? 0;
        n += 1;
      }
      s += sum / n;
    }
    if (ok) out.set(r.code, s / clusters.length);
  }
  return out;
}

/** How many of the night's movers sat in the Cortex's top tenth the evening before. */
export function moverCoverage(
  night: FeatureNight | null,
  movers: readonly Mover[],
): MoverCoverage | null {
  if (night === null || night.rows.length === 0) return null;
  const scores = eveningScores(night);
  if (scores.size === 0) return null;
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]));
  const top = new Set(
    ranked.slice(0, Math.max(1, Math.floor(ranked.length / TENTH))).map(([c]) => c),
  );
  let gainersInTop = 0;
  let losersInTop = 0;
  let newsBeforeOpen = 0;
  let newsInTop = 0;
  for (const m of movers) {
    const inTop = top.has(m.code);
    if (m.cause === NEWS_BEFORE_OPEN) {
      newsBeforeOpen += 1;
      if (inTop) newsInTop += 1;
    } else if (inTop) {
      if (m.side === "gainer") gainersInTop += 1;
      else losersInTop += 1;
    }
  }
  return {
    gainers: movers.filter((m) => m.side === "gainer").length,
    gainersInTop,
    losers: movers.filter((m) => m.side === "loser").length,
    losersInTop,
    newsBeforeOpen,
    newsInTop,
    scored: scores.size,
  };
}
