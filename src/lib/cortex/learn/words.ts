// The learning Cortex's plain market words (design C.7 "words.ts", C.11; LRN-AT-9). Pure. The CTX-070
// rule for Owner text applies: no angle ids, no gate ids, no ISO dates or times, no "IC", "decile",
// "n_eff" or "lower bound". Angles are named by their registry title, days with formatDay ("Tue 10 Nov"),
// four weeks rather than "20 sessions". Every sentence is built here from the numbers of the night.
import { angleById } from "../angles/registry";
import { baseIdOf } from "../angles/trial";
import { CARD_BANNED } from "../phrases";
import { formatDay } from "@/lib/view/format";
import { PSI_BREAK_PPM, type AngleDayRow, type MoverCoverage } from "./scorecard";
import type { Top5Flags } from "./top5";

/** What the Evening Review shows under "What the brain learned" (stored in daily_learning.body_json). */
export type CortexLearnSection = {
  readonly lines: readonly string[];
  readonly numbers: {
    /** Scorecard rows of the night (angles x horizons). */
    readonly rows: number;
    readonly angles: number;
    /** Horizon-1 angles with a result, and how many pointed the right way. */
    readonly nextDayOf: number;
    readonly nextDayRight: number;
    /** Horizon-1 angles whose inputs moved like a data break. */
    readonly dataBreaks: number;
    readonly coverage: MoverCoverage | null;
    /** The learner's night (duel, checkpoint, leader; stage.ts learnerNight); absent without a learner. */
    readonly learner?: LearnerNightNumbers;
    /** D-986: per measure (scored set and open probes), did its top tenth hold a top-5 gainer / loser. */
    readonly top5?: Top5Flags;
    /** D-1860: the night's trial scores (angles not yet proven); absent when there were none. */
    readonly trial?: {
      readonly rows: number;
      readonly angles: number;
      readonly nextDayOf: number;
      readonly nextDayRight: number;
    };
  };
};

/** D-1860: how the review calls scores of angles that are not yet proven. */
export const TRIAL_LABEL = "trial scores (angles not yet proven)";
/** D-1860: said when the Cortex holds no angle history at all (nothing was ever loaded). */
export const NO_HISTORY_WORDS =
  "The Cortex's history has not been loaded yet, so the day's biggest movers cannot be checked against it.";

/** The learner's numbers of a night (integration step 3; D-927, D-928). */
export type LearnerNightNumbers = {
  readonly family: string;
  readonly generation: number;
  readonly leader: "fixed" | "learner";
  readonly compareMatured: number;
  readonly duelNights: number;
  readonly duelAgree: number;
  readonly eBetter20: number;
  readonly eWorse20: number;
  readonly matured: number;
  readonly checkpoint: boolean;
  readonly actions: readonly string[];
  readonly mapRowWritten: boolean;
  readonly leaderChange: "switch" | "fallback" | "owner_kill" | null;
};

/** The scorecard's closing line (left out on a night the learner's review lowered a weight). */
export const NO_WEIGHT_CHANGED =
  "No weight changed tonight; the Cortex is never re-weighted on one night's results.";

/** Owner-text bans on top of the card list (CTX-070, LRN-AT-9). */
export const LEARN_BANNED: readonly RegExp[] = [
  ...CARD_BANNED,
  /\bA-D\d+-\d+\b/, // angle ids
  /\b\d{4}-\d{2}-\d{2}\b/, // threshold-ok: ISO date pattern
  /\bIC\b/,
  /\bPSI\b/i,
  /\bsessions?\b/i,
];

const PCT_PER_PPM = 10_000; // threshold-ok: parts per million in one percent
const MAX_NAMES = 3; // threshold-ok: angles named in one sentence before "and N more"

/** An angle's display name (registry title, quoted); never its id. */
export function angleName(id: string): string {
  const t = angleById(baseIdOf(id))?.title;
  return t === undefined ? "an unnamed angle" : `'${t}'`;
}

/** "1.1%" (no sign: the sentence says "beat" or "lagged"). */
export function pctAbs(ppm: number): string {
  return `${Number(Math.abs(ppm / PCT_PER_PPM).toFixed(1)).toFixed(1)}%`; // threshold-ok: one decimal
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

function names(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_NAMES).map(angleName);
  const more = ids.length - shown.length;
  const all = more > 0 ? [...shown, `${more} more`] : shown;
  return all.length <= 1
    ? (all[0] ?? "")
    : `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]!}`;
}

const beatOrLag = (ppm: number): string =>
  ppm >= 0
    ? `beat the average share by ${pctAbs(ppm)}`
    : `lagged the average share by ${pctAbs(ppm)}`;

/** The coverage sentence: the night's movers against the Cortex's top tenth the evening before. */
export function coverageWords(day: string, c: MoverCoverage | null, historyLoaded = true): string {
  if (c === null) {
    return historyLoaded
      ? `The Cortex stored no scores for the evening before ${day}, so the day's biggest movers cannot be checked against it.`
      : NO_HISTORY_WORDS;
  }
  const lead = c.trial === true ? `Judged on ${TRIAL_LABEL}, of` : "Of";
  let s = `${lead} the ${c.gainers} biggest gainers on ${day}, the Cortex had ${c.gainersInTop} in its top tenth the evening before, and ${c.losersInTop} of the ${c.losers} biggest losers.`;
  if (c.gainersInTop > 0 && c.losersInTop > 0) s += " Its favourite shares moved both ways.";
  if (c.newsBeforeOpen > 0) {
    s += ` ${c.newsBeforeOpen} of the ${c.gainers + c.losers} moved on company news published before the open, which nothing in prices could have seen`;
    s +=
      c.newsInTop > 0
        ? ` (the Cortex had ${c.newsInTop} of ${plural(c.newsInTop, "that one", "those")} in its top tenth).`
        : ".";
  }
  return s;
}

