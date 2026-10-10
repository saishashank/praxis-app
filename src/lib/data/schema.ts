// AU data layer: table and column names plus row types for main migration 0004_au_data.sql
// (docs/M2_design.md section 2). Constants and types only, no business logic. Timestamps are
// ISO-8601 UTC text with milliseconds and Z (D-031); `d` is the Sydney trading date YYYY-MM-DD;
// booleans are 0 | 1.

export type Flag01 = 0 | 1;
export type Tier = "U1" | "U2" | "U3";

export const AU_TABLES = {
  market: "market",
  tradingCalendar: "trading_calendar",
  instrument: "instrument",
  universeSnapshot: "universe_snapshot",
  priceBar: "price_bar",
  barRefetch: "bar_refetch",
  adjustmentFactor: "adjustment_factor",
  corporateAction: "corporate_action",
  corporateActionEvent: "corporate_action_event",
  announcement: "announcement",
  sourceRegister: "source_register",
  sourceRegisterHistory: "source_register_history",
  sourceStatus: "source_status",
  dataQualityFlag: "data_quality_flag",
  qualityScore: "quality_score",
  ingestCursor: "ingest_cursor",
  completionMarker: "completion_marker",
  asxRateToken: "asx_rate_token",
  workerState: "worker_state",
  backfillJob: "backfill_job",
} as const;

export type AuTableName = (typeof AU_TABLES)[keyof typeof AU_TABLES];

/** Column names per table, in table order. */
export const AU_COLUMNS = {
  market: ["code", "tz", "open_time", "close_time", "cutoff_time", "currency", "mode"],
  trading_calendar: ["market", "d", "kind", "close_time", "confirmed", "source"],
  instrument: [
    "id",
    "market",
    "code",
    "name",
    "listed_on",
    "delisted_on",
    "delist_reason",
    "last_price",
    "last_price_d",
  ],
  universe_snapshot: ["market", "d", "code", "status", "tier", "mcap_est", "adv", "halted"],
  price_bar: [
    "market",
    "code",
    "d",
    "o",
    "h",
    "l",
    "c",
    "volume",
    "source",
    "published_at",
    "ingested_at",
  ],
  bar_refetch: ["market", "code", "d", "fetched_at", "ohlcv_json", "max_diff_pct"],
  adjustment_factor: ["market", "code", "ex_date", "factor", "corporate_action_id", "computed_at"],
  corporate_action: [
    "id",
    "market",
    "code",
    "type",
    "ex_date",
    "record_date",
    "payload_json",
    "evidence_json",
  ],
  corporate_action_event: ["id", "action_id", "at", "status", "by", "note"],
  announcement: [
    "id",
    "market",
    "code",
    "ann_id",
    "published_at",
    "ingested_at",
    "type",
    "price_sensitive",
    "title",
    "url",
    "source",
  ],
  source_register: [
    "source",
    "terms_url",
    "permitted_use",
    "rate_limits",
    "last_checked",
    "risk",
    "status",
    "owner_ref",
    "summarisation_permitted",
  ],
  source_register_history: [
    "id",
    "source",
    "changed_at",
    "op",
    "terms_url",
    "permitted_use",
    "rate_limits",
    "last_checked",
    "risk",
    "status",
    "owner_ref",
    "summarisation_permitted",
  ],
  source_status: ["source", "mode", "since", "reason", "tripped_by"],
  data_quality_flag: [
    "id",
    "market",
    "code",
    "d",
    "check_id",
    "severity",
    "detail_json",
    "raised_at",
    "cleared_at",
    "blocks_entries",
  ],
  quality_score: ["market", "d", "tier", "valid", "expected", "score", "gate_pass"],
  ingest_cursor: ["job", "market", "source", "cursor_json", "updated_at"],
  completion_marker: ["market", "d", "kind", "at", "run_id", "outcome"],
  asx_rate_token: ["id", "last_request_at", "day_count_date", "day_count"],
  worker_state: ["key", "value_json", "updated_at"],
  backfill_job: ["name", "source", "next_date", "done", "rows_written_month"],
} as const satisfies Record<AuTableName, readonly string[]>;

/** The AU source keys seeded into source_register / source_status. */
export const AU_SOURCES = ["asx_announcements", "yahoo_eod", "rba", "abs", "asic_short"] as const;
export type AuSource = (typeof AU_SOURCES)[number];

