// Cortex card phrase table (M15 P4; CTX-070, AT-55). EVERY word a Cortex card shows is in `PHRASES`,
// `FAMILY_WORD`, `CLUSTER_WORD`, `SOURCE_WORD`, `REGIME_WORD` or a gate label (src/lib/cortex/gates/list.ts);
// the renderers below only join those pieces with the numbers of the card. A static test
// (tests/acceptance/v2/at55.test.ts) checks that no renderer contains a word of its own and that
// no phrase contains a banned term. Banned on a card (CTX-070): gate ids, n_eff, "lower bound",
// "decile". Pure: no I/O, no clock, no imports besides types.
import type { InputKind } from "./pit/types";

export const CARD_BANNED: readonly RegExp[] = [
  /\bG\d{2}_[a-z_0-9]+/i, // CTX-013 gate ids
  /\bO\d{2}_[a-z_0-9]+/i, // CTX-028 open-time ids
  /\b8[a-e]_[a-z_]+/i, // gate 8 sub-ids
  /n[_ ]?eff/i,
  /effective sample/i,
  /lower[ -]bound/i,
  /upper[ -]bound/i,
  /decile/i,
  /\bp_be\b/i,
];

export const PHRASES = {
  openTakenA: "Praxis would buy ",
  openTakenB: " tonight as a ",
  openNotTakenA: "Praxis looked at ",
  openNotTakenC: " but would not buy it.",
  openSetup: " setup",
  openEnd: " setup.",
  similarA: "About ",
  similarB: " in 10 similar past setups came out ahead after costs",
  similarRangeA: " (range ",
  similarRangeB: " to ",
  similarRangeC: " in 10)",
  similarN: ", based on ",
  similarNEnd: " past setups.",
  similarNone: "No estimate is shown for this setup.",
  beNone: "Break-even: Not measured yet.",
  beA: "Break-even: if costs take ",
  beB: " of the trade, about ",
  beC: " in 10 trades must come out ahead to pay for them.",
  forA: "Reasons for: ",
  forNone: "Reasons for: nothing stands out.",
  againstA: "Reasons against: ",
  againstNone: "Reasons against: nothing stands out.",
  listSep: ", ",
  listAnd: " and ",
  stopA: "What would have stopped us: ",
  stopNone: "Nothing would have stopped us.",
  regimeA: "Market mood: ",
  sourcesA: "Based on ",
  sourcesB: " independent kinds of information: ",
  sourcesOneB: " independent kind of information: ",
  sourcesNone: "No independent kinds of information were counted.",
  costA: "Costs for this order: ",
  costB: " of its value, in and out.",
  end: ".",
  pct: "%",
  abstainA: "No trade tonight for this book: ",
} as const;

export const FAMILY_WORD: Readonly<Record<string, string>> = {
  F1: "trend breakout",
  F2: "catalyst drift",
  F3: "event drift",
  F4: "mean reversion",
  F5: "small-company discovery",
  F6: "consensus",
  F7: "sector tilt",
};

export const CLUSTER_WORD: Readonly<Record<string, string>> = {
  momentum: "recent price strength",
  low_volatility: "calm trading",
  liquidity: "easy to buy and sell",
  event: "recent company news",
  quality: "company quality",
  sentiment: "the mood of the news",
};

export const SOURCE_WORD: Readonly<Record<InputKind, string>> = {
  bar_au: "daily prices",
  index_au: "the Australian market index",
  index_us: "the US market",
  asic_short: "short-selling reports",
  macro: "economic data",
  announcement: "company announcements",
  corp_action: "corporate actions",
  index_change: "index changes",
  calendar: "the trading calendar",
  sector_map: "industry groups",
};

export const REGIME_WORD: Readonly<Record<string, string>> = {
  SHOCK: "a sudden shock",
  "RISK-OFF": "cautious",
  "RISK-ON": "confident",
  NEUTRAL: "neutral",
  unknown: "not known yet",
};

/** The block a v2 card stores (src/lib/agents/cards.ts `CortexCardBlock`): whole numbers and words only. */
export type CardBlock = {
  readonly similar: {
    readonly p_ppm: number;
    readonly lo_ppm: number | null;
    readonly hi_ppm: number | null;
    readonly n: number;
  } | null;
  readonly break_even: readonly { readonly cost_ppm: number; readonly p_be_ppm: number }[];
  readonly reasons_for: readonly string[];
  readonly reasons_against: readonly string[];
  /** The plain label of the check that did not apply in this arm; never the check id. */
  readonly would_have_stopped: string | null;
  readonly independent_sources: readonly string[];
  readonly cost_per_order_ppm: number;
  /** The plain abstain label when this card records a night with no trade. */
  readonly abstain: string | null;
};