/** The next-day sentence of a set of rows; null when no angle had a result. `label` marks trial scores. */
function nextDayLine(rows: readonly AngleDayRow[], label: string): string | null {
  const next = rows.filter((r) => r.horizon === 1 && r.ic !== null);
  if (next.length === 0) return null;
  const right = next.filter((r) => r.ic! > 0);
  const best = [...next].sort((a, b) => b.ic! - a.ic! || (a.angleId < b.angleId ? -1 : 1))[0]!;
  let s = `For the next day, ${label}${right.length} of the ${next.length} ${plural(next.length, "angle", "angles")} pointed the right way`;
  s +=
    best.ic! > 0 && best.topExcessPpm !== null
      ? `; the clearest was ${angleName(best.angleId)}, whose favourite shares ${beatOrLag(best.topExcessPpm)}.`
      : ".";
  return s;
}

/** The four-week sentence of a set of rows; null when no angle had a result. */
function monthLine(rows: readonly AngleDayRow[], label: string): string | null {
  const month = rows
    .filter((r) => r.horizon === 20 && r.topExcessPpm !== null) // threshold-ok: the four-week horizon (C.6)
    .sort((a, b) => b.topExcessPpm! - a.topExcessPpm! || (a.angleId < b.angleId ? -1 : 1));
  if (month.length === 0) return null;
  const b = month[0]!;
  let s = `Over the last four weeks, ${label}the shares ${angleName(b.angleId)} liked most ${beatOrLag(b.topExcessPpm!)}`;
  if (month.length > 1) {
    const w = month[month.length - 1]!;
    s += `; those ${angleName(w.angleId)} liked most ${beatOrLag(w.topExcessPpm!).replace("the average share", "it")}`;
  }
  return `${s}.`;
}

/** The lines of the night, in the order the review shows them. */
export function scorecardWords(x: {
  readonly d: string;
  /** The proven angles' rows (never trial rows). */
  readonly rows: readonly AngleDayRow[];
  /** D-1860: rows of angles not yet proven; worded as trial and only when the proven angles have no result. */
  readonly trialRows?: readonly AngleDayRow[];
  /** D-1860: false when the Cortex holds no angle passport at all (its history was never loaded). */
  readonly historyLoaded?: boolean;
  readonly coverage: MoverCoverage | null;
  /** Anchors formatDay (the year only when it differs); never read as a clock. */
  readonly now: Date;
}): CortexLearnSection {
  const day = formatDay(x.d, x.now);
  const trialRows = x.trialRows ?? [];
  const loaded = x.historyLoaded ?? true;
  const lines: string[] = [coverageWords(day, x.coverage, loaded)];
  const next = x.rows.filter((r) => r.horizon === 1 && r.ic !== null);
  const right = next.filter((r) => r.ic! > 0);
  lines.push(
    nextDayLine(x.rows, "") ??
      nextDayLine(trialRows, `on ${TRIAL_LABEL}, `) ??
      "No angle had enough scored shares to judge the next day.",
  );
  lines.push(
    monthLine(x.rows, "") ??
      monthLine(trialRows, `on ${TRIAL_LABEL}, `) ??
      (loaded
        ? "There are not yet four weeks of stored Cortex scores to judge the angles over a month."
        : "The Cortex's history has not been loaded yet, so the angles cannot be judged over a month."),
  );
  const breaks = x.rows
    .filter((r) => r.horizon === 1 && r.psiPpm !== null && r.psiPpm >= PSI_BREAK_PPM)
    .map((r) => r.angleId);
  if (breaks.length > 0) {
    lines.push(
      `The inputs of ${names(breaks)} look different from the last three months, so ${plural(breaks.length, "its result reads", "their results read")} as a data change tonight, not a lesson.`,
    );
  }
  lines.push(NO_WEIGHT_CHANGED);
  return {
    lines,
    numbers: {
      rows: x.rows.length,
      angles: new Set(x.rows.map((r) => r.angleId)).size,
      nextDayOf: next.length,
      nextDayRight: right.length,
      dataBreaks: breaks.length,
      coverage: x.coverage,
      ...(trialRows.length === 0
        ? {}
        : {
            trial: {
              rows: trialRows.length,
              angles: new Set(trialRows.map((r) => r.angleId)).size,
              nextDayOf: trialRows.filter((r) => r.horizon === 1 && r.ic !== null).length,
              nextDayRight: trialRows.filter((r) => r.horizon === 1 && r.ic !== null && r.ic > 0)
                .length,
            },
          }),
    },
  };
}

/** The one-line words of the 'scorecard' event (the first two lines). */
export function eventWords(s: CortexLearnSection): string {
  return s.lines.slice(0, 2).join(" ");
}

/** True when a line holds a banned term (LRN-AT-9). */
export function hasBannedTerm(line: string): boolean {
  return LEARN_BANNED.some((re) => re.test(line));
}
