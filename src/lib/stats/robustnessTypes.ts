// JSON shapes of the M14 `replay_stat` metrics (docs/M14_design.md 2.1, 2.2, 2.8). Types only, no
// logic: the writers (WP3 robustness stage, WP4 rank-quality and MinBTL) and the Strategies loader
// (WP8) all build against these, so the UI can be tested with seeded rows before the writers exist.
// Every metric is descriptive ("not a finding"); scope is the execution or lineage id like `zero_edge`.

export const ROBUSTNESS_METRICS = [
  "exit_ablation",
  "slip_one_tick",
  "stability",
  "rank_ic",
  "min_btl",
  "error_budget",
] as const;
export type RobustnessMetric = (typeof ROBUSTNESS_METRICS)[number];

/** Counts and net returns of one side of a comparison (net = after brokerage and slippage). */
export type ReturnSummary = {
  readonly n: number;
  readonly mean_net: number | null;
  readonly median_net: number | null;
  readonly hit_rate: number | null;
  readonly mean_sessions_held: number | null;
};

/** ARN-106: the rule against the time-stop-only comparator, on the development split. */
export type ExitAblationStat = {
  readonly family: string;
  readonly rule_version: string;
  readonly rule: ReturnSummary;
  readonly time_stop_only: ReturnSummary;
};

/** ARN-107: the same rows with one more adverse tick per side, beside the ARN-083 stress figure. */
export type SlipOneTickStat = {
  readonly family: string;
  readonly rule_version: string;
  readonly base: ReturnSummary;
  readonly one_tick: ReturnSummary;
  /** The ARN-083 stress figure (P3 + 50 % slippage), for the side-by-side table; null if absent. */
  readonly stress_mean_net: number | null;
};

/** One neighbour (+-1 grid step of one numeric key) of ARN-108. */
export type StabilityNeighbour = {
  readonly key: string;
  readonly direction: "down" | "up";
  readonly value: number;
  readonly n: number;
  readonly mean_net: number | null;
  /** One-sided 90 % lower bound under P5 (ARN-081 bootstrap, the lineage's frozen block). */
  readonly net_lower90: number | null;
  readonly passes_absolute_gate: boolean;
};

/** ARN-108: a version is `fragile` when it passes the absolute gate and any neighbour fails it. */
export type StabilityStat = {
  readonly family: string;
  readonly rule_version: string;
  readonly passes_absolute_gate: boolean;
  readonly fragile: boolean;
  readonly neighbours: readonly StabilityNeighbour[];
};

/** VAL-114: the bootstrap summary of the daily rank quality (Spearman IC). */
export type RankIcStat = {
  readonly family: string;
  readonly rank_variant: string;
  readonly n_days: number;
  readonly median_ic: number | null;
  readonly mean_ic: number | null;
  /** 90 % interval of the median (21-session circular block bootstrap). */
  readonly lower90: number | null;
  readonly upper90: number | null;
};

/** VAL-115: the minimum backtest length against the length available. */
export type MinBtlStat = {
  readonly lineage: string;
  /** Cumulative trials N over all split versions. */
  readonly trials: number;
  readonly target_sharpe: number;
  readonly min_years: number | null;
  readonly available_years: number;
  readonly label: "too short" | "long enough";
};

/** VAL-112/116 status shown beside the tables: the level of the next test and the lesson pool. */
export type ErrorBudgetStat = {
  readonly lineage: string;
  readonly mode: "fixed" | "alpha_spending";
  readonly tests_so_far: number;
  readonly next_level: number;
  readonly lesson_pool: "open" | "exhausted";
};
