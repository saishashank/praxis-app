// Agent / family / replay tables: table and column names plus row types for main migration
// 0008_agents.sql (docs/M4_design.md section 3, D-078). Constants and types only, no business logic.
//
// Money columns are INTEGER micro-AUD named `*_micro` and typed `bigint` (the engine reads them with
// the libSQL client in bigint mode, as the arena does). Share quantities, counts, ppm ratios and
// versions are `number`. Exact rationals are INTEGER `*_num` / `*_den` pairs (bigint); the day-0
// abnormal return of an event is decimal TEXT because its product of micro prices can pass 64 bits.
// Instants are ISO-8601 UTC text with milliseconds and Z (D-031); `d` is the Sydney trading date
// YYYY-MM-DD; booleans are 0 | 1. REAL columns exist only where the design calls for float64
// (Wilder RSI, log-return volatility, bootstrap statistics); AGENT_REAL_COLUMNS lists them all.

import type { Flag01, Micro } from "@/lib/arena/schema";

export const AGENT_TABLES = {
  indexBar: "index_bar",
  shortInterest: "short_interest",
  insiderNotice: "insider_notice",
  indicatorDaily: "indicator_daily",
  patternDaily: "pattern_daily",
  regimeDaily: "regime_daily",
  event: "event",
  insiderFlowScore: "insider_flow_score",
  signal: "signal",
  decisionCard: "decision_card",
  cardNote: "card_note",
  stopLevel: "stop_level",
  c2Selection: "c2_selection",
  lineage: "lineage",
  lineageSplit: "lineage_split",
  trialLedger: "trial_ledger",
  ledgerRow: "ledger_row",
  ledgerControl: "ledger_control",
  replayRun: "replay_run",
  validationResult: "validation_result",
  label: "label",
  replayStat: "replay_stat",
  killswitchLook: "killswitch_look",
  llmCache: "llm_cache",
  llmCall: "llm_call",
} as const;

export type AgentTableName = (typeof AGENT_TABLES)[keyof typeof AGENT_TABLES];

/**
 * Retention-pruned tables: DELETE is allowed only for rows beyond the floor, which the trigger
 * evaluates against the current clock. `column` is the date (or expiry) it compares; `days` is the
 * floor (0 = already expired). 500 sessions is about 724 days, so the 730-day floor never cuts
 * below the retention (the price_bar rule of migration 0004).
 */
export const AGENT_PRUNED_TABLES = {
  short_interest: { column: "as_of", days: 730 },
  indicator_daily: { column: "d", days: 730 },
  pattern_daily: { column: "d", days: 730 },
  insider_flow_score: { column: "d", days: 730 },
  replay_stat: { column: "d", days: 730 },
  llm_call: { column: "d", days: 180 },
  llm_cache: { column: "expires_at", days: 0 },
} as const satisfies Partial<Record<AgentTableName, { column: string; days: number }>>;

export type AgentPrunedTable = keyof typeof AGENT_PRUNED_TABLES;

/** Tables that refuse DELETE outright (kept forever, DAT-142). */
export const AGENT_FOREVER_TABLES: readonly AgentTableName[] = Object.values(AGENT_TABLES).filter(
  (t) => !Object.prototype.hasOwnProperty.call(AGENT_PRUNED_TABLES, t),
);

/** Tables that refuse UPDATE and (before their floor) DELETE: append-only. */
export const AGENT_APPEND_ONLY_TABLES = [
  "index_bar",
  "short_interest",
  "insider_notice",
  "indicator_daily",
  "pattern_daily",
  "regime_daily",
  "insider_flow_score",
  "signal",
  "decision_card",
  "card_note",
  "stop_level",
  "c2_selection",
  "lineage",
  "lineage_split",
  "trial_ledger",
  "ledger_control",
  "replay_run",
  "validation_result",
  "label",
  "replay_stat",
  "killswitch_look",
  "llm_cache",
  "llm_call",
] as const satisfies readonly AgentTableName[];

/** State tables that allow only the documented one-way changes (DELETE is refused). */
export const AGENT_ONE_WAY_TABLES = [
  "event",
  "ledger_row",
] as const satisfies readonly AgentTableName[];

