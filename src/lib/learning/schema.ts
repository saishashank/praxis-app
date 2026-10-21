// Learning and knowledge tables: table and column names plus row types for main migration
// 0010_learning.sql and auth migration 0005_annotation.sql (docs/M6_design.md section 3, D-110,
// D-111). Constants and types only, no business logic.
//
// Money columns are INTEGER micro-AUD named `*_micro` (typed `bigint` when read in bigint mode, as
// the arena does); ratios are INTEGER ppm; REAL columns hold float64 statistics only
// (LEARNING_REAL_COLUMNS lists them). Instants are ISO-8601 UTC text with milliseconds and Z
// (D-031); `d` is the Melbourne/Sydney local date YYYY-MM-DD; booleans are 0 | 1.

import type { Flag01 } from "@/lib/arena/schema";

export const LEARNING_TABLES = {
  ruleVersion: "rule_version",
  ruleVersionStatus: "rule_version_status",
  lessonWindow: "lesson_window",
  lesson: "lesson",
  lessonGrade: "lesson_grade",
  alphaWealth: "alpha_wealth",
  attribution: "attribution",
  blockedTrade: "blocked_trade",
  comparisonResult: "comparison_result",
  comparisonFinding: "comparison_finding",
  critique: "critique",
  critiqueNote: "critique_note",
  challenger: "challenger",
  challengerEvent: "challenger_event",
  promotion: "promotion",
  changeLedger: "change_ledger",
  playbookVersion: "playbook_version",
  planItem: "plan_item",
  planReview: "plan_review",
  document: "document",
  kbArchiveRun: "kb_archive_run",
  factorBucketStat: "factor_bucket_stat",
  pick: "pick",
  pickOutcome: "pick_outcome",
  bakeoffResult: "bakeoff_result",
} as const;

export type LearningTableName = (typeof LEARNING_TABLES)[keyof typeof LEARNING_TABLES];

/** Auth DB tables of migration 0005. */
export const AUTH_ANNOTATION_TABLES = {
  annotation: "annotation",
  annotationHistory: "annotation_history",
} as const;

/**
 * Retention-pruned tables: DELETE is allowed only for rows beyond the floor, which the trigger
 * evaluates against the current clock. `column` is the date or instant it compares; `kind` says
 * which; `days` is the floor (and the retention). The maintenance job deletes exactly these.
 */
export const LEARNING_PRUNED_TABLES = {
  comparison_result: { column: "d", kind: "date", days: 730 },
  kb_archive_run: { column: "started_at", kind: "instant", days: 180 },
} as const satisfies Partial<
  Record<LearningTableName, { column: string; kind: "date" | "instant"; days: number }>
>;

export type LearningPrunedTable = keyof typeof LEARNING_PRUNED_TABLES;

/** Tables that refuse DELETE outright (kept forever, DAT-142). */
export const LEARNING_FOREVER_TABLES: readonly LearningTableName[] = Object.values(
  LEARNING_TABLES,
).filter((t) => !Object.prototype.hasOwnProperty.call(LEARNING_PRUNED_TABLES, t));

/** Tables that refuse every UPDATE. */
export const LEARNING_APPEND_ONLY_TABLES = [
  "rule_version",
  "rule_version_status",
  "lesson_window",
  "lesson",
  "lesson_grade",
  "alpha_wealth",
  "attribution",
  "comparison_result",
  "critique",
  "critique_note",
  "challenger_event",
  "change_ledger",
  "playbook_version",
  "plan_item",
  "plan_review",
  "document",
  "factor_bucket_stat",
  "pick",
  "bakeoff_result",
] as const satisfies readonly LearningTableName[];

/** State tables that allow only the documented one-way changes (DELETE is refused or pruned). */
export const LEARNING_ONE_WAY_TABLES = [
  "blocked_trade",
  "comparison_finding",
  "challenger",
  "promotion",
  "kb_archive_run",
  "pick_outcome",
] as const satisfies readonly LearningTableName[];

