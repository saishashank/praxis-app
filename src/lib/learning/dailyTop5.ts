// D-990…D-996 (Owner 2026-11-11: "I want to see the top 5 of top gainers in our picks or intraday
// consistently. That should be your target."): the nightly top-5 gainer measure of the daily learning.
// Pure: no database, no clock.
//
//   The five biggest gainers (and the five biggest losers) of session d among the liquid shares (U1/U2,
//   active, not halted), close to close, from the daily loop's World. A gainer counts as NAMED BEFORE IT
//   MOVED when it was
//     - in the picks published the evening before (any profile: strategy, shortlist or candidate
//       measure; the picks are published after the close of the session before d, so before d's open),
//       or
//     - an intraday candidate of session d found while the share was up less than half of its final
//       day gain (move at the time it was found < final close-to-close gain / 2).
//   A loser counts when it was in the evening-before picks (an intraday candidate is never a short).
//   Each missed gainer gets a cause from the daily loop's explanation: news before the open, a sector
//   move, a market move, news during the day, else "no measure".
//   Chance baseline: named shares / liquid shares x 5 = how many of the five a random list of the same
//   size would hold; "about 1 day in N" = 1 / that number.
//   Rolling: the last 20 stored nights (four weeks), hits against the summed chance.
// No look-ahead: d's gainers are known only after d's close; the picks counted were published before d's
// open, the intraday candidates were found during d at a move below half of the final one.
import type { MoverCause } from "./daily";

/** How many of the biggest gainers and losers the target looks at. */
export const TOP_N = 5; // threshold-ok: Owner 2026-11-11 "top 5 of top gainers"
/** An intraday candidate counts only when found below this share of the share's final day gain. */
export const INTRADAY_MOVE_SHARE = 0.5; // threshold-ok: D-991 "before it had made most of its move"
/** Nights in the rolling rate (four weeks of trading days). */
export const ROLLING_NIGHTS = 20; // threshold-ok: four weeks of trading days
const PPM_PER_PCT = 10_000; // threshold-ok: parts per million in one percent

export type MoveLike = { readonly code: string; readonly movePpm: number };

export type Top5Sets = {
  readonly gainers: readonly MoveLike[];
  readonly losers: readonly MoveLike[];
};

/** The five biggest liquid gainers (biggest first) and losers (biggest fall first) of the night. */
export function top5Movers(moves: readonly MoveLike[], liquid: readonly string[]): Top5Sets {
  const ok = new Set(liquid);
  const live = moves.filter((m) => ok.has(m.code));
  const byCode = (a: MoveLike, b: MoveLike): number => (a.code < b.code ? -1 : 1);
  const gainers = live
    .filter((m) => m.movePpm > 0)
    .sort((a, b) => b.movePpm - a.movePpm || byCode(a, b))
    .slice(0, TOP_N);
  const losers = live
    .filter((m) => m.movePpm < 0)
    .sort((a, b) => a.movePpm - b.movePpm || byCode(a, b))
    .slice(0, TOP_N);
  return { gainers, losers };
}

/** Where a share was named the evening before: a pick of one source (the picks side's words). */
export type PickSource = "strategy" | "shortlist" | "candidate";
export type PickedBefore = { readonly where: string; readonly source: PickSource };

/** One intraday candidate of session d: when it was found and the share's move at that time. */
export type IntradayFound = {
  readonly code: string;
  readonly foundAt: string;
  readonly movePpm: number;
};

/** The missed-gainer causes in the Owner's words (D-992). */
export type MissCause =
  "news_before_open" | "sector_move" | "market_move" | "news_during_day" | "no_measure";

export const MISS_WORDS: Readonly<Record<MissCause, string>> = {
  news_before_open: "news before the open",
  sector_move: "sector move",
  market_move: "market move",
  news_during_day: "news during the day",
  no_measure: "no measure",
};

export function missCause(cause: MoverCause | null): MissCause {
  if (cause === "news_before_open") return "news_before_open";
  if (cause === "sector_move") return "sector_move";
  if (cause === "market_move") return "market_move";
  if (cause === "news_during_day") return "news_during_day";
  return "no_measure";
}

export type Top5Entry = {
  readonly code: string;
  readonly name: string | null;
  readonly movePpm: number;
  /** "pick" source or "intraday"; null = not named before it moved. */
  readonly via: PickSource | "intraday" | null;
  /** The pick's place ("Balanced #2") or the intraday find time; null when not named. */
  readonly where: string | null;
  /** For a gainer not named: why it was missed; null otherwise. */
  readonly missed: MissCause | null;
};