export type CardLineInput = {
  readonly code: string;
  readonly family: string;
  readonly taken: boolean;
  readonly regime: string;
  readonly cortex: CardBlock;
};

// ---- renderers: they join table entries and numbers, nothing else --------------------------------
const PPM = 1_000_000; // threshold-ok: parts per million
const TEN = 10; // threshold-ok: "in 10" scale
const PCT = 100; // threshold-ok: percent scale
const ONE_DP = 10; // threshold-ok: one decimal place

const tenths = (ppm: number): string => String(Math.round((ppm / PPM) * TEN));
const oneDp = (ppm: number): string => String(Math.round((ppm / PPM) * TEN * ONE_DP) / ONE_DP);
const percent = (ppm: number): string => `${Math.round((ppm / PPM) * PCT * ONE_DP) / ONE_DP}`;

/** "a, b and c" from table words. */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(PHRASES.listSep)}${PHRASES.listAnd}${words[words.length - 1]}`;
}

const word = (table: Readonly<Record<string, string>>, k: string): string => table[k] ?? k;
const THREE = 3; // threshold-ok: three reasons for and against

export function openingLine(c: CardLineInput): string {
  const fam = word(FAMILY_WORD, c.family);
  return c.taken
    ? `${PHRASES.openTakenA}${c.code}${PHRASES.openTakenB}${fam}${PHRASES.openEnd}`
    : `${PHRASES.openNotTakenA}${c.code}${PHRASES.openTakenB}${fam}${PHRASES.openSetup}${PHRASES.openNotTakenC}`;
}

export function similarLine(b: CardBlock): string {
  const s = b.similar;
  if (s === null) return PHRASES.similarNone;
  const range =
    s.lo_ppm === null || s.hi_ppm === null
      ? ""
      : `${PHRASES.similarRangeA}${tenths(s.lo_ppm)}${PHRASES.similarRangeB}${tenths(s.hi_ppm)}${PHRASES.similarRangeC}`;
  return `${PHRASES.similarA}${tenths(s.p_ppm)}${PHRASES.similarB}${range}${PHRASES.similarN}${s.n}${PHRASES.similarNEnd}`;
}

export function breakEvenLine(b: CardBlock): string {
  if (b.break_even.length === 0) return PHRASES.beNone;
  const costs = joinWords(b.break_even.map((x) => `${percent(x.cost_ppm)}${PHRASES.pct}`));
  const ps = joinWords(b.break_even.map((x) => oneDp(x.p_be_ppm)));
  return `${PHRASES.beA}${costs}${PHRASES.beB}${ps}${PHRASES.beC}`;
}

const reasons = (lead: string, none: string, clusters: readonly string[]): string =>
  clusters.length === 0
    ? none
    : `${lead}${joinWords(clusters.slice(0, THREE).map((k) => word(CLUSTER_WORD, k)))}${PHRASES.end}`;

export const reasonsForLine = (b: CardBlock): string =>
  reasons(PHRASES.forA, PHRASES.forNone, b.reasons_for);
export const reasonsAgainstLine = (b: CardBlock): string =>
  reasons(PHRASES.againstA, PHRASES.againstNone, b.reasons_against);

export const stoppedLine = (b: CardBlock): string =>
  b.would_have_stopped === null
    ? PHRASES.stopNone
    : `${PHRASES.stopA}${b.would_have_stopped}${PHRASES.end}`;

export const regimeLine = (regime: string): string =>
  `${PHRASES.regimeA}${word(REGIME_WORD, regime)}${PHRASES.end}`;

export function sourcesLine(b: CardBlock): string {
  if (b.independent_sources.length === 0) return PHRASES.sourcesNone;
  const names = b.independent_sources.map((k) => word(SOURCE_WORD as Record<string, string>, k));
  return `${PHRASES.sourcesA}${names.length}${names.length === 1 ? PHRASES.sourcesOneB : PHRASES.sourcesB}${joinWords(names)}${PHRASES.end}`;
}

export const costLine = (b: CardBlock): string =>
  `${PHRASES.costA}${percent(b.cost_per_order_ppm)}${PHRASES.pct}${PHRASES.costB}`;

/** The abstain line (CTX-070): the plain label only. */
export const abstainLine = (label: string): string => `${PHRASES.abstainA}${label}${PHRASES.end}`;

/** All lines of a Cortex card, in reading order. An abstain card is one line. */
export function cortexCardLines(c: CardLineInput): string[] {
  const b = c.cortex;
  if (b.abstain !== null) return [abstainLine(b.abstain)];
  return [
    openingLine(c),
    similarLine(b),
    breakEvenLine(b),
    reasonsForLine(b),
    reasonsAgainstLine(b),
    stoppedLine(b),
    regimeLine(c.regime),
    sourcesLine(b),
    costLine(b),
  ];
}