/** Auth DB: annotation is soft-delete only; its history is append-only. */
export const AUTH_ANNOTATION_APPEND_ONLY_TABLES = ["annotation_history"] as const;
export const AUTH_ANNOTATION_ONE_WAY_TABLES = ["annotation"] as const;

/** KB-040 challenger states and the allowed edges (the trigger and the event CHECK use the same). */
export const CHALLENGER_STATES = [
  "proposed",
  "replay",
  "shakedown",
  "review",
  "approved",
  "promoted",
  "rejected",
  "retired",
] as const;
export type ChallengerState = (typeof CHALLENGER_STATES)[number];

export const CHALLENGER_EDGES: Readonly<Record<ChallengerState, readonly ChallengerState[]>> = {
  proposed: ["replay", "rejected", "retired"],
  replay: ["shakedown", "rejected", "retired"],
  shakedown: ["review", "rejected", "retired"],
  review: ["approved", "rejected", "retired"],
  approved: ["promoted", "rejected", "retired"],
  promoted: [],
  rejected: [],
  retired: [],
};

export const LESSON_GRADES = ["L0", "L1", "L2", "L3", "retired"] as const;
export type LessonGrade = (typeof LESSON_GRADES)[number];

export const RULE_ORIGINS = ["seed", "challenger", "owner", "rollback", "force"] as const;
export type RuleOrigin = (typeof RULE_ORIGINS)[number];

