// Sentinel, alert and email tables: table and column names plus row types for main migration
// 0009_sentinel_email.sql and auth migration 0004_alert_user_state.sql (docs/M5_design.md section 3,
// D-096, D-097). Constants and types only, no business logic.
//
// There is no money column here: the held weight of an alert is `weight_ppm` (INTEGER parts per
// million, floored, for display; the tier decision compares an exact rational in code). Instants are
// ISO-8601 UTC text with milliseconds and Z (D-031); `d` is the Melbourne/Sydney local date
// YYYY-MM-DD; booleans are 0 | 1. Nothing is REAL.

import type { Flag01 } from "@/lib/arena/schema";

export const SENTINEL_TABLES = {
  sentinelPollDay: "sentinel_poll_day",
  sentinelIngest: "sentinel_ingest",
  itemAssessment: "item_assessment",
  watchListOwner: "watch_list_owner",
  alert: "alert",
  thesisBreakerEval: "thesis_breaker_eval",
  preopenRun: "preopen_run",
  preopenResult: "preopen_result",
  eveningReview: "evening_review",
  reviewRead: "review_read",
  emailMessage: "email_message",
  emailAttempt: "email_attempt",
  healthSnapshot: "health_snapshot",
  attentionSnooze: "attention_snooze",
  credentialExpiry: "credential_expiry",
  credentialExpiryHistory: "credential_expiry_history",
} as const;

export type SentinelTableName = (typeof SENTINEL_TABLES)[keyof typeof SENTINEL_TABLES];

/** Auth DB table of migration 0004. */
export const AUTH_ALERT_TABLES = { alertUserState: "alert_user_state" } as const;

/**
 * Retention-pruned tables: DELETE is allowed only for rows beyond the floor, which the trigger
 * evaluates against the current clock. `column` is the date or instant it compares; `kind` says
 * which; `days` is the floor (and the retention). The maintenance job deletes exactly these.
 */
export const SENTINEL_PRUNED_TABLES = {
  sentinel_poll_day: { column: "d", kind: "date", days: 400 },
  sentinel_ingest: { column: "received_at", kind: "instant", days: 180 },
  item_assessment: { column: "assessed_at", kind: "instant", days: 400 },
  alert: { column: "detected_at", kind: "instant", days: 730 },
  email_message: { column: "created_at", kind: "instant", days: 400 },
  email_attempt: { column: "at", kind: "instant", days: 400 },
  health_snapshot: { column: "d", kind: "date", days: 400 },
} as const satisfies Partial<
  Record<SentinelTableName, { column: string; kind: "date" | "instant"; days: number }>
>;

export type SentinelPrunedTable = keyof typeof SENTINEL_PRUNED_TABLES;

/** Tables that refuse DELETE outright (kept forever, DAT-142). */
export const SENTINEL_FOREVER_TABLES: readonly SentinelTableName[] = Object.values(
  SENTINEL_TABLES,
).filter((t) => !Object.prototype.hasOwnProperty.call(SENTINEL_PRUNED_TABLES, t));

/** Tables that refuse every UPDATE. */
export const SENTINEL_APPEND_ONLY_TABLES = [
  "thesis_breaker_eval",
  "preopen_result",
  "evening_review",
  "review_read",
  "email_attempt",
  "health_snapshot",
  "attention_snooze",
  "credential_expiry_history",
] as const satisfies readonly SentinelTableName[];

/** State tables that allow only the documented one-way changes. */
export const SENTINEL_ONE_WAY_TABLES = [
  "sentinel_poll_day",
  "sentinel_ingest",
  "item_assessment",
  "watch_list_owner",
  "alert",
  "preopen_run",
  "email_message",
  "credential_expiry",
] as const satisfies readonly SentinelTableName[];

