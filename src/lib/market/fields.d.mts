export type ProfileField =
  | "exchange"
  | "tz"
  | "session_open"
  | "session_close"
  | "closing_auction"
  | "opening_auction_window"
  | "announcement_hours"
  | "decision_cutoff"
  | "known_time_rules"
  | "batch_schedule"
  | "review_date_rule"
  | "currency"
  | "seed_amount"
  | "parcel_floor"
  | "settlement_days"
  | "tick_table"
  | "slippage_buckets"
  | "tiers"
  | "cost_formula"
  | "benchmark_index"
  | "regime_index"
  | "volatility_index"
  | "control_instrument"
  | "classification_scheme"
  | "short_data_kind"
  | "insider_notice_kind"
  | "halt_model"
  | "index_change_source"
  | "forward_results_dates"
  | "fundamentals_source"
  | "macro_series"
  | "dividend_imputation"
  | "sleeve_reality_cap"
  | "calendar_source"
  | "fx_source"
  | "yahoo_suffix"
  | "bar_latency_p95_min"
  | "preopen_recheck_min"
  | "category_map"
  | "universe_max";

export type WorkStatus = "not_started" | "in_build" | "testing" | "built" | "active" | "paused";
export type MarketModeValue = "off" | "data_only" | "full";
/** The profile fields that have a `mkt.<CODE>.<field>` key; the value says whether the Owner may edit it. */
export type MktKeyField =
  | "decision_cutoff"
  | "settlement_days"
  | "parcel_floor"
  | "opening_auction_window"
  | "preopen_recheck_min"
  | "classification_scheme"
  | "cost_formula"
  | "universe_max"
  | "dividend_imputation";

export const PROFILE_FIELDS: readonly ProfileField[];
export const WORK_STATUSES: readonly WorkStatus[];
export const MARKET_MODES: readonly MarketModeValue[];
export const COUNTED_TRIAL_FIELDS: readonly ProfileField[];
export const MKT_KEY_FIELDS: Readonly<Record<MktKeyField, "O" | "fixed">>;
export const FIELD_VALIDATORS: Readonly<Record<ProfileField, (value: unknown) => string | null>>;
/** Error text for a value of a field, or null (null values are accepted: "not set yet"). */
export function validateField(field: string, value: unknown): string | null;
