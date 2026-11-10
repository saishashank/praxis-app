// D-921 (Owner 2026-11-10): the honest part of the daily learning loop. A fixed list of evening-before
// features is tested over the last 40 sessions on ALL liquid shares, not only on the winners: for each
// feature, the mean next-day close-to-close move of the share-days that had it against the mean move of
// every liquid share-day in the same sessions. Pure: bars in, lessons out. The features of session t use
// bars up to and including t only; the move measured is t -> the next session, and the last session
// measured is D itself, so nothing after D is ever read (no look-ahead).
import type { FeatureLesson } from "./daily";

export type LBar = {
  readonly d: string;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
};
export type LShare = {
  readonly code: string;
  readonly tier: string;
  readonly bars: readonly LBar[];
};

const PPM = 1_000_000; // threshold-ok: parts per million
export const LESSON_SESSIONS = 40; // threshold-ok: D-921 rolling window of sessions
const RISE_N = 63; // threshold-ok: SL.v1 three-month rise window, sessions
const MA_MID = 50; // threshold-ok: 50-session average
const MA_SLOW = 200; // threshold-ok: 200-session average
const HIGH_N = 252; // threshold-ok: 52-week high window, sessions
const VOL_N = 30; // threshold-ok: usual volume = 30-session average
const RSI_N = 14; // threshold-ok: RSI(14)
const SECTOR_N = 20; // threshold-ok: sector strength = average 20-session rise
const TOP_SHARE = 0.2; // threshold-ok: top fifth
const VOL_MULT = 2; // threshold-ok: volume at least 2x usual
const NEAR_HIGH = 0.02; // threshold-ok: within 2 % of the 52-week high
const OVERSOLD = 30; // threshold-ok: RSI below 30
const RSI_MAX = 100; // threshold-ok: RSI scale
const GAP_UP = 0.03; // threshold-ok: gap up more than 3 % at the open
export const SECTOR_MIN = 3; // threshold-ok: a sector needs at least 3 liquid shares
const MOVE_CAP = 0.5; // threshold-ok: one share-day move is capped at +-50 % so a bad bar cannot swamp a mean
/** A feature beats or lags the market only past this lift (0.3 % a day) and with this many share-days. */
export const LIFT_MIN_PPM = 3_000; // threshold-ok: D-921 lift of at least 0.3 % a day
export const N_MIN = 100; // threshold-ok: D-921 at least 100 share-days
const CHANGE_MIN_PPM = 1_000; // threshold-ok: a lift that moved by 0.1 % counts as stronger or weaker

export type FeatureKey =
  "lead63" | "vol2x" | "near52" | "oversold" | "annAfter" | "aboveMA" | "gapUp" | "sectorTop";

export type FeatureDef = {
  readonly key: FeatureKey;
  readonly label: string;
  /** expert-claim category (the existing knowledge base's cluster categories) */
  readonly category: string;
  /** plain statement used when a hypothesis is opened */
  readonly idea: string;
};

export const FEATURES: readonly FeatureDef[] = [
  {
    key: "lead63",
    label: "3-month leader (top fifth)",
    category: "trend_momentum",
    idea: "Shares in the top fifth by 3-month rise keep outperforming the average share the next day.",
  },
  {
    key: "vol2x",
    label: "volume at least 2x usual",
    category: "volume",
    idea: "Shares that trade at least twice their usual volume at the close outperform the average share the next day.",
  },
  {
    key: "near52",
    label: "within 2% of its 52-week high",
    category: "trend_momentum",
    idea: "Shares that close within 2% of their 52-week high outperform the average share the next day.",
  },
  {
    key: "oversold",
    label: "oversold (RSI below 30)",
    category: "mean_reversion",
    idea: "Oversold shares (RSI below 30) bounce and outperform the average share the next day.",
  },
  {
    key: "annAfter",
    label: "price-sensitive news after the close",
    category: "events_news",
    idea: "Shares with a price-sensitive announcement after the close or before the open outperform the average share that day.",
  },
  {
    key: "aboveMA",
    label: "above its 50- and 200-day averages",
    category: "trend_momentum",
    idea: "Shares closing above both their 50- and 200-day averages outperform the average share the next day.",
  },
  {
    key: "gapUp",
    label: "gapped up more than 3% at the open",
    category: "chart_patterns",
    idea: "Shares that opened more than 3% above the previous close keep outperforming the average share the next day.",
  },
  {
    key: "sectorTop",
    label: "in a top-fifth sector (last month)",
    category: "trend_momentum",
    idea: "Shares in the strongest fifth of sectors over the last month outperform the average share the next day.",
  },
];

