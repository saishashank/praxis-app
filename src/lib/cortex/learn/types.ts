// Shared row types of the learning loop (cortex_learning_architecture C.6, migration 0031). Field names
// are the camelCase of the SQL columns, so store.ts maps them one to one. Pure types plus the closed
// lists the tables CHECK; no I/O.

/** Sessions between the feature night and the end of the forward return (C.6 `horizon`). */
export type Horizon = 1 | 20; // threshold-ok: C.6 CHECK (horizon IN (1, 20))

/** One `cortex_angle_day` row: an angle's nightly scorecard for one horizon. */
export type AngleDayRow = {
  readonly market: string;
  /** The night the row is known (features of an earlier night). */
  readonly d: string;
  readonly angleId: string;
  readonly angleVersion: number;
  readonly horizon: Horizon;
  readonly featureD: string;
  /** Liquid codes with a defined value. */
  readonly n: number;
  /** Spearman(feature, forward return); null when not computable. */
  readonly ic: number | null;
  readonly topExcessPpm: number | null;
  readonly bottomExcessPpm: number | null;
  readonly basePpm: number | null;
  readonly regime: string;
  readonly resultsSeason: 0 | 1;
  /** Feature distribution vs the prior 60 sessions, in ppm (0.25 = 250000). */
  readonly psiPpm: number | null;
  /** Movers excluded for news_before_open. */
  readonly excludedNews: number;
  readonly activeSetHash: string;
  readonly manifestId: string;
};

/** One `cortex_learn_compare` row: the paired top picks of a family's book on one decision night. */
export type CompareRow = {
  readonly market: string;
  readonly decisionD: string;
  readonly family: string;
  /** The real book; learner decisions are `bookId#learn` in cortex_decision. */
  readonly bookId: string;
  readonly fixedRuleVersion: string;
  readonly learnerRuleVersion: string;
  readonly learnerGeneration: number;
  /** Top pick each; null = abstained. */
  readonly fixedCode: string | null;
  readonly learnerCode: string | null;
  readonly agree: 0 | 1;
  readonly fixedRet1Ppm: number | null;
  readonly learnerRet1Ppm: number | null;
  readonly fixedRet20Ppm: number | null;
  readonly learnerRet20Ppm: number | null;
  readonly maturedD: string;
  readonly regime: string;
};

/** The `cortex_learn_event.kind` CHECK list (C.6), in that order. */
export const LEARN_EVENT_KINDS = [
  "scorecard",
  "checkpoint",
  "watch",
  "cap",
  "escalate",
  "reweight",
  "no_change",
  "bench",
  "unbench",
  "probe_open",
  "probe_close",
  "platt_refit",
  "switch",
  "fallback",
  "rollback",
  "placebo",
] as const;
export type LearnEventKind = (typeof LEARN_EVENT_KINDS)[number];

/** One `cortex_learn_event` row (without `created_at`, which the stage stamps from its own clock). */
export type LearnEvent = {
  readonly market: string;
  readonly d: string;
  readonly seq: number;
  readonly kind: LearnEventKind;
  readonly family: string | null;
  readonly angleId: string | null;
  readonly generation: number | null;
  /** Stored as `evidence_json` (canonical JSON). */
  readonly evidence: Readonly<Record<string, unknown>>;
  /** The Evening Review line, from the phrase helpers only (learnWords.ts). */
  readonly words: string;
  readonly reversesSeq: number | null;
  /** cap: the session on which the cap expires. */
  readonly expiresD: string | null;
};

export type Leader = "fixed" | "learner";
export type LeaderSetBy = "evaluator" | "fallback" | "owner_kill";

/** One `cortex_leader` row (latest `sinceD` per family wins; default leader 'fixed'). */
export type LeaderRow = {
  readonly market: string;
  readonly family: string;
  readonly sinceD: string;
  readonly leader: Leader;
  readonly learnerRuleVersion: string | null;
  readonly learnerGeneration: number | null;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly setBy: LeaderSetBy;
};

/** The learner's weights (C.2 `params_json.weights`): angle id → weight, cluster → weight. */
export type LearnerWeights = {
  readonly angle: Readonly<Record<string, number>>;
  readonly cluster: Readonly<Record<string, number>>;
};
