// D-1078 (Owner, 2026-11-17): the learning Cortex's WARM START. The learner's weekly re-weighting needs
// `learn_min_nights` scored nights in `cortex_angle_day`, and the nightly scorecard only began in
// November, so the learner could not move a weight for about two months. This fills the scorecard for
// the past sessions exactly as the live nightly stage (./stage.ts) would have written them on those
// nights, so the next weekly run has the evidence and fits a real weight generation.
//
// Point in time, per night D: only the bars up to D, the announcements published before D's close, the
// regime of the two feature evenings, and the feature nights of session D-1 (horizon 1) and D-21
// (horizon 20): the STORED `cortex_feature_daily` rows when they exist (that is what live used), else
// the `source` (the pick scorecard's Cortex line, ../../replay/cortexReplay.ts: the fixed Cortex as of
// that evening, with the angle set in force then; D-1066/D-1070: before the first frozen passport the
// earliest frozen set, never today's). The pure `scorecardNight` does the scoring; nothing in it is
// reimplemented here. A night needs both feature nights, else it is skipped (never half a night, the
// table is append-only). Rows carry the manifest id prefix `warmstart:` so they stay identifiable.
// Writes ONLY `cortex_angle_day` (insert-or-ignore: live rows win, a re-run writes nothing new) and one
// `cortex_learn_event` (kind 'scorecard', seq 99, no histogram: it is never a prior-60 reference). No
// map, passport, weight, leader, decision or comparison is written; the switch rule is not touched.
// Reads (Turso free plan): the universe of each night once, closes of sessions D and D-1 (each read once),
// the liquid shares' bars once for the whole window, <= 40 movers' announcements a night, the stored
// feature nights one at a time (cached, <= 25 nights in memory). No OFFSET; IN lists chunked at 200.
import type { Client } from "@libsql/client";
import type { CalendarRow } from "@/lib/data/calendar";
import { addDays, previousTradingDay, sessionsBetween } from "@/lib/data/calendar";
import { chunked, loadBars, MOVERS_PER_SIDE } from "@/lib/learning/dailyLoad";
import { splitNews, type News } from "@/lib/learning/dailyMovers";
import { DEFAULT_MOVERS_PARAMS } from "../moversParams";
import { inResultsWindow } from "../gates/resultsSeason";
import {
  BACK20_SESSIONS,
  PRIOR_SESSIONS,
  priorReference,
  regimeBefore,
  sessionsBack,
} from "./stage";
import { scorecardNight, type AngleDayRow, type FeatureNight, type Mover } from "./scorecard";
import { WARM_EVENT_SEQ, WARM_PREFIX } from "./warmConst";
import { eventsSince, featureNights, insertAngleDays, logEvent } from "./store";

export const WARM_SESSIONS_DEFAULT = 60; // threshold-ok: the learner's window (learn_window_sessions default)
export const WARM_SESSIONS_MIN = 1; // threshold-ok: at least one night
export const WARM_SESSIONS_MAX = 120; // threshold-ok: learn_window_sessions maximum
export { WARM_EVENT_SEQ, WARM_PREFIX };
const CALENDAR_SPAN = 3; // threshold-ok: calendar days searched per session (weekends, holidays)
const CACHE_NIGHTS = 25; // threshold-ok: feature nights kept (D-1 and D-21 of a window of nights)
const CLOSE_CACHE = 3; // threshold-ok: closes of D, D-1 and one spare
const PPM = 1_000_000; // threshold-ok: parts per million
const LIQUID = ["U1", "U2"]; // threshold-ok: the liquid tiers (dailyLoad.ts)
const NOT_NEWS = "not_news_before_open";

/** Computes the fixed Cortex's feature night as of the evening of `d` (null = it abstained). */
export type FeatureNightSource = (d: string) => Promise<FeatureNight | null>;

export type WarmStartOpts = {
  readonly market: string;
  readonly calendar: readonly CalendarRow[];
  /** Nights to cover: the last N sessions that have a following close (1..120, default 60). */
  readonly sessions?: number;
  /** created_at of the event; never part of a statistic. */
  readonly now: string;
  /** Computes feature nights that were never stored; absent = such nights are skipped. */
  readonly source?: FeatureNightSource;
};