/** Column names per table, in table order (checked against PRAGMA table_info by the tests). */
export const SENTINEL_COLUMNS = {
  sentinel_poll_day: [
    "market",
    "source",
    "d",
    "scheduled",
    "ok",
    "not_modified",
    "failed",
    "blocked",
    "max_gap_s",
    "last_ok_at",
  ],
  sentinel_ingest: [
    "id",
    "received_at",
    "items_seen",
    "items_new",
    "assessed",
    "carried",
    "status",
    "attempt",
  ],
  item_assessment: [
    "source",
    "ann_id",
    "market",
    "code",
    "materiality",
    "rule_version",
    "polarity",
    "held",
    "watch",
    "candidate",
    "tracked",
    "assessed_at",
    "materiality_llm",
    "text_llm",
  ],
  watch_list_owner: ["id", "market", "code", "added_by", "added_at", "expires_d", "removed_at"],
  alert: [
    "alert_key",
    "market",
    "code",
    "kind",
    "tier",
    "execution_id",
    "weight_ppm",
    "materiality",
    "published_at",
    "detected_at",
    "facts_json",
    "email_key",
    "text_llm",
  ],
  thesis_breaker_eval: [
    "subject_id",
    "breaker_id",
    "d",
    "phase",
    "seq",
    "subject_kind",
    "card_id",
    "market",
    "code",
    "status",
    "value_text",
    "trigger_text",
    "amber_text",
    "trigger_ref",
    "rule_version",
  ],
  preopen_run: [
    "market",
    "d",
    "attempt",
    "started_at",
    "finished_at",
    "status",
    "checked",
    "cancelled",
  ],
  preopen_result: ["order_id", "market", "d", "outcome", "reason", "card_id"],
  evening_review: [
    "d",
    "version",
    "kind",
    "missing_json",
    "facts_json",
    "facts_sha",
    "html",
    "text",
    "markdown",
    "size_html",
    "narrative",
    "created_at",
  ],
  review_read: ["d", "read_at", "via"],
  email_message: [
    "email_key",
    "env",
    "kind",
    "d",
    "slot",
    "status",
    "subject",
    "size_html",
    "size_text",
    "provider_id",
    "attempts",
    "recipient_sha",
    "created_at",
    "sent_at",
    "ref_json",
  ],
  email_attempt: ["email_key", "n", "at", "outcome", "http_status", "provider_id"],
  health_snapshot: ["d", "purpose", "components_json"],
  attention_snooze: [
    "id",
    "component",
    "item_key",
    "from_d",
    "until_d",
    "created_at",
    "created_by",
  ],
  credential_expiry: ["name", "expires_on", "set_at", "set_by"],
  credential_expiry_history: ["id", "name", "changed_at", "op", "expires_on", "set_by"],
} as const satisfies Record<SentinelTableName, readonly string[]>;

export const ALERT_USER_STATE_COLUMNS = [
  "user_id",
  "alert_key",
  "acked_at",
  "snoozed_until",
  "updated_at",
] as const;

// ---- enums (each mirrors a CHECK in the migration) ----

export const INGEST_STATUSES = ["ok", "partial", "error", "timeout"] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

