// Plain-words phrase helpers of the learning loop (cortex_learning_architecture C.7 `words.ts`, C.11;
// LRN-AT-9). Every Evening Review line the learner writes is built here from the phrases below and the
// caller's plain angle names. Never in the words (CTX-070 plus the learner's own list, LEARN_BANNED):
// gate ids, angle ids, "n_eff", "lower bound", "decile", ISO dates or times, "session(s)", statistic
// names. Spans of trading days are said in weeks ("four weeks", not "20 sessions"); dates as
// "Fri 6 Nov" (format.ts formatDay, with the year taken from the night, never from a clock); evidence
// as "chance of luck about 1 in N". Pure.
import { CARD_BANNED, CLUSTER_WORD, FAMILY_WORD } from "@/lib/cortex/phrases";
import { formatDay } from "@/lib/view/format";

/** Terms the learner's words must never contain (CTX-070 card list + LRN-AT-9). */
export const LEARN_BANNED: readonly RegExp[] = [
  ...CARD_BANNED,
  /\bA-D\d+-\d+\b/, // angle ids
  /\bF\d\.[a-z0-9.-]+/i, // threshold-ok: regex text; rule versions such as F1.learn, F1.v2-mom
  /\d{4}-\d{2}-\d{2}/, // threshold-ok: regex text; ISO dates
  /\d{2}:\d{2}:\d{2}/, // ISO times
  /\bsessions?\b/i,
  /e-?value/i,
  /p-?value/i,
  /\bIC\b/,
  /\bPSI\b/,
  /Page|Hinkley|mSPRT|bootstrap|shrunk|generation/i,
];

/** True when `text` contains none of the banned terms. */
export function cleanWords(text: string): boolean {
  return !LEARN_BANNED.some((re) => re.test(text));
}

const TRADING_DAYS_PER_WEEK = 5; // threshold-ok: five trading days a week
const NUMBER_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];
const LUCK_CEILING = 1000; // threshold-ok: beyond 1 in 1,000 the words stop counting
const PERCENT = 100; // threshold-ok: fraction to percent

/** "a week", "four weeks", "24 weeks"; spans that are not whole weeks as "13 trading days". */
export function spanWords(tradingDays: number): string {
  if (tradingDays % TRADING_DAYS_PER_WEEK !== 0) return `${tradingDays} trading days`;
  const weeks = tradingDays / TRADING_DAYS_PER_WEEK;
  if (weeks === 1) return "a week";
  return `${weeks < NUMBER_WORDS.length ? NUMBER_WORDS[weeks] : String(weeks)} weeks`;
}

/** "fires about once in 100 trading days by chance" for a null percentile such as 99. */
export function falseAlarmWords(faPct: number): string {
  const every = Math.round(PERCENT / (PERCENT - faPct));
  return `an alarm at the level that fires about once in ${every} trading days by chance`;
}

/** The evidence of an always-valid test as "chance of luck about 1 in N" (N ≈ e). */
export function luckWords(e: number): string {
  if (!(e > 1)) return "no better than chance so far";
  if (e >= LUCK_CEILING) return "chance of luck below 1 in 1,000";
  return `chance of luck about 1 in ${Math.round(e)}`;
}

/** A fraction as "1.1 %" (one decimal, sign kept). */
export function percentWords(fraction: number): string {
  return `${(fraction * PERCENT).toFixed(1)} %`;
}

/** A trading date as "Fri 6 Nov", the year shown only when it differs from tonight's. */
export function dayWords(d: string, tonight: string): string {
  return formatDay(d, new Date(`${tonight.slice(0, 10)}T12:00:00Z`));
}

const quoted = (name: string | undefined) => (name ? `'${name}'` : "one of the angles");

