// The market profile's field list (M19 A1; DAT-241, D-992, D-1008). One name per row of the ch. 20 profile
// table (docs/M19_design.md, spec 20_markets_in_us.md 20.1) plus the five fields CXA-002 needs
// (yahoo_suffix, bar_latency_p95_min, preopen_recheck_min, category_map, universe_max). The list is pinned by
// tests/market/profile.test.ts: adding a field is a migration, a seed edit and a test edit together.
// Plain ESM (the Worker and the Actions scripts import it, like calendarCore.mjs).

/** Every profile field, in the order the Markets table and the seed print them. */
export const PROFILE_FIELDS = Object.freeze([
  "exchange",
  "tz",
  "session_open",
  "session_close",
  "closing_auction",
  "opening_auction_window",
  "announcement_hours",
  "decision_cutoff",
  "known_time_rules",
  "batch_schedule",
  "review_date_rule",
  "currency",
  "seed_amount",
  "parcel_floor",
  "settlement_days",
  "tick_table",
  "slippage_buckets",
  "tiers",
  "cost_formula",
  "benchmark_index",
  "regime_index",
  "volatility_index",
  "control_instrument",
  "classification_scheme",
  "short_data_kind",
  "insider_notice_kind",
  "halt_model",
  "index_change_source",
  "forward_results_dates",
  "fundamentals_source",
  "macro_series",
  "dividend_imputation",
  "sleeve_reality_cap",
  "calendar_source",
  "fx_source",
  "yahoo_suffix",
  "bar_latency_p95_min",
  "preopen_recheck_min",
  "category_map",
  "universe_max",
]);

/** Work status of a market (MKT-106, MKT-114). */
export const WORK_STATUSES = Object.freeze([
  "not_started",
  "in_build",
  "testing",
  "built",
  "active",
  "paused",
]);

/** The two-switch modes (D-994). */
export const MARKET_MODES = Object.freeze(["off", "data_only", "full"]);

/**
 * Fields whose Owner/seed change is a counted trial for the market's lineages (DAT-242, VAL-112):
 * costs, ticks, slippage, settlement and the parcel floor.
 */
export const COUNTED_TRIAL_FIELDS = Object.freeze([
  "cost_formula",
  "tick_table",
  "slippage_buckets",
  "settlement_days",
  "parcel_floor",
]);

/**
 * The fields behind a `mkt.<CODE>.<field>` configuration key (spec ch. 15 15.11.1, D-993) and whether the
 * Owner may edit the key. A key overlays the seed row; an Owner edit goes through setProfileField.
 */