export const ALERT_KINDS = [
  "announcement",
  "halt",
  "halt_proxy",
  "thesis_breaker",
  "regime_shift",
  "preopen_failure",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_TIERS = ["P0", "P1", "P2"] as const;
export type AlertTier = (typeof ALERT_TIERS)[number];

export const BREAKER_PHASES = ["nightly", "preopen", "intraday"] as const;
export type BreakerPhase = (typeof BREAKER_PHASES)[number];

export const BREAKER_STATUSES = ["green", "amber", "red"] as const;
export type BreakerStatus = (typeof BREAKER_STATUSES)[number];

export const PREOPEN_RUN_STATUSES = ["ok", "error", "not_run"] as const;
export type PreopenRunStatus = (typeof PREOPEN_RUN_STATUSES)[number];

export const PREOPEN_OUTCOMES = ["pass", "cancel", "not_rechecked"] as const;
export type PreopenOutcome = (typeof PREOPEN_OUTCOMES)[number];

export const REVIEW_KINDS = ["full", "partial", "minimal", "non_trading"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const NARRATIVE_SOURCES = ["rules", "llm", "mock"] as const;
export type NarrativeSource = (typeof NARRATIVE_SOURCES)[number];

export const REVIEW_READ_VIA = ["page", "email_link"] as const;
export type ReviewReadVia = (typeof REVIEW_READ_VIA)[number];

export const EMAIL_ENVS = ["production", "staging", "development", "test"] as const;
export type EmailEnv = (typeof EMAIL_ENVS)[number];

export const EMAIL_KINDS = [
  "review",
  "p0",
  "p0_batch",
  "incident_open",
  "incident_s1",
  "tokens",
  "unread7",
  "reminder",
  "brief",
  "test",
  "dbdown",
  // M17 (D-381..D-400; migration 0020): pick alerts and the intraday candidate mail. Pool slot only.
  "pick_hit",
  "pick_cleared",
  "pick_candidate",
  "pick_batch",
  "pick_digest",
] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

export const EMAIL_SLOTS = [
  "reserved_review",
  "reserved_incident",
  "reserved_reminder",
  "pool",
  "p0",
] as const;
export type EmailSlot = (typeof EMAIL_SLOTS)[number];

export const EMAIL_STATUSES = [
  "claimed",
  "sent",
  "failed",
  "suppressed_cap",
  "suppressed_off",
  "suppressed_paused",
  "no_recipient",
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const EMAIL_ATTEMPT_OUTCOMES = [
  "accepted",
  "retryable",
  "rejected",
  "network",
  "timeout",
] as const;
export type EmailAttemptOutcome = (typeof EMAIL_ATTEMPT_OUTCOMES)[number];

export const SNAPSHOT_PURPOSES = ["reminder", "review"] as const;
export type SnapshotPurpose = (typeof SNAPSHOT_PURPOSES)[number];

/** The nine health components of UXN-283 (EML-023); ids as stored in attention_snooze. */
export const HEALTH_COMPONENTS = [
  "sentinel",
  "market_data",
  "nightly_run",
  "ai_models",
  "evening_email",
  "database",
  "backups",
  "security",
  "free_tier_limits",
] as const;
export type HealthComponent = (typeof HEALTH_COMPONENTS)[number];

/** Upper bound of attention_snooze_max_days, mirrored by the table CHECK. */
export const ATTENTION_SNOOZE_DB_MAX_DAYS = 14;
/** Upper bound of owner_add_expiry_days (AGT-014: expiry at most 90 days). */
export const WATCH_LIST_MAX_DAYS = 90;

/**
 * The SEC-017 secrets that have an expiry the Owner can record (spec 10 SEC-017 table rows, by row
 * id). Names only: the table never holds a value (EML-005, SEC-103). The two machine-checkable
 * non-expiring rows (k, l) are not listed.
 */
export const CREDENTIAL_NAMES = {
  a_build_agent_token: "(a) Build-agent token (bot account)",
  b_worker_dispatch_token: "(b) Worker dispatch token",
  b_s_staging_dispatch_token: "(b-s) Staging Worker dispatch token",
  c1_session_cron_secret: "(c1) Session secret and CRON_SECRET",
  c2_worker_hmac: "(c2) Worker to Vercel HMAC secret",
  c3_actions_hmac: "(c3) Actions to Vercel HMAC secret",
  c4_test_identity_secret: "(c4) Staging test-identity secret",
  d_turso_main_tokens: "(d) Turso main-database tokens",
  e_turso_auth_token: "(e) Turso auth-database token",
  f_data_repo_token: "(f) Data-repo token",
  f_r_fixtures_read_token: "(f-r) Read-only fixtures token",
  g_cloudflare_api_token: "(g) Cloudflare API token",
  n_vercel_deploy_token: "(n) Vercel deploy token",
  h_resend_api_keys: "(h) Resend API keys",
  i_llm_api_keys: "(i) LLM API keys",
  j_google_oauth_secrets: "(j) Google OAuth client secrets",
  m_github_read_token: "(m) GitHub read token",
} as const;
export type CredentialName = keyof typeof CREDENTIAL_NAMES;
export const CREDENTIAL_NAME_LIST = Object.keys(CREDENTIAL_NAMES) as CredentialName[];

// ---- row types ----

export type SentinelPollDayRow = {
  market: string;
  source: string;
  d: string;
  scheduled: number;
  ok: number;
  not_modified: number;
  failed: number;
  blocked: number;
  max_gap_s: number;
  last_ok_at: string | null;
};

export type SentinelIngestRow = {
  id: string;
  received_at: string;
  items_seen: number;
  items_new: number;
  assessed: number;
  carried: number;
  status: IngestStatus;
  attempt: 1 | 2 | 3;
};

export type ItemAssessmentRow = {
  source: string;
  ann_id: string;
  market: string;
  code: string;
  materiality: 0 | 1 | 2 | 3;
  rule_version: string;
  polarity: -1 | 0 | 1;
  held: Flag01;
  watch: Flag01;
  candidate: Flag01;
  tracked: Flag01;
  assessed_at: string;
  materiality_llm: 0 | 1 | 2 | 3 | null;
  text_llm: string | null;
};

export type WatchListOwnerRow = {
  id: string;
  market: string;
  code: string;
  added_by: number;
  added_at: string;
  expires_d: string;
  removed_at: string | null;
};

export type AlertRow = {
  alert_key: string;
  market: string;
  code: string | null;
  kind: AlertKind;
  tier: AlertTier;
  execution_id: string | null;
  weight_ppm: number | null;
  materiality: 0 | 1 | 2 | 3 | null;
  published_at: string | null;
  detected_at: string;
  facts_json: string;
  email_key: string | null;
  text_llm: string | null;
};

export type ThesisBreakerEvalRow = {
  subject_id: string;
  breaker_id: string;
  d: string;
  phase: BreakerPhase;
  seq: number;
  subject_kind: "trade" | "order";
  card_id: string;
  market: string;
  code: string;
  status: BreakerStatus;
  value_text: string;
  trigger_text: string;
  amber_text: string | null;
  trigger_ref: string | null;
  rule_version: string;
};

export type PreopenRunRow = {
  market: string;
  d: string;
  attempt: 1 | 2;
  started_at: string;
  finished_at: string | null;
  status: PreopenRunStatus;
  checked: number;
  cancelled: number;
};

export type PreopenResultRow = {
  order_id: string;
  market: string;
  d: string;
  outcome: PreopenOutcome;
  reason: string | null;
  card_id: string | null;
};

export type EveningReviewRow = {
  d: string;
  version: number;
  kind: ReviewKind;
  missing_json: string;
  facts_json: string;
  facts_sha: string;
  html: string;
  text: string;
  markdown: string;
  size_html: number;
  narrative: NarrativeSource;
  created_at: string;
};

export type ReviewReadRow = { d: string; read_at: string; via: ReviewReadVia };

export type EmailMessageRow = {
  email_key: string;
  env: EmailEnv;
  kind: EmailKind;
  d: string;
  slot: EmailSlot;
  status: EmailStatus;
  subject: string;
  size_html: number;
  size_text: number;
  provider_id: string | null;
  attempts: 0 | 1 | 2 | 3;
  recipient_sha: string | null;
  created_at: string;
  sent_at: string | null;
  ref_json: string;
};

export type EmailAttemptRow = {
  email_key: string;
  n: 1 | 2 | 3;
  at: string;
  outcome: EmailAttemptOutcome;
  http_status: number | null;
  provider_id: string | null;
};

export type HealthSnapshotRow = {
  d: string;
  purpose: SnapshotPurpose;
  components_json: string;
};

export type AttentionSnoozeRow = {
  id: string;
  component: HealthComponent;
  item_key: string;
  from_d: string;
  until_d: string;
  created_at: string;
  created_by: number;
};

export type CredentialExpiryRow = {
  name: string;
  expires_on: string;
  set_at: string;
  set_by: number;
};

export type CredentialExpiryHistoryRow = {
  id: number;
  name: string;
  changed_at: string;
  op: "insert" | "update";
  expires_on: string;
  set_by: number;
};

export type AlertUserStateRow = {
  user_id: number;
  alert_key: string;
  acked_at: string | null;
  snoozed_until: string | null;
  updated_at: string;
};
