// Glossary entries (UX-071b, UXN-031, UXN-032). Built from the one friendly-term table of the UI
// (`@/lib/view/terms`, official term kept) plus the words that only the Glossary explains: CIF,
// effective N, cost drag, effective cohorts, the evidence labels, the lesson grades and a few trading
// words. Plain data and a pure search: no codes, no names, nothing that depends on the viewer, so every
// role (masked or not) sees the same page. Each entry has a stable anchor (`#simulated`, ...) that the
// "More" link of a term popover and the Simulated label point at.
import { TERMS, validationLabel } from "@/lib/view/terms";

export type GlossaryEntry = {
  id: string;
  /** The friendly word as the app shows it. */
  term: string;
  /** The official term, when it differs (kept in exports, logs and the spec). */
  official: string | null;
  meaning: string;
  group: string;
};

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const FROM_TABLE: GlossaryEntry[] = TERMS.map((t) => ({
  id: slug(t.shown),
  term: t.shown,
  official: t.official === t.shown ? null : t.official,
  meaning: t.hover,
  group: "Words used in the app",
}));

const LABEL_MEANING: ReadonlyArray<readonly [string, string]> = [
  ["UNVALIDATED", "No test has been passed yet. The strategy is still only an idea in practice."],
  [
    "PASSED-BACKTEST",
    "It beat a luck check on past data it was not built on, and held up once more on data kept aside.",
  ],
  [
    "CONSISTENT-FORWARD",
    "It keeps beating the luck check in live practice: at least 100 practice trades over at least six months.",
  ],
  [
    "FAILED",
    "The test shows no useful edge: even its best case is below the smallest edge worth having.",
  ],
  [
    "NOT-DEMONSTRATED",
    "The test did not pass, but a useful edge has not been ruled out. More evidence is needed.",
  ],
  ["UNVALIDATABLE", "There is too little event data to test it at all yet."],
  [
    "possible luck",
    "It doubled its money without passing the past-data test, so it may just be luck.",
  ],
];

const FROM_LABELS: GlossaryEntry[] = LABEL_MEANING.map(([official, meaning]) => {
  const f = validationLabel(official);
  return {
    id: `evidence-${slug(official)}`,
    term: f.shown,
    official,
    meaning,
    group: "Evidence labels",
  };
});

const EXTRA: GlossaryEntry[] = [
  {
    id: "simulated",
    term: "Simulated",
    official: null,
    meaning:
      "Every amount in this app is pretend money. Nothing is bought or sold, and the app can never place a real order.",
    group: "Honesty",
  },
  {
    id: "cif",
    term: "Chance over time (CIF)",
    official: "CIF (cumulative incidence function)",
    meaning:
      "The share of rounds that reached the goal, hit the loss limit or ran out of time by a given point, counting only what has really happened so far, with a range that shows how sure we are.",
    group: "Statistics",
  },
  {
    id: "effective-n",
    term: "Independent rounds (effective N)",
    official: "Effective N",
    meaning:
      "How many separate rounds the evidence really counts. Rounds that overlap in time are not counted twice, so this is smaller than the number of rounds started.",
    group: "Statistics",
  },
  {
    id: "effective-cohorts",
    term: "Independent rounds that count",
    official: "Effective cohorts",
    meaning:
      "The rounds that do not overlap with each other. Only these are used when a range of uncertainty is worked out.",
    group: "Statistics",
  },
  {
    id: "cost-drag",
    term: "Cost drag",
    official: null,
    meaning:
      "How much of a strategy's return is eaten by trading fees and price slip. A strategy that looks good before costs can lose after them.",
    group: "Statistics",
  },
  {
    id: "grade-l0",
    term: "L0 Observation",
    official: "Lesson grade L0",
    meaning: "Something seen in the data. It has not been tested, so no advice rests on it.",
    group: "Lesson grades",
  },
  {
    id: "grade-l1",
    term: "L1 Hypothesis",
    official: "Lesson grade L1",
    meaning:
      "It held on the first part of the development data, with at least 30 relevant trades and a range that excludes zero.",
    group: "Lesson grades",
  },
  {
    id: "grade-l2",
    term: "L2 Tested",
    official: "Lesson grade L2",
    meaning: "It also held on a separate later part of the data that was not used to find it.",
    group: "Lesson grades",
  },
  {
    id: "grade-l3",
    term: "L3 Adopted",
    official: "Lesson grade L3",
    meaning: "It was adopted into the rules the strategies follow.",
    group: "Lesson grades",
  },
  {
    id: "stop-loss",
    term: "Stop-loss",
    official: null,
    meaning:
      "A price at which a practice trade is closed to limit the loss. Example: bought at A$4.00 with a stop-loss at A$3.70 loses about 7.5% at most, before fees and price slip.",
    group: "Trading words",
  },
  {
    id: "leverage",
    term: "Leverage",
    official: null,
    meaning:
      "Trading with borrowed money. It makes gains and losses bigger. Here it is only simulated.",
    group: "Trading words",
  },
  {
    id: "volume",
    term: "Volume",
    official: null,
    meaning:
      "How many shares changed hands in a day. Low volume means a price can move more on a small trade.",
    group: "Trading words",
  },
  {
    id: "moving-average",
    term: "Moving average",
    official: "50-day and 200-day moving average",
    meaning:
      "The average closing price over the last 50 or 200 days, redrawn each day. It smooths out day-to-day noise to show the trend.",
    group: "Trading words",
  },
  {
    id: "rsi",
    term: "RSI",
    official: "Relative strength index",
    meaning:
      "A number from 0 to 100 that compares recent rises with recent falls. Above 70 is often called stretched, below 30 beaten down. It is a clue, not a forecast.",
    group: "Trading words",
  },
  {
    id: "written-with-ai",
    term: "Written with AI / Written without AI today",
    official: null,
    meaning:
      "Shows who wrote the learned, worked-better and improve sections of an Evening Review: the AI, or the safe fallback that only lists the facts.",
    group: "Reviews",
  },
  {
    id: "partial-review",
    term: "Partial review",
    official: null,
    meaning:
      "A review sent at the deadline while some data was still missing. A complete version is stored later and replaces it here.",
    group: "Reviews",
  },
  {
    id: "stock-a",
    term: "Stock A, Stock B",
    official: null,
    meaning:
      "Stand-in names used when stock names are hidden for your access level. The letters stay the same for one day.",
    group: "Reviews",
  },
];

export const GLOSSARY: readonly GlossaryEntry[] = [...FROM_TABLE, ...FROM_LABELS, ...EXTRA];

/** Entries whose term, official term or meaning contains every word of `q` (case-insensitive). */
export function searchGlossary(q: string | undefined): GlossaryEntry[] {
  const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...GLOSSARY];
  return GLOSSARY.filter((e) => {
    const hay = `${e.term} ${e.official ?? ""} ${e.meaning}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