export type WarmStartResult = {
  readonly written: number;
  readonly nights: readonly string[];
  /** Nights that already had scorecard rows (live rows win). */
  readonly skippedExisting: number;
  /** Nights left out: a feature night or the day's prices missing. */
  readonly skippedNoData: number;
  readonly firstD: string | null;
  readonly lastD: string | null;
  readonly rows: number;
};

export type WarmStartPlan = {
  /** The nights D that need rows (no scorecard row yet), oldest first. */
  readonly nights: readonly string[];
  readonly skippedExisting: number;
  /** Feature nights those need that are not stored (the `source` must supply them). */
  readonly missingFeatureNights: readonly string[];
};

const str = (v: unknown): string => String(v);

function checkSessions(n: number | undefined): number {
  const v = n ?? WARM_SESSIONS_DEFAULT;
  if (!Number.isInteger(v) || v < WARM_SESSIONS_MIN || v > WARM_SESSIONS_MAX) {
    throw new RangeError(`sessions must be ${WARM_SESSIONS_MIN}..${WARM_SESSIONS_MAX}`);
  }
  return v;
}

/** The last N sessions that have a following session with prices (D itself is never the newest). */
async function candidateNights(
  db: Pick<Client, "execute">,
  o: Pick<WarmStartOpts, "market" | "calendar">,
  n: number,
): Promise<string[]> {
  const r = await db.execute({
    sql: "SELECT MAX(d) AS d FROM price_bar WHERE market = ?",
    args: [o.market],
  });
  const newest = r.rows[0]?.d;
  if (typeof newest !== "string") return [];
  const all = sessionsBetween(addDays(newest, -(n + 1) * CALENDAR_SPAN), newest, o.calendar);
  return all.slice(-(n + 1), -1); // the newest session has no following one
}

/** Which nights still need rows and which feature nights they need that are not stored. Read only. */
export async function planWarmStart(
  db: Pick<Client, "execute" | "batch">,
  o: Pick<WarmStartOpts, "market" | "calendar" | "sessions">,
): Promise<WarmStartPlan> {
  const n = checkSessions(o.sessions);
  const cands = await candidateNights(db, o, n);
  if (cands.length === 0) return { nights: [], skippedExisting: 0, missingFeatureNights: [] };
  const have = await db.execute({
    sql: `SELECT DISTINCT d FROM cortex_angle_day WHERE market = ? AND d >= ? AND d <= ?`,
    args: [o.market, cands[0]!, cands[cands.length - 1]!],
  });
  const existing = new Set(have.rows.map((x) => str(x.d)));
  const nights = cands.filter((d) => !existing.has(d));
  const need = new Set<string>();
  for (const d of nights) {
    need.add(previousTradingDay(d, o.calendar));
    need.add(sessionsBack(d, BACK20_SESSIONS, o.calendar));
  }
  const list = [...need].sort();
  const stored = new Set<string>();
  if (list.length > 0) {
    const res = await db.batch(
      list.map((d) => ({
        sql: "SELECT 1 AS x FROM cortex_feature_daily WHERE market = ? AND d = ? LIMIT 1",
        args: [o.market, d],
      })),
      "read",
    );
    list.forEach((d, i) => {
      if (res[i]!.rows.length > 0) stored.add(d);
    });
  }
  return {
    nights,
    skippedExisting: cands.length - nights.length,
    missingFeatureNights: list.filter((d) => !stored.has(d)),
  };
}