/** Column names per table, in table order (checked against PRAGMA table_info by the tests). */
export const AGENT_COLUMNS = {
  index_bar: [
    "market",
    "index_code",
    "d",
    "o_micro",
    "h_micro",
    "l_micro",
    "c_micro",
    "source",
    "published_at",
    "ingested_at",
  ],
  short_interest: [
    "market",
    "code",
    "as_of",
    "short_ppm",
    "published_at",
    "ingested_at",
    "assumed_time",
    "source",
  ],
  insider_notice: [
    "market",
    "ann_id",
    "code",
    "kind",
    "value_micro",
    "published_at",
    "parser_version",
  ],
  indicator_daily: [
    "market",
    "code",
    "d",
    "ind_version",
    "close_adj_micro",
    "sma5_micro",
    "sma50_micro",
    "sma200_micro",
    "atr20_micro",
    "rsi2",
    "rsi14",
    "ret126_ppm",
    "ret126_pct_tier",
    "high250",
    "vol_ratio_ppm",
    "adv20_micro",
    "range_pos_ppm",
    "vol20",
    "vol_decile",
  ],
  pattern_daily: ["market", "code", "d", "pattern", "version", "hit"],
  regime_daily: [
    "market",
    "d",
    "version",
    "close_micro",
    "sma200_micro",
    "vol20",
    "vol_pct",
    "fall5_ppm",
    "raw_state",
    "state",
    "exit_streak",
  ],
  event: [
    "market",
    "source",
    "ann_id",
    "code",
    "published_at",
    "timed",
    "day0_d",
    "group_key",
    "category",
    "price_sensitive",
    "ar_ppm",
    "ar_num",
    "ar_den",
    "vol_ratio_ppm",
    "polarity",
    "rule_version",
    "category_llm",
    "polarity_llm",
    "category_detail",
  ],
  insider_flow_score: ["market", "code", "d", "score_q", "inputs_json"],
  signal: [
    "id",
    "market",
    "d",
    "family",
    "rule_version",
    "variant",
    "code",
    "regime",
    "rank_score",
    "rules_json",
    "evidence_json",
    "classes",
    "group_key",
    "partial",
    "schema_version",
    "agent_version",
    "inputs_ref",
    "decided_at",
  ],
  decision_card: [
    "id",
    "signal_id",
    "execution_id",
    "cohort_id",
    "taken",
    "not_taken_reason",
    "order_id",
    "card_json",
    "card_sha",
    "schema_version",
    "decided_at",
  ],
  card_note: [
    "card_id",
    "kind",
    "text",
    "provider",
    "model_id",
    "fallback_depth",
    "tokens_in",
    "tokens_out",
    "prompt_sha",
  ],
  stop_level: ["trade_id", "d", "rule", "cohort_id", "level_micro"],
  c2_selection: [
    "cohort_id",
    "d",
    "matched_signal_id",
    "code",
    "skipped",
    "skip_reason",
    "pool_size",
    "rng_draw",
  ],
  lineage: ["id", "created_d", "parent"],
  lineage_split: [
    "lineage_id",
    "version",
    "block_sessions",
    "holdout_len",
    "validation_len",
    "purge",
    "data_end_d",
    "holdout_start_d",
    "holdout_end_d",
    "validation_start_d",
    "validation_end_d",
    "dev_end_d",
    "deferred_until_d",
    "reason",
    "measured_on_run",
  ],
  trial_ledger: [
    "id",
    "market",
    "lineage_id",
    "split_version",
    "kind",
    "rule_version",
    "variant",
    "run_id",
    "d",
  ],
  ledger_row: [
    "id",
    "signal_id",
    "group_key",
    "entry_d",
    "exit_d",
    "exit_tag",
    "qty",
    "fill_in_micro",
    "fill_out_micro",
    "brok_in_micro",
    "brok_out_micro",
    "stress_in_micro",
    "stress_out_micro",
    "qty_out",
    "dividend_micro",
    "gross_num",
    "gross_den",
    "timed",
    "forward",
  ],
  ledger_control: [
    "row_id",
    "idx",
    "code",
    "entry_d",
    "exit_d",
    "net_num",
    "net_den",
    "stress_num",
    "stress_den",
  ],
  replay_run: [
    "id",
    "kind",
    "market",
    "snapshot_sha",
    "commit_sha",
    "params_sha",
    "seed",
    "node_version",
    "files_json",
    "minutes",
  ],
  validation_result: [
    "id",
    "run_id",
    "lineage_id",
    "rule_version",
    "variant",
    "split_version",
    "test",
    "level",
    "B",
    "n",
    "blocks",
    "stat",
    "p",
    "mde",
    "lower",
    "upper",
    "L_used",
    "m_used",
    "outcome",
    "reachable_d",
  ],
  label: [
    "id",
    "execution_id",
    "rule_version",
    "variant",
    "label",
    "qualifiers_json",
    "cost_infeasible",
    "n",
    "mde",
    "d",
    "result_ids",
  ],
  replay_stat: ["run_id", "scope", "metric", "d", "value_json"],
  killswitch_look: [
    "lineage_id",
    "rule_version",
    "criterion",
    "look_k",
    "d",
    "trades",
    "stat",
    "p",
    "alpha_k",
    "triggered",
  ],
  llm_cache: ["role", "model_id", "prompt_sha", "kb_version", "response_json", "expires_at"],
  llm_call: [
    "id",
    "role",
    "provider",
    "model_id",
    "fallback_depth",
    "tokens_in",
    "tokens_out",
    "cached",
    "outcome",
    "injection_filtered",
    "market",
    "d",
  ],
} as const satisfies Record<AgentTableName, readonly string[]>;

