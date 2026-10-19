// Lesson template catalogue and grade wording (M6 T4; ARN-063, KB-020; design 2.3; D-117 proposed).
//
// `LESSON_TEMPLATES_V1` is a versioned code table: each template says which development rows are
// relevant for a subject (a selector over attribution tags), which value is averaged, and how the
// subject is worded. Cells are enumerated on the L1 window and the SAME subject is then selected on the
// L2 window, so a subject (and its lesson id) means the same rows in both windows.
//
// Wording (KB-020): the verb of every rendered statement comes from the grade, never stronger than it
// ("was observed" L0, "may" L1, "held in a later test" L2, "adopted" L3). `renderStatement` refuses a
// text that contains a word reserved for a stronger grade.
import { createHash } from "node:crypto";
import { canonicalJson } from "../arena/cohort";
import type { WindowRow } from "./windows";
import { LessonError } from "./windows";

export type LessonGradeName = "L0" | "L1" | "L2" | "L3" | "retired";

/** One development signal-ledger row (or blocked signal) as the lesson engine reads it. */
export type LessonObs = WindowRow & {
  readonly id: string;
  readonly family: string;
  /** `executed` = a fixed-notional ledger row; `blocked` = a blocked signal's counterfactual path. */
  readonly kind: "executed" | "blocked";
  /** Excess over the mean of the row's controls (executed rows), a fraction (0.01 = 1 %). */
  readonly excess: number | null;
  /** Executed: net return; blocked: the counterfactual net return. A fraction. */
  readonly net: number;
  /** Excess under the stress profile (P3 + 50 % slippage); null when not computed. */
  readonly stressExcess: number | null;
  readonly regime: string | null;
  readonly tier: string | null;
  /** IS / CS / TB. */
  readonly exitKind: string | null;
  readonly holdSessions: number | null;
  /** Blocked rows: the filter or gate that stopped it. */
  readonly blockedBy: string | null;
  /** F6 evidence classes present on the row. */
  readonly evidenceClasses: readonly string[];
};

export type Subject = Readonly<Record<string, string | number>>;

export type LessonCell = {
  /** Group A rows (all relevant rows, or the first side of a difference). */
  readonly a: readonly LessonObs[];
  /** Group B rows for a difference of means; null for a single-group mean. */
  readonly b: readonly LessonObs[] | null;
};

export type LessonTemplate = {
  readonly id: string;
  readonly version: number;
  readonly scope: "lineage" | "market";
  /** Stored in `lesson.metric`. */
  readonly metric: string;
  /** Used in the wording. */
  readonly metricLabel: string;
  /** Families whose rows the template reads (lineage scope: the lineage's own family). */
  readonly families: readonly string[] | null;
  /** The value averaged for a row (null excludes the row from the cell). */
  readonly valueOf: (o: LessonObs) => number | null;
  /** The subjects present in the (L1-window) rows, in a fixed order. */
  readonly enumerate: (rows: readonly LessonObs[]) => Subject[];
  /** The cell of a subject on a set of rows. */
  readonly select: (rows: readonly LessonObs[], subject: Subject) => LessonCell;
  /** A rule parameter a challenger could move (KB-040 generator hint), if any. */
  readonly paramHint: (subject: Subject, family: string | null) => string | null;
  /** The subject as words, e.g. `entries in the regime "bull"`. */
  readonly describe: (subject: Subject, family: string | null) => string;
};

const EVENT_FAMILIES = ["F2", "F3", "F5"] as const;
const TECHNICAL_FAMILIES = ["F1", "F4"] as const;

const asc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function distinct(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))].sort(asc);
}

const executed = (rows: readonly LessonObs[]): LessonObs[] =>
  rows.filter((r) => r.kind === "executed" && r.excess !== null);

/** Nearest-rank terciles of the holding periods: the 1/3 and 2/3 edges (sessions). */
export function holdEdges(holds: readonly number[]): [number, number] | null {
  const n = holds.length;
  if (n < 3) return null; // threshold-ok: three terciles need three values
  const s = Float64Array.from(holds).sort();
  const at = (k: number): number => s[Math.min(n - 1, Math.max(0, Math.ceil((k * n) / 3) - 1))]!; // threshold-ok: terciles
  return [at(1), at(2)];
}

const excessOf = (o: LessonObs): number | null => o.excess;

function byTag(
  tag: "regime" | "tier" | "exitKind",
  field: string,
): Pick<LessonTemplate, "enumerate" | "select"> {
  return {
    enumerate: (rows) => distinct(executed(rows).map((r) => r[tag])).map((v) => ({ [field]: v })),
    select: (rows, subject) => ({
      a: executed(rows).filter((r) => r[tag] === subject[field]),
      b: null,
    }),
  };
}