export type Prepared = {
  readonly code: string;
  readonly tier: string;
  readonly bars: readonly LBar[];
  readonly idx: ReadonlyMap<string, number>;
  readonly cs: readonly number[]; // prefix sums of closes (cs[i] = sum of closes[0..i-1])
  readonly vs: readonly number[]; // prefix sums of volumes
  readonly rsi: readonly (number | null)[];
};

/** What a share looked like at the close of one session (null = not enough history). */
export type Raw = {
  readonly c: number;
  readonly rise63: number | null;
  readonly ma50: number | null;
  readonly ma200: number | null;
  readonly rsi: number | null;
  readonly high52: number | null;
  readonly volRatio: number | null;
  readonly gap: number | null;
  readonly ret20: number | null;
};

export function prepare(s: LShare): Prepared {
  const cs = [0];
  const vs = [0];
  for (const b of s.bars) {
    cs.push(cs[cs.length - 1]! + b.c);
    vs.push(vs[vs.length - 1]! + b.v);
  }
  const rsi: (number | null)[] = s.bars.map(() => null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < s.bars.length; i += 1) {
    const ch = s.bars[i]!.c - s.bars[i - 1]!.c;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    if (i <= RSI_N) {
      gain += g;
      loss += l;
      if (i === RSI_N) {
        gain /= RSI_N;
        loss /= RSI_N;
      }
    } else {
      gain = (gain * (RSI_N - 1) + g) / RSI_N;
      loss = (loss * (RSI_N - 1) + l) / RSI_N;
    }
    if (i >= RSI_N) rsi[i] = loss === 0 ? RSI_MAX : RSI_MAX - RSI_MAX / (1 + gain / loss);
  }
  return {
    code: s.code,
    tier: s.tier,
    bars: s.bars,
    idx: new Map(s.bars.map((b, i) => [b.d, i])),
    cs,
    vs,
    rsi,
  };
}

/** The raw readings at bar index i, from bars 0..i only. */
export function rawAt(p: Prepared, i: number): Raw {
  const b = p.bars;
  const c = b[i]!.c;
  const avg = (n: number): number | null =>
    i >= n - 1 ? (p.cs[i + 1]! - p.cs[i + 1 - n]!) / n : null;
  let high52: number | null = null;
  if (i >= HIGH_N - 1) {
    high52 = c;
    for (let k = i - HIGH_N + 1; k <= i; k += 1) if (b[k]!.c > high52) high52 = b[k]!.c;
  }
  let volRatio: number | null = null;
  if (i >= VOL_N) {
    const usual = (p.vs[i]! - p.vs[i - VOL_N]!) / VOL_N;
    if (usual > 0) volRatio = b[i]!.v / usual;
  }
  const back = (n: number): number | null =>
    i >= n && b[i - n]!.c > 0 ? c / b[i - n]!.c - 1 : null;
  return {
    c,
    rise63: back(RISE_N),
    ma50: avg(MA_MID),
    ma200: avg(MA_SLOW),
    rsi: p.rsi[i] ?? null,
    high52,
    volRatio,
    gap: i >= 1 && b[i - 1]!.c > 0 ? b[i]!.o / b[i - 1]!.c - 1 : null,
    ret20: back(SECTOR_N),
  };
}