/** Columns that hold money: every `*_micro` column, and nothing else. */
type MicroColumns<T extends readonly string[]> = Extract<T[number], `${string}_micro`>;
export const AGENT_MONEY_COLUMNS: {
  [K in AgentTableName]: readonly MicroColumns<(typeof AGENT_COLUMNS)[K]>[];
} = Object.fromEntries(
  Object.entries(AGENT_COLUMNS).map(([t, cols]) => [
    t,
    (cols as readonly string[]).filter((c) => c.endsWith("_micro")),
  ]),
) as never;

/**
 * The only REAL columns (float64 by design, docs/M4_design.md 2.1). No money, price, rate, fill or
 * ledger amount is ever REAL, and no rule comparison reads one of these.
 */
export const AGENT_REAL_COLUMNS = {
  indicator_daily: ["rsi2", "rsi14", "vol20"],
  regime_daily: ["vol20", "vol_pct"],
  replay_run: ["minutes"],
  validation_result: ["level", "stat", "p", "mde", "lower", "upper"],
  label: ["mde"],
  killswitch_look: ["stat", "p", "alpha_k"],
} as const satisfies Partial<{
  [K in AgentTableName]: readonly (typeof AGENT_COLUMNS)[K][number][];
}>;

// ---- value sets (mirror the CHECK constraints of 0008) ----
export const FAMILIES = ["F1", "F2", "F3", "F4", "F5", "F6"] as const;
export type Family = (typeof FAMILIES)[number];

export const REGIME_STATES = ["SHOCK", "RISK-OFF", "RISK-ON", "NEUTRAL", "unknown"] as const;
export type RegimeState = (typeof REGIME_STATES)[number];

export const INSIDER_NOTICE_KINDS = [
  "director_buy",
  "director_sell",
  "sh_new",
  "sh_increase",
  "sh_decrease",
] as const;
export type InsiderNoticeKind = (typeof INSIDER_NOTICE_KINDS)[number];

export const CANDLE_PATTERNS = [
  "bullish_engulfing",
  "hammer",
  "morning_star",
  "piercing_line",
] as const;
export type CandlePattern = (typeof CANDLE_PATTERNS)[number];