export type MarketMode = "off" | "data_only" | "full";
export type CalendarKind = "session" | "holiday" | "early_close";
export type CorporateActionStatus =
  "auto_confirmed" | "queued" | "applied_best_evidence" | "resolved";
export type SourceRisk = "low" | "medium" | "high";
export type SourceRegisterStatus = "pending" | "enabled" | "disabled";
export type SourceMode = "on" | "off" | "tripped";
export type MarkerKind = "data" | "non-trading" | "late_sweep";

export type MarketRow = {
  code: string;
  tz: string;
  open_time: string;
  close_time: string;
  cutoff_time: string;
  currency: string;
  mode: MarketMode;
};

export type TradingCalendarRow = {
  market: string;
  d: string;
  kind: CalendarKind;
  close_time: string | null;
  confirmed: Flag01;
  source: string;
};

export type InstrumentRow = {
  id: number;
  market: string;
  code: string;
  name: string;
  listed_on: string | null;
  delisted_on: string | null;
  delist_reason: string | null;
  last_price: number | null;
  last_price_d: string | null;
};

export type UniverseSnapshotRow = {
  market: string;
  d: string;
  code: string;
  status: string;
  tier: Tier;
  mcap_est: number | null;
  adv: number | null;
  halted: Flag01;
};

export type PriceBarRow = {
  market: string;
  code: string;
  d: string;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
  source: string;
  published_at: string;
  ingested_at: string;
};

export type BarRefetchRow = {
  market: string;
  code: string;
  d: string;
  fetched_at: string;
  ohlcv_json: string;
  max_diff_pct: number;
};

export type AdjustmentFactorRow = {
  market: string;
  code: string;
  ex_date: string;
  factor: number;
  corporate_action_id: number;
  computed_at: string;
};

export type CorporateActionRow = {
  id: number;
  market: string;
  code: string;
  type: string;
  ex_date: string;
  record_date: string | null;
  payload_json: string;
  evidence_json: string | null;
};

export type CorporateActionEventRow = {
  id: number;
  action_id: number;
  at: string;
  status: CorporateActionStatus;
  by: string;
  note: string | null;
};

export type AnnouncementRow = {
  id: number;
  market: string;
  code: string;
  ann_id: string;
  published_at: string;
  ingested_at: string;
  type: string | null;
  price_sensitive: Flag01;
  title: string;
  url: string | null;
  source: string;
};

export type SourceRegisterRow = {
  source: string;
  terms_url: string | null;
  permitted_use: string | null;
  rate_limits: string | null;
  last_checked: string | null;
  risk: SourceRisk;
  status: SourceRegisterStatus;
  owner_ref: string | null;
  summarisation_permitted: Flag01;
};

export type SourceRegisterHistoryRow = SourceRegisterRow & {
  id: number;
  changed_at: string;
  op: "insert" | "update";
};

export type SourceStatusRow = {
  source: string;
  mode: SourceMode;
  since: string;
  reason: string | null;
  tripped_by: string | null;
};

export type DataQualityFlagRow = {
  id: number;
  market: string;
  code: string | null;
  d: string;
  check_id: string;
  severity: string;
  detail_json: string | null;
  raised_at: string;
  cleared_at: string | null;
  blocks_entries: Flag01;
};

export type QualityScoreRow = {
  market: string;
  d: string;
  tier: Tier;
  valid: number;
  expected: number;
  score: number;
  gate_pass: Flag01;
};

export type IngestCursorRow = {
  job: string;
  market: string;
  source: string;
  cursor_json: string;
  updated_at: string;
};

export type CompletionMarkerRow = {
  market: string;
  d: string;
  kind: MarkerKind;
  at: string;
  run_id: number | null;
  outcome: string;
};

export type AsxRateTokenRow = {
  id: 1;
  last_request_at: string | null;
  day_count_date: string | null;
  day_count: number;
};

export type WorkerStateRow = { key: string; value_json: string; updated_at: string };

export type BackfillJobRow = {
  name: string;
  source: string;
  next_date: string | null;
  done: Flag01;
  rows_written_month: number;
};

/**
 * Retention floors enforced by the DELETE triggers (the nightly prune may only delete rows
 * older than these; maintenance wiring is a later task).
 */
export const RETENTION_FLOOR = {
  priceBarDays: 730,
  barRefetchDays: 730,
  announcementDays: 400,
  /** Flags that blocked entries (blocks_entries = 1) are never deleted. */
  dataQualityFlagDays: 180,
} as const;
