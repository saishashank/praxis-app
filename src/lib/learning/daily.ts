// D-921 (Owner 2026-11-10: "the system never learns from each day"): the DAILY LEARNING LOOP, run every
// night after the picks (src/lib/picks/cli.ts). It
//   1. explains each of the session's 20 biggest gainers and 20 biggest losers from evidence (news before
//      the open or during the day, its sector, the index, volume) and says whether anything had it on the
//      radar the evening before and how close the shortlist rule came;
//   2. tests, honestly, which evening-before features predict the NEXT day's move: over the last 40
//      sessions, on ALL liquid shares (not only the winners), feature share-days against the base of every
//      share-day (dailyFeatures.ts);
//   3. feeds a strong finding (beats the market on 10 of the last 15 stored nights) into the existing
//      learning system as one proposed expert-claim cluster, once (dailyHypothesis.ts), never changing a
//      strategy rule or the shortlist rule by itself;
//   4. lists up to 6 improvements with their evidence (dailyImprove.ts);
//   5. stores the night (table daily_learning, migration 0030) so tomorrow can compare and the Evening
//      Review can read it back with loadDailyLearning.
// The picks and shortlist knowledge (which share was picked, how close the SL.v1 rule came) lives in
// src/lib/picks, which this folder may not import (tests/picks/isolation.test.ts); the picks entry hands
// it in through `hooks`. Without hooks the loop still runs on strategy signals alone.
// Deterministic: the same stored data gives the same document. Reads: see dailyLoad.ts (about 190k rows).
import type { Client } from "@libsql/client";
import type { CalendarRow } from "@/lib/data/calendar";
import { addDays, isTradingDay, previousTradingDay, sessionsBetween } from "@/lib/data/calendar";
import { STRATEGY_NAMES_DEFAULT } from "@/lib/config/keys";
import { displayName, formatDay } from "@/lib/view/format";
import { openHypothesis, clusterIdOf, HYP_MIN, HYP_WINDOW } from "./dailyHypothesis";
import {
  computeLessons,
  crossSection,
  FEATURES,
  flagsOf,
  prepare,
  rawAt,
  setupWords,
  withChange,
  type LBar,
  type Prepared,
} from "./dailyFeatures";
import { buildImprovements, blockWords, LOOKBACK } from "./dailyImprove";
import { loadBlocked, loadWorld, MOVERS_PER_SIDE, type World } from "./dailyLoad";
import { classifyCause, evening, pct, PPM, splitNews } from "./dailyMovers";

export type MoverCause =
  | "news_before_open"
  | "news_during_day"
  | "sector_move"
  | "market_move"
  | "volume_no_news"
  | "stock_specific";

export type MoverExplanation = {
  code: string;
  name: string | null;
  side: "gainer" | "loser";
  movePpm: number;
  cause: MoverCause;
  causeText: string;
  indexMovePpm: number | null;
  sectorName: string | null;
  sectorMovePpm: number | null;
  volumeVsUsualPpm: number | null;
  setupBefore: string[];
  caughtBy: string | null;
  nearMiss: string | null;
};

export type FeatureLesson = {
  feature: string;
  sessions: number;
  n: number;
  nextDayAvgPpm: number;
  baseAvgPpm: number;
  liftPpm: number;
  hitRatePpm: number;
  verdict: "beats the market" | "lags the market" | "no clear edge yet";
  change: "new" | "stronger" | "weaker" | "unchanged";
};

export type ImprovementItem = {
  title: string;
  evidence: string;
  action: string;
  area: "picks" | "strategies" | "data" | "learning";
};

export type DailyLearning = {
  d: string;
  summary: string[];
  movers: MoverExplanation[];
  lessons: FeatureLesson[];
  improvements: ImprovementItem[];
  hypothesesOpened: string[];
};

