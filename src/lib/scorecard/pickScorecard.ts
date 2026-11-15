// D-1060…D-1069 (Owner O-84, 2026-11-16): "Replay the last 40 sessions night by night: each night uses
// only data known then, makes that night's picks, and scores them against the next day's top 5
// gainers and losers." The pure scoring half of the pick scorecard (a REPORT: it changes no rule, no
// config, no Cortex weight, no learner, no promotion test and no arena state). No database, no clock.
//
//   Night d: the picks made from data known at the close of d (./pickReplay.ts builds them). On the
//   next session d+1 the five biggest liquid gainers and losers are measured with the SAME functions as
//   the daily learning (src/lib/learning/dailyTop5.ts: top5Movers / top5Night, the same liquid
//   definition and the same chance method, "named shares / liquid shares x 5"). Every pick also gets
//   its own d+1 open-to-close return, its 5-session return and whether its aim or its stop came
//   first within 5 sessions (or "not yet known").
//   The Cortex line (Owner addition 2026-11-16): the FIXED Cortex's evening score of d (equal cluster
//   weights, no learner; src/lib/cortex/learn/scorecard.ts eveningScores) ranks the liquid shares it
//   could score; how many of the top-5 gainers sat in its top tenth, how many of the top-5 losers in
//   its bottom tenth (chance: one tenth), and the d+1 return of the top tenth minus the bottom tenth
//   (the scorecard's own top-tenth / bottom-tenth formula at one session).
import {
  chanceDays,
  top5Movers,
  top5Night,
  type MissCause,
  type MoveLike,
  type PickedBefore,
  type PickSource,
  type Top5Entry,
} from "@/lib/learning/dailyTop5";
import type { MoverCause } from "@/lib/learning/daily";
import { eveningScores, TENTH, type FeatureNight } from "@/lib/cortex/learn/scorecard";
import { mean } from "@/lib/stats/bootstrap";

export const SUMMARY_FORMAT = 1;
export const SESSIONS_DEFAULT = 40; // threshold-ok: O-84 "the last 40 sessions"
export const SESSIONS_MAX = 60; // threshold-ok: O-84 cap on the replay length
/** Sessions after the pick night over which the 5-session return and the aim/stop race run. */
export const HORIZON = 5; // threshold-ok: O-84 "5-session return"
const PPM = 1_000_000;
const PPM_N = 1_000_000n; // threshold-ok: parts per million

/** One pick the replay made on night d (the fields the scoring needs). */
export type ScoredPick = {
  readonly profile: string;
  readonly rank: number;
  readonly code: string;
  readonly source: PickSource;
  readonly stopMicro: bigint;
  readonly aimMicro: bigint;
};

/** A bar from session d+1 on, in order (micro prices). */
export type LaterBar = {
  readonly d: string;
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
};

export type Race = "aim" | "stop" | "neither" | "unknown";

export type PickOutcome = {
  readonly profile: string;
  readonly rank: number;
  readonly code: string;
  readonly source: PickSource;
  /** d+1 open to d+1 close, ppm; null without a d+1 bar. */
  readonly nextPpm: number | null;
  /** d+1 open to the close of the 5th session from d+1 on; null = not yet known. */
  readonly fivePpm: number | null;
  readonly race: Race;
};

const ppmOf = (a: bigint, b: bigint): number => Number(((b - a) * PPM_N) / a); // money-float-ok: ppm integer

/** One pick followed through the bars from d+1 (pure). Stop first when one bar touches both. */
export function followPick(p: ScoredPick, later: readonly LaterBar[]): PickOutcome {
  const head = later[0];
  const base = { profile: p.profile, rank: p.rank, code: p.code, source: p.source };
  if (head === undefined || head.open <= 0n) {
    return { ...base, nextPpm: null, fivePpm: null, race: "unknown" };
  }
  const window = later.slice(0, HORIZON);
  let race: Race = window.length >= HORIZON ? "neither" : "unknown";
  for (const b of window) {
    if (b.low <= p.stopMicro) {
      race = "stop";
      break;
    }
    if (b.high >= p.aimMicro) {
      race = "aim";
      break;
    }
  }
  return {
    ...base,
    nextPpm: ppmOf(head.open, head.close),
    fivePpm: window.length >= HORIZON ? ppmOf(head.open, window[HORIZON - 1]!.close) : null,
    race,
  };
}

/** The sums of one profile's picks on one night (compact; the run's summary adds them up). */
export type ProfileDay = {
  readonly n: number;
  readonly nextN: number;
  readonly nextSumPpm: number;
  readonly nextUp: number;
  readonly fiveN: number;
  readonly fiveSumPpm: number;
  readonly fiveUp: number;
  readonly aim: number;
  readonly stop: number;
  readonly neither: number;
  readonly unknown: number;
};