/** A list of names: "'a'", "'a' and 'b'", "'a', 'b' and 'c'". */
export function nameList(names: readonly string[]): string {
  const q = names.map((n) => quoted(n));
  if (q.length <= 1) return q.join("");
  return `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
}

export function familyWords(family: string | null | undefined): string {
  const w = family ? FAMILY_WORD[family] : undefined;
  return w ? `the ${w} setup` : "this setup";
}

export function clusterWords(cluster: string): string {
  return CLUSTER_WORD[cluster] ?? "another group of angles";
}

// ---- checkpoint lines (B.4) ------------------------------------------------------------------------

export const NOTHING_TO_CHANGE = "Review: nothing to change.";

export function dataBreakWords(name: string | undefined): string {
  return `Review: the figures behind ${quoted(name)} changed shape tonight, so this is data, not learning; nothing else was read into it.`;
}

export function watchWords(name: string | undefined, faPct: number): string {
  return `Review: ${quoted(name)} has slipped (${falseAlarmWords(faPct)}). On watch; its weight is already at its lowest, so nothing else changes.`;
}

export function capWords(
  name: string | undefined,
  faPct: number,
  untilD: string | null,
  tonight: string,
): string {
  const until = untilD
    ? `until ${dayWords(untilD, tonight)} or the Friday check, whichever comes first`
    : "until the Friday check";
  return `Review: ${quoted(name)} has slipped (${falseAlarmWords(faPct)}). On watch; its weight is halved in the learning Cortex ${until}.`;
}

export function rollbackWords(name: string | undefined, updateD: string, tonight: string): string {
  return `Review: the weekly update of ${dayWords(updateD, tonight)} gave more weight to ${quoted(name)}, which has slipped since; the increases of that update are undone.`;
}

export function riseWords(name: string | undefined): string {
  return `Review: ${quoted(name)} has picked up lately; only the Friday check can give it more weight.`;
}

export function quietWords(name: string | undefined, k: number, n: number): string {
  return `Review: ${quoted(name)} has gone quiet: ${k} of the last ${n} nights were below its usual level.`;
}

export function weeklyLimitWords(name: string | undefined): string {
  return `Review: ${quoted(name)} also raised an alarm, but this week's limit on review changes is reached, so it goes to the Friday check.`;
}

export function fallbackWords(
  family: string | null,
  e: number,
  againD: string | null,
  tonight: string,
): string {
  const again = againD
    ? `may be compared again from ${dayWords(againD, tonight)}`
    : "may be compared again in four weeks";
  return `Review: the learning Cortex has fallen behind the fixed one for ${familyWords(family)} (${luckWords(e)}). The fixed Cortex makes the decisions from tomorrow; the learner keeps running beside it and ${again}.`;
}

export function ownerOffWords(family: string | null): string {
  return `Review: the learning Cortex is switched off for ${familyWords(family)}; the fixed Cortex makes the decisions.`;
}

// ---- duel and weekly lines (C.5, C.11) --------------------------------------------------------------

export function switchWords(family: string | null, e: number, nights: number): string {
  return `The learning Cortex now makes the decisions for ${familyWords(family)}: on the ${nights} nights the two chose different shares and the results are in, it was ahead (${luckWords(e)}).`;
}

export function duelWords(input: {
  readonly agree: number;
  readonly nights: number;
  readonly mean: number;
  readonly e: number;
  readonly matured: number;
  readonly needed: number;
}): string {
  const differ = input.nights - input.agree;
  const lead =
    differ === 0
      ? "they have not differed yet."
      : `on the ${differ} nights they differed, the learner's pick was ${input.mean >= 0 ? "ahead" : "behind"} by ${percentWords(Math.abs(input.mean))} over four weeks (${luckWords(input.e)}).`;
  return `Learning Cortex vs fixed Cortex: they chose the same share on ${input.agree} of the last ${input.nights} nights; ${lead} The real test, trades held to the end, has ${input.matured} of the ${input.needed} results it needs.`;
}

export function reweightWords(input: {
  readonly changed: boolean;
  readonly up: readonly string[];
  readonly down: readonly string[];
  readonly maxStep: number;
  readonly realMove: number;
  readonly placeboMove: number | null;
}): string {
  if (!input.changed) {
    return "Weekly re-weighting: no weight moved by enough to matter, so the weights stay as they were.";
  }
  const parts: string[] = [];
  if (input.up.length > 0) parts.push(`more weight to ${nameList(input.up)}`);
  if (input.down.length > 0) parts.push(`less to ${nameList(input.down)}`);
  const what = parts.length > 0 ? parts.join(", ") : "small moves across the angles";
  const share =
    input.maxStep <= 0.25 // threshold-ok: phrase choice for the default trust region
      ? "at most a quarter of the way"
      : `at most ${percentWords(input.maxStep)} of the way`;
  let chance = "";
  if (input.placeboMove !== null) {
    const within = input.realMove <= input.placeboMove;
    chance = ` A Cortex learning from coin flips would have moved a weight by about ${percentWords(input.placeboMove)} this week; tonight's largest move was ${percentWords(input.realMove)}${within ? ", within chance" : ""}.`;
  }
  return `Weekly re-weighting: ${what}; weights move ${share}.${chance}`;
}

// ---- the weekly start and the nightly duel without a result yet (integration, D-941) ---------------

export function startWords(family: string | null): string {
  return `The learning Cortex starts beside the fixed one for ${familyWords(family)}, with the same weight on every angle; it records what it would do from the next trading day and may change weights on Fridays only.`;
}

export function duelWaitingWords(family: string | null): string {
  return `Learning Cortex vs fixed Cortex for ${familyWords(family)}: no four-week result is in yet, so there is nothing to compare.`;
}

export function capLiftWords(names: readonly string[]): string {
  return `The halved weight of ${nameList(names)} in the learning Cortex is back to its weekly level from the next trading day.`;
}