/** What the picks side knows and the learning folder may not read itself (picks isolation, D-181). */
export type PickHooks = {
  /** Published picks of the previous evening for these codes: code -> "Picked (Balanced #2)" words. */
  pickedBefore(
    db: Client,
    market: string,
    prev: string,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  /** Which of these sessions had at least one published pick. */
  publishedDays(db: Client, market: string, days: readonly string[]): Promise<ReadonlySet<string>>;
  /** How close the shortlist rule came at the close of `prev` for these codes (bars up to prev). */
  shortlistNotes(
    shares: readonly { code: string; tier: string; bars: readonly LBar[] }[],
    prev: string,
    codes: readonly string[],
  ): ReadonlyMap<string, { note: string; onShortlist: boolean }>;
};

type Opts = {
  market: string;
  d: string;
  calendar: readonly CalendarRow[];
  now?: string;
  hooks?: PickHooks;
};

const ZERO = { movers: 0, lessons: 0, improvements: 0, hypotheses: 0 };
const GAP_SESSIONS = 30; // threshold-ok: sessions of price history checked for gaps

const strategyName = (family: string): string =>
  (STRATEGY_NAMES_DEFAULT as Record<string, { name: string } | undefined>)[family]?.name ??
  "a strategy";

async function loadRecent(
  db: Pick<Client, "execute">,
  market: string,
  d: string,
): Promise<DailyLearning[]> {
  const r = await db.execute({
    sql: `SELECT body_json FROM daily_learning WHERE market = ? AND d < ? ORDER BY d DESC LIMIT ?`,
    args: [market, d, HYP_WINDOW - 1],
  });
  const out: DailyLearning[] = [];
  for (const x of r.rows) {
    const b = parseBody(String(x.body_json));
    if (b !== null) out.push(b);
  }
  return out.reverse(); // oldest first
}

function parseBody(json: string): DailyLearning | null {
  try {
    const v = JSON.parse(json) as Partial<DailyLearning> | null;
    if (v === null || typeof v !== "object" || typeof v.d !== "string") return null;
    return {
      d: v.d,
      summary: v.summary ?? [],
      movers: v.movers ?? [],
      lessons: v.lessons ?? [],
      improvements: v.improvements ?? [],
      hypothesesOpened: v.hypothesesOpened ?? [],
    };
  } catch {
    return null;
  }
}

/** The stored night, or null when none was stored for that session. */
export async function loadDailyLearning(
  db: Pick<Client, "execute">,
  market: string,
  d: string,
): Promise<DailyLearning | null> {
  const r = await db.execute({
    sql: "SELECT body_json FROM daily_learning WHERE market = ? AND d = ?",
    args: [market, d],
  });
  return r.rows.length === 0 ? null : parseBody(String(r.rows[0]!.body_json));
}

function signalWords(
  facts: World["signals"] extends ReadonlyMap<string, infer V> ? V : never,
): string | null {
  if (facts.length === 0) return null;
  const names = [...new Set(facts.map((f) => strategyName(f.family)))].sort();
  const traded = facts.some((f) => f.traded);
  const blocked = [...new Set(facts.flatMap((f) => f.blocked))].sort();
  const head = `Signalled by ${names.join(" and ")}`;
  if (traded) return `${head}, and traded`;
  if (blocked.length > 0) return `${head}, trade blocked: ${blocked.map(blockWords).join("; ")}`;
  return `${head}, not a pick`;
}

function buildMovers(
  w: World,
  o: Opts,
  hooks: {
    picked: ReadonlyMap<string, string>;
    notes: ReadonlyMap<string, { note: string; onShortlist: boolean }>;
  },
  prepared: ReadonlyMap<string, Prepared>,
  newsAfter: ReadonlyMap<string, ReadonlySet<string>>,
): MoverExplanation[] {
  const liquid = [...prepared.values()].filter((p) => w.liquidCodes.includes(p.code));
  const crossPrev = crossSection(liquid, w.sectorOf, w.prev);
  const moveOf = new Map(w.moves.map((m) => [m.code, m.movePpm]));
  const gainers = w.moves.filter((m) => m.movePpm > 0).slice(0, MOVERS_PER_SIDE);
  const losers = w.moves
    .filter((m) => m.movePpm < 0)
    .slice(-MOVERS_PER_SIDE)
    .reverse();
  const sectorMembers = new Map<string, string[]>();
  for (const code of w.liquidCodes) {
    const sec = w.sectorOf.get(code);
    if (sec !== undefined) sectorMembers.set(sec, [...(sectorMembers.get(sec) ?? []), code]);
  }
  const one = (
    m: { code: string; movePpm: number },
    side: "gainer" | "loser",
  ): MoverExplanation => {
    const p = prepared.get(m.code);
    const sector = w.sectorOf.get(m.code) ?? null;
    const others =
      sector === null
        ? []
        : (sectorMembers.get(sector) ?? []).filter((c) => c !== m.code && moveOf.has(c));
    const sectorMovePpm =
      others.length === 0
        ? null
        : Math.round(others.reduce((a, c) => a + moveOf.get(c)!, 0) / others.length);
    const iD = p?.idx.get(o.d);
    const iPrev = p?.idx.get(w.prev);
    const volRatio = p !== undefined && iD !== undefined ? rawAt(p, iD).volRatio : null;
    const volumeVsUsualPpm = volRatio === null ? null : Math.round(volRatio * PPM);
    const news = splitNews(w.sensitive.get(m.code) ?? [], o.d, w.prev, o.calendar);
    const { cause, causeText } = classifyCause({
      movePpm: m.movePpm,
      indexMovePpm: w.indexMovePpm,
      sectorName: sector,
      sectorMovePpm,
      sectorShares: others.length + (w.liquidCodes.includes(m.code) ? 1 : 0),
      volumeVsUsualPpm,
      newsBefore: news.before,
      newsDuring: news.during,
    });
    const setupBefore =
      p !== undefined && iPrev !== undefined
        ? (() => {
            const raw = rawAt(p, iPrev);
            return setupWords(
              flagsOf(raw, {
                cross: crossPrev,
                sector: sector ?? undefined,
                newsAfter: newsAfter.get(m.code)?.has(w.prev) ?? false,
              }),
              raw,
            );
          })()
        : [];
    const note = hooks.notes.get(m.code);
    const picked = hooks.picked.get(m.code);
    const caughtBy =
      picked ??
      signalWords(w.signals.get(m.code) ?? []) ??
      (note?.onShortlist === true ? "On the shortlist" : null);
    const name = w.names.get(m.code);
    return {
      code: m.code,
      name: name === undefined || name.trim() === "" ? null : displayName(name),
      side,
      movePpm: m.movePpm,
      cause,
      causeText,
      indexMovePpm: w.indexMovePpm,
      sectorName: sector,
      sectorMovePpm,
      volumeVsUsualPpm,
      setupBefore,
      caughtBy,
      nearMiss: note === undefined || note.onShortlist ? null : note.note,
    };
  };
  return [...gainers.map((m) => one(m, "gainer")), ...losers.map((m) => one(m, "loser"))];
}

function summarise(
  d: string,
  movers: readonly MoverExplanation[],
  lessons: readonly FeatureLesson[],
  improvements: number,
  opened: number,
): string[] {
  const count = (c: MoverCause): number => movers.filter((m) => m.cause === c).length;
  const news = count("news_before_open") + count("news_during_day");
  const parts: string[] = [];
  if (news > 0) parts.push(`${news} on company news`);
  if (count("sector_move") > 0) parts.push(`${count("sector_move")} with their sector`);
  if (count("market_move") > 0) parts.push(`${count("market_move")} with the whole market`);
  if (count("volume_no_news") > 0)
    parts.push(`${count("volume_no_news")} on heavy trading without news`);
  if (count("stock_specific") > 0) parts.push(`${count("stock_specific")} for no visible reason`);
  const join = (xs: string[]): string =>
    xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]!}`;
  const out: string[] = [];
  out.push(
    movers.length === 0
      ? `${formatDay(d)}: no mover could be explained because the price data was incomplete.`
      : `${formatDay(d)}: of the ${movers.length} biggest movers, ${join(parts)}.`,
  );
  const caught = movers.filter((m) => m.caughtBy !== null).length;
  if (movers.length > 0) {
    out.push(
      `Our strategies, picks or shortlist had ${caught} of them on their radar the evening before.`,
    );
  }
  const beats = lessons
    .filter((l) => l.verdict === "beats the market")
    .sort((a, b) => b.liftPpm - a.liftPpm);
  const sessions = lessons[0]?.sessions ?? 0;
  const changed = lessons.filter((l) => l.change === "stronger" || l.change === "weaker").length;
  if (beats.length > 0) {
    const b = beats[0]!;
    out.push(
      `Over the last ${sessions} sessions ${beats.length === 1 ? "one evening setup" : `${beats.length} evening setups`} beat the market the next day; the best, ${b.feature}, moved ${pct(b.nextDayAvgPpm)} against ${pct(b.baseAvgPpm)} for the average share (${changed} of ${lessons.length} lessons changed since last night).`,
    );
  } else {
    out.push(
      `Over the last ${sessions} sessions no evening setup has beaten the market by a clear margin yet (${changed} of ${lessons.length} lessons changed since last night).`,
    );
  }
  out.push(
    opened > 0
      ? `${opened === 1 ? "One hypothesis was" : `${opened} hypotheses were`} opened for review; ${improvements} ${improvements === 1 ? "improvement is" : "improvements are"} listed for tomorrow.`
      : `${improvements} ${improvements === 1 ? "improvement is" : "improvements are"} listed for tomorrow.`,
  );
  return out;
}

export async function runDailyLearning(
  db: Client,
  o: Opts,
): Promise<{ movers: number; lessons: number; improvements: number; hypotheses: number }> {
  if (!isTradingDay(o.d, o.calendar)) return { ...ZERO };
  let prev: string;
  try {
    prev = previousTradingDay(o.d, o.calendar);
  } catch {
    return { ...ZERO };
  }
  const w = await loadWorld(db, { market: o.market, d: o.d, prev });
  if (w === null) return { ...ZERO };
  const now = o.now ?? new Date().toISOString();

  const prepared = new Map<string, Prepared>();
  for (const [code, s] of w.shares) prepared.set(code, prepare(s));
  const liquid = w.liquidCodes
    .map((c) => prepared.get(c))
    .filter((p): p is Prepared => p !== undefined);
  const newsAfter = new Map<string, Set<string>>();
  for (const [code, anns] of w.sensitive) {
    for (const a of anns) {
      const t = evening(a.publishedAt, o.calendar);
      if (t === null) continue;
      if (!newsAfter.has(code)) newsAfter.set(code, new Set());
      newsAfter.get(code)!.add(t);
    }
  }

  const recent = await loadRecent(db, o.market, o.d);
  const lessons = withChange(
    computeLessons(liquid, w.sectorOf, newsAfter, o.d),
    recent.length > 0 ? recent[recent.length - 1]!.lessons : null,
  );

  // the picks side: who was picked, how close the shortlist rule came (hooks; signals alone without them)
  const moverCodes = [
    ...w.moves.filter((m) => m.movePpm > 0).slice(0, MOVERS_PER_SIDE),
    ...w.moves.filter((m) => m.movePpm < 0).slice(-MOVERS_PER_SIDE),
  ].map((m) => m.code);
  const picked = o.hooks
    ? await o.hooks.pickedBefore(db, o.market, prev, moverCodes)
    : new Map<string, string>();
  const notes = o.hooks
    ? o.hooks.shortlistNotes(
        liquid
          .map((p) => ({ code: p.code, tier: p.tier, bars: p.bars }))
          .concat(
            moverCodes
              .map((c) => prepared.get(c))
              .filter((p): p is Prepared => p !== undefined && !w.liquidCodes.includes(p.code))
              .map((p) => ({ code: p.code, tier: p.tier, bars: p.bars })),
          ),
        prev,
        moverCodes,
      )
    : new Map<string, { note: string; onShortlist: boolean }>();
  const movers = buildMovers(w, o, { picked, notes }, prepared, newsAfter);

  // feed back: beats the market on 10 of the last 15 stored nights -> one hypothesis, once
  const nights = [...recent, { d: o.d, lessons } as DailyLearning];
  const ids = FEATURES.map((f) => clusterIdOf(f.key));
  const existing = await db.execute({
    sql: `SELECT id FROM cluster WHERE id IN (${ids.map(() => "?").join(", ")})`,
    args: ids,
  });
  const alreadyOpen = new Set(
    FEATURES.filter((f) => existing.rows.some((r) => String(r.id) === clusterIdOf(f.key))).map(
      (f) => f.label,
    ),
  );
  const opened: string[] = [];
  const hypothesesOpened: string[] = [];
  for (const l of lessons) {
    if (l.verdict !== "beats the market" || alreadyOpen.has(l.feature)) continue;
    const beatNights = nights.filter((n) =>
      n.lessons.some((x) => x.feature === l.feature && x.verdict === "beats the market"),
    ).length;
    if (beatNights < HYP_MIN) continue;
    const made = await openHypothesis(db, {
      feature: l.feature,
      d: o.d,
      now,
      evidence: {
        nights: beatNights,
        of: nights.length,
        liftText: pct(l.liftPpm).replace("+", ""),
        n: l.n,
      },
    });
    if (made) {
      opened.push(l.feature);
      hypothesesOpened.push(
        `${l.feature}: beat the market on ${beatNights} of the last ${nights.length} nights; opened for the Owner to review as a proposed shortlist factor.`,
      );
    }
  }

  // improvements, with their evidence
  const sessions = sessionsBetween(addDays(o.d, -(LOOKBACK * 2)), o.d, o.calendar).slice(-LOOKBACK);
  const published = o.hooks ? await o.hooks.publishedDays(db, o.market, sessions) : null;
  const blocked = await loadBlocked(db, o.market, sessions[0] ?? o.d, o.d);
  const expected = sessionsBetween(addDays(o.d, -(GAP_SESSIONS * 2)), o.d, o.calendar).slice(
    -GAP_SESSIONS,
  );
  let gapMovers = 0;
  for (const c of moverCodes) {
    const p = prepared.get(c);
    const have = new Set(p?.bars.map((b) => b.d) ?? []);
    const first = p?.bars[0]?.d ?? "";
    if (p === undefined || expected.filter((e) => e >= first && !have.has(e)).length > 0)
      gapMovers += 1;
  }
  const today: DailyLearning = {
    d: o.d,
    summary: [],
    movers,
    lessons,
    improvements: [],
    hypothesesOpened,
  };
  const improvements = buildImprovements({
    d: o.d,
    lessons,
    opened,
    alreadyOpen,
    pickSessions: published === null ? null : sessions,
    noPickDays: published === null ? [] : sessions.filter((s) => !published.has(s)),
    blocked,
    history: [...recent, today],
    gapMovers,
    moversChecked: moverCodes.length,
  });
  const body: DailyLearning = {
    d: o.d,
    summary: summarise(o.d, movers, lessons, improvements.length, opened.length),
    movers,
    lessons,
    improvements,
    hypothesesOpened,
  };
  await db.execute({
    sql: `INSERT INTO daily_learning (market, d, body_json, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (market, d) DO UPDATE SET body_json = excluded.body_json, created_at = excluded.created_at`,
    args: [o.market, o.d, JSON.stringify(body), now],
  });
  return {
    movers: movers.length,
    lessons: lessons.length,
    improvements: improvements.length,
    hypotheses: opened.length,
  };
}
