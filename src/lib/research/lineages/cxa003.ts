// CXA-003 lineages on the history extract (M23 R2; D-1626 to D-1631, D-1685 to D-1688). Pure: arrays in, setups and figures
// out; the runner (`scripts/research/run-lineage.mjs`) owns every file read. The frozen plan is
// `docs/research/prereg/CXA-003.json`; the numbers below are the ones that file states in words (a test compares them).
//
// Point in time: a signal is known at the close of its signal session; the universe (tier U1) is the app's tier rule over
// the bars up to and including that session; a short-position report counts from the session after its stored
// publication date (the `asic_short` known-time rule). Prices are the vendor's split-adjusted bars.
import { assignTiers, TIER_RULES, type TierRules } from "@/lib/data/universe/tiers.mjs";
import type { ControlCandidate, ControlPool } from "../controls";
import {
  ASSUMED_HAIRCUT_RULE,
  PARCEL_BASE_MICRO,
  PARCEL_LARGE_MICRO,
  profileCostFn,
} from "../costs";
import {
  bonferroniAlpha,
  countEntries,
  eventStudy,
  oneOpenPerCode,
  type EntryCounts,
  type EventStudyResult,
  type Setup,
} from "../eventStudy";
import { entrySessionOf, type PriceBook } from "../exits";

/** The detector numbers of the frozen plan (D-1686). */
export const CXA003_PARAMS = {
  hi52: { windowSessions: 252, volumeMultiple: 2, volumeSessions: 20, volumeMinBars: 18, hold: 60 },
  lowvol: { decile: 0, hold: 21 },
  shortCover: { minSharePct: 5, minFallPp: 2, lookbackSessions: 20, hold: 20 },
  vol: { sessions: 60, minReturns: 54 },
  floors: { minSetups: 60, minBlocks: 20 },
  boundary: { developmentTo: "2021-12-31", holdoutFrom: "2022-01-01" },
} as const;

const MICRO = 1_000_000;

// ---------------------------------------------------------------------------------------------------------------------
// The world: sessions and one series per code

/** One code's bars, split-adjusted, indexed by bar; `pos` maps a session index to the bar index (-1: no bar). */
export type Series = {
  readonly code: string;
  readonly pos: Int32Array;
  /** Session index of each bar. */
  readonly session: Int32Array;
  readonly open: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly volume: Float64Array;
  /** Later split factor of each bar: raw close = adjusted close x factor. */
  readonly rawFactor: Float64Array;
};