export type Top5Night = {
  readonly d: string;
  readonly liquid: number;
  /** Distinct liquid shares named before d's open (picks) or found intraday on d. */
  readonly named: number;
  readonly gainers: readonly Top5Entry[];
  readonly gainersHad: number;
  readonly losers: readonly Top5Entry[];
  readonly losersHad: number;
  /** The evening-before picks: how many had a move on d, how many rose and fell, the mean move. */
  readonly picks: {
    readonly n: number;
    readonly up: number;
    readonly down: number;
    readonly meanMovePpm: number | null;
  };
  /** Chance: how many of the five a random list of `named` liquid shares would hold. */
  readonly chanceHits: number;
  /** The four-week rolling rate (this night included). */
  readonly rolling: Top5Rolling;
};

export type Top5Rolling = {
  readonly nights: number;
  readonly gainers: number;
  readonly had: number;
  readonly chanceHits: number;
};

/** Tonight's measure (pure). `explain` gives a share's daily-loop cause and name. */
export function top5Night(x: {
  readonly d: string;
  readonly sets: Top5Sets;
  readonly liquid: readonly string[];
  readonly allMoves: readonly MoveLike[];
  readonly picked: ReadonlyMap<string, PickedBefore>;
  readonly intraday: readonly IntradayFound[];
  readonly explain: (
    code: string,
    side: "gainer" | "loser",
  ) => { cause: MoverCause | null; name: string | null };
  /** The stored nights before d (oldest first), at most ROLLING_NIGHTS - 1 of them. */
  readonly history: readonly Pick<Top5Night, "gainers" | "gainersHad" | "chanceHits">[];
}): Top5Night {
  const liquid = new Set(x.liquid);
  const firstFound = new Map<string, IntradayFound>();
  for (const f of [...x.intraday].sort((a, b) => (a.foundAt < b.foundAt ? -1 : 1))) {
    if (!firstFound.has(f.code)) firstFound.set(f.code, f);
  }
  const named = new Set<string>();
  for (const c of [...x.picked.keys(), ...firstFound.keys()]) if (liquid.has(c)) named.add(c);
  const entry = (m: MoveLike, side: "gainer" | "loser"): Top5Entry => {
    const e = x.explain(m.code, side);
    const p = x.picked.get(m.code);
    if (p !== undefined) {
      return {
        code: m.code,
        name: e.name,
        movePpm: m.movePpm,
        via: p.source,
        where: p.where,
        missed: null,
      };
    }
    const f = side === "gainer" ? firstFound.get(m.code) : undefined;
    if (f !== undefined && f.movePpm < m.movePpm * INTRADAY_MOVE_SHARE) {
      return {
        code: m.code,
        name: e.name,
        movePpm: m.movePpm,
        via: "intraday",
        where: f.foundAt,
        missed: null,
      };
    }
    return {
      code: m.code,
      name: e.name,
      movePpm: m.movePpm,
      via: null,
      where: null,
      missed: side === "gainer" ? missCause(e.cause) : null,
    };
  };
  const gainers = x.sets.gainers.map((m) => entry(m, "gainer"));
  const losers = x.sets.losers.map((m) => entry(m, "loser"));
  const moveOf = new Map(x.allMoves.map((m) => [m.code, m.movePpm]));
  const pickMoves = [...x.picked.keys()]
    .sort()
    .map((c) => moveOf.get(c))
    .filter((v): v is number => v !== undefined);
  const chanceHits =
    liquid.size === 0
      ? 0
      : (Math.min(named.size, liquid.size) / liquid.size) * x.sets.gainers.length;
  const gainersHad = gainers.filter((g) => g.via !== null).length;
  const prior = x.history.slice(-(ROLLING_NIGHTS - 1));
  return {
    d: x.d,
    liquid: liquid.size,
    named: named.size,
    gainers,
    gainersHad,
    losers,
    losersHad: losers.filter((l) => l.via !== null).length,
    picks: {
      n: pickMoves.length,
      up: pickMoves.filter((v) => v > 0).length,
      down: pickMoves.filter((v) => v < 0).length,
      meanMovePpm:
        pickMoves.length === 0
          ? null
          : Math.round(pickMoves.reduce((a, b) => a + b, 0) / pickMoves.length),
    },
    chanceHits,
    rolling: {
      nights: prior.length + 1,
      gainers: prior.reduce((a, n) => a + n.gainers.length, 0) + gainers.length,
      had: prior.reduce((a, n) => a + n.gainersHad, 0) + gainersHad,
      chanceHits: prior.reduce((a, n) => a + n.chanceHits, 0) + chanceHits,
    },
  };
}

/** A stored night read back (a malformed one is skipped). */
export function parseTop5(v: unknown): Top5Night | null {
  if (v === null || typeof v !== "object") return null;
  const t = v as Partial<Top5Night>;
  if (
    typeof t.d !== "string" ||
    !Array.isArray(t.gainers) ||
    typeof t.gainersHad !== "number" ||
    typeof t.chanceHits !== "number" ||
    !Number.isFinite(t.chanceHits) ||
    t.rolling === null ||
    typeof t.rolling !== "object"
  ) {
    return null;
  }
  return t as Top5Night;
}