/** What the whole liquid universe looked like at the close of one session. */
export type Cross = { readonly riseCut: number | null; readonly topSectors: ReadonlySet<string> };

/** Top-fifth cut of the 3-month rise, and the top-fifth sectors by average 20-session rise (pure). */
export function crossSection(
  all: readonly Prepared[],
  sectorOf: ReadonlyMap<string, string>,
  t: string,
): Cross {
  const rises: number[] = [];
  const bySector = new Map<string, number[]>();
  for (const p of all) {
    const i = p.idx.get(t);
    if (i === undefined) continue;
    const r = rawAt(p, i);
    if (r.rise63 !== null) rises.push(r.rise63);
    const sec = sectorOf.get(p.code);
    if (sec !== undefined && r.ret20 !== null)
      bySector.set(sec, [...(bySector.get(sec) ?? []), r.ret20]);
  }
  rises.sort((a, b) => b - a);
  const riseCut =
    rises.length === 0 ? null : rises[Math.max(0, Math.ceil(rises.length * TOP_SHARE) - 1)]!;
  const avgs = [...bySector.entries()]
    .filter(([, xs]) => xs.length >= SECTOR_MIN)
    .map(([k, xs]) => ({ k, m: xs.reduce((a, b) => a + b, 0) / xs.length }))
    .sort((a, b) => b.m - a.m || (a.k < b.k ? -1 : 1));
  const top = new Set<string>();
  if (avgs.length > 0) {
    const cut = avgs[Math.max(0, Math.ceil(avgs.length * TOP_SHARE) - 1)]!.m;
    for (const a of avgs) if (a.m >= cut) top.add(a.k);
  }
  return { riseCut, topSectors: top };
}

export type Flags = Readonly<Record<FeatureKey, boolean>>;

/** The feature flags of one share at one close. */
export function flagsOf(
  r: Raw,
  x: { cross: Cross; sector: string | undefined; newsAfter: boolean },
): Flags {
  return {
    lead63: r.rise63 !== null && x.cross.riseCut !== null && r.rise63 >= x.cross.riseCut,
    vol2x: r.volRatio !== null && r.volRatio >= VOL_MULT,
    near52: r.high52 !== null && r.c >= r.high52 * (1 - NEAR_HIGH),
    oversold: r.rsi !== null && r.rsi < OVERSOLD,
    annAfter: x.newsAfter,
    aboveMA: r.ma50 !== null && r.ma200 !== null && r.c > r.ma50 && r.c > r.ma200,
    gapUp: r.gap !== null && r.gap > GAP_UP,
    sectorTop: x.sector !== undefined && x.cross.topSectors.has(x.sector),
  };
}

const x1 = (n: number): string => String(Number(n.toFixed(1))); // threshold-ok: one decimal

/** Plain words for the features true at the close (the "setup before" of a mover). */
export function setupWords(f: Flags, r: Raw): string[] {
  const out: string[] = [];
  if (f.lead63) out.push("3-month leader (top fifth)");
  if (f.vol2x && r.volRatio !== null) out.push(`volume ${x1(r.volRatio)}x usual`);
  if (f.near52) out.push("within 2% of its 52-week high");
  if (f.oversold) out.push("oversold (RSI below 30)");
  if (f.annAfter) out.push("price-sensitive news after the close");
  if (f.aboveMA) out.push("above its 50- and 200-day averages");
  if (f.gapUp) out.push("gapped up more than 3% at the open");
  if (f.sectorTop) out.push("in a top-fifth sector over the last month");
  return out;
}

export function verdictOf(liftPpm: number, n: number): FeatureLesson["verdict"] {
  if (n >= N_MIN && liftPpm > LIFT_MIN_PPM) return "beats the market";
  if (n >= N_MIN && liftPpm < -LIFT_MIN_PPM) return "lags the market";
  return "no clear edge yet";
}