const emptyProfile = (): ProfileDay => ({
  n: 0,
  nextN: 0,
  nextSumPpm: 0,
  nextUp: 0,
  fiveN: 0,
  fiveSumPpm: 0,
  fiveUp: 0,
  aim: 0,
  stop: 0,
  neither: 0,
  unknown: 0,
});

export function profileDay(outcomes: readonly PickOutcome[]): ProfileDay {
  let r = emptyProfile();
  for (const o of outcomes) {
    r = {
      n: r.n + 1,
      nextN: r.nextN + (o.nextPpm === null ? 0 : 1),
      nextSumPpm: r.nextSumPpm + (o.nextPpm ?? 0),
      nextUp: r.nextUp + (o.nextPpm !== null && o.nextPpm > 0 ? 1 : 0),
      fiveN: r.fiveN + (o.fivePpm === null ? 0 : 1),
      fiveSumPpm: r.fiveSumPpm + (o.fivePpm ?? 0),
      fiveUp: r.fiveUp + (o.fivePpm !== null && o.fivePpm > 0 ? 1 : 0),
      aim: r.aim + (o.race === "aim" ? 1 : 0),
      stop: r.stop + (o.race === "stop" ? 1 : 0),
      neither: r.neither + (o.race === "neither" ? 1 : 0),
      unknown: r.unknown + (o.race === "unknown" ? 1 : 0),
    };
  }
  return r;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---- the Cortex's night -------------------------------------------------------------------------

/** D-1070: "live" = the angle set frozen on or before the night; "golive" = the earliest frozen set, replayed. */
export type CortexBasis = "live" | "golive";

export type CortexDay = {
  readonly basis: CortexBasis;
  /** Liquid shares the fixed Cortex could score on the evening of d. */
  readonly scored: number;
  readonly gainersInTop: number;
  readonly gainersN: number;
  readonly losersInBottom: number;
  readonly losersN: number;
  /** Top tenth's mean d+1 return minus the bottom tenth's, ppm; null below the share floor. */
  readonly gapPpm: number | null;
};

/** Fewer scored liquid shares than this and the Cortex has no result for the night. */
export const CORTEX_MIN_SCORED = 20; // threshold-ok: same floor as the daily rank IC (RANK_IC_MIN_CODES)

/**
 * The fixed Cortex's call on night d scored on d+1 (pure). `night` = its features of the evening of d;
 * `closeMoves` = every liquid share's d+1 close-to-close move (the top-5 sets come from the same
 * moves); `returns` = d -> d+1 returns of the liquid shares (the gap).
 */
export function cortexDay(
  night: FeatureNight | null,
  sets: { readonly gainers: readonly MoveLike[]; readonly losers: readonly MoveLike[] },
  liquid: readonly string[],
  returns: ReadonlyMap<string, number>,
  basis: CortexBasis = "live",
): CortexDay | null {
  if (night === null || night.rows.length === 0) return null;
  const ok = new Set(liquid);
  const all = eveningScores(night);
  const ranked = [...all.entries()]
    .filter(([c]) => ok.has(c))
    .sort((a, b) => b[1] - a[1] || byText(a[0], b[0]));
  if (ranked.length < CORTEX_MIN_SCORED) return null;
  const k = Math.max(1, Math.floor(ranked.length / TENTH));
  const top = new Set(ranked.slice(0, k).map(([c]) => c));
  const bottom = new Set(ranked.slice(-k).map(([c]) => c));
  const scored = new Set(ranked.map(([c]) => c));
  const inScored = (m: MoveLike): boolean => scored.has(m.code);
  const topR = ranked.slice(0, k).flatMap(([c]) => returns.get(c) ?? []);
  const botR = ranked.slice(-k).flatMap(([c]) => returns.get(c) ?? []);
  const gap =
    topR.length === 0 || botR.length === 0 ? null : Math.round((mean(topR) - mean(botR)) * PPM);
  const g = sets.gainers.filter(inScored);
  const l = sets.losers.filter(inScored);
  return {
    basis,
    scored: ranked.length,
    gainersInTop: g.filter((m) => top.has(m.code)).length,
    gainersN: g.length,
    losersInBottom: l.filter((m) => bottom.has(m.code)).length,
    losersN: l.length,
    gapPpm: gap === null || gap === 0 ? 0 : gap,
  };
}

// ---- one night ----------------------------------------------------------------------------------

export type DayInput = {
  readonly d: string;
  readonly nextD: string;
  readonly picks: readonly ScoredPick[];
  /** Close-to-close d -> d+1 moves of every active share with a bar on both sessions. */
  readonly moves: readonly MoveLike[];
  /** Liquid shares (U1/U2, active, not halted) on d+1. */
  readonly liquid: readonly string[];
  readonly explain: (
    code: string,
    side: "gainer" | "loser",
  ) => { cause: MoverCause | null; name: string | null };
  /** Bars of a code from d+1 on, oldest first (scoring side only: the picks never saw them). */
  readonly later: (code: string) => readonly LaterBar[];
  readonly cortex: CortexDay | null;
};

export type DayDetail = {
  readonly gainers: readonly Pick<
    Top5Entry,
    "code" | "name" | "movePpm" | "via" | "where" | "missed"
  >[];
  readonly losers: readonly Pick<Top5Entry, "code" | "name" | "movePpm" | "via" | "where">[];
  readonly picks: readonly PickOutcome[];
};

export type DayResult = {
  readonly d: string;
  readonly nextD: string;
  readonly picksN: number;
  readonly gainersN: number;
  readonly gainerHits: number;
  readonly losersN: number;
  readonly loserHits: number;
  readonly liquidN: number;
  readonly namedN: number;
  /** Chance of the day: how many of the five a random list as long as ours would hold, ppm. */
  readonly chancePpm: number;
  readonly profiles: Readonly<Record<string, ProfileDay>>;
  readonly detail: DayDetail;
  readonly cortex: CortexDay | null;
};

const PROFILE_ORDER = ["aggressive", "balanced", "conservative"];

export function scoreDay(x: DayInput): DayResult {
  const sets = top5Movers(x.moves, x.liquid);
  const picked = new Map<string, PickedBefore>();
  for (const p of [...x.picks].sort((a, b) => a.rank - b.rank || byText(a.profile, b.profile))) {
    if (!picked.has(p.code)) {
      picked.set(p.code, {
        where: `${p.profile.charAt(0).toUpperCase()}${p.profile.slice(1)} #${p.rank}`,
        source: p.source,
      });
    }
  }
  const night = top5Night({
    d: x.nextD,
    sets,
    liquid: x.liquid,
    allMoves: x.moves,
    picked,
    intraday: [],
    explain: x.explain,
    history: [],
  });
  const outcomes = x.picks.map((p) => followPick(p, x.later(p.code)));
  const names = [...new Set([...PROFILE_ORDER, ...outcomes.map((o) => o.profile)])].sort(
    (a, b) => PROFILE_ORDER.indexOf(a) - PROFILE_ORDER.indexOf(b) || byText(a, b),
  );
  const profiles: Record<string, ProfileDay> = {};
  for (const n of names) profiles[n] = profileDay(outcomes.filter((o) => o.profile === n));
  return {
    d: x.d,
    nextD: x.nextD,
    picksN: x.picks.length,
    gainersN: night.gainers.length,
    gainerHits: night.gainersHad,
    losersN: night.losers.length,
    loserHits: night.losersHad,
    liquidN: night.liquid,
    namedN: night.named,
    chancePpm: Math.round(night.chanceHits * PPM),
    profiles,
    detail: {
      gainers: night.gainers.map((g) => ({
        code: g.code,
        name: g.name,
        movePpm: g.movePpm,
        via: g.via,
        where: g.where,
        missed: g.missed,
      })),
      losers: night.losers.map((l) => ({
        code: l.code,
        name: l.name,
        movePpm: l.movePpm,
        via: l.via,
        where: l.where,
      })),
      picks: outcomes,
    },
    cortex: x.cortex,
  };
}

// ---- the run -------------------------------------------------------------------------------------

export type ProfileSummary = ProfileDay;

export type ScorecardSummary = {
  readonly v: typeof SUMMARY_FORMAT;
  readonly sessions: number;
  readonly firstD: string;
  readonly lastD: string;
  /** Nights scored (those with a following session and at least one liquid mover). */
  readonly days: number;
  readonly picksN: number;
  readonly daysWithPicks: number;
  readonly gainers: { readonly total: number; readonly hits: number; readonly daysWithHit: number };
  /** Sum over the nights of the chance expected hits (a float with four decimals). */
  readonly chanceHits: number;
  readonly losers: { readonly total: number; readonly hits: number; readonly daysWithHit: number };
  readonly profiles: Readonly<Record<string, ProfileSummary>>;
  readonly misses: Readonly<Record<MissCause, number>>;
  readonly cortex: {
    readonly days: number;
    readonly gainers: number;
    readonly gainersInTop: number;
    readonly chanceGainers: number;
    readonly losers: number;
    readonly losersInBottom: number;
    readonly gapDays: number;
    readonly gapSumPpm: number;
    readonly gapUpDays: number;
    /** D-1070: nights scored with the angle set live then, and nights replayed with the go-live set. */
    readonly liveNights: number;
    readonly goLiveNights: number;
  };
  /** D-1071: nights with at least one strategy pick (the others had only shortlist picks). */
  readonly strategyNights: number;
  /** What the replay left out, in the words of the page and the report. */
  readonly skipped: readonly string[];
};

export const SKIPPED_DEFAULT: readonly string[] = [
  "candidate measures",
  "intraday ideas",
  "news after the cut-off of 2 Nov",
];

const MISS_CAUSES: readonly MissCause[] = [
  "news_before_open",
  "sector_move",
  "market_move",
  "news_during_day",
  "no_measure",
];

const addProfile = (a: ProfileDay, b: ProfileDay): ProfileDay => ({
  n: a.n + b.n,
  nextN: a.nextN + b.nextN,
  nextSumPpm: a.nextSumPpm + b.nextSumPpm,
  nextUp: a.nextUp + b.nextUp,
  fiveN: a.fiveN + b.fiveN,
  fiveSumPpm: a.fiveSumPpm + b.fiveSumPpm,
  fiveUp: a.fiveUp + b.fiveUp,
  aim: a.aim + b.aim,
  stop: a.stop + b.stop,
  neither: a.neither + b.neither,
  unknown: a.unknown + b.unknown,
});

/** Add the nights up (pure). `sessions` = how many sessions were asked for. */
export function summarise(
  days: readonly DayResult[],
  o: { sessions: number; skipped?: readonly string[] },
): ScorecardSummary {
  const profiles: Record<string, ProfileDay> = {};
  const misses = Object.fromEntries(MISS_CAUSES.map((c) => [c, 0])) as Record<MissCause, number>;
  let chance = 0;
  const cx = {
    days: 0,
    gainers: 0,
    gainersInTop: 0,
    chanceGainers: 0,
    losers: 0,
    losersInBottom: 0,
    gapDays: 0,
    gapSumPpm: 0,
    gapUpDays: 0,
    liveNights: 0,
    goLiveNights: 0,
  };
  for (const day of days) {
    chance += day.chancePpm / PPM;
    for (const [name, p] of Object.entries(day.profiles)) {
      profiles[name] = addProfile(profiles[name] ?? emptyProfile(), p);
    }
    for (const g of day.detail.gainers) if (g.missed !== null) misses[g.missed] += 1;
    const c = day.cortex;
    if (c !== null) {
      cx.days += 1;
      if (c.basis === "golive") cx.goLiveNights += 1;
      else cx.liveNights += 1;
      cx.gainers += c.gainersN;
      cx.gainersInTop += c.gainersInTop;
      cx.chanceGainers += c.gainersN / TENTH;
      cx.losers += c.losersN;
      cx.losersInBottom += c.losersInBottom;
      if (c.gapPpm !== null) {
        cx.gapDays += 1;
        cx.gapSumPpm += c.gapPpm;
        cx.gapUpDays += c.gapPpm > 0 ? 1 : 0;
      }
    }
  }
  const ordered = Object.fromEntries(
    Object.keys(profiles)
      .sort((a, b) => PROFILE_ORDER.indexOf(a) - PROFILE_ORDER.indexOf(b) || byText(a, b))
      .map((k) => [k, profiles[k]!]),
  );
  return {
    v: SUMMARY_FORMAT,
    sessions: o.sessions,
    firstD: days[0]?.d ?? "",
    lastD: days[days.length - 1]?.d ?? "",
    days: days.length,
    picksN: days.reduce((a, d) => a + d.picksN, 0),
    daysWithPicks: days.filter((d) => d.picksN > 0).length,
    gainers: {
      total: days.reduce((a, d) => a + d.gainersN, 0),
      hits: days.reduce((a, d) => a + d.gainerHits, 0),
      daysWithHit: days.filter((d) => d.gainerHits > 0).length,
    },
    chanceHits: Math.round(chance * 10_000) / 10_000, // threshold-ok: four decimals
    losers: {
      total: days.reduce((a, d) => a + d.losersN, 0),
      hits: days.reduce((a, d) => a + d.loserHits, 0),
      daysWithHit: days.filter((d) => d.loserHits > 0).length,
    },
    profiles: ordered,
    misses,
    strategyNights: days.filter((d) => d.detail.picks.some((p) => p.source === "strategy")).length,
    cortex: { ...cx, chanceGainers: Math.round(cx.chanceGainers * 100) / 100 }, // threshold-ok: two decimals
    skipped: o.skipped ?? SKIPPED_DEFAULT,
  };
}

/** A stored summary read back; null when it is not a v1 summary. */
export function parseSummary(v: unknown): ScorecardSummary | null {
  if (v === null || typeof v !== "object") return null;
  const s = v as Partial<ScorecardSummary>;
  if (
    s.v !== SUMMARY_FORMAT ||
    typeof s.days !== "number" ||
    typeof s.chanceHits !== "number" ||
    s.gainers === undefined ||
    s.profiles === undefined ||
    s.cortex === undefined
  ) {
    return null;
  }
  return s as ScorecardSummary;
}

export { chanceDays };