export const MKT_KEY_FIELDS = Object.freeze({
  decision_cutoff: "fixed",
  settlement_days: "fixed",
  parcel_floor: "O",
  opening_auction_window: "fixed",
  preopen_recheck_min: "fixed",
  classification_scheme: "fixed",
  cost_formula: "O",
  universe_max: "O",
  dividend_imputation: "fixed",
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isMicro = (v) => typeof v === "bigint" && v >= 0n;
const isHhmm = (v) => typeof v === "string" && HHMM.test(v);
const isIana = (v) => typeof v === "string" && /^[A-Za-z_]+(\/[A-Za-z_+\-0-9]+)+$/.test(v);
const strList = (v) => Array.isArray(v) && v.length > 0 && v.every(isStr);
const kindOf = (v, kinds) => isObj(v) && typeof v.kind === "string" && kinds.includes(v.kind);
const indexOk = (v) => isObj(v) && isStr(v.code) && isStr(v.yahoo);

/**
 * One validator per field: (value) => error text | null. Called for non-null values only (null means "not
 * set yet", which the completeness check reports). Shapes are the ones the seed writes.
 */
export const FIELD_VALIDATORS = Object.freeze({
  exchange: (v) => (isStr(v) ? null : "exchange must be text"),
  tz: (v) => (isIana(v) ? null : "tz must be an IANA zone"),
  session_open: (v) => (isHhmm(v) ? null : "session_open must be HH:MM"),
  session_close: (v) => (isHhmm(v) ? null : "session_close must be HH:MM"),
  closing_auction: (v) =>
    kindOf(v, ["auction", "cross", "none"]) && (v.kind === "none" || isHhmm(v.at))
      ? null
      : "closing_auction must be { kind, at }",
  opening_auction_window: (v) =>
    (kindOf(v, ["staggered"]) && isHhmm(v.from) && isHhmm(v.to)) ||
    (kindOf(v, ["single"]) && isHhmm(v.at))
      ? null
      : "opening_auction_window must be staggered { from, to } or single { at }",
  announcement_hours: (v) =>
    isObj(v) && (v.kind === "continuous" || (isHhmm(v.from) && isHhmm(v.to)))
      ? null
      : "announcement_hours must be { from, to } or continuous",
  decision_cutoff: (v) =>
    isObj(v) && isHhmm(v.time) && isIana(v.zone) ? null : "decision_cutoff must be { time, zone }",
  known_time_rules: (v) =>
    isObj(v) && isStr(v.filings) && isStr(v.bars)
      ? null
      : "known_time_rules needs filings and bars",
  batch_schedule: (v) =>
    isObj(v) && isStr(v.kind) ? null : "batch_schedule must be { kind, ... }",
  review_date_rule: (v) => (isObj(v) && isStr(v.kind) ? null : "review_date_rule must be { kind }"),
  currency: (v) =>
    typeof v === "string" && /^[A-Z]{3}$/.test(v) ? null : "currency must be ISO 4217",
  seed_amount: (v) => (isObj(v) && isStr(v.kind) ? null : "seed_amount must be { kind, ... }"),
  parcel_floor: (v) => (isMicro(v) ? null : "parcel_floor must be micro units (bigint, 0 or more)"),
  settlement_days: (v) => (isInt(v, 0, 3) ? null : "settlement_days must be a whole number 0 to 3"),
  tick_table: (v) =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (b) =>
        isObj(b) && isMicro(b.fromMicro) && typeof b.tickMicro === "bigint" && b.tickMicro > 0n,
    )
      ? null
      : "tick_table must be a list of { fromMicro, tickMicro } bands",
  slippage_buckets: (v) =>
    isObj(v) && Array.isArray(v.buckets) && v.buckets.length > 0
      ? null
      : "slippage_buckets must be { buckets: [...] }",
  tiers: (v) => (isObj(v) ? null : "tiers must be an object"),
  cost_formula: (v) => (isStr(v) ? null : "cost_formula must be a profile code"),
  benchmark_index: (v) => (indexOk(v) ? null : "benchmark_index must be { code, yahoo }"),
  regime_index: (v) => (indexOk(v) ? null : "regime_index must be { code, yahoo }"),
  volatility_index: (v) => (indexOk(v) ? null : "volatility_index must be { code, yahoo }"),
  control_instrument: (v) =>
    isObj(v) && isStr(v.kind) ? null : "control_instrument must be { kind }",
  classification_scheme: (v) =>
    ["gics_group", "nse_level2", "sic_2digit"].includes(v)
      ? null
      : "classification_scheme must be gics_group, nse_level2 or sic_2digit",
  short_data_kind: (v) => (isStr(v) ? null : "short_data_kind must be text"),
  insider_notice_kind: (v) => (isStr(v) ? null : "insider_notice_kind must be text"),
  halt_model: (v) =>
    ["cx16", "in_bands", "us_luld"].includes(v)
      ? null
      : "halt_model must be cx16, in_bands or us_luld",
  index_change_source: (v) => (isStr(v) ? null : "index_change_source must be text"),
  forward_results_dates: (v) =>
    isObj(v) && isStr(v.kind) ? null : "forward_results_dates must be { kind }",
  fundamentals_source: (v) =>
    isObj(v) && isStr(v.kind) ? null : "fundamentals_source must be { kind }",
  macro_series: (v) => (strList(v) ? null : "macro_series must be a list of series names"),
  dividend_imputation: (v) =>
    typeof v === "boolean" ? null : "dividend_imputation must be true or false",
  sleeve_reality_cap: (v) =>
    isObj(v) && typeof v.multiple === "number" && v.multiple > 0
      ? null
      : "sleeve_reality_cap must be { multiple }",
  calendar_source: (v) => (isStr(v) ? null : "calendar_source must be text"),
  fx_source: (v) => (isStr(v) ? null : "fx_source must be text"),
  yahoo_suffix: (v) =>
    typeof v === "string" && /^(\.[A-Z]{1,3})?$/.test(v)
      ? null
      : "yahoo_suffix must be like .AX or empty",
  bar_latency_p95_min: (v) =>
    kindOf(v, ["at_cutoff"]) ||
    (kindOf(v, ["assumed"]) &&
      typeof v.minutes === "number" &&
      v.minutes >= 0 &&
      v.minutes <= 1440) ||
    (typeof v === "number" && v >= 0 && v <= 1440)
      ? null
      : "bar_latency_p95_min must be minutes, { kind: at_cutoff } or { kind: assumed, minutes }",
  preopen_recheck_min: (v) =>
    isInt(v, 1, 30) ? null : "preopen_recheck_min must be whole minutes 1 to 30",
  category_map: (v) => (isObj(v) && isStr(v.kind) ? null : "category_map must be { kind }"),
  universe_max: (v) =>
    kindOf(v, ["none"]) || isInt(v, 500, 6000) ? null : "universe_max must be none or 500 to 6,000",
});

/** The error text for a value of a field, or null (null values are accepted: "not set yet"). */
export function validateField(field, value) {
  const check = FIELD_VALIDATORS[field];
  if (check === undefined) return `unknown profile field: ${String(field)}`;
  if (value === null) return null;
  return check(value);
}