// ---- words -----------------------------------------------------------------------------------------

const NUMBER = ["none", "one", "two", "three", "four", "five"];
const n0 = (n: number): string => NUMBER[n] ?? String(n);
const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const join = (xs: readonly string[]): string =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]!}`;

const VIA_WORDS: Readonly<Record<PickSource | "intraday", string>> = {
  strategy: "in the picks",
  shortlist: "in the picks, from the shortlist",
  candidate: "in the picks, from a candidate measure",
  intraday: "as an intraday alert before most of its move",
};

/** "Name (CODE)", the code alone when the name is unknown: the form of reviewWords companyLabel (not
 *  imported: the review words import this file). The name is the daily loop's displayName. */
const label = (e: Top5Entry): string =>
  e.name === null || e.name === "" || e.name === "n/a" ? e.code : `${e.name} (${e.code})`;

/** "about 1 day in 4" for an expected number of hits per day; null when it is not below one a day. */
export function chanceDays(expected: number): string {
  if (!(expected > 0)) return "never by chance";
  if (expected >= 1) return "about every day by chance";
  return `about 1 day in ${Math.round(1 / expected)} by chance`;
}

const one = (x: number): string => (Math.round(x * 10) / 10).toFixed(1); // threshold-ok: one decimal

const pctOf = (ppm: number): string => {
  const v = Number((ppm / PPM_PER_PCT).toFixed(1)); // threshold-ok: one decimal
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`; // threshold-ok: one decimal
};

/** The night's lines, first line first (the Evening Review opens its learning section with them). */
export function top5Lines(t: Top5Night): string[] {
  if (t.gainers.length === 0) {
    return ["Top 5 gainers today: no large or mid-size share rose, so there was nothing to catch."];
  }
  const had = t.gainers.filter((g) => g.via !== null);
  const news = t.gainers.filter((g) => g.via === null && g.missed === "news_before_open");
  const missed = t.gainers.filter((g) => g.via === null && g.missed !== "news_before_open");
  const parts: string[] = [];
  parts.push(
    had.length === 0
      ? "we had none"
      : `we had ${n0(had.length)} (${had.map((g) => `${label(g)} ${VIA_WORDS[g.via!]}`).join("; ")})`,
  );
  if (news.length > 0) parts.push(`${n0(news.length)} moved on news before the open`);
  if (missed.length > 0) {
    parts.push(
      `${n0(missed.length)} we missed (${missed.map((g) => MISS_WORDS[g.missed ?? "no_measure"]).join(", ")})`,
    );
  }
  const chance =
    t.chanceHits > 0
      ? ` A random list as long as ours would hold one ${chanceDays(t.chanceHits).replace(" by chance", "")}.`
      : "";
  const out: string[] = [
    `${t.gainers.length === 1 ? "Top gainer" : `Top ${t.gainers.length} gainers`} today: ${parts.join("; ")}.${chance}`,
  ];
  const badLosers = t.losers.filter((l) => l.via !== null);
  if (t.losers.length > 0) {
    out.push(
      badLosers.length === 0
        ? t.losers.length === 1
          ? "The biggest loser was not in our picks."
          : `None of the ${n0(t.losers.length)} biggest losers was in our picks.`
        : `${sentence(n0(badLosers.length))} of the ${n0(t.losers.length)} biggest losers ${badLosers.length === 1 ? "was" : "were"} in our picks (${join(badLosers.map(label))}).`,
    );
  }
  if (t.picks.meanMovePpm !== null) {
    out.push(
      `The picks of the evening before ${t.picks.meanMovePpm >= 0 ? "made money" : "lost money"} on the day overall: ${pctOf(t.picks.meanMovePpm)} on average (${t.picks.up} up, ${t.picks.down} down).`,
    );
  }
  out.push(rollingLine(t.rolling));
  return out;
}

/** The four-week line (also the Home line). */
export function rollingLine(r: Top5Rolling): string {
  if (r.gainers === 0) return "Top 5 gainers over the last four weeks: nothing stored yet.";
  const rate = Math.round((100 * r.had) / r.gainers); // threshold-ok: percent
  const chance = Math.round((100 * r.chanceHits) / r.gainers); // threshold-ok: percent
  const days = r.nights === 1 ? "tonight only" : `the last ${r.nights} trading days`;
  return `Top 5 gainers named before they moved, ${days}: ${r.had} of ${r.gainers} (${rate}%), against about ${one(r.chanceHits)} by chance (${chance}%).`;
}