export const CHANGE_KINDS = [
  "lane_a_playbook",
  "lane_a_note",
  "lesson_force",
  "promotion",
  "force_apply",
  "rollback",
  "owner_version",
  "retire",
  "kill_freeze",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** Change-ledger kinds that change what an LLM sees (the KB version moves with them, LLM-031). */
export const CONTEXT_CHANGE_KINDS: readonly ChangeKind[] = [
  "lane_a_playbook",
  "lane_a_note",
  "lesson_force",
  "promotion",
  "force_apply",
  "rollback",
  "owner_version",
  "retire",
];

export const PLAYBOOK_AGENTS = ["A1", "A2", "A3", "A6", "A7", "A8"] as const;
export type PlaybookAgent = (typeof PLAYBOOK_AGENTS)[number];

export const DOCUMENT_TYPES = [
  "family",
  "playbook",
  "lesson",
  "challenger",
  "review",
  "hypothesis",
  "source_register",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Every REAL column (float64 statistics): table -> columns. */
export const LEARNING_REAL_COLUMNS = {
  lesson_grade: ["estimate", "lower", "upper", "p", "alpha_j"],
  alpha_wealth: ["w_before", "alpha_j", "p", "w_after"],
  comparison_result: ["estimate", "lower", "upper", "p"],
  bakeoff_result: [
    "json_valid_pct",
    "injection_resistance_pct",
    "detection_pct",
    "triage_agreement_pct",
  ],
} as const satisfies Partial<Record<LearningTableName, readonly string[]>>;

/** Column names per table, in table order (checked against PRAGMA table_info by the tests). */
export const LEARNING_COLUMNS = {
  rule_version: [
    "id",
    "market",
    "family",
    "n",
    "parent",
    "origin",
    "params_json",
    "params_sha",
    "spec_json",
    "schema_version",
    "registered_d",
    "created_by",
  ],
  rule_version_status: ["rule_version_id", "seq", "status", "d", "reason"],
  lesson_window: [
    "lineage_id",
    "split_version",
    "l1_start_d",
    "l1_end_d",
    "purge",
    "l2_start_d",
    "l2_end_d",
    "block",
    "frozen_run",
  ],
  lesson: [
    "id",
    "market",
    "scope",
    "lineage_id",
    "template_id",
    "template_version",
    "subject_json",
    "rule_version",
    "metric",
    "direction",
    "param_hint",
    "created_d",
    "created_run",
  ],
  lesson_grade: [
    "lesson_id",
    "seq",
    "grade",
    "split_version",
    "window",
    "n",
    "blocks",
    "estimate",
    "lower",
    "upper",
    "p",
    "alpha_j",
    "B",
    "state_text",
    "reachable_d",
    "run_id",
    "d",
    "corrects_seq",
  ],
  alpha_wealth: [
    "pool",
    "seq",
    "lesson_id",
    "window_key",
    "w_before",
    "alpha_j",
    "p",
    "rejected",
    "w_after",
    "run_id",
  ],
  attribution: [
    "subject_kind",
    "subject_id",
    "version",
    "market",
    "d",
    "final",
    "tags_json",
    "mfe_ppm",
    "mae_ppm",
    "hold_sessions",
    "cost_micro",
    "slippage_micro",
    "net_micro",
    "excess_ppm",
    "stress_ppm",
  ],
  blocked_trade: [
    "signal_id",
    "execution_id",
    "market",
    "d",
    "reason",
    "card_id",
    "counterfactual_row_id",
    "counterfactual_net_ppm",
    "final",
  ],
  comparison_result: [
    "market",
    "kind",
    "pair_id",
    "d",
    "n_a",
    "n_b",
    "estimate",
    "lower",
    "upper",
    "p",
    "bh_rank",
    "discovery",
    "block",
    "B",
    "label",
  ],
  comparison_finding: [
    "id",
    "pair_id",
    "direction",
    "detected_d",
    "look_due_d",
    "state",
    "lockout_until_d",
    "look_result_ref",
  ],
  critique: [
    "subject_kind",
    "subject_id",
    "run_id",
    "checks_json",
    "passed",
    "access_trial_id",
    "d",
  ],
  critique_note: [
    "subject_kind",
    "subject_id",
    "run_id",
    "kind",
    "text",
    "provider",
    "model_id",
    "fallback_depth",
    "tokens_in",
    "tokens_out",
    "prompt_sha",
    "deferred",
  ],
  challenger: [
    "id",
    "lineage_id",
    "rule_version_id",
    "incumbent_version_id",
    "origin",
    "lesson_ids_json",
    "state",
    "state_d",
    "trial_id",
    "shakedown_ok_sessions",
    "shadow_viewed_d",
    "ready",
  ],
  challenger_event: [
    "challenger_id",
    "seq",
    "from_state",
    "to_state",
    "d",
    "actor",
    "reason",
    "ref_json",
  ],
  promotion: [
    "id",
    "market",
    "family",
    "kind",
    "from_version",
    "to_version",
    "challenger_id",
    "approved_at",
    "approved_by",
    "status",
    "applied_d",
    "group_id",
  ],
  change_ledger: [
    "id",
    "market",
    "kind",
    "target",
    "before_json",
    "after_json",
    "diff_text",
    "lesson_ids_json",
    "challenger_id",
    "effective_d",
    "actor",
    "audit_ref",
    "created_at",
  ],
  playbook_version: [
    "market",
    "agent",
    "n",
    "content",
    "content_sha",
    "tokens_est",
    "change_id",
    "effective_d",
  ],
  plan_item: ["market", "d", "rank", "kind", "reason", "lesson_id", "lane", "measure_json"],
  plan_review: ["market", "plan_d", "rank", "reviewed_d", "outcome", "evidence_json"],
  document: [
    "path",
    "version",
    "market",
    "doc_type",
    "front_json",
    "body",
    "body_sha",
    "source_ids_json",
    "d",
    "created_at",
  ],
  kb_archive_run: [
    "run_id",
    "d",
    "status",
    "files_changed",
    "commit_sha",
    "started_at",
    "finished_at",
  ],
  factor_bucket_stat: [
    "market",
    "family",
    "rule_version",
    "split_version",
    "factor",
    "bucket",
    "edges_json",
    "n",
    "median_net_ppm",
    "family_median_ppm",
  ],
  pick: [
    "market",
    "d",
    "profile",
    "rank",
    "code",
    "family",
    "tier",
    "rule_version",
    "signal_id",
    "card_id",
    "label",
    "reference_micro",
    "buy_max_micro",
    "valid_until_d",
    "stop_micro",
    "aim_micro",
    "aim_reach_ppm",
    "n_similar",
    "bad_ppm",
    "typical_ppm",
    "good_ppm",
    "time_frame_sessions",
    "size_micro",
    "risk_micro",
    "factors_json",
    "based_on_json",
    "pick_sha",
    "created_at",
  ],
  pick_outcome: [
    "market",
    "d",
    "profile",
    "rank",
    "kind",
    "code",
    "published_sha",
    "state",
    "entry_d",
    "entry_micro",
    "exit_d",
    "exit_micro",
    "exit_reason",
    "net_micro",
    "net_ppm",
    "updated_d",
  ],
  bakeoff_result: [
    "run_id",
    "model_id",
    "category",
    "items",
    "json_valid_pct",
    "invented_numbers",
    "injection_resistance_pct",
    "detection_pct",
    "triage_agreement_pct",
    "passes",
    "report_sha",
    "trains_on_prompts_checked_d",
  ],
} as const satisfies Record<LearningTableName, readonly string[]>;

export const AUTH_ANNOTATION_COLUMNS = {
  annotation: [
    "id",
    "subject_kind",
    "subject_id",
    "author_id",
    "text",
    "created_at",
    "edited_at",
    "deleted_at",
  ],
  annotation_history: ["id", "annotation_id", "op", "at", "actor_id", "before_text", "after_text"],
} as const;

// ---- row types (the ones later tasks read most; others are added with their writers) ----

export type RuleVersionRow = {
  id: string;
  market: string;
  family: "F1" | "F2" | "F3" | "F4" | "F5" | "F6";
  n: number;
  parent: string | null;
  origin: RuleOrigin;
  params_json: string;
  params_sha: string;
  spec_json: string;
  schema_version: number;
  registered_d: string;
  created_by: string;
};

export type LessonRow = {
  id: string;
  market: string;
  scope: "lineage" | "market";
  lineage_id: string | null;
  template_id: string;
  template_version: number;
  subject_json: string;
  rule_version: string;
  metric: string;
  direction: -1 | 1;
  param_hint: string | null;
  created_d: string;
  created_run: string;
};

export type LessonGradeRow = {
  lesson_id: string;
  seq: number;
  grade: LessonGrade;
  split_version: number;
  window: "l1" | "l2" | null;
  n: number;
  blocks: number;
  estimate: number | null;
  lower: number | null;
  upper: number | null;
  p: number | null;
  alpha_j: number | null;
  B: number;
  state_text: string;
  reachable_d: string | null;
  run_id: string;
  d: string;
  corrects_seq: number | null;
};

export type ChallengerRow = {
  id: string;
  lineage_id: string;
  rule_version_id: string;
  incumbent_version_id: string;
  origin: "generator" | "owner";
  lesson_ids_json: string;
  state: ChallengerState;
  state_d: string;
  trial_id: string;
  shakedown_ok_sessions: number;
  shadow_viewed_d: string | null;
  ready: Flag01;
};

export type ChangeLedgerRow = {
  id: number;
  market: string;
  kind: ChangeKind;
  target: string;
  before_json: string | null;
  after_json: string | null;
  diff_text: string | null;
  lesson_ids_json: string;
  challenger_id: string | null;
  effective_d: string;
  actor: string;
  audit_ref: string | null;
  created_at: string;
};

export type PromotionRow = {
  id: string;
  market: string;
  family: "F1" | "F2" | "F3" | "F4" | "F5" | "F6";
  kind: "promotion" | "force_apply" | "rollback";
  from_version: string;
  to_version: string;
  challenger_id: string | null;
  approved_at: string;
  approved_by: string;
  status: "pending" | "applied" | "cancelled";
  applied_d: string | null;
  group_id: string;
};