export const LESSON_TEMPLATES_V1: readonly LessonTemplate[] = [
  {
    id: "LT-REGIME",
    version: 1,
    scope: "lineage",
    metric: "mean_excess",
    metricLabel: "mean excess return per trade",
    families: null,
    valueOf: excessOf,
    ...byTag("regime", "regime"),
    paramHint: () => null,
    describe: (s, f) => `${f ?? "family"} entries in the regime "${String(s.regime)}"`,
  },
  {
    id: "LT-TIER",
    version: 1,
    scope: "lineage",
    metric: "mean_excess",
    metricLabel: "mean excess return per trade",
    families: null,
    valueOf: excessOf,
    ...byTag("tier", "tier"),
    paramHint: () => null,
    describe: (s, f) => `${f ?? "family"} entries in tier ${String(s.tier)}`,
  },
  {
    id: "LT-EXIT",
    version: 1,
    scope: "lineage",
    metric: "mean_excess",
    metricLabel: "mean excess return per trade",
    families: null,
    valueOf: excessOf,
    ...byTag("exitKind", "exit"),
    paramHint: () => null,
    describe: (s, f) => `${f ?? "family"} trades that ended by exit kind ${String(s.exit)}`,
  },
  {
    id: "LT-HOLD",
    version: 1,
    scope: "lineage",
    metric: "mean_excess",
    metricLabel: "mean excess return per trade",
    families: null,
    valueOf: excessOf,
    enumerate: (rows) => {
      const ex = executed(rows).filter((r) => r.holdSessions !== null);
      const e = holdEdges(ex.map((r) => r.holdSessions!));
      if (!e) return [];
      return [1, 2, 3].map((tercile) => ({ tercile, e1: e[0], e2: e[1] })); // threshold-ok: terciles
    },
    select: (rows, s) => {
      const lo = Number(s.e1);
      const hi = Number(s.e2);
      const t = Number(s.tercile);
      return {
        a: executed(rows).filter((r) => {
          const h = r.holdSessions;
          if (h === null) return false;
          const k = h <= lo ? 1 : h <= hi ? 2 : 3; // threshold-ok: terciles
          return k === t;
        }),
        b: null,
      };
    },
    paramHint: (_s, f) => (f ? `${f.toLowerCase()}_max_hold` : null),
    describe: (s, f) =>
      `${f ?? "family"} trades with a holding period of ${
        Number(s.tercile) === 1
          ? `up to ${String(s.e1)} sessions`
          : Number(s.tercile) === 2 // threshold-ok: terciles
            ? `${String(s.e1)} to ${String(s.e2)} sessions`
            : `more than ${String(s.e2)} sessions`
      }`,
  },
  {
    id: "LT-COST",
    version: 1,
    scope: "lineage",
    metric: "mean_cost_drag",
    metricLabel: "mean cost drag per trade (stress minus P5 excess)",
    families: null,
    valueOf: (o) =>
      o.excess !== null && o.stressExcess !== null ? o.stressExcess - o.excess : null,
    enumerate: () => [{}],
    select: (rows) => ({
      a: executed(rows).filter((r) => r.stressExcess !== null),
      b: null,
    }),
    paramHint: () => null,
    describe: (_s, f) => `${f ?? "family"} trades under the stress cost profile`,
  },
  {
    id: "LT-FILTER",
    version: 1,
    scope: "lineage",
    metric: "mean_counterfactual_net",
    metricLabel: "mean counterfactual net return of the blocked signals",
    families: null,
    valueOf: (o) => (o.kind === "blocked" ? o.net : null),
    enumerate: (rows) =>
      distinct(rows.filter((r) => r.kind === "blocked").map((r) => r.blockedBy)).map((k) => ({
        filter: k,
      })),
    select: (rows, s) => ({
      a: rows.filter((r) => r.kind === "blocked" && r.blockedBy === s.filter),
      b: null,
    }),
    paramHint: (s) => `filter:${String(s.filter)}`,
    describe: (s, f) => `${f ?? "family"} signals blocked by ${String(s.filter)}`,
  },
  {
    id: "LT-EVTECH",
    version: 1,
    scope: "market",
    metric: "diff_mean_excess",
    metricLabel: "difference of mean excess return per trade (event minus technical)",
    families: [...EVENT_FAMILIES, ...TECHNICAL_FAMILIES],
    valueOf: excessOf,
    enumerate: () => [{}],
    select: (rows) => ({
      a: executed(rows).filter((r) => (EVENT_FAMILIES as readonly string[]).includes(r.family)),
      b: executed(rows).filter((r) => (TECHNICAL_FAMILIES as readonly string[]).includes(r.family)),
    }),
    paramHint: () => null,
    describe: () => "event families (F2, F3, F5) against technical families (F1, F4)",
  },
  {
    id: "LT-CLASS",
    version: 1,
    scope: "lineage",
    metric: "diff_mean_excess",
    metricLabel: "difference of mean excess return per trade (class present minus absent)",
    families: ["F6"],
    valueOf: excessOf,
    enumerate: (rows) =>
      distinct(executed(rows).flatMap((r) => r.evidenceClasses)).map((c) => ({
        evidenceClass: c,
      })),
    select: (rows, s) => {
      const ex = executed(rows);
      const has = (r: LessonObs): boolean => r.evidenceClasses.includes(String(s.evidenceClass));
      return { a: ex.filter(has), b: ex.filter((r) => !has(r)) };
    },
    paramHint: () => null,
    describe: (s) => `F6 entries with evidence class ${String(s.evidenceClass)} present`,
  },
];