/** The sessions of the window: the last LESSON_SESSIONS + 1 dates (<= d) with bars among the shares. */
export function windowDates(all: readonly Prepared[], d: string): string[] {
  const set = new Set<string>();
  for (const p of all) for (const b of p.bars) if (b.d <= d) set.add(b.d);
  return [...set].sort().slice(-(LESSON_SESSIONS + 1));
}

type Obs = { j: number; move: number; flags: Flags };

/**
 * The feature lessons of the last 40 sessions up to d over ALL the given (liquid) shares. `newsAfter`
 * maps a code to the sessions after whose close a price-sensitive announcement arrived. `change` is
 * left "new"; the caller compares it with yesterday's stored lesson.
 */
export function computeLessons(
  all: readonly Prepared[],
  sectorOf: ReadonlyMap<string, string>,
  newsAfter: ReadonlyMap<string, ReadonlySet<string>>,
  d: string,
): FeatureLesson[] {
  const dates = windowDates(all, d);
  const obs: Obs[] = [];
  for (let j = 0; j + 1 < dates.length; j += 1) {
    const t = dates[j]!;
    const next = dates[j + 1]!;
    const cross = crossSection(all, sectorOf, t);
    for (const p of all) {
      const i = p.idx.get(t);
      const i2 = p.idx.get(next);
      if (i === undefined || i2 === undefined) continue;
      const c0 = p.bars[i]!.c;
      if (!(c0 > 0)) continue;
      const raw = p.bars[i2]!.c / c0 - 1;
      const move = Math.max(-MOVE_CAP, Math.min(MOVE_CAP, raw));
      obs.push({
        j,
        move,
        flags: flagsOf(rawAt(p, i), {
          cross,
          sector: sectorOf.get(p.code),
          newsAfter: newsAfter.get(p.code)?.has(t) ?? false,
        }),
      });
    }
  }
  const sessions = Math.max(0, dates.length - 1);
  const daySum = new Map<number, { s: number; n: number }>();
  let total = 0;
  for (const o of obs) {
    const a = daySum.get(o.j) ?? { s: 0, n: 0 };
    a.s += o.move;
    a.n += 1;
    daySum.set(o.j, a);
    total += o.move;
  }
  const base = obs.length === 0 ? 0 : total / obs.length;
  return FEATURES.map((f) => {
    const mine = obs.filter((o) => o.flags[f.key]);
    const n = mine.length;
    const mean = n === 0 ? base : mine.reduce((a, o) => a + o.move, 0) / n;
    const hits = mine.filter((o) => {
      const a = daySum.get(o.j)!;
      return o.move > a.s / a.n;
    }).length;
    const nextDayAvgPpm = Math.round(mean * PPM);
    const baseAvgPpm = Math.round(base * PPM);
    const liftPpm = nextDayAvgPpm - baseAvgPpm;
    return {
      feature: f.label,
      sessions,
      n,
      nextDayAvgPpm,
      baseAvgPpm,
      liftPpm,
      hitRatePpm: n === 0 ? 0 : Math.round((hits * PPM) / n),
      verdict: verdictOf(liftPpm, n),
      change: "new" as const,
    };
  });
}

/** Compare tonight's lessons with the previous stored night's (a lift that moved 0.1 % or more). */
export function withChange(
  lessons: readonly FeatureLesson[],
  previous: readonly FeatureLesson[] | null,
): FeatureLesson[] {
  return lessons.map((l) => {
    const p = previous?.find((x) => x.feature === l.feature);
    if (p === undefined) return { ...l, change: "new" as const };
    // for a feature that lags the market a more negative lift is the stronger finding
    const delta = (l.liftPpm - p.liftPpm) * (l.verdict === "lags the market" ? -1 : 1);
    const change =
      delta >= CHANGE_MIN_PPM ? "stronger" : delta <= -CHANGE_MIN_PPM ? "weaker" : "unchanged";
    return { ...l, change };
  });
}