/** AGT-020 categories. */
export const EVENT_CATEGORIES = [
  "results",
  "guidance_up",
  "guidance_down",
  "contract_win",
  "capital_raising",
  "director_trade",
  "substantial_holder",
  "takeover_target",
  "takeover_bidder",
  "halt_suspension",
  "exchange_query",
  "dividend_change",
  "management_change",
  "other",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/**
 * M14 event detail (AGT-135, AGT-138; D-241): a finer label beside the category, stored in the
 * nullable `event.category_detail` column (0018). NULL on every v1 event.
 */
export const EVENT_DETAILS = ["query_response", "guidance_maintained"] as const;
export type EventDetail = (typeof EVENT_DETAILS)[number];

/**
 * M14 reasons an entry is not taken before the order stage (FAM-004/005/006/009, DAT-234). They
 * are the `not_taken_reason` words of a Decision Card (checked by the card validator).
 */
export const ENTRY_SKIP_REASONS = [
  "skipped_stop_distance",
  "skipped_cost_gate",
  "second_position",
  "abstain_shock",
  "index_change",
] as const;
export type EntrySkipReason = (typeof ENTRY_SKIP_REASONS)[number];
export type Polarity = -1 | 0 | 1;

export const LEDGER_EXIT_TAGS = ["IS", "CS"] as const;
export type LedgerExitTag = (typeof LEDGER_EXIT_TAGS)[number];

export const LINEAGE_SPLIT_REASONS = ["create", "roll"] as const;
export type LineageSplitReason = (typeof LINEAGE_SPLIT_REASONS)[number];

export const TRIAL_KINDS = [
  "validation_access",
  "holdout_access",
  "pattern_test",
  "challenger",
  "new_lineage",
] as const;
export type TrialKind = (typeof TRIAL_KINDS)[number];

export const REPLAY_RUN_KINDS = ["light", "full", "null", "injected", "evidence"] as const;
export type ReplayRunKind = (typeof REPLAY_RUN_KINDS)[number];

export const VALIDATION_TESTS = [
  "i",
  "ii",
  "iii",
  "iv",
  "iv-b",
  "v",
  "vi",
  "holdout",
  "ks",
  "size",
  "leverage",
] as const;
export type ValidationTest = (typeof VALIDATION_TESTS)[number];

/** ARN-086 labels plus the two stated outcomes "insufficient evidence" and "possible luck". */
export const LABELS = [
  "UNVALIDATED",
  "PASSED-BACKTEST",
  "CONSISTENT-FORWARD",
  "FAILED",
  "NOT-DEMONSTRATED",
  "UNVALIDATABLE",
  "insufficient evidence",
  "possible luck",
] as const;
export type LabelName = (typeof LABELS)[number];

export const KILLSWITCH_CRITERIA = ["expectancy", "win_rate", "cif"] as const;
export type KillswitchCriterion = (typeof KILLSWITCH_CRITERIA)[number];

/** AGT-002: 0 = first choice, 1, 2 ... as digit text, or 'rules-only' when no model was used. */
export type FallbackDepth = "rules-only" | `${number}`;

// ---- row types (money fields are bigint) ----
export type IndexBarRow = {
  market: string;
  index_code: string;
  d: string;
  o_micro: Micro;
  h_micro: Micro;
  l_micro: Micro;
  c_micro: Micro;
  source: string;
  published_at: string;
  ingested_at: string;
};

export type ShortInterestRow = {
  market: string;
  code: string;
  as_of: string;
  short_ppm: number;
  published_at: string;
  ingested_at: string;
  assumed_time: Flag01;
  source: string;
};

export type InsiderNoticeRow = {
  market: string;
  ann_id: string;
  code: string;
  kind: InsiderNoticeKind;
  value_micro: Micro | null;
  published_at: string;
  parser_version: string;
};

export type IndicatorDailyRow = {
  market: string;
  code: string;
  d: string;
  ind_version: number;
  close_adj_micro: Micro;
  sma5_micro: Micro | null;
  sma50_micro: Micro | null;
  sma200_micro: Micro | null;
  atr20_micro: Micro | null;
  rsi2: number | null;
  rsi14: number | null;
  ret126_ppm: number | null;
  /** Tier percentile in ppm, floored (so a whole-ppm threshold such as 800000 is exact). */
  ret126_pct_tier: number | null;
  high250: Flag01 | null;
  vol_ratio_ppm: number | null;
  adv20_micro: Micro | null;
  range_pos_ppm: number | null;
  vol20: number | null;
  vol_decile: number | null;
};

export type PatternDailyRow = {
  market: string;
  code: string;
  d: string;
  pattern: CandlePattern;
  version: number;
  hit: Flag01;
};

export type RegimeDailyRow = {
  market: string;
  d: string;
  version: number;
  close_micro: Micro;
  sma200_micro: Micro | null;
  vol20: number | null;
  vol_pct: number | null;
  fall5_ppm: number | null;
  raw_state: RegimeState;
  state: RegimeState;
  exit_streak: number;
};

export type EventRow = {
  market: string;
  source: string;
  ann_id: string;
  code: string;
  published_at: string;
  timed: Flag01;
  day0_d: string;
  group_key: string;
  category: EventCategory;
  price_sensitive: Flag01;
  ar_ppm: number | null;
  /** Exact day-0 abnormal return numerator / denominator as decimal text (can pass 64 bits). */
  ar_num: string | null;
  ar_den: string | null;
  vol_ratio_ppm: number | null;
  polarity: Polarity;
  rule_version: string;
  /** LLM-adjusted fields: NULL -> value once, never read by A5 (AGT-011a). */
  category_llm: string | null;
  polarity_llm: Polarity | null;
  /** AGT-135 / AGT-138 detail (0018); NULL on rows written before events-v2. */
  category_detail?: EventDetail | null;
};

export type InsiderFlowScoreRow = {
  market: string;
  code: string;
  d: string;
  /** Quarter units -4..+4 (0.25 = 1); null = unknown, never 0. */
  score_q: number | null;
  inputs_json: string;
};

export type SignalRow = {
  id: string;
  market: string;
  d: string;
  family: Family;
  rule_version: string;
  variant: string;
  code: string;
  regime: RegimeState;
  /** Exact rank score as text. */
  rank_score: string;
  rules_json: string;
  evidence_json: string;
  classes: string | null;
  group_key: string | null;
  partial: Flag01;
  schema_version: number;
  agent_version: string;
  inputs_ref: string;
  decided_at: string;
};

export type DecisionCardRow = {
  id: string;
  signal_id: string;
  execution_id: string;
  cohort_id: string | null;
  taken: Flag01;
  not_taken_reason: string | null;
  order_id: string | null;
  card_json: string;
  card_sha: string;
  schema_version: number;
  decided_at: string;
};

export type CardNoteRow = {
  card_id: string;
  kind: string;
  text: string;
  provider: string | null;
  model_id: string | null;
  fallback_depth: FallbackDepth;
  tokens_in: number;
  tokens_out: number;
  prompt_sha: string | null;
};

export type StopLevelRow = {
  trade_id: string;
  d: string;
  rule: string;
  cohort_id: string;
  level_micro: Micro;
};

export type C2SelectionRow = {
  cohort_id: string;
  d: string;
  matched_signal_id: string;
  code: string | null;
  skipped: Flag01;
  skip_reason: string | null;
  pool_size: number;
  rng_draw: bigint | null;
};

export type LineageRow = { id: string; created_d: string; parent: string | null };

export type LineageSplitRow = {
  lineage_id: string;
  version: number;
  block_sessions: number;
  holdout_len: number;
  validation_len: number;
  purge: number;
  data_end_d: string;
  holdout_start_d: string | null;
  holdout_end_d: string | null;
  validation_start_d: string | null;
  validation_end_d: string | null;
  dev_end_d: string | null;
  deferred_until_d: string | null;
  reason: LineageSplitReason;
  measured_on_run: string | null;
};

export type TrialLedgerRow = {
  id: string;
  market: string;
  lineage_id: string;
  split_version: number;
  kind: TrialKind;
  rule_version: string | null;
  variant: string | null;
  run_id: string | null;
  d: string;
};

export type LedgerRowRow = {
  id: string;
  signal_id: string;
  group_key: string | null;
  entry_d: string;
  exit_d: string | null;
  exit_tag: LedgerExitTag | null;
  qty: number;
  fill_in_micro: Micro;
  fill_out_micro: Micro | null;
  brok_in_micro: Micro;
  brok_out_micro: Micro | null;
  /** Stressed cost basis (P3 + 50 % slippage), known at entry. */
  stress_in_micro: Micro;
  /** Stressed proceeds, known at the exit. */
  stress_out_micro: Micro | null;
  gross_num: bigint | null;
  gross_den: bigint | null;
  timed: Flag01;
  forward: Flag01;
};

export type LedgerControlRow = {
  row_id: string;
  idx: number;
  code: string;
  entry_d: string;
  exit_d: string;
  net_num: bigint;
  net_den: bigint;
  stress_num: bigint;
  stress_den: bigint;
};

export type ReplayRunRow = {
  id: string;
  kind: ReplayRunKind;
  market: string;
  snapshot_sha: string;
  commit_sha: string;
  params_sha: string;
  seed: bigint;
  node_version: string;
  files_json: string;
  minutes: number;
};

export type ValidationResultRow = {
  id: string;
  run_id: string;
  lineage_id: string;
  rule_version: string;
  variant: string;
  split_version: number;
  test: ValidationTest;
  level: number;
  B: number;
  n: number;
  blocks: number;
  stat: number | null;
  p: number | null;
  mde: number | null;
  lower: number | null;
  upper: number | null;
  L_used: number;
  m_used: number;
  outcome: string;
  reachable_d: string | null;
};

export type LabelRow = {
  id: string;
  execution_id: string;
  rule_version: string;
  variant: string;
  label: LabelName;
  qualifiers_json: string;
  cost_infeasible: Flag01;
  n: number;
  mde: number | null;
  d: string;
  result_ids: string;
};

export type ReplayStatRow = {
  run_id: string;
  scope: string;
  metric: string;
  d: string;
  value_json: string;
};

export type KillswitchLookRow = {
  lineage_id: string;
  rule_version: string;
  criterion: KillswitchCriterion;
  look_k: number;
  d: string;
  trades: number;
  stat: number | null;
  p: number | null;
  alpha_k: number;
  triggered: Flag01;
};

export type LlmCacheRow = {
  role: string;
  model_id: string;
  prompt_sha: string;
  kb_version: string;
  response_json: string;
  expires_at: string;
};

export type LlmCallRow = {
  id: string;
  role: string;
  provider: string;
  model_id: string | null;
  fallback_depth: FallbackDepth;
  tokens_in: number;
  tokens_out: number;
  cached: Flag01;
  outcome: string;
  injection_filtered: Flag01;
  market: string;
  d: string;
};