export type World = {
  /** Session dates, ascending. */
  readonly dates: readonly string[];
  readonly series: ReadonlyMap<string, Series>;
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** Calendar date (YYYY-MM-DD) of a Unix-seconds instant in the zone `tz`. */
export function localDate(epochSec: number, tz: string): string {
  let f = fmtCache.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f.format(new Date(epochSec * 1000));
}

type YahooLike = {
  readonly tz?: string;
  readonly timestamps?: readonly number[];
  readonly open?: readonly (number | null)[];
  readonly low?: readonly (number | null)[];
  readonly close?: readonly (number | null)[];
  readonly volume?: readonly (number | null)[];
  readonly splits?: Readonly<
    Record<string, { date?: number; numerator?: number; denominator?: number }>
  >;
};

/** Session dates of an index file: the dates with a non-null close, ascending and distinct. */
export function sessionsFromIndexFile(file: YahooLike, tzOverride?: string): string[] {
  const tz = tzOverride ?? file.tz ?? "UTC";
  const out: string[] = [];
  const ts = file.timestamps ?? [];
  const close = file.close ?? [];
  for (let i = 0; i < ts.length; i += 1) {
    if (close[i] === null || close[i] === undefined) continue;
    const d = localDate(ts[i]!, tz);
    const last = out[out.length - 1];
    if (last === undefined || last < d) out.push(d);
    else if (last !== d) throw new RangeError(`index dates not increasing at ${d}`);
  }
  return out;
}

/**
 * One vendor file to a series on the session calendar. A bar off the calendar is dropped; a bar without a positive
 * close is dropped; a missing open stays NaN (the setup is then unfilled). The later split factor is kept for the raw
 * close (the tier price floor). Returns null when no bar is left.
 */
export function parseSeries(
  code: string,
  file: YahooLike,
  sessionOf: ReadonlyMap<string, number>,
  sessionCount: number,
): Series | null {
  const tz = file.tz ?? "UTC";
  const ts = file.timestamps ?? [];
  const splits: { exDate: string; ratio: number }[] = [];
  for (const s of Object.values(file.splits ?? {})) {
    if (
      typeof s?.date === "number" &&
      typeof s.numerator === "number" &&
      typeof s.denominator === "number" &&
      s.denominator > 0
    ) {
      const ratio = s.numerator / s.denominator;
      if (Number.isFinite(ratio) && ratio > 0 && ratio !== 1)
        splits.push({ exDate: localDate(s.date, tz), ratio });
    }
  }
  const idx: number[] = [];
  const sess: number[] = [];
  let lastSession = -1;
  for (let i = 0; i < ts.length; i += 1) {
    const s = sessionOf.get(localDate(ts[i]!, tz));
    if (s === undefined) continue;
    const c = file.close?.[i];
    if (typeof c !== "number" || !(c > 0)) continue;
    if (s === lastSession) {
      idx[idx.length - 1] = i; // a duplicate date: the later row wins
      continue;
    }
    if (s < lastSession) throw new RangeError(`${code}: bars not in date order`);
    lastSession = s;
    idx.push(i);
    sess.push(s);
  }
  if (idx.length === 0) return null;
  const n = idx.length;
  const pos = new Int32Array(sessionCount).fill(-1);
  const out = {
    code,
    pos,
    session: Int32Array.from(sess),
    open: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
    rawFactor: new Float64Array(n),
  };
  for (let b = 0; b < n; b += 1) {
    const i = idx[b]!;
    pos[sess[b]!] = b;
    const o = file.open?.[i];
    const l = file.low?.[i];
    const v = file.volume?.[i];
    out.open[b] = typeof o === "number" && o > 0 ? o : Number.NaN;
    out.low[b] = typeof l === "number" && l > 0 ? l : Number.NaN;
    out.close[b] = file.close![i] as number;
    out.volume[b] = typeof v === "number" && v >= 0 ? v : 0;
    const d = localDate(ts[i]!, tz);
    let f = 1;
    for (const s of splits) if (s.exDate > d) f *= s.ratio;
    out.rawFactor[b] = f;
  }
  return out;
}

/** The engine's price book over a world: opens (and lows) in micro, undefined when there is no usable bar. */
export function priceBook(world: World): PriceBook {
  const micro = (x: number): bigint | undefined =>
    Number.isFinite(x) && x > 0 ? BigInt(Math.round(x * MICRO)) : undefined;
  return {
    open(code, session) {
      const s = world.series.get(code);
      if (s === undefined || session < 0 || session >= s.pos.length) return undefined;
      const b = s.pos[session]!;
      return b < 0 ? undefined : micro(s.open[b]!);
    },
    low(code, session) {
      const s = world.series.get(code);
      if (s === undefined || session < 0 || session >= s.pos.length) return undefined;
      const b = s.pos[session]!;
      return b < 0 ? undefined : micro(s.low[b]!);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The universe at a session: tier U1 and the volatility decile

export type UniverseRow = {
  readonly code: string;
  readonly volDecile: number;
  readonly vol: number;
};

/** The U1 codes of a session with their volatility decile (0 lowest), lazily computed and cached. */
export class Universe {
  private readonly cache = new Map<number, readonly UniverseRow[]>();
  private readonly firstSession = new Map<string, number>();

  constructor(
    private readonly world: World,
    private readonly rules: TierRules = TIER_RULES,
  ) {
    for (const [code, s] of world.series) this.firstSession.set(code, s.session[0]!);
  }

  at(session: number): readonly UniverseRow[] {
    const hit = this.cache.get(session);
    if (hit !== undefined) return hit;
    const rows = this.compute(session);
    this.cache.set(session, rows);
    return rows;
  }

  private compute(session: number): readonly UniverseRow[] {
    const { world, rules } = this;
    const W = rules.windowSessions;
    const from = Math.max(0, session - W + 1);
    const inputs: {
      code: string;
      priceMicro: bigint;
      tradedMicro: bigint[];
      listedSince: string | null;
    }[] = [];
    for (const [code, s] of world.series) {
      const traded: bigint[] = [];
      let priceMicro = 0n;
      for (let t = session; t >= from; t -= 1) {
        const b = s.pos[t]!;
        if (b < 0) continue;
        if (traded.length === 0)
          priceMicro = BigInt(Math.round(s.close[b]! * s.rawFactor[b]! * MICRO));
        traded.push(BigInt(Math.round(s.close[b]! * s.volume[b]! * MICRO)));
      }
      if (traded.length < rules.u1.minSessions) continue; // cannot be U1; leaves the ranking of the others untouched
      inputs.push({
        code,
        priceMicro,
        tradedMicro: traded,
        listedSince: world.dates[this.firstSession.get(code)!] ?? null,
      });
    }
    const tiers = assignTiers(inputs, world.dates[session] ?? "", rules);
    const u1: { code: string; vol: number }[] = [];
    for (const [code, out] of tiers) {
      if (out.status !== "active" || out.tier !== "U1") continue;
      const vol = this.realisedVol(world.series.get(code)!, session);
      if (vol !== null) u1.push({ code, vol });
    }
    u1.sort((a, b) => a.vol - b.vol || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    return u1.map((r, i) => ({
      code: r.code,
      vol: r.vol,
      volDecile: Math.min(9, Math.floor((i * 10) / u1.length)),
    }));
  }

  /** Sample st. dev. of daily log returns over the last `vol.sessions` sessions; null with too few returns. */
  private realisedVol(s: Series, session: number): number | null {
    const { sessions, minReturns } = CXA003_PARAMS.vol;
    const from = Math.max(0, session - sessions + 1);
    let prev = Number.NaN;
    const rets: number[] = [];
    for (let t = from; t <= session; t += 1) {
      const b = s.pos[t]!;
      if (b < 0) {
        prev = Number.NaN;
        continue;
      }
      const c = s.close[b]!;
      if (!Number.isNaN(prev)) rets.push(Math.log(c / prev));
      prev = c;
    }
    if (rets.length < minReturns) return null;
    let sum = 0;
    for (const r of rets) sum += r;
    const mean = sum / rets.length;
    let ss = 0;
    for (const r of rets) ss += (r - mean) * (r - mean);
    return Math.sqrt(ss / (rets.length - 1));
  }

  /** Control pool of the engine: the U1 codes of the signal session (the session before the entry session). */
  pool(): ControlPool {
    return (entrySession) =>
      this.at(entrySession - 1).map((r): ControlCandidate => ({
        code: r.code,
        tier: "U1",
        volDecile: r.volDecile,
      }));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Detectors

/** Signal sessions of the 52-week-high-on-volume rule for one code (before the universe test). */
export function hi52VolSessions(s: Series, p = CXA003_PARAMS.hi52): number[] {
  const out: number[] = [];
  const first = s.session[0]!;
  const deque: number[] = []; // bar indexes with decreasing closes, inside the window
  for (let b = 0; b < s.session.length; b += 1) {
    const t = s.session[b]!;
    while (deque.length > 0 && s.close[deque[deque.length - 1]!]! < s.close[b]!) deque.pop();
    deque.push(b);
    while (s.session[deque[0]!]! <= t - p.windowSessions) deque.shift();
    // a code needs a bar on or before the session windowSessions - 1 earlier: the window is full of its own history
    if (t - first < p.windowSessions - 1) continue;
    if (s.close[deque[0]!]! > s.close[b]!) continue; // an earlier close in the window is higher (a tie still counts)
    // volume check: median of the volume sessions before t
    const vols: number[] = [];
    for (let u = t - p.volumeSessions; u < t; u += 1) {
      if (u < 0) continue;
      const k = s.pos[u]!;
      if (k >= 0) vols.push(s.volume[k]!);
    }
    if (vols.length < p.volumeMinBars) continue;
    vols.sort((x, y) => x - y);
    const mid = Math.floor(vols.length / 2);
    const median = vols.length % 2 === 1 ? vols[mid]! : (vols[mid - 1]! + vols[mid]!) / 2;
    if (s.volume[b]! >= p.volumeMultiple * median && s.volume[b]! > 0) out.push(t);
  }
  return out;
}

/** First session index of each calendar month. */
export function monthStartSessions(dates: readonly string[]): number[] {
  const out: number[] = [];
  let month = "";
  dates.forEach((d, i) => {
    const m = d.slice(0, 7);
    if (m !== month) {
      out.push(i);
      month = m;
    }
  });
  return out;
}

export type ShortReport = {
  /** The report date (YYYY-MM-DD). */
  readonly asOf: string;
  /** Short share of the shares on issue, percent. */
  readonly pct: number;
  /** The stored publication time (ISO); only its date part is read. */
  readonly published: string;
};

/** First session whose date is after `publishedDate` (the report is known at that session's close). */
function firstSessionAfter(dates: readonly string[], publishedDate: string): number {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (dates[mid]! > publishedDate) hi = mid;
    else lo = mid + 1;
  }
  return lo; // dates.length: not known inside the calendar
}

/**
 * Signal sessions of the short-cover rule for one code: the first session at which a report is known, when its share is
 * at least `minSharePct` and at least `minFallPp` below the latest report known `lookbackSessions` sessions earlier.
 */
export function shortCoverSessions(
  reports: readonly ShortReport[],
  dates: readonly string[],
  p = CXA003_PARAMS.shortCover,
): number[] {
  const byAsOf = reports.slice().sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
  // the latest report (greatest asOf) that becomes known at each session
  const latestAt = new Map<number, ShortReport>();
  for (const r of byAsOf) {
    const k = firstSessionAfter(dates, r.published.slice(0, 10));
    if (k >= dates.length) continue;
    latestAt.set(k, r); // ascending asOf: the last one wins
  }
  const knownSessions = [...latestAt.keys()].sort((a, b) => a - b);
  // the latest known report at or before a session
  const knownAtOrBefore = (session: number): ShortReport | undefined => {
    let lo = 0;
    let hi = knownSessions.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (knownSessions[mid]! <= session) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? undefined : latestAt.get(knownSessions[lo - 1]!);
  };
  const out: number[] = [];
  for (const s of knownSessions) {
    const now = latestAt.get(s)!;
    if (now.pct < p.minSharePct) continue;
    const before = knownAtOrBefore(s - p.lookbackSessions);
    if (before === undefined) continue;
    if (before.pct - now.pct >= p.minFallPp) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Setups

export type LineageKey = "hi52_vol" | "lowvol" | "short_cover";

export const LINEAGE_IDS: Readonly<Record<LineageKey, string>> = {
  hi52_vol: "cxa003_hi52_vol",
  lowvol: "cxa003_lowvol",
  short_cover: "cxa003_short_cover",
};

export const HOLDS: Readonly<Record<LineageKey, number>> = {
  hi52_vol: CXA003_PARAMS.hi52.hold,
  lowvol: CXA003_PARAMS.lowvol.hold,
  short_cover: CXA003_PARAMS.shortCover.hold,
};

/** Controls matched on tier only for the low-volatility lineage, on tier and volatility decile otherwise (D-1627). */
export const MATCH_ON: Readonly<Record<LineageKey, readonly ("tier" | "volDecile")[]>> = {
  hi52_vol: ["tier", "volDecile"],
  lowvol: ["tier"],
  short_cover: ["tier", "volDecile"],
};

/** Setups of one lineage on the world: the detector's signals that sit in U1 at their session. */
export function buildSetups(
  key: LineageKey,
  world: World,
  universe: Universe,
  shorts: ReadonlyMap<string, readonly ShortReport[]>,
): Setup[] {
  const hold = HOLDS[key];
  const out: Setup[] = [];
  const inU1 = (session: number): Map<string, UniverseRow> =>
    new Map(universe.at(session).map((r) => [r.code, r]));
  const push = (code: string, session: number, row: UniverseRow | undefined): void => {
    if (row === undefined) return;
    out.push({ code, signalSession: session, hold, tier: "U1", volDecile: row.volDecile });
  };
  if (key === "lowvol") {
    for (const s of monthStartSessions(world.dates)) {
      for (const r of universe.at(s)) {
        if (r.volDecile === CXA003_PARAMS.lowvol.decile) push(r.code, s, r);
      }
    }
    return out;
  }
  const raw: { code: string; session: number }[] = [];
  if (key === "hi52_vol") {
    for (const [code, s] of world.series)
      for (const t of hi52VolSessions(s)) raw.push({ code, session: t });
  } else {
    for (const [code, reports] of shorts) {
      if (!world.series.has(code)) continue;
      for (const t of shortCoverSessions(reports, world.dates)) raw.push({ code, session: t });
    }
  }
  const bySession = new Map<number, string[]>();
  for (const r of raw) {
    const list = bySession.get(r.session);
    if (list === undefined) bySession.set(r.session, [r.code]);
    else list.push(r.code);
  }
  for (const session of [...bySession.keys()].sort((a, b) => a - b)) {
    const members = inU1(session);
    for (const code of bySession.get(session)!.sort()) push(code, session, members.get(code));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Windows, looks and figures

export type WindowSplit = {
  readonly boundarySession: number;
  readonly development: Setup[];
  readonly holdout: Setup[];
  /** Development setups dropped because their scheduled exit is on or after the boundary. */
  readonly purged: number;
  /** Setups dropped because their scheduled exit is after the last session of the extract. */
  readonly unfinished: number;
};

/** First session index with a date on or after `holdoutFrom`; the number of sessions when there is none. */
export function boundarySessionOf(dates: readonly string[], holdoutFrom: string): number {
  const i = dates.findIndex((d) => d >= holdoutFrom);
  return i < 0 ? dates.length : i;
}

/** Split setups into the two windows with the purge and the unfinished rule (D-1685, D-1687); entries only. */
export function splitWindows(
  setups: readonly Setup[],
  boundarySession: number,
  lastSession: number,
): WindowSplit {
  const development: Setup[] = [];
  const holdout: Setup[] = [];
  let purged = 0;
  let unfinished = 0;
  for (const s of setups) {
    const exit = entrySessionOf(s.signalSession) + s.hold;
    if (exit > lastSession) {
      unfinished += 1;
      continue;
    }
    if (s.signalSession >= boundarySession) holdout.push(s);
    else if (exit >= boundarySession) purged += 1;
    else development.push(s);
  }
  return { boundarySession, development, holdout, purged, unfinished };
}

/** Counts of the holdout entries and whether the floors are met: no price is read. */
export function holdoutEntryCounts(
  split: WindowSplit,
  floors: { readonly minSetups: number; readonly minBlocks: number } = CXA003_PARAMS.floors,
): { counts: EntryCounts; floorsMet: boolean } {
  const counts = countEntries(oneOpenPerCode(split.holdout));
  const { minSetups, minBlocks } = floors;
  return { counts, floorsMet: counts.setups >= minSetups && counts.blocks >= minBlocks };
}

export type Window = "development" | "holdout" | "full";

/** One window's figures at one parcel: the engine's result without per-setup rows. */
export type WindowFigures =
  | { readonly status: "below_sample"; readonly reason: string; readonly counts: EntryCounts }
  | {
      readonly status: "looked";
      readonly verdict: "PASS" | "NULL" | "INCONCLUSIVE";
      readonly counts: EntryCounts;
      readonly unfilled: number;
      readonly unmatched: number;
      readonly meanNetPpm: number;
      readonly withHaircut: { n: number; meanPpm: number; lowerPpm: number | null; alpha: number };
      readonly withoutHaircut: {
        n: number;
        meanPpm: number;
        lowerPpm: number | null;
        alpha: number;
      };
    };

export function figuresOf(r: EventStudyResult): WindowFigures {
  if (r.status === "below_sample")
    return { status: "below_sample", reason: r.reason, counts: r.counts };
  return {
    status: "looked",
    verdict: r.verdict,
    counts: r.counts,
    unfilled: r.unfilled,
    unmatched: r.unmatched,
    meanNetPpm: r.meanNetPpm,
    withHaircut: { ...r.withHaircut },
    withoutHaircut: { ...r.withoutHaircut },
  };
}

/** Run the engine on one window of one lineage at one parcel (the variant passes the base lineage's key and a parcel). */
export function studyWindow(input: {
  readonly key: LineageKey;
  readonly setups: readonly Setup[];
  readonly prices: PriceBook;
  readonly pool: ControlPool;
  readonly k: number;
  readonly parcelMicro: bigint;
  readonly costProfile: string;
  readonly floors?: { readonly minSetups: number; readonly minBlocks: number };
  readonly replicates?: number;
}): EventStudyResult {
  return eventStudy(
    input.setups,
    { prices: input.prices, pool: input.pool },
    {
      lineage: LINEAGE_IDS[input.key],
      parcelMicro: input.parcelMicro,
      cost: profileCostFn(input.costProfile),
      floors: input.floors ?? CXA003_PARAMS.floors,
      haircut: ASSUMED_HAIRCUT_RULE,
      matchOn: MATCH_ON[input.key],
      alpha: bonferroniAlpha(input.k),
      replicates: input.replicates,
    },
  );
}

export const PARCELS = { base: PARCEL_BASE_MICRO, large: PARCEL_LARGE_MICRO } as const;