export function templateById(id: string): LessonTemplate | undefined {
  return LESSON_TEMPLATES_V1.find((t) => t.id === id);
}

/** The identity of a template version, as listed in "withdrawn" sets. */
export const templateKey = (t: { id: string; version: number }): string => `${t.id}@${t.version}`;

/** `L-<market>-<template>-<subject_sha8>-<rule_version>` (design 2.3). */
export function lessonId(
  market: string,
  templateId: string,
  subject: Subject,
  ruleVersion: string,
): string {
  const sha8 = createHash("sha256").update(canonicalJson(subject)).digest("hex").slice(0, 8); // threshold-ok: 8 hex chars
  return `L-${market}-${templateId}-${sha8}-${ruleVersion}`;
}

// ---- wording -----------------------------------------------------------------------------------------------

/** Words reserved for a stronger grade; a statement at grade g must not contain those of a stronger one. */
const FORBIDDEN: Readonly<Record<LessonGradeName, RegExp>> = {
  L0: /\b(may|held|adopted|confirmed|proven|demonstrated)\b/i,
  L1: /\b(held|adopted|confirmed|proven|demonstrated)\b/i,
  L2: /\b(adopted|proven|demonstrated)\b/i,
  L3: /\b(proven|demonstrated)\b/i,
  retired: /\b(may|held|adopted|confirmed|proven|demonstrated)\b/i,
};

/** The verb phrase of each grade (KB-020). */
export const GRADE_VERB: Readonly<Record<LessonGradeName, string>> = {
  L0: "was observed",
  L1: "may reflect a real effect",
  L2: "held in a later test",
  L3: "is adopted",
  retired: "is retired",
};

const sign = (x: number): string => (x < 0 ? "-" : "+");
const PERCENT = 100; // threshold-ok: display scale (fraction to percent)

/** `+0.40 %` from a fraction. */
export function pctText(x: number): string {
  return `${sign(x)}${Math.abs(x * PERCENT).toFixed(2)} %`; // threshold-ok: two decimals
}

export type StatementInput = {
  readonly template: LessonTemplate;
  readonly subject: Subject;
  readonly family: string | null;
  readonly grade: LessonGradeName;
  readonly n: number;
  readonly estimate: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly p: number | null;
  readonly alphaJ: number | null;
  /** The interval level in percent, e.g. 90. */
  readonly intervalPct: number;
  /** Text of the grade state, e.g. "L2 test not passed", used by retired lessons. */
  readonly stateText: string;
};

/** The statement of a lesson at its grade (KB-020: never stronger than the grade). */
export function renderStatement(i: StatementInput): string {
  const subject = i.template.describe(i.subject, i.family);
  const metric = i.template.metricLabel;
  const est = i.estimate === null ? "n/a" : pctText(i.estimate);
  const span =
    i.lower !== null && i.upper !== null
      ? `${String(i.intervalPct)} % interval ${pctText(i.lower)} to ${pctText(i.upper)}, `
      : "";
  let text: string;
  switch (i.grade) {
    case "L0":
      text = `${subject}: ${metric} of ${est} ${GRADE_VERB.L0} over n = ${String(i.n)} trades (an observation, no test).`;
      break;
    case "L1":
      text = `${subject}: ${metric} of ${est} (${span}n = ${String(i.n)}) ${GRADE_VERB.L1}; a hypothesis, not yet checked on later data.`;
      break;
    case "L2":
      text = `${subject}: ${metric} of ${est} ${GRADE_VERB.L2} (n = ${String(i.n)}, p = ${i.p === null ? "n/a" : i.p.toFixed(4)} at level ${i.alphaJ === null ? "n/a" : i.alphaJ.toFixed(4)}).`; // threshold-ok: display digits
      break;
    case "L3":
      text = `${subject}: ${metric} of ${est}; this lesson ${GRADE_VERB.L3} (it held in a later test and passed the Critic checks).`;
      break;
    case "retired":
      text = `${subject}: this lesson ${GRADE_VERB.retired}${i.stateText ? ` (${i.stateText})` : ""}.`;
      break;
  }
  if (FORBIDDEN[i.grade].test(text) && i.grade !== "retired") {
    const stronger = FORBIDDEN[i.grade].exec(text)?.[0] ?? "";
    throw new LessonError(
      "wording_too_strong",
      `statement at ${i.grade} contains "${stronger}", reserved for a stronger grade`,
    );
  }
  return text;
}