/** Fills `cortex_angle_day` for the planned nights; see the header. */
export async function warmStart(db: Client, o: WarmStartOpts): Promise<WarmStartResult> {
  const plan = await planWarmStart(db, o);
  const none: WarmStartResult = {
    written: 0,
    nights: [],
    skippedExisting: plan.skippedExisting,
    skippedNoData: 0,
    firstD: null,
    lastD: null,
    rows: 0,
  };
  if (plan.nights.length === 0) return none;
  const { market, calendar } = o;
  const first = plan.nights[0]!;
  const last = plan.nights[plan.nights.length - 1]!;

  // pass 1: the universe of every night (cached by snapshot date), so the bars are read once
  const tierBySnap = new Map<string, Map<string, string>>();
  const snapOf = new Map<string, string>();
  const universeOf = async (d: string): Promise<Map<string, string> | null> => {
    let snap = snapOf.get(d);
    if (snap === undefined) {
      const r = await db.execute({
        sql: "SELECT MAX(d) AS d FROM universe_snapshot WHERE market = ? AND d <= ?",
        args: [market, d],
      });
      const v = r.rows[0]?.d;
      snap = typeof v === "string" ? v : "";
      snapOf.set(d, snap);
    }
    if (snap === "") return null;
    let m = tierBySnap.get(snap);
    if (m === undefined) {
      const u = await db.execute({
        sql: `SELECT code, tier FROM universe_snapshot
              WHERE market = ? AND halted = 0 AND status = 'active' AND d = ? ORDER BY code`,
        args: [market, snap],
      });
      m = new Map(u.rows.map((x) => [str(x.code), str(x.tier)]));
      tierBySnap.set(snap, m);
    }
    return m.size === 0 ? null : m;
  };
  const liquidUnion = new Set<string>();
  for (const d of plan.nights) {
    const t = await universeOf(d);
    if (t === null) continue;
    for (const [code, tier] of t) if (LIQUID.includes(tier)) liquidUnion.add(code);
  }
  // one read of the liquid shares' bars for the whole window (up to the last night, nothing later)
  const allBars = await loadBars(
    db,
    market,
    [...liquidUnion].sort(),
    sessionsBack(first, BACK20_SESSIONS, calendar),
    last,
  );

  // the feature nights: stored rows first, else the source; cached, at most CACHE_NIGHTS in memory
  const cache = new Map<string, FeatureNight | null>();
  const featureOf = async (d: string): Promise<FeatureNight | null> => {
    if (cache.has(d)) {
      const v = cache.get(d)!;
      cache.delete(d);
      cache.set(d, v);
      return v;
    }
    const stored = (await featureNights(db, market, [d])).get(d) ?? null;
    let night: FeatureNight | null = stored !== null && stored.rows.length > 0 ? stored : null;
    if (night === null && o.source !== undefined) night = await o.source(d);
    if (night !== null && night.rows.length === 0) night = null;
    cache.set(d, night);
    if (cache.size > CACHE_NIGHTS) cache.delete(cache.keys().next().value as string);
    return night;
  };

  // prior-60 reference: the stored scorecard events plus the nights computed in this run
  const priorStored = await eventsSince(
    db,
    market,
    addDays(first, -PRIOR_SESSIONS * CALENDAR_SPAN),
    last,
  );
  const storedCards = priorStored.filter((e) => e.kind === "scorecard");
  const computedCards: { d: string; evidence: unknown }[] = [];

  const closeCache = new Map<string, Map<string, number>>();
  const closeOn = async (d: string): Promise<Map<string, number>> => {
    let m = closeCache.get(d);
    if (m === undefined) {
      const r = await db.execute({
        sql: "SELECT code, c FROM price_bar WHERE market = ? AND d = ?",
        args: [market, d],
      });
      m = new Map(r.rows.map((x) => [str(x.code), Number(x.c)])); // money-float-ok: ratio of closes
      closeCache.set(d, m);
      if (closeCache.size > CLOSE_CACHE)
        closeCache.delete(closeCache.keys().next().value as string);
    }
    return m;
  };

  const written: string[] = [];
  let skippedNoData = 0;
  let rowsTotal = 0;
  for (const d of plan.nights) {
    const prev = previousTradingDay(d, calendar);
    const back20 = sessionsBack(d, BACK20_SESSIONS, calendar);
    const tierOf = await universeOf(d);
    if (tierOf === null) {
      skippedNoData += 1;
      continue;
    }
    const [cNow, cPrev] = [await closeOn(d), await closeOn(prev)];
    // the night's biggest movers (the live loadWorld ranking) and which of them moved on news
    const moves: { code: string; movePpm: number }[] = [];
    for (const code of tierOf.keys()) {
      const a = cNow.get(code);
      const b = cPrev.get(code);
      if (a === undefined || b === undefined || !(a > 0) || !(b > 0)) continue;
      moves.push({ code, movePpm: Math.round(((a - b) * PPM) / b) });
    }
    moves.sort((x, y) => y.movePpm - x.movePpm || (x.code < y.code ? -1 : 1));
    if (moves.length === 0) {
      skippedNoData += 1;
      continue;
    }
    const gainers = moves.filter((m) => m.movePpm > 0).slice(0, MOVERS_PER_SIDE);
    const losers = moves.filter((m) => m.movePpm < 0).slice(-MOVERS_PER_SIDE);
    const moverCodes = [...gainers, ...losers].map((m) => m.code);
    const sensitive = new Map<string, News[]>();
    const anns = await chunked(moverCodes, async (part) => {
      const r = await db.execute({
        sql: `SELECT code, published_at, title FROM announcement
              WHERE market = ? AND code IN (${part.map(() => "?").join(", ")})
                AND published_at >= ? AND published_at < ? AND price_sensitive = 1
              ORDER BY code, published_at`,
        args: [
          market,
          ...part,
          `${addDays(prev, -1)}T00:00:00.000Z`,
          `${addDays(d, 1)}T00:00:00.000Z`,
        ],
      });
      return r.rows;
    });
    for (const x of anns) {
      const k = str(x.code);
      if (!sensitive.has(k)) sensitive.set(k, []);
      sensitive.get(k)!.push({ publishedAt: str(x.published_at), title: str(x.title) });
    }
    const asMover = (m: { code: string }, side: "gainer" | "loser"): Mover => ({
      code: m.code,
      side,
      cause:
        splitNews(sensitive.get(m.code) ?? [], d, prev, calendar).before.length > 0
          ? "news_before_open"
          : NOT_NEWS,
    });
    const movers = [
      ...gainers.map((m) => asMover(m, "gainer")),
      ...losers.map((m) => asMover(m, "loser")),
    ];
    const liquidCodes = [...tierOf]
      .filter(([, t]) => LIQUID.includes(t))
      .map(([c]) => c)
      .sort();
    const [featuresPrev, featuresBack20] = [await featureOf(prev), await featureOf(back20)];
    if (featuresPrev === null || featuresBack20 === null || liquidCodes.length === 0) {
      skippedNoData += 1;
      continue;
    }
    // bars up to d only (look-ahead guard: whatever the read returned past d is dropped)
    const bars = new Map(
      liquidCodes.map((c) => [
        c,
        (allBars.get(c) ?? []).filter((b) => b.d <= d).map((b) => ({ d: b.d, c: b.c })),
      ]),
    );
    const regimes = new Map<string, string>([
      [prev, await regimeBefore(db, market, prev)],
      [back20, await regimeBefore(db, market, back20)],
    ]);
    const window = sessionsBetween(
      addDays(prev, -PRIOR_SESSIONS * CALENDAR_SPAN),
      prev,
      calendar,
    ).slice(-PRIOR_SESSIONS);
    const from = window[0] ?? prev;
    const reference = priorReference(
      [...storedCards, ...computedCards]
        .filter((e) => e.d >= from && e.d <= prev)
        .map((e) => e.evidence),
    );
    const card = scorecardNight({
      market,
      d,
      featuresPrev,
      featuresBack20,
      end20: prev,
      bars,
      liquidCodes,
      movers,
      regimes,
      resultsSeason: (fd) => inResultsWindow(fd, DEFAULT_MOVERS_PARAMS),
      prior60: reference,
    });
    computedCards.push({ d, evidence: { hist: card.histograms } });
    if (card.rows.length === 0) {
      skippedNoData += 1;
      continue;
    }
    const marked: AngleDayRow[] = card.rows.map((r) => ({
      ...r,
      manifestId: `${WARM_PREFIX}${r.manifestId}`,
    }));
    const res = await insertAngleDays(db, marked);
    if (res.inserted > 0) {
      written.push(d);
      rowsTotal += res.inserted;
    }
  }
  const out: WarmStartResult = {
    written: written.length,
    nights: written,
    skippedExisting: plan.skippedExisting,
    skippedNoData,
    firstD: written[0] ?? null,
    lastD: written[written.length - 1] ?? null,
    rows: rowsTotal,
  };
  if (out.lastD !== null) {
    await logEvent(db, {
      market,
      d: out.lastD,
      seq: WARM_EVENT_SEQ,
      kind: "scorecard",
      evidence: {
        warmStart: true,
        nights: out.written,
        rows: out.rows,
        firstD: out.firstD,
        lastD: out.lastD,
        skippedExisting: out.skippedExisting,
        skippedNoData: out.skippedNoData,
      },
      words: `Warm start: ${out.written} past sessions were scored from the price history, as of each evening.`,
      createdAt: o.now,
    });
  }
  return out;
}
