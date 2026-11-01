import { COST_PROFILE_CODES } from "@/lib/arena/costs";
import { DEFAULT_INJECTION_PHRASES } from "@/lib/llm/injection";

// Typed registry of configuration keys (spec ch.15). Values are stored as JSON in config_version.
// Spec refs cite spec/15_configuration_reference.md line numbers.

export type ConfigKeyDef = {
  default: unknown;
  unit: string;
  // O = Owner-editable; B = Lane-B (Owner-editable within the bounds until M6, decision D-078 #10);
  // fixed = never edited.
  editable: "O" | "B" | "fixed";
  /** Inclusive numeric bounds, for scalar keys that have them (the tests read them). */
  range?: readonly [number, number];
  ref: string;
  // Returns an error text for an invalid value, or null. `get` reads another key's effective value.
  validate: (v: unknown, get: (key: ConfigKey) => Promise<unknown>) => Promise<string | null>;
};

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const intRange =
  (min: number, max = Infinity) =>
  async (v: unknown) =>
    isInt(v) && v >= min && v <= max ? null : `must be a whole number from ${min} to ${max}`;

const numRange = (min: number, max: number) => async (v: unknown) =>
  isNum(v) && v >= min && v <= max ? null : `must be a number from ${min} to ${max}`;

function exactKeys(v: unknown, keys: string[]): v is Record<string, unknown> {
  return isObj(v) && Object.keys(v).sort().join() === [...keys].sort().join();
}

const never = async () => "this setting is fixed";

const oneOf = (allowed: readonly string[]) => async (v: unknown) =>
  typeof v === "string" && allowed.includes(v) ? null : `must be one of ${allowed.join(", ")}`;

/** Markets that have a mode (MKT-102: IN and US do not exist before their build starts). */
export const MODE_MARKETS = ["AU"] as const;
/**
 * Modes that can be selected. `full` is accepted here as a value; in PRODUCTION the Owner action
 * (src/lib/data/controls.ts setMarketMode) refuses it unless a go_live_signoff row exists and
 * email_mode is not off (src/lib/golive/interlock.ts, M8 decision 33). Staging is free.
 */
export const SELECTABLE_MODES = ["off", "data_only", "full"] as const;

export function validateMarketModes(v: unknown): string | null {
  if (!isObj(v)) return "must list a mode for each market";
  const keys = Object.keys(v);
  if (keys.length === 0 || !keys.every((k) => (MODE_MARKETS as readonly string[]).includes(k))) {
    return "unknown market";
  }
  for (const x of Object.values(v)) {
    if (!(SELECTABLE_MODES as readonly unknown[]).includes(x))
      return "mode must be off, data_only or full";
  }
  return null;
}

/**
 * ARN-004 C1: the AU broad-index ETF code is an Owner [VERIFY] item (D-069 decision 20). This
 * placeholder is not a ticker; while it is set, C1 places no orders (arena/cohort.ts c1EtfStatus).
 */
export const C1_ETF_PLACEHOLDER = "UNSET-C1-ETF";

// ---- M4 keys (agents, families, replay engine; docs/M4_design.md section 6 decisions 10, 24, 28) ----
// Edit classes: "O" = Owner-editable; "B" = Lane-B: Owner-editable within the bounds now, becomes
// Lane B (A6 challengers) in M6 (decision 10); "fixed" = a spec constant, never edited. Defaults and
// bounds are those of ch.15 as extracted in docs/M4_requirements.md sections 2 and 3. Where the
// extract gives no bounds or no value the ref says so ("D-079") and the choice is the architect's
// to confirm. Variant names (F2-no-fundamentals, ...) are labels, not keys.

type RangedRow = readonly [
  key: string,
  kind: "int" | "num",
  def: number,
  min: number,
  max: number,
  unit: string,
  edit: "O" | "B",
  area: ConfigArea,
  ref: string,
  label: string,
];
type FixedRow = readonly [
  key: string,
  kind: "int" | "num" | "text",
  def: number | string,
  unit: string,
  area: ConfigArea,
  ref: string,
  label: string,
];

const FAM: ConfigArea = "Strategy families";
const REG: ConfigArea = "Regime and events";
const VAL: ConfigArea = "Validation statistics";
const REP: ConfigArea = "Replay and compute";

/** Owner-editable (O) or Lane-B (B) keys with bounds: families, events, replay, statistics, LLM. */
// prettier-ignore
const M4_RANGED = [
  // F1 trend / breakout (ch.15 section 15.3, spec 07 l.52)
  ["f1_volume_ratio_min", "num", 1.5, 1.2, 3, "x", "B", FAM, "ch.15 15.3 F1 volume_ratio_min", "F1: minimum volume ratio"],
  ["f1_rs_top_fraction", "num", 0.2, 0.1, 0.3, "fraction", "B", FAM, "ch.15 15.3 F1 rs_top_fraction", "F1: share of the tier counted as top 6-month return"],
  ["f1_initial_stop_atr", "num", 2, 1.5, 3, "x ATR", "B", FAM, "ch.15 15.3 F1 initial_stop_atr", "F1: initial stop distance"],
  ["f1_trail_atr", "num", 3, 2, 4, "x ATR", "B", FAM, "ch.15 15.3 F1 trail_atr", "F1: trailing stop distance"],
  ["f1_time_stop", "int", 40, 20, 60, "sessions", "B", FAM, "ch.15 15.3 F1 time_stop", "F1: sessions held before the slow-gain check"],
  ["f1_min_gain_pct", "num", 5, 0, 10, "%", "B", FAM, "ch.15 15.3 F1 min_gain", "F1: gain needed at the time stop"],
  ["f1_max_hold", "int", 120, 60, 120, "sessions", "B", FAM, "ch.15 15.3 F1 max_hold", "F1: hard maximum hold"],
  ["f1_high_lookback", "int", 250, 120, 250, "sessions", "B", FAM, "ch.15 high_lookback (AGT-030)", "F1: new-high lookback"],
  // F2 quality-value with catalyst (07 l.53)
  ["f2_event_ar_min_pct", "num", 3, 2, 6, "%", "B", FAM, "ch.15 15.3 F2 event_ar_min", "F2: minimum day-0 abnormal return"],
  ["f2_lookback_sessions", "int", 5, 3, 10, "sessions", "B", FAM, "ch.15 15.3 F2 lookback_sessions", "F2: event must be within the last"],
  ["f2_stop_atr", "num", 2.5, 1.5, 3.5, "x ATR", "B", FAM, "ch.15 15.3 F2 stop_atr", "F2: initial stop distance"],
  ["f2_time_stop", "int", 60, 30, 90, "sessions", "B", FAM, "ch.15 15.3 F2 time_stop", "F2: time exit"],
  // F3 event drift (07 l.54)
  ["f3_event_ar_min_pct", "num", 4, 3, 8, "%", "B", FAM, "ch.15 15.3 F3 event_ar_min", "F3: minimum day-0 abnormal return"],
  ["f3_volume_ratio_min", "num", 2, 1.5, 4, "x", "B", FAM, "ch.15 15.3 F3 volume_ratio_min", "F3: minimum day-0 volume ratio"],
  ["f3_max_gap_pct", "num", 8, 5, 12, "%", "B", FAM, "ch.15 15.3 F3 max_gap", "F3: cancel the order if the open gaps this far above the day-0 close"],
  ["f3_trail_after_pct", "num", 10, 5, 20, "%", "B", FAM, "ch.15 15.3 F3 trail_after", "F3: gain after which the trailing stop starts"],
  ["f3_trail_atr", "num", 2.5, 1.5, 4, "x ATR", "B", FAM, "ch.15 15.3 F3 trail_atr", "F3: trailing stop distance"],
  ["f3_time_exit", "int", 20, 10, 60, "sessions", "B", FAM, "ch.15 15.3 F3 time_exit", "F3: time exit"],
  // F4 mean reversion (07 l.55)
  ["f4_rsi2_max", "num", 10, 5, 20, "RSI", "B", FAM, "ch.15 15.3 F4 rsi2_max", "F4: RSI(2) below"],
  ["f4_rsi14_max", "num", 30, 20, 35, "RSI", "B", FAM, "ch.15 15.3 F4 rsi14_max", "F4: RSI(14) below"],
  ["f4_time_exit", "int", 10, 5, 20, "sessions", "B", FAM, "ch.15 15.3 F4 time_exit", "F4: time exit"],
  ["f4_stop_atr", "num", 2, 1.5, 3, "x ATR", "B", FAM, "ch.15 15.3 F4 stop_atr", "F4: initial stop distance"],
  // F5 small/mid-cap discovery (07 l.56)
  ["f5_volume_ratio_min", "num", 3, 2, 5, "x", "B", FAM, "ch.15 15.3 F5 volume_ratio_min", "F5: minimum volume ratio"],
  ["f5_ar_min_pct", "num", 3, 2, 6, "%", "B", FAM, "ch.15 15.3 F5 ar_min", "F5: minimum day-0 abnormal return"],
  ["f5_range_pos_min", "num", 0.75, 0.6, 0.9, "fraction", "B", FAM, "ch.15 15.3 F5 range_pos_min", "F5: minimum day-range position"],
  ["f5_stop_atr", "num", 2.5, 1.5, 3.5, "x ATR", "B", FAM, "ch.15 15.3 F5 stop_atr", "F5: initial stop distance"],
  ["f5_stop_cap_pct", "num", 20, 10, 25, "%", "B", FAM, "ch.15 15.3 F5 stop_cap (spec -20 % within -10 to -25 %, stored as a positive loss)", "F5: largest initial stop loss"],
  ["f5_trail_atr", "num", 3, 2, 4, "x ATR", "B", FAM, "ch.15 15.3 F5 trail_atr", "F5: trailing stop distance"],
  ["f5_time_stop", "int", 30, 15, 45, "sessions", "B", FAM, "ch.15 15.3 F5 time_stop", "F5: time exit"],
  // F6 multi-agent consensus (07 l.57)
  ["f6_min_classes", "int", 3, 3, 4, "classes", "B", FAM, "ch.15 15.3 F6 min_classes", "F6: evidence classes needed"],
  ["f6_insider_min", "num", 0.5, 0.25, 0.75, "score", "B", FAM, "ch.15 15.3 F6 insider_min", "F6: insider/flow score counted as evidence"],
  ["f6_short_drop_pp", "num", 2, 1, 4, "pp", "B", FAM, "ch.15 15.3 F6 short_drop_pp; ch.15 l.116", "F6: short-interest fall counted as evidence"],
  ["f6_stop_atr", "num", 2, 1.5, 3, "x ATR", "B", FAM, "ch.15 15.3 F6 stop_atr", "F6: initial stop distance"],
  ["f6_time_stop", "int", 20, 10, 40, "sessions", "B", FAM, "ch.15 15.3 F6 time_stop", "F6: time exit"],
  // Shared family rules
  ["reentry_block", "int", 10, 5, 20, "sessions", "B", FAM, "FAM-002; ch.15 l.110", "Sessions a code is blocked after a stop exit"],
  ["max_open_positions", "int", 2, 1, 2, "positions", "O", FAM, "ARN-003; ch.15 l.17", "Most positions open at once"],
  // Events and insider/flow (AGT-020, AGT-105)
  ["event_polarity_threshold_pct", "num", 2, 0.5, 10, "%", "B", REG, "AGT-020; ch.15 l.117 (bounds not in the extract, D-079)", "Abnormal return that gives an event a polarity"],
  ["insider_window_sessions", "int", 30, 10, 60, "sessions", "B", REG, "AGT-105; ch.15 l.116 (bounds not in the extract, D-079)", "Insider/flow window"],
  // Replay engine
  ["rolling_start_step", "int", 5, 5, 21, "sessions", "O", REP, "ARN-080; ch.15 l.39", "Rolling-start replay step"],
  ["c2_live_per_family", "int", 20, 10, 50, "controls", "O", REP, "ARN-004; ch.15 l.38", "Live C2 controls per family"],
  ["zero_edge_trials", "int", 20000, 5000, 100000, "paths", "O", REP, "ARN-071, PRD-020; ch.15 l.180", "Zero-edge Monte-Carlo paths"],
  ["replay_light_minutes", "int", 30, 5, 120, "min", "O", REP, "ARN-100; ch.15 l.61 (bounds not in the extract, D-079)", "Weekly light replay budget"],
  ["replay_full_minutes", "int", 300, 15, 360, "min", "O", REP, "ARN-100; ch.15 l.61 (bounds not in the extract, D-079)", "Monthly full replay budget"],
  ["nightly_compute_minutes", "int", 10, 2, 60, "min", "O", REP, "ARN-100 (bounds not in the extract, D-079)", "Nightly deterministic compute budget per market"],
  ["turso_recent_sessions", "int", 500, 260, 1000, "sessions", "O", REP, "DAT-142; ch.15 l.141 (bounds not in the extract, D-079)", "Sessions of bars kept in the database"],
  ["event_backfill_years", "int", 6, 1, 15, "years", "O", REP, "DAT-125; ch.15 l.147 (bounds not in the extract, D-079)", "Announcement metadata backfill depth"],
  // Validation statistics (Owner-editable ones)
  ["trial_budget_per_lineage", "int", 20, 1, 100, "tests", "O", VAL, "ARN-085; ch.15 l.44 (bounds not in the extract, D-079)", "Trial budget per lineage"],
  ["survivorship_flag_share_pct", "num", 5, 1, 50, "%", "O", VAL, "ARN-082; ch.15 l.45 (bounds not in the extract, D-079)", "Missing-price share that marks a year survivorship-exposed"],
  ["useful_edge_min_pct", "num", 0.5, 0, 5, "%", "O", VAL, "ARN-086; ch.15 l.46 (bounds not in the extract, D-079)", "Smallest net edge that counts as useful"],
  ["delta_bust_tolerance", "num", 0.05, 0, 0.25, "fraction", "O", VAL, "VAL-110 (iii); ch.15 l.63 (bounds not in the extract, D-079)", "Bust-plus-stalled excess that blocks a promotion"],
  ["barrier_k_up", "num", 2, 1, 3, "x ATR", "O", VAL, "ARN-072; ch.15 l.72", "Triple-barrier upper distance"],
  ["barrier_k_down", "num", 1.5, 1, 3, "x ATR", "O", VAL, "ARN-072; ch.15 l.72", "Triple-barrier lower distance"],
  ["killswitch_max_looks_per_year", "int", 1, 1, 52, "looks", "O", VAL, "ARN-093; ch.15 l.54 (set each year from the measured trade rate, decision 28; default 1 until first computed, D-079)", "Kill-switch looks per year"],
  // LLM budgets (LLM-050, ARN-068)
  ["llm_budget_r1_daily", "int", 60000, 30000, 90000, "tokens/day", "O", "Quotas", "LLM-050; ch.15 l.183 (bounds as R2, +/-50 %, D-079)", "Daily LLM token budget, R1 triage"],
  ["llm_budget_r2_daily", "int", 50000, 25000, 75000, "tokens/day", "O", "Quotas", "LLM-050; ch.15 l.184", "Daily LLM token budget, R2 analysis"],
  ["llm_budget_r3_daily", "int", 25000, 12500, 37500, "tokens/day", "O", "Quotas", "LLM-050; ch.15 l.185 (bounds as R2, +/-50 %, D-079)", "Daily LLM token budget, R3"],
  ["llm_budget_r5_daily", "int", 10000, 5000, 15000, "tokens/day", "O", "Quotas", "LLM-050; ch.15 l.186 (bounds as R2, +/-50 %, D-079)", "Daily LLM token budget, R5"],
  ["nightly_tokens_per_market", "int", 30000, 0, 40000, "tokens/night", "O", "Quotas", "ARN-068; ch.15 l.75", "LLM tokens per night per market"],
  ["llm_cache_ttl_hours", "int", 24, 1, 168, "h", "O", "Quotas", "LLM-031; ch.15 l.169", "LLM response cache lifetime"],
  ["r2_materiality_min", "int", 2, 1, 3, "level", "O", "Quotas", "LLM-032; ch.15 l.118 (bounds not in the extract, D-079)", "Rule materiality needed to ask R2"],
] as const satisfies readonly RangedRow[];

/** Fixed spec constants (edit "-"): indicator windows (decision 10), statistics, replay. */
// prettier-ignore
const M4_FIXED = [
  // Decision 10: fixed windows that were literals in the spec text
  ["atr_period", "int", 20, "sessions", REG, "AGT-030 ATR(20), Wilder", "ATR period"],
  ["rsi_short_period", "int", 2, "sessions", REG, "AGT-030 RSI(2), Wilder", "Short RSI period"],
  ["rsi_long_period", "int", 14, "sessions", REG, "AGT-030 RSI(14), Wilder", "Long RSI period"],
  ["sma_exit_period", "int", 5, "sessions", REG, "F4 exit, spec 07 l.55", "Short SMA period (F4 exit)"],
  ["sma_mid_period", "int", 50, "sessions", REG, "indicator_daily sma50, design 3", "Medium SMA period"],
  ["sma_trend_period", "int", 200, "sessions", REG, "F4 entry, spec 07 l.55", "Trend SMA period"],
  ["return_window_sessions", "int", 126, "sessions", REG, "AGT-030 6-month return", "6-month return window"],
  ["adv_window_sessions", "int", 20, "sessions", REG, "AGT-030 ADV", "ADV window"],
  ["volume_ratio_window_sessions", "int", 20, "sessions", REG, "AGT-030 volume ratio", "Volume ratio window"],
  ["vol_window_sessions", "int", 20, "sessions", REG, "AGT-101 20-session realised volatility", "Realised volatility window"],
  ["regime_vol_lookback_sessions", "int", 1260, "sessions", REG, "AGT-101 trailing 1,260 sessions; ARN-080 warm-up", "Regime volatility percentile lookback"],
  ["regime_fall_window_sessions", "int", 5, "sessions", REG, "AGT-101 5-session fall", "Regime fall window"],
  ["short_interest_window_sessions", "int", 10, "sessions", REG, "F6 class (d), spec 07 l.57", "Short-interest change window"],
  ["f4_event_window_sessions", "int", 3, "sessions", REG, "F4, spec 07 l.55 (no negative event in the last 3 sessions)", "F4: negative-event look-back"],
  ["day0_close_offset_min", "int", 10, "min", REG, "ARN-020 day 0; continuous trading ends 10 min before the close [VERIFY]", "Day-0 boundary before the calendar close [VERIFY]"],
  ["decision_cutoff", "text", "18:10", "Melbourne time", REG, "ARN-020, DAT-001; ch.15 l.15", "Decision cut-off"],
  ["thesis_breakers_min", "int", 3, "count", REG, "AGT-110", "Thesis-breakers on a card, at least"],
  ["thesis_breakers_max", "int", 5, "count", REG, "AGT-110", "Thesis-breakers on a card, at most"],
  ["thesis_amber_fraction", "num", 0.2, "fraction", REG, "AGT-111 amber within 20 % of the trigger", "Amber when this close to a thesis-breaker trigger"],
  ["ledger_notional_aud", "int", 600, "A$", VAL, "ARN-080 fixed notional A$600", "Signal-ledger notional per row"],
  // Statistics (ARN-081..087, VAL-110)
  ["alpha", "num", 0.05, "level", VAL, "ARN-081; ch.15 l.62", "Overall test level"],
  ["bootstrap_replications_min", "int", 1000, "replications", VAL, "ARN-081 B = max(1,000, 20 / level); ch.15 l.57", "Bootstrap replications, floor"],
  ["bootstrap_replications_factor", "int", 20, "x", VAL, "ARN-081 B = max(1,000, 20 / level)", "Bootstrap replications: numerator over the level"],
  ["bootstrap_size_check_replications", "int", 2000, "replications", VAL, "AT-17 test-size check; decision 24", "Bootstrap replications for the size checks"],
  ["bootstrap_block_min_sessions", "int", 5, "sessions", VAL, "ARN-081 block = max(5, p75); ch.15 l.60", "Bootstrap block length, floor"],
  ["bootstrap_block_percentile", "int", 75, "percentile", VAL, "ARN-081 block = max(5, p75); ch.15 l.60", "Holding-period percentile that sets the block"],
  ["min_blocks", "int", 15, "blocks", VAL, "ARN-081; ch.15 l.58", "Independent blocks needed in a tested window"],
  ["min_trades", "int", 100, "trades", VAL, "ARN-082; ch.15 l.59", "Signal-ledger trades needed in a tested window"],
  ["c2_controls_per_row", "int", 20, "controls", VAL, "ARN-081, ARN-080; ch.15 l.56 (at least 10)", "Matched C2 controls per ledger row"],
  ["active_lineages_floor", "int", 6, "lineages", VAL, "ARN-081 L = max(6, active lineages); ch.15 l.41", "Least L in the lineage correction"],
  ["split_holdout_min_sessions", "int", 378, "sessions", VAL, "ARN-082 holdout = max(378, 15 x block); ch.15 l.40", "Holdout length, floor"],
  ["split_validation_min_sessions", "int", 504, "sessions", VAL, "ARN-082 validation = max(504, 15 x block); ch.15 l.40", "Validation length, floor"],
  ["split_block_multiple", "int", 15, "blocks", VAL, "ARN-082 15 x block", "Split lengths in blocks"],
  ["split_development_min_sessions", "int", 252, "sessions", VAL, "ARN-082 development at least 252 or the splits defer", "Development split, minimum"],
  ["purge_extra_sessions", "int", 20, "sessions", VAL, "ARN-082 purge = max holding bound + 20; ch.15 l.42", "Purge: sessions added to the holding bound"],
  ["survivorship_min_announcements", "int", 3, "announcements", VAL, "ARN-082 survivorship series", "Announcements that make a code count"],
  ["survivorship_window_sessions", "int", 60, "sessions", VAL, "ARN-082 survivorship series", "Window for those announcements"],
  ["forward_alpha_total", "num", 0.1, "level", VAL, "ARN-086 (0.10 / L) / 2^k; ch.15 l.52", "CONSISTENT-FORWARD level to spend"],
  ["forward_look_trades", "int", 100, "trades", VAL, "ARN-086 looks at 100, 200, 300 trades", "Forward trades per look"],
  ["forward_min_months", "int", 6, "months", VAL, "ARN-086 at least 6 months", "Forward evidence, least months"],
  ["safety_check_min_neff", "int", 8, "cohorts", VAL, "VAL-110 (iii); ch.15 l.55", "Effective N for the safety check to block"],
  ["pbo_max", "num", 0.2, "probability", VAL, "VAL-110 (v); ch.15 l.64", "Largest probability of backtest overfitting"],
  ["pbo_min_variants", "int", 5, "variants", VAL, "VAL-110 (v); ch.15 l.50", "Variants needed for PBO"],
  ["pbo_blocks", "int", 10, "blocks", VAL, "VAL-110 (v) S = 10", "PBO blocks"],
  ["dsr_min", "num", 0.95, "probability", VAL, "VAL-110 (vi); ch.15 l.65", "Smallest deflated Sharpe ratio"],
  ["min_cohorts_ranked", "int", 5, "cohorts", VAL, "ARN-078; ch.15 l.73", "Resolved forward cohorts needed to rank"],
  ["progress_min_neff", "int", 3, "cohorts", VAL, "ARN-071; ch.15 l.71", "Effective N for the progress figure"],
  ["scenario_min_n", "int", 30, "trades", VAL, "AGT-110, ARN-070; ch.15 l.123", "Trades needed to show a scenario table"],
  ["cost_feasibility_ratio", "num", 2, "x", VAL, "ARN-094; ch.15 l.74", "Gross edge needed as a multiple of round-trip cost"],
  ["stress_cost_profile", "text", "P3", "profile", VAL, "ARN-083 P3 + 50 % slippage; ch.15 l.29", "Stress test cost profile"],
  ["stress_slippage_extra_pct", "int", 50, "%", VAL, "ARN-083 P3 + 50 % slippage; ch.15 l.29", "Stress test extra slippage"],
  ["barrier_horizon_sessions", "int", 20, "sessions", VAL, "ARN-072 20-session limit", "Triple-barrier horizon"],
  ["killswitch_trades_per_look", "int", 20, "trades", VAL, "ARN-093 looks every 20 forward trades; ch.15 l.53", "Forward trades per kill-switch look"],
  ["killswitch_alpha_total", "num", 0.05, "level", VAL, "ARN-093 alpha 0.05 / 3 per criterion", "Kill-switch level to spend"],
  ["killswitch_criteria", "int", 3, "criteria", VAL, "ARN-093 three criteria", "Kill-switch criteria"],
  ["killswitch_quiet_sessions", "int", 60, "sessions", VAL, "VAL-103 no kill-switch event in the last 60 sessions (decision 28)", "Kill-switch quiet window"],
  ["event_coverage_min_pct", "int", 90, "%", VAL, "DAT-127, ARN-086; ch.15 l.148", "Event coverage below which a family is UNVALIDATABLE"],
  // Replay and sleeve
  ["zero_edge_seed", "int", 20261018, "seed", REP, "PRD-020; ch.15 l.181 (stored at build; value chosen at M4, D-079)", "Zero-edge benchmark seed"],
  ["sleeve_leverage", "int", 10, "x", REP, "ARN-049; ch.15 l.31", "Sleeve leverage"],
  ["reality_cap", "int", 5, "x", REP, "ARN-049 reality-adjusted figure [VERIFY]; ch.15 l.37", "Reality-adjusted leverage [VERIFY]"],
] as const satisfies readonly FixedRow[];

type RangedKey = (typeof M4_RANGED)[number][0];
type FixedKey = (typeof M4_FIXED)[number][0];

const boundsText = (kind: "int" | "num", min: number, max: number, unit: string) =>
  `${kind === "int" ? "whole number" : "number"}, ${min} to ${max}${unit === "%" ? " percent" : ""}`;

const M4_RANGED_KEYS = Object.fromEntries(
  M4_RANGED.map(([key, kind, def, min, max, unit, edit, , ref]) => [
    key,
    {
      default: def,
      unit,
      editable: edit,
      ref,
      range: [min, max] as const,
      validate: kind === "int" ? intRange(min, max) : numRange(min, max),
    } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<RangedKey, ConfigKeyDef>;

const M4_FIXED_KEYS = Object.fromEntries(
  M4_FIXED.map(([key, , def, unit, , ref]) => [
    key,
    { default: def, unit, editable: "fixed", ref, validate: never } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<FixedKey, ConfigKeyDef>;

const M4_META: Record<RangedKey | FixedKey, ConfigMeta> = {
  ...(Object.fromEntries(
    M4_RANGED.map(([key, kind, , min, max, unit, , area, , label]) => [
      key,
      {
        label,
        area,
        bounds: boundsText(kind, min, max, unit),
        input: kind === "int" ? "int" : "number",
      },
    ]),
  ) as Record<RangedKey, ConfigMeta>),
  ...(Object.fromEntries(
    M4_FIXED.map(([key, kind, , , area, , label]) => [
      key,
      {
        label,
        area,
        bounds: "fixed",
        input: kind === "text" ? "text" : kind === "num" ? "number" : "int",
      },
    ]),
  ) as Record<FixedKey, ConfigMeta>),
};

// ---- M5 keys (Sentinel, alerts, email; docs/M5_design.md 4.11, decisions D-096 and D-097) ----
// Defaults and bounds are those of ch.15 where the spec gives them (ch.15 l.119-122, 158, 163-165,
// 174-175, 189-198). Where ch.15 gives a default but no bounds, or the design adds a key (D-096), the
// ref says so: "D-097" marks bounds chosen by the builder, "D-096" a key the architect added. Times
// are Melbourne local "HH:MM" read by the Worker clock (docs/M5_design.md 2.1).

const SEM: ConfigArea = "Sentinel and email";

// prettier-ignore
const M5_RANGED = [
  // Alert tiers and the Sentinel (AGT-014, AGT-115, EML-020, PLT-075)
  ["alert_p0_weight", "num", 0.1, 0.01, 0.5, "fraction of NAV", "O", SEM, "AGT-115; ch.15 l.119 (10 % NAV; bounds not in the extract, D-097)", "Held weight in its execution's NAV that makes a P0"],
  ["p0_email_daily_cap", "int", 10, 1, 20, "emails/day", "O", SEM, "EML-020; ch.15 l.120 (bounds not in the extract, D-097)", "Most P0 alert emails per day"],
  ["p0_batch_window_min", "int", 5, 1, 15, "min", "O", SEM, "EML-020, AGT-115; ch.15 l.120 (bounds not in the extract, D-097)", "P0 follow-ups inside this window are batched into one email"],
  ["watch_list_window", "int", 20, 5, 60, "sessions", "O", SEM, "AGT-014; ch.15 l.121 (bounds not in the extract, D-097)", "A code with a family signal in the last this many sessions is on the watch-list"],
  ["owner_add_expiry_days", "int", 90, 1, 90, "days", "O", SEM, "AGT-014 (expiry at most 90 days); ch.15 l.121 (lower bound D-097)", "Longest an Owner-added watch-list code stays on"],
  ["sentinel_max_items_per_run", "int", 40, 1, 40, "items", "O", SEM, "AGT-010, PLT-075 (at most 40); ch.15 l.122 (lower bound D-097)", "Announcements assessed per Sentinel call"],
  // Email budget and review follow-up (EML-004, EML-036, NFR-006)
  ["email_daily_cap", "int", 20, 5, 50, "emails/day", "O", SEM, "EML-004; ch.15 l.189", "Emails per day (3 are reserved, P0 uses the rest)"],
  ["email_monthly_cap", "int", 300, 50, 1000, "emails/month", "O", SEM, "EML-004; ch.15 l.190", "Emails per month"],
  ["unopened_review_banner_days", "int", 3, 1, 14, "days", "O", SEM, "EML-036; ch.15 l.165 (bounds not in the extract, D-097)", "Banner and UNREAD subject after this many days without a read review"],
  ["unopened_review_incident_days", "int", 7, 3, 14, "days", "O", SEM, "NFR-006, EML-036; ch.15 l.191", "Incident email after this many days without a read review"],
  // Attention reminder (EML-023)
  ["attention_snooze_max_days", "int", 7, 1, 14, "days", "O", SEM, "EML-023; ch.15 l.198", "Longest an attention item can be snoozed"],
  // Thesis-breakers (AGT-111, decision 16)
  ["tb_kw_confirm_sessions", "int", 1, 1, 5, "sessions", "O", SEM, "AGT-111, D-096 decision 16 (bounds D-097)", "A keyword thesis-breaker turns green again if unconfirmed after this many nights"],
] as const satisfies readonly RangedRow[];

// prettier-ignore
const M5_FIXED = [
  ["email_max_size_kb", "int", 90, "KB", SEM, "EML-013; ch.15 l.164", "Largest Evening Review email (HTML)"],
  ["email_reserved_slots", "int", 3, "emails/day", SEM, "EML-004, EML-023; ch.15 l.174", "Emails reserved each day: Evening Review, new incident, attention reminder"],
  ["sentinel_body_max_kb", "int", 256, "KB", SEM, "D-096 (design 4.2)", "Largest feed body the Worker hands to the Sentinel route"],
  ["test_email_min_interval_min", "int", 10, "min", SEM, "EML-034, D-096 decision 23", "Shortest gap between test emails"],
  ["test_email_daily_max", "int", 3, "emails/day", SEM, "EML-034, D-096 decision 23", "Most test emails per day"],
] as const satisfies readonly FixedRow[];

type M5RangedKey = (typeof M5_RANGED)[number][0];
type M5FixedKey = (typeof M5_FIXED)[number][0];

const M5_RANGED_KEYS = Object.fromEntries(
  M5_RANGED.map(([key, kind, def, min, max, unit, edit, , ref]) => [
    key,
    {
      default: def,
      unit,
      editable: edit,
      ref,
      range: [min, max] as const,
      validate: kind === "int" ? intRange(min, max) : numRange(min, max),
    } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M5RangedKey, ConfigKeyDef>;

const M5_FIXED_KEYS = Object.fromEntries(
  M5_FIXED.map(([key, , def, unit, , ref]) => [
    key,
    { default: def, unit, editable: "fixed", ref, validate: never } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M5FixedKey, ConfigKeyDef>;

const M5_META_TABLES: Record<M5RangedKey | M5FixedKey, ConfigMeta> = {
  ...(Object.fromEntries(
    M5_RANGED.map(([key, kind, , min, max, unit, , area, , label]) => [
      key,
      {
        label,
        area,
        bounds: boundsText(kind, min, max, unit),
        input: kind === "int" ? "int" : "number",
      },
    ]),
  ) as Record<M5RangedKey, ConfigMeta>),
  ...(Object.fromEntries(
    M5_FIXED.map(([key, , , , area, , label]) => [
      key,
      { label, area, bounds: "fixed", input: "int" },
    ]),
  ) as Record<M5FixedKey, ConfigMeta>),
};

/** "HH:MM" Melbourne local time as minutes after midnight, or null when not of that shape. */
export function clockMinutes(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** A time of day inside [lo, hi] ("HH:MM", inclusive), the shape of every M5 time key. */
const timeIn = (lo: string, hi: string) => async (v: unknown) => {
  const t = clockMinutes(v);
  return t !== null && t >= clockMinutes(lo)! && t <= clockMinutes(hi)!
    ? null
    : `must be a time of day from ${lo} to ${hi} written HH:MM (Melbourne)`;
};

/** A "on" / "off" switch stored as text, as written in ch.15 ("on / off"). */
export const ON_OFF = ["on", "off"] as const;

export const WATCHDOG_TIME_NAMES = ["first", "second"] as const;
/** watchdog_times (ch.15 l.158): the two YAML watchdog runs, Melbourne local. Bounds D-097. */
async function validateWatchdogTimes(v: unknown): Promise<string | null> {
  if (!exactKeys(v, [...WATCHDOG_TIME_NAMES])) return "needs first and second";
  const { first, second } = v;
  const a = clockMinutes(first);
  const b = clockMinutes(second);
  if (a === null || b === null) return "first and second must be times written HH:MM";
  if (a < 20 * 60 + 30 || a > 21 * 60 + 30) return "first must be from 20:30 to 21:30";
  if (b < 21 * 60 || b > 23 * 60) return "second must be from 21:00 to 23:00";
  return a < b ? null : "first must be earlier than second";
}

/** email_retry_policy (D-096 decision 23): in-request retry, Retry-After cap, next-invocation gap. */
export const EMAIL_RETRY_POLICY = {
  max_attempts: 3,
  in_request_delay_s: 2,
  retry_after_max_s: 5,
  next_invocation_min_s: 60,
  timeout_s: 8,
} as const;

/**
 * The Evening Review times (ch.15 l.163). They must stay in order: send time < partial_at < send_by.
 * Moving one past a neighbour needs the neighbour changed first. Bounds D-097.
 */
type OrderedTimeKey = "evening_review_time" | "partial_at" | "send_by";
async function validateOrderedTime(
  key: OrderedTimeKey,
  v: unknown,
  get: (k: OrderedTimeKey) => Promise<unknown>,
): Promise<string | null> {
  const range =
    key === "evening_review_time"
      ? (["19:30", "21:00"] as const)
      : key === "partial_at"
        ? (["20:00", "21:30"] as const)
        : (["20:15", "22:00"] as const);
  const bad = await timeIn(range[0], range[1])(v);
  if (bad) return bad;
  const t = clockMinutes(v)!;
  const other = async (k: OrderedTimeKey) => clockMinutes(await get(k));
  const start = key === "evening_review_time" ? t : await other("evening_review_time");
  const partial = key === "partial_at" ? t : await other("partial_at");
  const by = key === "send_by" ? t : await other("send_by");
  if (start === null || partial === null || by === null) return null; // a neighbour is unreadable
  if (!(start < partial && partial < by)) {
    return `must keep the order send time < partial_at < send_by (now ${hhmm(start)}, ${hhmm(partial)}, ${hhmm(by)})`;
  }
  return null;
}

/** AGT-101 thresholds (ch.15 l.115): one Owner-editable object. Bounds are the architect's (D-079). */
export const REGIME_PARAM_NAMES = [
  "sma_sessions",
  "vol_pct_riskoff",
  "vol_pct_shock",
  "vol_pct_riskon",
  "fall5_pct",
  "exit_hysteresis",
] as const;
async function validateRegimeParams(v: unknown): Promise<string | null> {
  if (!exactKeys(v, [...REGIME_PARAM_NAMES])) return `needs ${REGIME_PARAM_NAMES.join(", ")}`;
  const { sma_sessions: sma, vol_pct_riskoff: off, vol_pct_shock: shock } = v;
  const { vol_pct_riskon: on, fall5_pct: fall, exit_hysteresis: hyst } = v;
  if (!isInt(sma) || sma < 50 || sma > 400) {
    return "sma_sessions must be a whole number from 50 to 400";
  }
  if (!isNum(on) || !isNum(off) || !isNum(shock) || !(0 < on && on < off && off < shock)) {
    return "must satisfy 0 < vol_pct_riskon < vol_pct_riskoff < vol_pct_shock <= 100";
  }
  if (shock > 100)
    return "must satisfy 0 < vol_pct_riskon < vol_pct_riskoff < vol_pct_shock <= 100";
  if (!isNum(fall) || fall <= 0 || fall > 50) return "fall5_pct must be above 0 and at most 50";
  if (!isInt(hyst) || hyst < 1 || hyst > 10) {
    return "exit_hysteresis must be a whole number from 1 to 10";
  }
  return null;
}

/** AGT-105 score weights (ch.15 l.116): director net, new or increased holder, decreased holder. */
export const INSIDER_WEIGHT_NAMES = [
  "director_net",
  "holder_new_or_increase",
  "holder_decrease",
] as const;
async function validateInsiderWeights(v: unknown): Promise<string | null> {
  // director_sale is optional (AGT-136, D-242): absent means it follows director_net, as in v1.
  const base = [...INSIDER_WEIGHT_NAMES];
  if (!exactKeys(v, base) && !exactKeys(v, [...base, "director_sale"]))
    return `needs ${INSIDER_WEIGHT_NAMES.join(", ")} (and optionally director_sale)`;
  return Object.values(v).every((x) => isNum(x) && x >= 0 && x <= 1)
    ? null
    : "every weight must be a number from 0 to 1";
}

/** Share of the daily role budgets that one market may use (design 4.6); AU is the only market. */
async function validateMarketShare(v: unknown): Promise<string | null> {
  if (!isObj(v) || Object.keys(v).length === 0) return "must list a share for each market";
  for (const [k, x] of Object.entries(v)) {
    if (!(MODE_MARKETS as readonly string[]).includes(k)) return "unknown market";
    if (!isNum(x) || x < 0 || x > 1) return "every share must be a number from 0 to 1";
  }
  return null;
}

// ---- M6 keys (learning and knowledge; docs/M6_design.md 4.12, decisions D-110 and D-111) ----
// Defaults and bounds are those of ch.15 where the spec gives them (ch.15 l.40-75, 124, 170, 182,
// 207-215). "D-111" marks bounds and keys chosen by the builder (docs/M6_design.md 4.12
// "agent-chosen") and the reviewed constants that now have a key (D-085, D-090, D-091, D-095).
// Fixed keys are spec constants no screen edits; the editable ones are Owner-editable (O).

const LRN: ConfigArea = "Learning and knowledge";

// prettier-ignore
const M6_RANGED = [
  // Challengers (ARN-005, ARN-065, KB-042)
  ["max_challengers", "int", 8, 1, 8, "challengers", "O", LRN, "ARN-005, KB-042; ch.15 l.66", "Most challengers per market in proposed ... approved"],
  ["max_promotions_per_week", "int", 3, 0, 3, "promotions/week", "O", LRN, "ARN-065, KB-042; ch.15 l.67", "Most promotions applied per market per week"],
  ["shakedown_sessions", "int", 10, 5, 20, "sessions", "O", LRN, "ARN-065; ch.15 l.68", "Live-feed sessions a challenger runs before review"],
  // Critic wording (LLM-021)
  ["critic_llm_calls_per_night", "int", 10, 0, 20, "calls/night", "O", LRN, "LLM-021; ch.15 l.124 (bounds 0-20 agent-chosen, D-111)", "Critic wording calls per night per market"],
  // Ch.16 factor data and picks (AGT-112, AGT-113, ARN-095)
  ["factor_min_bucket_n", "int", 30, 20, 100, "trades", "O", LRN, "AGT-112; ch.15 l.207", "Trades a factor bucket needs to be shown"],
  ["picks_per_profile", "int", 10, 0, 10, "picks", "O", LRN, "AGT-113; ch.15 l.208; M17 O-76 default 10", "Picks per profile per night"],
  ["picks_max_per_family", "int", 10, 10, 10, "picks", "O", LRN, "AGT-113; ch.15 l.211; M17 O-76: no per-family cap; bounds pinned to 10 by D-791", "Fixed at 10 = no per-family cap (Owner decision O-76); kept so a stored value cannot bring the cap back"],
  ["pick_valid_sessions", "int", 2, 1, 5, "sessions", "O", LRN, "UXN-040, AGT-113; ch.15 l.212", "Not used since D-187: a waiting pick is checked each night against information instead of a session count"],
  ["pick_success_min_n", "int", 30, 10, 200, "picks", "O", LRN, "UXN-041; ch.15 l.213 (bounds 'as ch. 16' not given, 10-200 agent-chosen, D-111)", "Closed picks needed before model success is shown"],
] as const satisfies readonly RangedRow[];

// prettier-ignore
const M6_FIXED = [
  // Lessons (ARN-063, KB-020)
  ["lesson_L0_min_n", "int", 10, "rows", LRN, "ARN-063, M6 decision 42 (D-110); not in ch.15", "Rows a cell needs to be stored as an L0 observation"],
  ["lesson_L1_min_n", "int", 30, "rows", LRN, "ARN-063; ch.15 l.69", "Rows a lesson needs for L1 and for the L2 test"],
  ["lesson_bootstrap_level", "num", 0.1, "level", LRN, "ARN-063, M6 decision 13 (D-110): two-sided 90 % interval", "Level of the L1 block-bootstrap interval"],
  ["l2_alpha_w0", "num", 0.1, "level", LRN, "ARN-063 l2_alpha_investing; ch.15 l.49", "Alpha-investing starting wealth per pool"],
  ["l2_alpha_payout", "num", 0.05, "level", LRN, "ARN-063 l2_alpha_investing; ch.15 l.49", "Alpha-investing payout on a rejection"],
  // Comparisons (ARN-062)
  ["comparisons_fdr_q", "num", 0.1, "level", LRN, "ARN-062; ch.15 l.51, l.70", "Benjamini-Hochberg level of the weekly comparisons"],
  ["comparison_look_alpha", "num", 0.05, "level", LRN, "ARN-062; ch.15 l.51", "One-sided level of the confirmation look"],
  ["comparison_lockout_sessions", "int", 60, "sessions", LRN, "ARN-062; ch.15 l.51", "Sessions a pair is locked out after a failed look"],
  ["comparison_min_rows", "int", 30, "rows", LRN, "ARN-062; ch.15 l.51", "Rows per side a comparison needs"],
  // Playbooks, loop, generator (KB-002, NFR-011, ARN-065) - not keyed in ch.15
  ["playbook_max_tokens", "int", 1500, "tokens", LRN, "KB-002, M6 decision 28 (D-110); not in ch.15", "Largest agent playbook"],
  ["learning_loop_minutes", "int", 5, "min", LRN, "NFR-011, M6 decision 27 (D-110); not in ch.15", "Target length of the nightly learning loop"],
  ["challenger_generator_per_week", "int", 1, "challengers", LRN, "ARN-065, M6 decision 20 (D-110); not in ch.15", "Challengers the generator proposes per lineage per week"],
  // Statistics that were reviewed constants (D-090, D-091)
  ["code_reuse_gap_sessions", "int", 120, "sessions", VAL, "ARN-082 code reuse; D-090 (key added, D-111)", "Gap that, with a name change, flags a reused code"],
  ["dsr_default_sr_variance", "num", 0.0001, "variance", VAL, "VAL-110 (vi); ch.15 l.47: computed at the first evidence run and frozen per split (a computed config version like K, D-093); this default is the fallback when fewer than 2 families have development rows (D-111)", "Default variance of the daily Sharpe across variants (DSR)"],
  ["cif_confidence", "num", 0.9, "level", VAL, "ARN-070 all intervals are 90 %; D-091 (key added, D-111)", "Confidence level of every interval in the app"],
  // ARN-011 filter thresholds (spec 05 l.41, Owner-only; fixed until the Owner confirms them, D-085, D-111)
  ["arn011_gain_sessions", "int", 5, "sessions", FAM, "ARN-011 +100 % in 5 sessions; D-085 (key added, D-111)", "ARN-011: window of the large-gain filter"],
  ["arn011_gain_max", "num", 1, "fraction", FAM, "ARN-011 +100 % (a gain of 1.00); D-085 (key added, D-111)", "ARN-011: gain over the window that blocks an entry"],
  ["arn011_one_day_gain", "num", 0.3, "fraction", FAM, "ARN-011 +30 % in one session; D-085 (key added, D-111)", "ARN-011: one-session gain that blocks an entry"],
  ["arn011_volume_ratio_max", "num", 10, "x", FAM, "ARN-011 volume ratio above 10; D-085 (key added, D-111)", "ARN-011: volume ratio that blocks an entry"],
  ["arn011_placement_window", "int", 120, "sessions", FAM, "ARN-011 placements in 120 sessions; D-085 (key added, D-111)", "ARN-011: window of the placements filter"],
  ["arn011_placements_max", "int", 2, "placements", FAM, "ARN-011 two or more placements block; D-085 (key added, D-111)", "ARN-011: placements in the window that block an entry"],
  ["arn011_raise_window", "int", 60, "sessions", FAM, "ARN-011 deep-discount raise in 60 sessions; D-085 (key added, D-111)", "ARN-011: window of the discount-raise filter"],
  ["arn011_query_window", "int", 2, "sessions", FAM, "ARN-011 exchange query on D or D-1; D-085 (key added, D-111)", "ARN-011: window of the exchange-query filter"],
  ["arn011_consolidation_window", "int", 90, "sessions", FAM, "ARN-011 consolidation in 90 sessions; D-085 (key added, D-111)", "ARN-011: window of the consolidation filter"],
  ["arn011_range_fraction", "num", 0.25, "fraction", FAM, "ARN-011 range above 25 % of price; D-085 (key added, D-111)", "ARN-011: day range, as a share of price, that counts as wide"],
  ["arn011_range_days_window", "int", 5, "sessions", FAM, "ARN-011 last 5 sessions; D-085 (key added, D-111)", "ARN-011: window of the wide-range filter"],
  ["arn011_range_days_min", "int", 3, "sessions", FAM, "ARN-011 at least 3 of them; D-085 (key added, D-111)", "ARN-011: wide-range sessions in the window that block an entry"],
  // F5 volume exit (spec 07 l.56, D-085)
  ["f5_dry_up_ratio", "num", 0.5, "x", FAM, "F5 CS: volume ratio below 0.5 (spec 07 l.56); D-085 (key added, D-111)", "F5: volume ratio under which volume has dried up"],
  ["f5_dry_up_sessions", "int", 3, "sessions", FAM, "F5 CS: for 3 sessions (spec 07 l.56); D-085 (key added, D-111)", "F5: sessions of dried-up volume that exit"],
] as const satisfies readonly FixedRow[];

type M6RangedKey = (typeof M6_RANGED)[number][0];
type M6FixedKey = (typeof M6_FIXED)[number][0];

const M6_RANGED_KEYS = Object.fromEntries(
  M6_RANGED.map(([key, kind, def, min, max, unit, edit, , ref]) => [
    key,
    {
      default: def,
      unit,
      editable: edit,
      ref,
      range: [min, max] as const,
      validate: kind === "int" ? intRange(min, max) : numRange(min, max),
    } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M6RangedKey, ConfigKeyDef>;

const M6_FIXED_KEYS = Object.fromEntries(
  M6_FIXED.map(([key, , def, unit, , ref]) => [
    key,
    { default: def, unit, editable: "fixed", ref, validate: never } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M6FixedKey, ConfigKeyDef>;

const M6_META_TABLES: Record<M6RangedKey | M6FixedKey, ConfigMeta> = {
  ...(Object.fromEntries(
    M6_RANGED.map(([key, kind, , min, max, unit, , area, , label]) => [
      key,
      {
        label,
        area,
        bounds: boundsText(kind, min, max, unit),
        input: kind === "int" ? "int" : "number",
      },
    ]),
  ) as Record<M6RangedKey, ConfigMeta>),
  ...(Object.fromEntries(
    M6_FIXED.map(([key, kind, , , area, , label]) => [
      key,
      { label, area, bounds: "fixed", input: kind === "num" ? "number" : "int" },
    ]),
  ) as Record<M6FixedKey, ConfigMeta>),
};

/** CIF horizons 3, 6 and 12 months in sessions (ARN-071; D-091, key added D-111). */
export const CIF_HORIZONS_DEFAULT: readonly number[] = [63, 126, 252]; // threshold-ok: ARN-071 3/6/12 months
/** Progress table NAV bucket lower edges, ppm of the seed (ch.15 l.76; D-091, key added D-111). */
export const PROGRESS_NAV_EDGES_DEFAULT: readonly number[] = [
  600_000, 800_000, 1_000_000, 1_200_000, 1_500_000, 1_800_000,
]; // threshold-ok: progress NAV bucket edges
/** Progress table session checkpoints (ch.15 l.77; D-091, key added D-111). */
export const PROGRESS_SESSIONS_DEFAULT: readonly number[] = [21, 63, 126, 189]; // threshold-ok: progress sessions buckets

/** Names allowed for a pick profile (the Owner may rename them, AGT-113). */
const PROFILE_NAME_RE = /^[a-z][a-z0-9_]{0,23}$/;
const PICK_TIERS = ["U1", "U2", "U3"] as const;
export const PICK_PROFILE_FIELDS = ["tiers", "max_pct_per_pick", "risk_pct_per_pick"] as const;

/** pick_profiles (ch.15 l.209): per profile the tiers and the two caps, each cap 0-100 %. */
async function validatePickProfiles(v: unknown): Promise<string | null> {
  if (!isObj(v) || Object.keys(v).length < 1 || Object.keys(v).length > 6) {
    return "must list 1 to 6 profiles";
  }
  for (const [name, p] of Object.entries(v)) {
    if (!PROFILE_NAME_RE.test(name)) {
      return `profile name ${name} must be lower-case letters, digits or _`;
    }
    if (!exactKeys(p, [...PICK_PROFILE_FIELDS])) {
      return `${name} needs ${PICK_PROFILE_FIELDS.join(", ")}`;
    }
    const { tiers, max_pct_per_pick: max, risk_pct_per_pick: risk } = p;
    if (
      !Array.isArray(tiers) ||
      tiers.length < 1 ||
      !tiers.every((t) => (PICK_TIERS as readonly unknown[]).includes(t)) ||
      new Set(tiers).size !== tiers.length
    ) {
      return `${name}: tiers must be distinct values from ${PICK_TIERS.join(", ")}`;
    }
    if (!isNum(max) || max < 0 || max > 100) return `${name}: max_pct_per_pick must be 0 to 100`;
    if (!isNum(risk) || risk < 0 || risk > 100) {
      return `${name}: risk_pct_per_pick must be 0 to 100`;
    }
  }
  return null;
}

/** profile_portfolio_amount (ch.15 l.210): A$1,000-1,000,000 per profile, sizing examples only. */
async function validateProfileAmounts(v: unknown): Promise<string | null> {
  if (!isObj(v) || Object.keys(v).length < 1 || Object.keys(v).length > 6) {
    return "must list 1 to 6 profiles";
  }
  for (const [name, x] of Object.entries(v)) {
    if (!PROFILE_NAME_RE.test(name)) {
      return `profile name ${name} must be lower-case letters, digits or _`;
    }
    if (!isInt(x) || x < 1000 || x > 1_000_000) {
      return `${name}: must be a whole A$ amount from 1000 to 1000000`;
    }
  }
  return null;
}

export const INJECTION_PHRASES_KEY_VERSION = "v1";
/** llm_injection_phrases (ch.15 l.182, LLM-035): a versioned phrase list the Owner can extend. */
async function validateInjectionPhrases(v: unknown): Promise<string | null> {
  if (!exactKeys(v, ["version", "phrases"])) return "needs version and phrases";
  const { version, phrases } = v;
  if (typeof version !== "string" || !/^[A-Za-z0-9._-]{1,16}$/.test(version)) {
    return "version must be 1 to 16 letters, digits, . _ or -";
  }
  if (!Array.isArray(phrases) || phrases.length < 1 || phrases.length > 200) {
    return "phrases must be a list of 1 to 200 phrases";
  }
  const seen = new Set<string>();
  for (const p of phrases) {
    if (typeof p !== "string" || p.trim().length < 3 || p.length > 120) {
      return "every phrase must be 3 to 120 characters";
    }
    const k = p.trim().toLowerCase();
    if (seen.has(k)) return "phrases must be distinct (ignoring case)";
    seen.add(k);
  }
  return null;
}

/** The phrase list inside a stored llm_injection_phrases value (anything invalid gives the built-in v1 list). */
export function injectionPhrasesOf(v: unknown): readonly string[] {
  if (isObj(v) && Array.isArray(v.phrases) && v.phrases.every((p) => typeof p === "string")) {
    return v.phrases as string[];
  }
  return DEFAULT_INJECTION_PHRASES;
}

const M6_EXPLICIT_KEYS = {
  // ch.15 l.170: selected by the LLM-040 bake-off; none until one passes (M6 decision 9, D-110).
  llm_classifier_model: {
    default: "none",
    unit: "provider:model",
    editable: "O",
    ref: "KB-032, LLM-040; ch.15 l.170 (default none until a bake-off passes, D-110; provider list [VERIFY])",
    validate: async (v: unknown) =>
      v === "none" ||
      (typeof v === "string" && /^[a-z][a-z0-9_-]{1,30}:[A-Za-z0-9._/-]{1,80}$/.test(v))
        ? null
        : "must be none or provider:model (set only after a passing bake-off)",
  },
  llm_injection_phrases: {
    default: { version: INJECTION_PHRASES_KEY_VERSION, phrases: [...DEFAULT_INJECTION_PHRASES] },
    unit: "phrases",
    editable: "O",
    ref: "LLM-035, KB-061; ch.15 l.182 (default = the built-in v1 list, D-084, D-111)",
    validate: async (v: unknown) => validateInjectionPhrases(v),
  },
  // ch.15 l.214: terciles (default) or quintiles of the development distribution.
  factor_buckets: {
    default: "terciles",
    unit: "buckets",
    editable: "O",
    ref: "AGT-112; ch.15 l.214 (terciles / quintiles)",
    validate: oneOf(["terciles", "quintiles"]),
  },
  // M6 decision 29 (D-110): the archive time, after the late review store; not in ch.15.
  kb_archive_time: {
    default: "22:15",
    unit: "Melbourne time",
    editable: "O",
    ref: "PLT-022a, M6 decision 29 (D-110); bounds 21:00-23:00 agent-chosen (D-111)",
    validate: timeIn("21:00", "23:00"),
  },
  pick_profiles: {
    default: {
      aggressive: { tiers: ["U1", "U2", "U3"], max_pct_per_pick: 20, risk_pct_per_pick: 2 },
      balanced: { tiers: ["U1", "U2"], max_pct_per_pick: 10, risk_pct_per_pick: 1 },
      conservative: { tiers: ["U1"], max_pct_per_pick: 5, risk_pct_per_pick: 0.5 },
    },
    unit: "mixed",
    editable: "O",
    ref: "AGT-113; ch.15 l.209 (each cap 0-100 %)",
    validate: async (v: unknown) => validatePickProfiles(v),
  },
  profile_portfolio_amount: {
    default: { aggressive: 10000, balanced: 10000, conservative: 10000 },
    unit: "A$",
    editable: "O",
    ref: "AGT-113, UXN-040; ch.15 l.210 (A$1,000-1,000,000)",
    validate: async (v: unknown) => validateProfileAmounts(v),
  },
  cif_horizons_sessions: {
    default: [...CIF_HORIZONS_DEFAULT],
    unit: "sessions",
    editable: "fixed",
    ref: "ARN-071 3, 6 and 12 months; D-091 (key added, D-111)",
    validate: never,
  },
  progress_nav_edges_ppm: {
    default: [...PROGRESS_NAV_EDGES_DEFAULT],
    unit: "ppm of seed",
    editable: "fixed",
    ref: "ARN-071; ch.15 l.76; D-091 (key added, D-111)",
    validate: never,
  },
  progress_sessions_edges: {
    default: [...PROGRESS_SESSIONS_DEFAULT],
    unit: "sessions",
    editable: "fixed",
    ref: "ARN-071; ch.15 l.77; D-091 (key added, D-111)",
    validate: never,
  },
} satisfies Record<string, ConfigKeyDef>;

const M6_EXPLICIT_META: Record<keyof typeof M6_EXPLICIT_KEYS, ConfigMeta> = {
  llm_classifier_model: {
    label: "Injection classifier model (none until a bake-off passes)",
    area: LRN,
    bounds: "none, or provider:model",
    input: "text",
  },
  llm_injection_phrases: {
    label: "Prompt-injection phrase list (versioned)",
    area: LRN,
    bounds: 'JSON {"version": "v1", "phrases": [...]}, 3 to 120 characters each, up to 200',
    input: "object",
  },
  factor_buckets: {
    label: "Factor buckets",
    area: LRN,
    bounds: "terciles or quintiles",
    input: "text",
  },
  kb_archive_time: {
    label: "Knowledge archive time",
    area: LRN,
    bounds: "HH:MM, 21:00 to 23:00",
    input: "text",
  },
  pick_profiles: {
    label: "Pick profiles: tiers and caps",
    area: LRN,
    bounds: "1 to 6 profiles of tiers, max % per pick and risk % per pick, each cap 0 to 100",
    input: "object",
  },
  profile_portfolio_amount: {
    label: "Pick profile portfolio amount (sizing examples only)",
    area: LRN,
    bounds: "A$1,000 to A$1,000,000 per profile",
    input: "object",
  },
  cif_horizons_sessions: { label: "CIF horizons", area: VAL, bounds: "fixed", input: "list" },
  progress_nav_edges_ppm: {
    label: "Progress table NAV bucket edges",
    area: VAL,
    bounds: "fixed",
    input: "list",
  },
  progress_sessions_edges: {
    label: "Progress table session checkpoints",
    area: VAL,
    bounds: "fixed",
    input: "list",
  },
};

// ---- M7 keys (the UI; docs/M7_design.md 2.11, decision 29, D-128) -------------------------------
// Defaults and bounds are those of ch.15 section 15.8 and l.171 where the spec gives them. "D-129"
// marks bounds and keys chosen by the builder: `unmask_expiry` has no bounds in ch.15, and
// `attention_near_limit_pct` / `market_list_page_size` / `strategy_names` are named in ch.16 only.

const OTH: ConfigArea = "Other";

// prettier-ignore
const M7_RANGED = [
  ["unmask_expiry", "int", 30, 1, 365, "days", "O", OTH, "UX-009; ch.15 l.171 (bounds 1-365 agent-chosen, D-129)", "Days an Owner's unmask grant lasts"],
  ["overview_max_per_night", "int", 20, 0, 60, "companies/night", "O", OTH, "UXN-272; ch.15 l.203", "Company overviews written per night"],
  ["overview_refresh_days", "int", 7, 1, 30, "days", "O", OTH, "UXN-272; ch.15 l.204", "Days before a company overview is refreshed"],
  ["intraday_codes_max", "int", 150, 0, 300, "codes", "O", OTH, "UXN-048; ch.15 l.205", "Most codes given delayed intraday prices"],
  ["intraday_refresh_min", "int", 5, 2, 15, "min", "O", OTH, "UXN-048; ch.15 l.206", "Minutes between delayed price refreshes"],
  ["watchlist_max", "int", 50, 10, 200, "codes", "O", OTH, "UXN-047; ch.15 l.207", "Most codes on one personal watchlist"],
  ["attention_near_limit_pct", "int", 15, 5, 30, "%", "O", OTH, "UXN-046 (16 l.291); named in ch.16, not in ch.15 (D-128, D-129)", "Share of a limit at which a strategy is shown as near it"],
] as const satisfies readonly RangedRow[];

// prettier-ignore
const M7_FIXED = [
  ["market_list_page_size", "int", 50, "rows", OTH, "UXN-270 (16 l.308); named in ch.16, not in ch.15 (D-128, D-129)", "Rows on one page of the Market all-companies table"],
] as const satisfies readonly FixedRow[];

type M7RangedKey = (typeof M7_RANGED)[number][0];
type M7FixedKey = (typeof M7_FIXED)[number][0];

const M7_RANGED_KEYS = Object.fromEntries(
  M7_RANGED.map(([key, kind, def, min, max, unit, edit, , ref]) => [
    key,
    {
      default: def,
      unit,
      editable: edit,
      ref,
      range: [min, max] as const,
      validate: kind === "int" ? intRange(min, max) : numRange(min, max),
    } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M7RangedKey, ConfigKeyDef>;

const M7_FIXED_KEYS = Object.fromEntries(
  M7_FIXED.map(([key, , def, unit, , ref]) => [
    key,
    { default: def, unit, editable: "fixed", ref, validate: never } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M7FixedKey, ConfigKeyDef>;

/** The strategy-name table (UXN-039): one entry per family, Owner-editable, versioned by config_version. */
export const STRATEGY_NAME_FIELDS = [
  "name",
  "one_liner",
  "buys",
  "sells",
  "works_best",
  "main_risk",
] as const;
export const STRATEGY_NAME_FAMILIES = ["F1", "F2", "F3", "F4", "F5", "F6"] as const;
const STRATEGY_TEXT_MAX = 300; // threshold-ok: text length guard for an Owner-edited table
const STRATEGY_NAME_MAX = 40; // threshold-ok: text length guard for a short name

export const STRATEGY_NAMES_DEFAULT = {
  F1: {
    name: "Follow the trend",
    one_liner: "Buys shares that just hit a 1-year high with strong buying, and rides the rise.",
    buys: "Price at its highest in a year, trading busier than usual, among the best performers of the last 6 months.",
    sells:
      "A trailing stop-loss that rises with the price; gives up if it hasn't gained 5% in about 2 months.",
    works_best: "The market is calm and rising.",
    main_risk: "Sharp reversals: a new high can be the top.",
  },
  F2: {
    name: "Good company, good news",
    one_liner: "Buys solid, fairly priced companies right after good results.",
    buys: "Profitable, low debt, cheaper than similar companies, and just reported better-than-expected results.",
    sells: "Stop-loss below the buy price; sells on bad news or after about 3 months.",
    works_best: "Company results season.",
    main_risk: "Good results already in the price.",
  },
  F3: {
    name: "News jump",
    one_liner: "Buys shares that jump on big good news, hoping the rise continues for a few weeks.",
    buys: "Price-moving good news with a big jump and very heavy trading that day.",
    sells:
      "Sells if the price falls below the news-day low; locks in gains after +10%; exits after about 4 weeks.",
    works_best: "Busy news periods.",
    main_risk: "The jump fades quickly.",
  },
  F4: {
    name: "Buy the dip",
    one_liner: "Buys strong companies after a short, sharp fall, and sells when they bounce back.",
    buys: "Long-term uptrend, but the last few days fell hard; no bad news behind the fall.",
    sells: "Sells on the first recovery or after 2 weeks; stop-loss below the buy price.",
    works_best: "Mixed, choppy markets.",
    main_risk: "The fall was the start of a bigger drop.",
  },
  F5: {
    name: "Small-company spotter",
    one_liner: "Looks for small companies with unusual buying and good news. Higher risk.",
    buys: "Small or mid-size company, trading 3x busier than usual, with good news and a strong close.",
    sells:
      "Stop-loss (never more than -20%); sells when trading goes quiet, on bad news or after about 6 weeks.",
    works_best: "Calm, rising markets.",
    main_risk: "Small companies can be illiquid or hyped; biggest swings of all strategies.",
  },
  F6: {
    name: "Signals agree",
    one_liner: "Buys only when at least 3 different kinds of evidence point the same way.",
    buys: "At least 3 of: a price signal, a news signal, company insiders buying, fewer investors betting against the share.",
    sells:
      "Stop-loss below the buy price; after about 4 weeks or when the first signal's own exit triggers.",
    works_best: "Clear, calm markets.",
    main_risk: "Rare signals, so few trades to learn from.",
  },
} as const;

async function validateStrategyNames(v: unknown): Promise<string | null> {
  if (!exactKeys(v, [...STRATEGY_NAME_FAMILIES])) {
    return `must have exactly one entry for each of ${STRATEGY_NAME_FAMILIES.join(", ")}`;
  }
  for (const fam of STRATEGY_NAME_FAMILIES) {
    const row = v[fam];
    if (!exactKeys(row, [...STRATEGY_NAME_FIELDS])) {
      return `${fam} needs ${STRATEGY_NAME_FIELDS.join(", ")}`;
    }
    for (const f of STRATEGY_NAME_FIELDS) {
      const t = row[f];
      const max = f === "name" ? STRATEGY_NAME_MAX : STRATEGY_TEXT_MAX;
      if (typeof t !== "string" || t.trim().length < 1 || t.length > max) {
        return `${fam} ${f} must be text of 1 to ${max} characters`;
      }
    }
    // UXN-039: no numbers in names ("Strategy 1" is not allowed).
    if (/^\s*(strategy\s*)?#?\d/i.test(String(row.name))) {
      return `${fam} name must not start with a number`;
    }
  }
  return null;
}

const M7_EXPLICIT_KEYS = {
  strategy_names: {
    default: STRATEGY_NAMES_DEFAULT,
    unit: "table",
    editable: "O",
    ref: "UXN-039 (16 l.268-277); not in ch.15 (D-128, D-129)",
    validate: async (v: unknown) => validateStrategyNames(v),
  },
} satisfies Record<string, ConfigKeyDef>;

const M7_META_TABLES: Record<M7RangedKey | M7FixedKey | keyof typeof M7_EXPLICIT_KEYS, ConfigMeta> =
  {
    ...(Object.fromEntries(
      M7_RANGED.map(([key, kind, , min, max, unit, , area, , label]) => [
        key,
        {
          label,
          area,
          bounds: boundsText(kind, min, max, unit),
          input: kind === "int" ? "int" : "number",
        },
      ]),
    ) as Record<M7RangedKey, ConfigMeta>),
    ...(Object.fromEntries(
      M7_FIXED.map(([key, , , , area, , label]) => [
        key,
        { label, area, bounds: "fixed", input: "int" },
      ]),
    ) as Record<M7FixedKey, ConfigMeta>),
    strategy_names: {
      label: "Strategy names, one-liners and hover cards (one entry per family F1 to F6)",
      area: OTH,
      bounds:
        "F1 to F6, each with name, one_liner, buys, sells, works_best, main_risk; no numbers in names",
      input: "object",
    },
  };

// ---- M14 keys (returns and validation; docs/M14_design.md 2.7, decisions D-213 to D-252) ----
// Every default is the spec default (ch.15 V2 keys, Owner decisions O-43 to O-50). The structural
// switches (KB-081 / O-46) are enum or window keys of edit class B whose defaults reproduce v1
// exactly: nothing changes until a pre-registered challenger sets one (D-235).

// prettier-ignore
const M14_RANGED = [
  ["max_stop_distance_pct", "num", 12, 6, 20, "%", "O", FAM, "FAM-004, O-47 (D-216)", "Largest initial stop distance a new entry may have"],
  ["cost_gate_k", "num", 2, 1.5, 3, "x", "O", FAM, "FAM-005 (same key as CTX-022a; D-214)", "Median gross return needed as a multiple of the round-trip cost"],
  ["second_position_max_corr", "num", 0.6, 0.3, 0.9, "correlation", "O", FAM, "FAM-006 (D-217)", "Highest 60-session return correlation between two new positions"],
  ["val_fwer_per_lineage", "num", 0.05, 0.01, 0.1, "level", "O", VAL, "VAL-112, O-43 (D-226)", "Family-wise error allowed per lineage and split version"],
  ["l2_alpha_spend_fraction", "num", 0.1, 0.05, 0.25, "fraction", "O", VAL, "VAL-116, O-44 (D-231)", "Share of the lesson alpha pool spent on each lesson test"],
  ["dedup_minhash_threshold", "num", 0.85, 0.7, 0.95, "similarity", "O", REG, "DAT-237 (D-240)", "Title similarity at which a later announcement counts as a repeat"],
  ["f1_return_window_sessions", "int", 126, 126, 252, "sessions", "B", FAM, "KB-081, O-46 (D-235)", "F1: return window for the relative-strength rank"],
] as const satisfies readonly RangedRow[];

// prettier-ignore
const M14_FIXED = [
  ["cost_gate_min_rows", "int", 30, "rows", FAM, "FAM-005 (D-214)", "Signal-ledger rows needed before the cost gate applies"],
  ["second_position_corr_sessions", "int", 60, "sessions", FAM, "FAM-006 (D-217)", "Sessions of returns in the second-position correlation"],
  ["l2_alpha_exhausted_level", "num", 0.005, "level", VAL, "VAL-116 (D-231)", "Lesson alpha pool is exhausted below this test level"],
  ["minbtl_target_sharpe", "num", 1, "Sharpe", VAL, "VAL-115 (D-230)", "Annual Sharpe ratio the minimum backtest length is computed for"],
  ["rank_ic_min_codes", "int", 10, "codes", VAL, "VAL-114 (D-232)", "Scored codes needed for one day of rank quality"],
  ["rank_ic_bootstrap_replicates", "int", 2000, "replications", VAL, "VAL-114", "Bootstrap replications for the rank quality interval"],
  ["rank_ic_bootstrap_blocks", "text", "monthly", "blocks", VAL, "VAL-114 (monthly or weekly blocks; D-232)", "Block length of the rank quality bootstrap"],
  ["dedup_window_sessions", "int", 5, "sessions", REG, "DAT-237 (D-240)", "Sessions in which a repeated announcement is a duplicate"],
  ["index_change_window_sessions", "int", 1, "sessions", REG, "DAT-234 (D-238)", "Sessions around day 0 in which an index change excludes an F3 event"],
] as const satisfies readonly FixedRow[];

type M14RangedKey = (typeof M14_RANGED)[number][0];
type M14FixedKey = (typeof M14_FIXED)[number][0];

const M14_RANGED_KEYS = Object.fromEntries(
  M14_RANGED.map(([key, kind, def, min, max, unit, edit, , ref]) => [
    key,
    {
      default: def,
      unit,
      editable: edit,
      ref,
      range: [min, max] as const,
      validate: kind === "int" ? intRange(min, max) : numRange(min, max),
    } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M14RangedKey, ConfigKeyDef>;

const M14_FIXED_KEYS = Object.fromEntries(
  M14_FIXED.map(([key, , def, unit, , ref]) => [
    key,
    { default: def, unit, editable: "fixed", ref, validate: never } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M14FixedKey, ConfigKeyDef>;

/** VAL-112 error-budget modes. `bh_fdr` is refused in V2 (D-227). */
export const VAL_ERROR_BUDGET_MODES = ["fixed", "alpha_spending"] as const;
export const SETTLEMENT_STATS_MODES = ["conservative", "matched"] as const;
export const F5_UNIVERSES = ["U1", "U2", "U3"] as const;
export const F1_MOMENTUM_VARIANTS = ["v1", "skip_month_u2"] as const;
export const RANK_VARIANTS = ["v1", "composite3", "vol_scaled"] as const;
export const F4_ENTRY_VARIANTS = ["v1", "reversal5_u2"] as const;
export const F3_SURPRISE_MODES = ["category", "day0_ar"] as const;

// prettier-ignore
const M14_ENUM_ROWS = [
  ["val_error_budget_mode", "alpha_spending", VAL_ERROR_BUDGET_MODES, "O", VAL, "VAL-112, O-43 (D-226, D-227)", "How the validation error budget is spent"],
  ["settlement_stats_mode", "conservative", SETTLEMENT_STATS_MODES, "O", REP, "ARN-109, O-48 (D-225)", "Settlement used for replay statistics"],
  ["f5_default_universe", "U2", F5_UNIVERSES, "O", FAM, "O-49 (D-221)", "F5: universe it trades"],
  ["f1_momentum_variant", "v1", F1_MOMENTUM_VARIANTS, "B", FAM, "KB-081, O-46 (D-235)", "F1: momentum variant"],
  ["f1_rank_variant", "v1", RANK_VARIANTS, "B", FAM, "KB-081, O-46 (D-235)", "F1: rank variant"],
  ["f4_rank_variant", "v1", RANK_VARIANTS, "B", FAM, "KB-081, O-46 (D-235)", "F4: rank variant"],
  ["f4_entry_variant", "v1", F4_ENTRY_VARIANTS, "B", FAM, "KB-081, O-46 (D-235)", "F4: entry variant"],
  ["f3_surprise_mode", "category", F3_SURPRISE_MODES, "B", FAM, "AGT-137, KB-081 (D-243)", "F3: how the surprise is read"],
] as const;

type M14EnumKey = (typeof M14_ENUM_ROWS)[number][0];

const M14_ENUM_KEYS = Object.fromEntries(
  M14_ENUM_ROWS.map(([key, def, allowed, edit, , ref]) => [
    key,
    {
      default: def,
      unit: "choice",
      editable: edit,
      ref,
      validate:
        key === "val_error_budget_mode"
          ? async (v: unknown) =>
              v === "bh_fdr"
                ? "bh_fdr is not available in V2 (no family-wise-safe sequential form, D-227)"
                : oneOf(allowed)(v)
          : oneOf(allowed),
    } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M14EnumKey, ConfigKeyDef>;

const M14_META_TABLES: Record<M14RangedKey | M14FixedKey | M14EnumKey, ConfigMeta> = {
  ...(Object.fromEntries(
    M14_RANGED.map(([key, kind, , min, max, unit, , area, , label]) => [
      key,
      {
        label,
        area,
        bounds: boundsText(kind, min, max, unit),
        input: kind === "int" ? "int" : "number",
      },
    ]),
  ) as Record<M14RangedKey, ConfigMeta>),
  ...(Object.fromEntries(
    M14_FIXED.map(([key, kind, , , area, , label]) => [
      key,
      {
        label,
        area,
        bounds: "fixed",
        input: kind === "text" ? "text" : kind === "num" ? "number" : "int",
      },
    ]),
  ) as Record<M14FixedKey, ConfigMeta>),
  ...(Object.fromEntries(
    M14_ENUM_ROWS.map(([key, , allowed, , area, , label]) => [
      key,
      { label, area, bounds: `one of ${allowed.join(", ")}`, input: "text" },
    ]),
  ) as Record<M14EnumKey, ConfigMeta>),
};

// ---- M15 keys (Cortex calibration; docs/M15_requirements.md "Configuration keys", D-257 to D-306) ----
// Every default is the chapter 17 / ch.15 V2 default. An Owner edit of one of these keys is a charged
// trial and marks the map for a refit (CTX-072; src/lib/cortex/store/keyEdit.ts). `cost_gate_k`
// (CTX-022a) already exists from M14 and is reused unchanged.

// prettier-ignore
const M15_RANGED = [
  ["cell_min_setups", "int", 60, 30, 200, "setups", "O", VAL, "CTX-021", "Fewest matched setups a cell needs before it can trade"],
  ["cell_min_blocks", "int", 20, 6, 60, "blocks", "O", VAL, "CTX-012", "Fewest independent time blocks a cell or map needs"],
  ["cortex_min_neff_trade", "int", 200, 150, 400, "setups", "O", VAL, "CTX-053", "Effective sample size needed before a family may trade"],
  ["rank_shrink_n0", "int", 60, 20, 200, "setups", "O", FAM, "CTX-022", "Pseudo-sample that pulls a thin cell towards its family average when ranking"],
  ["max_loss_pct", "num", 18, 12, 25, "%", "O", FAM, "CTX-022b", "Largest loss a new entry may risk, stop distance plus overnight gap"],
  ["entry_gap_cap_pct", "num", 8, 4, 12, "%", "O", FAM, "CTX-022b, CTX-028", "Highest open above the close at which a limit order still buys"],
  ["cortex_disagreement_max", "num", 0.4, 0.25, 0.6, "score", "O", FAM, "CTX-023", "Evidence disagreement above which a candidate is not taken"],
  ["cluster_weight_max", "num", 0.35, 0.2, 0.35, "fraction", "O", FAM, "CTX-012", "Largest share of the score one angle cluster may carry"],
  ["sector_tilt_margin_pp", "num", 5, 0, 15, "pp", "O", FAM, "CTX-025", "Sector tilt margin (shadow only)"],
  ["max_books_same_code", "int", 2, 1, 3, "books", "O", FAM, "CTX-026", "Most books that may hold the same code"],
  ["max_books_same_industry", "int", 3, 2, 6, "books", "O", FAM, "CTX-026", "Most books that may hold the same industry (reporting only)"],
  ["max_code_nav_share", "num", 0.2, 0.1, 0.35, "fraction", "O", FAM, "CTX-026, O-61", "Largest share of a book's value in one code"],
  ["max_industry_nav_share", "num", 0.35, 0.2, 0.5, "fraction", "O", FAM, "CTX-026", "Largest share of a book's value in one industry"],
  ["freeze_max_loss_pct", "num", 25, 15, 40, "%", "O", REG, "CTX-015, O-63", "Loss at which a position frozen by an unresolved corporate action is sold"],
  ["unresolved_freeze_sessions", "int", 5, 2, 10, "sessions", "O", REG, "CTX-015", "Sessions an unresolved corporate action freezes a position"],
  ["persist_volume_mult", "num", 2, 1, 5, "x", "O", REG, "CTX-043", "Volume multiple that confirms an event on day two"],
  ["pump_volume_mult", "num", 4, 3, 6, "x", "O", REG, "CTX-044", "Volume multiple that raises a promotion flag"],
  ["pump_ar_pct", "num", 8, 5, 12, "%", "O", REG, "CTX-044", "Abnormal return that raises a promotion flag"],
  ["promotion_flag_sessions", "int", 20, 10, 40, "sessions", "O", REG, "CTX-044", "Sessions a promotion flag stays on"],
  ["abstain_alarm_sessions", "int", 40, 20, 120, "sessions", "O", FAM, "CTX-023", "Sessions of abstaining in a row that raise an alarm"],
  ["stale_universe_max_share", "num", 0.1, 0.02, 0.25, "fraction", "O", FAM, "CTX-028, D-289", "Share of the universe without a fresh bar above which the night abstains"],
  ["opinion_min_n", "int", 150, 100, 500, "opinions", "O", VAL, "CTX-060", "Settled opinions needed before an opinion track is read"],
  ["ledger_fdr_q", "num", 0.1, 0.05, 0.2, "level", "O", VAL, "CTX-031 (BH under PRDS)", "False-discovery rate allowed across the angle ledger"],
  ["bootstrap_block_sessions", "int", 120, 60, 250, "sessions", "O", VAL, "CTX-012", "Expected block length of the stationary bootstrap"],
  ["cortex_slope_hide_ub", "num", 1, 0.5, 1, "slope", "O", VAL, "CTX-053, D-257", "A probability is hidden when the calibration slope upper bound is below this"],
  ["cortex_stage_minutes", "int", 20, 5, 60, "minutes", "O", REP, "CTX-050, D-289", "Minutes the nightly Cortex stage may run before it abstains for the night"],
] as const satisfies readonly RangedRow[];

// prettier-ignore
const M15_FIXED = [
  ["survivorship_haircut_pp", "num", 1.5, "pp per holding year", VAL, "CTX-050, D-262 (freeze record)", "Survivorship haircut shown beside every result"],
  ["suspension_mark_policy", "text", "100% x5, -10pts per 5, floor 50%", "policy", REG, "CTX-016, D-272", "Mark of a suspended position (full for 5 sessions, then 10 points per 5, floor 50 %)"],
] as const satisfies readonly FixedRow[];

type M15RangedKey = (typeof M15_RANGED)[number][0];
type M15FixedKey = (typeof M15_FIXED)[number][0];

const M15_RANGED_KEYS = Object.fromEntries(
  M15_RANGED.map(([key, kind, def, min, max, unit, edit, , ref]) => [
    key,
    {
      default: def,
      unit,
      editable: edit,
      ref,
      range: [min, max] as const,
      validate: kind === "int" ? intRange(min, max) : numRange(min, max),
    } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M15RangedKey, ConfigKeyDef>;

const M15_FIXED_KEYS = Object.fromEntries(
  M15_FIXED.map(([key, , def, unit, , ref]) => [
    key,
    { default: def, unit, editable: "fixed", ref, validate: never } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M15FixedKey, ConfigKeyDef>;

const M15_META_TABLES: Record<M15RangedKey | M15FixedKey, ConfigMeta> = {
  ...(Object.fromEntries(
    M15_RANGED.map(([key, kind, , min, max, unit, , area, , label]) => [
      key,
      {
        label,
        area,
        bounds: boundsText(kind, min, max, unit),
        input: kind === "int" ? "int" : "number",
      },
    ]),
  ) as Record<M15RangedKey, ConfigMeta>),
  ...(Object.fromEntries(
    M15_FIXED.map(([key, kind, , , area, , label]) => [
      key,
      {
        label,
        area,
        bounds: "fixed",
        input: kind === "text" ? "text" : "number",
      },
    ]),
  ) as Record<M15FixedKey, ConfigMeta>),
};

// ---- M17 keys (intraday watch and pick alerts; docs/M17_design.md, D-381 to D-400) ----
// prettier-ignore
const M17_RANGED = [
  ["chase_cap_pct", "num", 3, 1, 8, "%", "O", OTH, "ARN-114", "Open or quote above the pick limit by this much clears its alert"],
  ["pick_alert_max_sessions", "int", 3, 1, 10, "sessions", "O", OTH, "ARN-114", "Sessions a pick alert stays armed before it expires"],
  ["pick_alert_emails_per_day", "int", 12, 0, 20, "emails", "O", SEM, "EML-041, D-389", "Most pick-alert e-mails a day, inside the daily e-mail budget"],
  ["intraday_scan_min", "int", 30, 15, 60, "min", "O", OTH, "AGT-140", "Minutes between intraday scans"],
  ["intraday_scan_codes_max", "int", 800, 0, 1500, "codes", "O", OTH, "DAT-239 (0 = scan off)", "Most codes the intraday scan looks at (0 turns the scan off)"],
  ["intraday_scan_requests_max", "int", 40, 10, 100, "requests", "O", OTH, "AGT-140, D-400", "Most delayed-quote requests in one scan run"],
  ["intraday_move_min_pct", "num", 4, 2, 10, "%", "O", OTH, "AGT-141", "Smallest sector-adjusted move that can make an intraday candidate"],
  ["intraday_rel_volume_min", "num", 2, 1.2, 4, "x", "O", OTH, "AGT-141", "Smallest volume, against the pro-rated 20-session average, for a candidate"],
  ["intraday_candidate_emails_per_day", "int", 3, 0, 8, "emails", "O", SEM, "EML-040, EML-041", "Most Attention-needed e-mails a day (inside the pick-alert budget)"],
  ["quote_pause_cooldown_min", "int", 30, 10, 120, "min", "O", OTH, "D-442", "Minutes the quote routes wait after a rate-limit, server error or network pause"],
  ["intraday_quote_delay_min", "int", 20, 0, 60, "min", "O", OTH, "UXN-048 [VERIFY at build], D-442", "Minutes the free quote feed is behind the market (shown as the delay)"],
  ["home_picks_shown", "int", 3, 1, 5, "picks", "O", OTH, "UXN-307", "Night picks shown on Home"],
  ["intraday_candidates_shown_max", "int", 5, 1, 20, "candidates", "O", OTH, "UXN-307", "Intraday candidates shown on Picks and Home"],
  ["pick_min_chance", "num", 55, 50, 70, "%", "O", LRN, "UXN-307, D-383", "Lowest chance of a net gain a pick may show (applies only where a calibrated chance exists)"],
] as const satisfies readonly RangedRow[];

export const INTRADAY_STREAM_STATES = ["shadow", "allowed", "live-tested"] as const;
export const PICKS_SORT_BASES = ["chance", "expected_gain"] as const;

// prettier-ignore
const M17_ENUM_ROWS = [
  ["pick_alerts_default_owner", "on", ON_OFF, "O", OTH, "ARN-112", "Pick alerts on for the Owner by default"],
  ["picks_default_sort", "chance", PICKS_SORT_BASES, "O", LRN, "UXN-309", "How the picks are ordered unless a person chooses otherwise"],
  // Fixed: no UI or API writer; only the VAL-118 evaluator (and the Owner's kill) moves it (D-391).
  ["intraday_stream_state", "shadow", INTRADAY_STREAM_STATES, "fixed", VAL, "VAL-118, D-391", "Validation state of the intraday stream (set only by the evaluator)"],
] as const;

type M17RangedKey = (typeof M17_RANGED)[number][0];
type M17EnumKey = (typeof M17_ENUM_ROWS)[number][0];
type M17TimeKey = "intraday_scan_start" | "intraday_scan_end";

const M17_RANGED_KEYS = Object.fromEntries(
  M17_RANGED.map(([key, kind, def, min, max, unit, edit, , ref]) => [
    key,
    {
      default: def,
      unit,
      editable: edit,
      ref,
      range: [min, max] as const,
      validate: kind === "int" ? intRange(min, max) : numRange(min, max),
    } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M17RangedKey, ConfigKeyDef>;

const M17_ENUM_KEYS = Object.fromEntries(
  M17_ENUM_ROWS.map(([key, def, allowed, edit, , ref]) => [
    key,
    {
      default: def,
      unit: "choice",
      editable: edit,
      ref,
      validate: edit === "fixed" ? never : oneOf(allowed),
    } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M17EnumKey, ConfigKeyDef>;

/** The scan window (AGT-140): inside the 10:00 to 16:00 session, start before end. */
async function validateScanWindow(
  key: M17TimeKey,
  v: unknown,
  get: (k: M17TimeKey) => Promise<unknown>,
): Promise<string | null> {
  const bad = await timeIn("10:00", "16:00")(v);
  if (bad) return bad;
  const t = clockMinutes(v)!;
  const other = clockMinutes(
    await get(key === "intraday_scan_start" ? "intraday_scan_end" : "intraday_scan_start"),
  );
  if (other === null) return null;
  const [a, b] = key === "intraday_scan_start" ? [t, other] : [other, t];
  return a < b ? null : "the scan start must be before the scan end";
}

const M17_TIME_KEYS: Record<M17TimeKey, ConfigKeyDef> = {
  intraday_scan_start: {
    default: "10:30",
    unit: "Melbourne time",
    editable: "O",
    ref: "AGT-140",
    validate: (v, get) => validateScanWindow("intraday_scan_start", v, (k) => get(k)),
  },
  intraday_scan_end: {
    default: "15:30",
    unit: "Melbourne time",
    editable: "O",
    ref: "AGT-140",
    validate: (v, get) => validateScanWindow("intraday_scan_end", v, (k) => get(k)),
  },
};

const M17_META_TABLES: Record<M17RangedKey | M17EnumKey | M17TimeKey, ConfigMeta> = {
  ...(Object.fromEntries(
    M17_RANGED.map(([key, kind, , min, max, unit, , area, , label]) => [
      key,
      {
        label,
        area,
        bounds: boundsText(kind, min, max, unit),
        input: kind === "int" ? "int" : "number",
      },
    ]),
  ) as Record<M17RangedKey, ConfigMeta>),
  ...(Object.fromEntries(
    M17_ENUM_ROWS.map(([key, , allowed, edit, area, , label]) => [
      key,
      {
        label,
        area,
        bounds: edit === "fixed" ? "fixed" : `one of ${allowed.join(", ")}`,
        input: "text",
      },
    ]),
  ) as Record<M17EnumKey, ConfigMeta>),
  intraday_scan_start: {
    label: "First intraday scan of the day",
    area: OTH,
    bounds: "HH:MM, 10:00 to 16:00, before the scan end",
    input: "text",
  },
  intraday_scan_end: {
    label: "Last intraday scan of the day",
    area: OTH,
    bounds: "HH:MM, 10:00 to 16:00, after the scan start",
    input: "text",
  },
};

/** Every key added in M17 (docs/M17_design.md, D-381 to D-400). */
export const M17_KEY_NAMES: readonly ConfigKey[] = [
  ...M17_RANGED.map((r) => r[0]),
  ...M17_ENUM_ROWS.map((r) => r[0]),
  "intraday_scan_start",
  "intraday_scan_end",
];

// ---- M11-lite keys (steelman; docs/M11L_design.md, D-480 to D-498) ----
// prettier-ignore
const M11L_RANGED = [
  ["llm_budget_r6_steelman_daily", "int", 20000, 0, 40000, "tokens/day", "O", "Quotas", "LLM-061, D-481", "Daily LLM token budget, R6 steelman"],
  ["evidence_pack_max_items", "int", 25, 10, 40, "items", "O", LRN, "AGT-131, D-486", "Most evidence items in one steelman pack"],
  ["steelman_daily_cards", "int", 8, 0, 20, "cards", "O", LRN, "AGT-133, D-484", "Most steelman cards written a night (0 turns the steelman off)"],
  ["steelman_suggestion_expiry_sessions", "int", 10, 5, 30, "sessions", "O", LRN, "AGT-133a, D-492", "Sessions an open steelman suggestion stays before it expires"],
] as const satisfies readonly RangedRow[];

// prettier-ignore
const M11L_ENUM_ROWS = [
  ["pick_reflection_enabled", "on", ON_OFF, "O", LRN, "AGT-134, D-496", "Write the optional AI-written pick reflection (on by default; needs a model)"],
] as const;

type M11LRangedKey = (typeof M11L_RANGED)[number][0];
type M11LEnumKey = (typeof M11L_ENUM_ROWS)[number][0];

const M11L_RANGED_KEYS = Object.fromEntries(
  M11L_RANGED.map(([key, kind, def, min, max, unit, edit, , ref]) => [
    key,
    {
      default: def,
      unit,
      editable: edit,
      ref,
      range: [min, max] as const,
      validate: kind === "int" ? intRange(min, max) : numRange(min, max),
    } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M11LRangedKey, ConfigKeyDef>;

const M11L_ENUM_KEYS = Object.fromEntries(
  M11L_ENUM_ROWS.map(([key, def, allowed, edit, , ref]) => [
    key,
    {
      default: def,
      unit: "choice",
      editable: edit,
      ref,
      validate: oneOf(allowed),
    } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M11LEnumKey, ConfigKeyDef>;

const M11L_META_TABLES: Record<M11LRangedKey | M11LEnumKey, ConfigMeta> = {
  ...(Object.fromEntries(
    M11L_RANGED.map(([key, kind, , min, max, unit, , area, , label]) => [
      key,
      {
        label,
        area,
        bounds: boundsText(kind, min, max, unit),
        input: kind === "int" ? "int" : "number",
      },
    ]),
  ) as Record<M11LRangedKey, ConfigMeta>),
  ...(Object.fromEntries(
    M11L_ENUM_ROWS.map(([key, , allowed, , area, , label]) => [
      key,
      { label, area, bounds: `one of ${allowed.join(", ")}`, input: "text" },
    ]),
  ) as Record<M11LEnumKey, ConfigMeta>),
};

/** Every key added in M11-lite (docs/M11L_design.md, D-480 to D-498); llm_daily_budget_total is re-based, not new. */
export const M11L_KEY_NAMES: readonly ConfigKey[] = [
  ...M11L_RANGED.map((r) => r[0]),
  ...M11L_ENUM_ROWS.map((r) => r[0]),
];

// ---- M13-lite keys (expert screening; docs/M13L_design.md, D-510 to D-533) ----
// prettier-ignore
const M13L_RANGED = [
  ["expert_min_scored", "int", 10, 5, 50, "claims", "O", LRN, "KB-074; ch.15 V2 l.25, D-528", "Tested claims an expert needs before a scorecard is shown"],
  ["expert_screen_fdr", "num", 0.1, 0.05, 0.2, "q", "O", LRN, "KB-075; ch.15 V2 l.26, D-528", "False-discovery rate for the weekly expert-cluster screening"],
  ["expert_challengers_per_week", "int", 2, 0, 4, "challengers/week", "O", LRN, "KB-077; ch.15 V2 l.27, D-528", "Most challengers proposed from expert clusters a week (0 turns proposals off)"],
  ["f7_min_clusters", "int", 3, 2, 10, "clusters", "O", LRN, "KB-078; ch.15 V2 l.28, D-528", "Clusters from distinct experts that must pass before the F7 gate fires"],
] as const satisfies readonly RangedRow[];

type M13LRangedKey = (typeof M13L_RANGED)[number][0];

const M13L_RANGED_KEYS = Object.fromEntries(
  M13L_RANGED.map(([key, kind, def, min, max, unit, edit, , ref]) => [
    key,
    {
      default: def,
      unit,
      editable: edit,
      ref,
      range: [min, max] as const,
      validate: kind === "int" ? intRange(min, max) : numRange(min, max),
    } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<M13LRangedKey, ConfigKeyDef>;

const M13L_META_TABLES = Object.fromEntries(
  M13L_RANGED.map(([key, kind, , min, max, unit, , area, , label]) => [
    key,
    {
      label,
      area,
      bounds: boundsText(kind, min, max, unit),
      input: kind === "int" ? "int" : "number",
    },
  ]),
) as Record<M13LRangedKey, ConfigMeta>;

/** Every key added in M13-lite (docs/M13L_design.md, D-528). */
export const M13L_KEY_NAMES: readonly ConfigKey[] = M13L_RANGED.map((r) => r[0]);

// ---- Movers gap additions (A1-A8; docs/M15_design.md "Movers gap additions", D-740 to D-759) ----
// Gates, states and facts outside the score; none is a Cortex refit key (D-752): editing one does not
// change the map or a family's status. Every addition starts in shadow.
// prettier-ignore
const MOVERS_RANGED = [
  ["halt_resume_arm_minute", "int", 600, 570, 720, "min after midnight", "O", OTH, "CR-MOV-A1, D-744", "Local minute from which a code resuming after a halt is given delayed prices (600 = 10:00)"],
  ["halt_resume_block_sessions", "int", 1, 0, 5, "sessions", "O", REG, "CR-MOV-A1, D-743", "Sessions after a halt resume with a negative expectation in which a dip-buy or short-cover entry is not taken (0 = only while halted)"],
  ["halt_watch_expiry_sessions", "int", 5, 2, 20, "sessions", "O", REG, "CR-MOV-A1, D-742", "Sessions after which an unresolved halt watch stops arming and blocking (a long halt is a suspension)"],
  ["results_window_start_day", "int", 1, 1, 15, "day of month", "O", REG, "CR-MOV-A2, D-745", "First day of the February and August reporting windows"],
  ["results_window_end_day", "int", 31, 16, 31, "day of month", "O", REG, "CR-MOV-A2, D-745", "Last day of the February and August reporting windows (cut at the month end)"],
  ["results_pre_window_sessions", "int", 2, 0, 10, "sessions", "O", REG, "CR-MOV-A2, D-745", "Sessions before a known results date in which a dip-buy entry is not taken (0 = off)"],
  ["known_date_min_history_days", "int", 365, 330, 730, "days", "O", REG, "CR-MOV-A2, D-745", "Days of announcement history needed before a company's own results date is predicted"],
  ["volume_creep_vr_min", "num", 3, 2, 6, "x", "O", REG, "CR-MOV-A3, D-746", "Volume against the 20-session average that counts as creep when no news is out"],
  ["volume_creep_ar_min_pct", "num", 2, 1, 6, "%", "O", REG, "CR-MOV-A3, D-746", "Smallest abnormal return that counts with the volume creep"],
  ["intraday_arm_codes_max", "int", 20, 0, 60, "codes", "O", OTH, "CR-MOV-A1, CR-MOV-A3, D-744", "Most armed codes (halt resumes, volume creep) added to a day's intraday scan (0 = none)"],
  ["short_risk_pct_min", "num", 5, 3, 12, "%", "O", REG, "CR-MOV-A4, D-747", "Short interest at or above which a name counts as heavily shorted (risk marker, not a signal)"],
  ["short_risk_change_pp_min", "num", 2, 1, 6, "pp", "O", REG, "CR-MOV-A4, D-747", "Rise in short interest over 20 reports that counts as a short-risk marker"],
  ["short_risk_f4_veto", "int", 0, 0, 1, "0 or 1", "O", REG, "CR-MOV-A4, D-747", "1 = no dip-buy entry in a heavily shorted name (0 = only the smaller parcel)"],
  ["sector_composite_min_members", "int", 5, 3, 30, "codes", "O", OTH, "CR-MOV-A8, D-750", "Fewest codes an industry needs before its end-of-day composite adjusts an intraday move"],
] as const satisfies readonly RangedRow[];

type MoversRangedKey = (typeof MOVERS_RANGED)[number][0];

const MOVERS_RANGED_KEYS = Object.fromEntries(
  MOVERS_RANGED.map(([key, kind, def, min, max, unit, edit, , ref]) => [
    key,
    {
      default: def,
      unit,
      editable: edit,
      ref,
      range: [min, max] as const,
      validate: kind === "int" ? intRange(min, max) : numRange(min, max),
    } satisfies ConfigKeyDef,
  ]),
) as unknown as Record<MoversRangedKey, ConfigKeyDef>;

const MOVERS_META_TABLES = Object.fromEntries(
  MOVERS_RANGED.map(([key, kind, , min, max, unit, , area, , label]) => [
    key,
    {
      label,
      area,
      bounds: boundsText(kind, min, max, unit),
      input: kind === "int" ? "int" : "number",
    },
  ]),
) as Record<MoversRangedKey, ConfigMeta>;

/** Every key added by the movers gap additions (D-740 to D-759). */
export const MOVERS_KEY_NAMES: readonly ConfigKey[] = MOVERS_RANGED.map((r) => r[0]);

export const CONFIG_KEYS = {
  ...M4_RANGED_KEYS,
  ...M4_FIXED_KEYS,
  ...M5_RANGED_KEYS,
  ...M5_FIXED_KEYS,
  ...M6_RANGED_KEYS,
  ...M6_FIXED_KEYS,
  ...M6_EXPLICIT_KEYS,
  ...M7_RANGED_KEYS,
  ...M7_FIXED_KEYS,
  ...M7_EXPLICIT_KEYS,
  ...M14_RANGED_KEYS,
  ...M14_FIXED_KEYS,
  ...M14_ENUM_KEYS,
  ...M15_RANGED_KEYS,
  ...M15_FIXED_KEYS,
  ...M17_RANGED_KEYS,
  ...M17_ENUM_KEYS,
  ...M17_TIME_KEYS,
  ...M11L_RANGED_KEYS,
  ...M11L_ENUM_KEYS,
  ...M13L_RANGED_KEYS,
  ...MOVERS_RANGED_KEYS,
  // ch.15 l.163: evening_review_time / partial_at / send_by 20:00 / 20:30 / 20:45, O; EML-010/011.
  evening_review_time: {
    default: "20:00",
    unit: "Melbourne time",
    editable: "O",
    ref: "EML-010; ch.15 l.163 (bounds not in the extract, D-097)",
    validate: async (v, get): Promise<string | null> =>
      validateOrderedTime("evening_review_time", v, (k) => get(k)),
  },
  partial_at: {
    default: "20:30",
    unit: "Melbourne time",
    editable: "O",
    ref: "EML-011; ch.15 l.163 (bounds not in the extract, D-097)",
    validate: async (v, get): Promise<string | null> =>
      validateOrderedTime("partial_at", v, (k) => get(k)),
  },
  send_by: {
    default: "20:45",
    unit: "Melbourne time",
    editable: "O",
    ref: "EML-011; ch.15 l.163 (bounds not in the extract, D-097)",
    validate: async (v, get): Promise<string | null> =>
      validateOrderedTime("send_by", v, (k) => get(k)),
  },
  // ch.15 l.158: watchdog_times 20:40 and 21:50 Melbourne, O; PLT-014a, NFR-006. The generated
  // dual-UTC triggers of the YAML watchdog follow these; the workflow stays dispatch-only in M5.
  watchdog_times: {
    default: { first: "20:40", second: "21:50" },
    unit: "Melbourne time",
    editable: "O",
    ref: "PLT-014a, NFR-006; ch.15 l.158 (bounds not in the extract, D-097)",
    validate: async (v) => validateWatchdogTimes(v),
  },
  // ch.15 l.196-197: attention_reminder_enabled on, attention_reminder_time 08:00 (06:00-22:00), O.
  attention_reminder_enabled: {
    default: "on",
    unit: "on/off",
    editable: "O",
    ref: "EML-023; ch.15 l.196",
    validate: oneOf(ON_OFF),
  },
  attention_reminder_time: {
    default: "08:00",
    unit: "Melbourne time",
    editable: "O",
    ref: "EML-023; ch.15 l.197",
    validate: timeIn("06:00", "22:00"),
  },
  // EML-016 Morning Brief and pause (D-096 decision 4): no ch.15 row; defaults off / 08:00 / off.
  morning_brief_enabled: {
    default: "off",
    unit: "on/off",
    editable: "O",
    ref: "EML-016, D-096 decision 4",
    validate: oneOf(ON_OFF),
  },
  morning_brief_time: {
    default: "08:00",
    unit: "Melbourne time",
    editable: "O",
    ref: "EML-016, D-096 decision 4",
    validate: timeIn("06:00", "10:00"),
  },
  evening_review_paused: {
    default: "off",
    unit: "on/off",
    editable: "O",
    ref: "EML-016, D-096 decision 4",
    validate: oneOf(ON_OFF),
  },
  // D-096 decision 23: three attempts (in-request, +2 s, next invocation). Fixed.
  email_retry_policy: {
    default: EMAIL_RETRY_POLICY,
    unit: "mixed",
    editable: "fixed",
    ref: "EML-030, D-096 decision 23",
    validate: never,
  },
  // Line 145: retention (logs 30 d, runs 180 d, news 400 d), Edit O, no bounds given; DAT-142.
  retention_logs_days: {
    default: 30,
    unit: "days",
    editable: "O",
    ref: "DAT-142",
    validate: intRange(1),
  },
  retention_runs_days: {
    default: 180,
    unit: "days",
    editable: "O",
    ref: "DAT-142",
    validate: intRange(1),
  },
  retention_news_days: {
    default: 400,
    unit: "days",
    editable: "O",
    ref: "DAT-142",
    validate: intRange(1),
  },
  // Line 146: backup retention 14 daily / 8 weekly / 12 monthly, Edit O; PLT-022b.
  backup_retention: {
    default: { daily: 14, weekly: 8, monthly: 12 },
    unit: "copies",
    editable: "O",
    ref: "PLT-022b",
    validate: async (v) =>
      exactKeys(v, ["daily", "weekly", "monthly"]) &&
      Object.values(v).every((x) => isInt(x) && x >= 1)
        ? null
        : "daily, weekly and monthly must each be a whole number of at least 1",
  },
  // Line 143: storage_warn_gb 2.5 GB, O; DAT-141.
  storage_warn_gb: {
    default: 2.5,
    unit: "GB",
    editable: "O",
    ref: "DAT-141",
    validate: async (v, get) => {
      if (!isNum(v) || v <= 0) return "must be greater than 0";
      const ceiling = await get("storage_ceiling_gb");
      return isNum(ceiling) && v > ceiling ? "must not exceed the storage ceiling" : null;
    },
  },
  // Line 144: storage_ceiling_gb 3 GB, O; DAT-141.
  storage_ceiling_gb: {
    default: 3,
    unit: "GB",
    editable: "O",
    ref: "DAT-141",
    validate: async (v, get) => {
      if (!isNum(v) || v <= 0) return "must be greater than 0";
      const warn = await get("storage_warn_gb");
      return isNum(warn) && v < warn ? "must not be below the storage warning" : null;
    },
  },
  // Line 155: quota thresholds 70/90/95% per period, O; PLT-051.
  quota_thresholds: {
    default: { notice: 0.7, alert: 0.9, degrade: 0.95 },
    unit: "fraction",
    editable: "O",
    ref: "PLT-051",
    validate: async (v) => {
      if (!exactKeys(v, ["notice", "alert", "degrade"])) return "needs notice, alert and degrade";
      const { notice, alert, degrade } = v;
      return isNum(notice) &&
        isNum(alert) &&
        isNum(degrade) &&
        notice > 0 &&
        notice < alert &&
        alert < degrade &&
        degrade <= 1
        ? null
        : "must satisfy 0 < notice < alert < degrade <= 1";
    },
  },
  // Line 160: session_lifetime 14 days, O; PLT-033; SEC-010 lifetime <= 14 days.
  session_lifetime_days: {
    default: 14,
    unit: "days",
    editable: "O",
    ref: "PLT-033",
    validate: intRange(1, 14),
  },
  // Line 161: sign-in 10/min/IP, writes 60/min/user, exports 5/h/user, O; SEC-014.
  rate_limits: {
    default: { signin_per_min_ip: 10, writes_per_min_user: 60, exports_per_hour_user: 5 },
    unit: "count",
    editable: "O",
    ref: "SEC-014",
    validate: async (v) =>
      exactKeys(v, ["signin_per_min_ip", "writes_per_min_user", "exports_per_hour_user"]) &&
      Object.values(v).every((x) => isInt(x) && x >= 1)
        ? null
        : "every limit must be a whole number of at least 1",
  },
  // Line 162: hmac_max_age 300 s, Edit "-" (fixed); SEC-017.
  hmac_max_age_s: {
    default: 300,
    unit: "s",
    editable: "fixed",
    ref: "SEC-017",
    validate: never,
  },
  // Line 175: token_warning_days 14 / 7 / 2, O; SEC-021.
  token_warning_days: {
    default: [14, 7, 2],
    unit: "days",
    editable: "O",
    ref: "SEC-021",
    validate: async (v) =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((x, i) => isInt(x) && x >= 1 && (i === 0 || x < v[i - 1]))
        ? null
        : "must be a non-empty, strictly descending list of whole days",
  },
  // Line 166: what_if_daily_limit_per_user 5, bounds 0-20, O; ROL-102a.
  what_if_daily_limit_per_user: {
    default: 5,
    unit: "count per user",
    editable: "O",
    ref: "ROL-102a",
    validate: intRange(0, 20),
  },
  // Line 156: sentinel_blind_alert 15 min, O; PLT-018.
  sentinel_blind_alert_min: {
    default: 15,
    unit: "min",
    editable: "O",
    ref: "PLT-018",
    validate: intRange(1),
  },
  // Line 142: turso ceilings (storage 3 GB, writes 6M/month, reads 300M/month, staging <= 15%); DAT-141.
  turso_writes_ceiling_month: {
    default: 6_000_000,
    unit: "rows/month",
    editable: "O",
    ref: "DAT-141",
    validate: intRange(1),
  },
  turso_reads_ceiling_month: {
    default: 300_000_000,
    unit: "rows/month",
    editable: "O",
    ref: "DAT-141",
    validate: intRange(1),
  },
  turso_staging_share: {
    default: 0.15,
    unit: "fraction",
    editable: "O",
    ref: "DAT-141",
    validate: async (v) =>
      isNum(v) && v > 0 && v <= 1 ? null : "must be greater than 0 and at most 1",
  },
  // Line 154: actions_minutes_soft_ceiling 3,000/month, O; PLT-014 (warns only, PLT-051).
  actions_minutes_soft_ceiling: {
    default: 3000,
    unit: "min/month",
    editable: "O",
    ref: "PLT-014",
    validate: intRange(1),
  },
  // Line 187: llm_daily_budget_total 150,000 tokens, bounds 75,000-225,000, O; LLM-050.
  // M11-lite (D-481): re-based to 240,000, bounds 150,000-300,000, to carry the R6 steelman cap.
  llm_daily_budget_total: {
    default: 240_000,
    unit: "tokens/day",
    editable: "O",
    ref: "LLM-050, D-481",
    validate: intRange(150_000, 300_000),
  },
  // Architect decision 8 (D-057): ch.15 has no Yahoo throttle row (spec gap, M2_requirements s4);
  // Owner-editable, bounds 10-500. Used by scripts/ingest/yahoo_fetch.py (DAT-120, DAT-103).
  yahoo_chunk_size: {
    default: 100,
    unit: "tickers/request",
    editable: "O",
    ref: "DAT-120",
    validate: intRange(10, 500),
  },
  // Architect decision 8 (D-057): minimum pause between Yahoo chunk requests, bounds 1-60.
  yahoo_min_gap_s: {
    default: 5,
    unit: "s",
    editable: "O",
    ref: "DAT-120",
    validate: intRange(1, 60),
  },
  // Line 132: refetch_diff_flag 0.1%, O; DAT-002. Percent units. Ch.15 gives no bounds (spec gap,
  // M2 T7): 0.01 to 5 keeps the flag meaningful. Mirrored by REFETCH_DIFF_PCT in rules.mjs.
  refetch_diff_flag: {
    default: 0.1,
    unit: "%",
    editable: "O",
    ref: "DAT-002",
    validate: numRange(0.01, 5),
  },
  // Line 133: suspect_move 40%, O; DAT-200. Percent units. No bounds in ch.15 (spec gap, M2 T7):
  // 10 to 90. Mirrored by DEFAULT_SUSPECT_MOVE_PCT in quality/rules.mjs.
  suspect_move: {
    default: 40,
    unit: "%",
    editable: "O",
    ref: "DAT-200",
    validate: numRange(10, 90),
  },
  // Line 134: u1_quality_gate 95%, O; DAT-210. Percent units. No bounds in ch.15 (spec gap, M2 T7):
  // 50 to 100. Mirrored by DEFAULT_U1_GATE_PCT in quality/rules.mjs.
  u1_quality_gate: {
    default: 95,
    unit: "%",
    editable: "O",
    ref: "DAT-210",
    validate: numRange(50, 100),
  },
  // D-057 decision 5: data-quality flags are kept 180 days unless they blocked a decision (those
  // are kept forever). Not in ch.15 (spec gap, M2 T7). The database trigger refuses deleting a
  // younger flag, so the minimum is 180.
  retention_flag_days: {
    default: 180,
    unit: "days",
    editable: "O",
    ref: "DAT-142",
    validate: intRange(180),
  },
  // DAT-221: "A queued item unresolved after 5 sessions is applied using the best-evidence
  // interpretation and flagged." The number 5 is in the spec text but not in ch.15, so this key
  // and its bounds are a spec gap (M2 T8): whole sessions, 1 to 60. Mirrored by
  // DEFAULT_AUTO_APPLY_SESSIONS in data/corporateActions/rules.mjs.
  corporate_action_auto_apply_sessions: {
    default: 5,
    unit: "sessions",
    editable: "O",
    ref: "DAT-221",
    validate: intRange(1, 60),
  },
  // DAT-221: an action is auto-confirmed when the announcement and "the price/vendor data agree".
  // How close the price must be to the announced ratio is not in the spec or ch.15 (spec gap, M2
  // T8): percent, 1 to 50. Mirrored by DEFAULT_PRICE_TOLERANCE_PCT in the same rules file.
  corporate_action_price_tolerance: {
    default: 10,
    unit: "%",
    editable: "O",
    ref: "DAT-221",
    validate: numRange(1, 50),
  },
  // D-057 decision 3 (BLD-024): per-market operating mode, read by the Worker and every job.
  // The value is an object keyed by market code. Ch.15 has no row for it (spec gap, M2 T10).
  // AU starts `data_only` (production data-only mode, BLD-024); `full` is refused until M3
  // (Arena, decision agents and emails do not exist yet). Marked fixed so the generic Configuration
  // page cannot edit it: the ONLY writer is the Owner action in src/lib/data/controls.ts, which
  // also updates `market.mode` (the column the Worker and the pipeline read at run time) in the
  // same transaction. Editing only this row would change nothing at run time.
  market_mode: {
    default: { AU: "data_only" },
    unit: "mode",
    editable: "fixed",
    ref: "BLD-024",
    validate: async (v) => validateMarketModes(v),
  },
  // Line 24: cost_profile_default P5 (enum P0-P5b), Edit O; ARN-031. Selects the brokerage profile
  // of a new cohort; the P0-P5b tables themselves are versioned cost_profile rows, verified = 0
  // until the Owner approves them (M3 design 4.4, D-070 note 8).
  cost_profile_default: {
    default: "P5",
    unit: "profile",
    editable: "O",
    ref: "ARN-031",
    validate: oneOf(COST_PROFILE_CODES),
  },
  // Line 12 (stall_floor, computed, not editable) with D-069 decision 4: the entry slippage inside
  // the stall floor is max(10 bps, one price tick), so the 10 bps is a fixed key of its own.
  stall_floor_bps: {
    default: 10,
    unit: "bps",
    editable: "fixed",
    ref: "ARN-032, spec 05 s5.1 l.12, D-069 decision 4",
    validate: never,
  },
  // ARN-013 (spec 05 l.43): trades above 0.5% of ADV are "possibly un-tradeable". Ch.15 has no row
  // (D-069 decision 12 adds this one). Percent of 20-session ADV, Owner-editable. The 0.1 to 5
  // bounds are the architect's choice; the spec gives none.
  untradeable_adv_pct: {
    default: 0.5,
    unit: "% of ADV",
    editable: "O",
    ref: "ARN-013, D-069 decision 12",
    validate: numRange(0.1, 5),
  },
  // Spec 05 section 5.1 / ch.15 stall_sessions (3-10, O): stalled (a) needs the NAV below the stall
  // floor for this many consecutive sessions. TST-101 is stated at the default 5.
  stall_sessions: {
    default: 5,
    unit: "sessions",
    editable: "O",
    ref: "section 5.1 stalled (a), ch.15 stall_sessions",
    validate: intRange(3, 10),
  },
  // Section 5.1 / ch.15 stall_parcel_rejections (10-40, O): stalled (b), sessions of parcel-only rejections.
  stall_parcel_rejections: {
    default: 20,
    unit: "sessions",
    editable: "O",
    ref: "section 5.1 stalled (b), ch.15 stall_parcel_rejections",
    validate: intRange(10, 40),
  },
  // Section 5.1 / ch.15 timeout_sessions (252, O). The spec gives no bounds; 20 to 1,000 is the
  // architect's choice (M3 T9, D-076).
  timeout_sessions: {
    default: 252,
    unit: "sessions",
    editable: "O",
    ref: "section 5.1 Timeout, ch.15 timeout_sessions",
    validate: intRange(20, 1000),
  },
  // ARN-004 C1: AU broad-index ETF code, [VERIFY code] - an Owner item. The default is a PLACEHOLDER,
  // not a ticker; C1 places no orders until the Owner replaces it (D-076).
  c1_etf_code: {
    default: C1_ETF_PLACEHOLDER,
    unit: "ETF code",
    editable: "O",
    ref: "ARN-004 C1 [VERIFY code]",
    validate: async (v: unknown) =>
      typeof v === "string" && /^[A-Z0-9-]{1,12}$/.test(v)
        ? null
        : "must be 1 to 12 capital letters, digits or hyphens",
  },
  // NFR-030 / DAT-142: email and name are hashed 90 days after revocation. Fixed, not in ch.15.
  pii_hash_after_revocation_days: {
    default: 90,
    unit: "days",
    editable: "fixed",
    ref: "NFR-030",
    validate: never,
  },
  // AGT-101 / ch.15 l.115 regime thresholds: SMA 200, vol percentile 70 / 95 / 50, 5-session fall
  // 7 %, exit hysteresis 3 sessions. Owner-editable (O).
  regime_params: {
    default: {
      sma_sessions: 200,
      vol_pct_riskoff: 70,
      vol_pct_shock: 95,
      vol_pct_riskon: 50,
      fall5_pct: 7,
      exit_hysteresis: 3,
    },
    unit: "mixed",
    editable: "O",
    ref: "AGT-101; ch.15 l.115 (bounds not in the extract, D-079)",
    validate: async (v) => validateRegimeParams(v),
  },
  // AGT-105 / ch.15 l.116 insider and flow weights: director net 0.5, holder new or increase 0.25,
  // holder decrease 0.25 (Lane B).
  insider_score_weights: {
    default: { director_net: 0.5, holder_new_or_increase: 0.25, holder_decrease: 0.25 },
    unit: "score",
    editable: "B",
    ref: "AGT-105; ch.15 l.116 (bounds not in the extract, D-079)",
    validate: async (v) => validateInsiderWeights(v),
  },
  // Design 4.6: each market's share of the daily LLM role budgets. Not in the ch.15 extract
  // (D-079): AU is the only market and takes all of it.
  llm_market_share: {
    default: { AU: 1 },
    unit: "fraction",
    editable: "O",
    ref: "design 4.6 llm_market_share [VERIFY against ch.15, D-079]",
    validate: async (v) => validateMarketShare(v),
  },
} satisfies Record<string, ConfigKeyDef>;

export type ConfigKey = keyof typeof CONFIG_KEYS;

export function isConfigKey(k: string): k is ConfigKey {
  return Object.prototype.hasOwnProperty.call(CONFIG_KEYS, k);
}

// Display metadata for the Owner Configuration page (UX-116). Kept apart from CONFIG_KEYS so the
// registry itself stays a pure description of values and validators.
export type ConfigArea =
  | "Retention"
  | "Quotas"
  | "Sessions & limits"
  | "Backups"
  | "Strategy families"
  | "Regime and events"
  | "Validation statistics"
  | "Replay and compute"
  | "Sentinel and email"
  | "Learning and knowledge"
  | "Other";
export type ConfigInput = "int" | "number" | "list" | "object" | "text";
export type ConfigMeta = { label: string; area: ConfigArea; bounds: string; input: ConfigInput };

/** Plain-English headings for the Configuration page (UXN-030); the area ids above stay stable. */
export const CONFIG_AREA_LABEL: Record<ConfigArea, string> = {
  Retention: "How long we keep data",
  Quotas: "Quotas",
  "Sessions & limits": "Sessions and limits",
  Backups: "Backups",
  "Strategy families": "Strategy families",
  "Regime and events": "Regime and events",
  "Validation statistics": "Checking results",
  "Replay and compute": "Replay and compute",
  "Sentinel and email": "Sentinel and email",
  "Learning and knowledge": "Learning and knowledge",
  Other: "Other",
};

export const CONFIG_AREAS: ConfigArea[] = [
  "Retention",
  "Quotas",
  "Sessions & limits",
  "Backups",
  "Strategy families",
  "Regime and events",
  "Validation statistics",
  "Replay and compute",
  "Sentinel and email",
  "Learning and knowledge",
  "Other",
];

export const CONFIG_META: Record<ConfigKey, ConfigMeta> = {
  ...M4_META,
  ...M5_META_TABLES,
  ...M6_META_TABLES,
  ...M6_EXPLICIT_META,
  ...M7_META_TABLES,
  ...M14_META_TABLES,
  ...M15_META_TABLES,
  ...M17_META_TABLES,
  ...M11L_META_TABLES,
  ...M13L_META_TABLES,
  ...MOVERS_META_TABLES,
  evening_review_time: {
    label: "Evening Review send time",
    area: SEM,
    bounds: "HH:MM, 19:30 to 21:00, before partial_at",
    input: "text",
  },
  partial_at: {
    label: "Send the review marked partial at",
    area: SEM,
    bounds: "HH:MM, 20:00 to 21:30, between the send time and send_by",
    input: "text",
  },
  send_by: {
    label: "Send the review by (latest)",
    area: SEM,
    bounds: "HH:MM, 20:15 to 22:00, after partial_at",
    input: "text",
  },
  watchdog_times: {
    label: "YAML watchdog times (Melbourne)",
    area: SEM,
    bounds: "first 20:30 to 21:30, second 21:00 to 23:00, first before second",
    input: "object",
  },
  attention_reminder_enabled: {
    label: "Daily attention reminder email",
    area: SEM,
    bounds: "on or off",
    input: "text",
  },
  attention_reminder_time: {
    label: "Attention reminder time",
    area: SEM,
    bounds: "HH:MM, 06:00 to 22:00",
    input: "text",
  },
  morning_brief_enabled: {
    label: "Morning Brief email (trading days)",
    area: SEM,
    bounds: "on or off",
    input: "text",
  },
  morning_brief_time: {
    label: "Morning Brief time",
    area: SEM,
    bounds: "HH:MM, 06:00 to 10:00",
    input: "text",
  },
  evening_review_paused: {
    label: "Pause the Evening Review email (it is still stored in the app)",
    area: SEM,
    bounds: "on or off",
    input: "text",
  },
  email_retry_policy: {
    label: "Email send retries",
    area: SEM,
    bounds: "fixed",
    input: "object",
  },
  regime_params: {
    label: "Regime thresholds (SMA, volatility percentiles, 5-session fall, exit hysteresis)",
    area: "Regime and events",
    bounds:
      "JSON with sma_sessions 50-400, vol_pct_riskon < vol_pct_riskoff < vol_pct_shock (0-100), fall5_pct above 0 to 50, exit_hysteresis 1-10",
    input: "object",
  },
  insider_score_weights: {
    label: "Insider and flow score weights",
    area: "Regime and events",
    bounds:
      "JSON with director_net, holder_new_or_increase, holder_decrease and optionally director_sale, each 0 to 1",
    input: "object",
  },
  llm_market_share: {
    label: "Share of the daily LLM budgets each market may use",
    area: "Quotas",
    bounds: 'JSON such as {"AU": 1}, each share 0 to 1',
    input: "object",
  },
  retention_logs_days: {
    label: "Keep application logs for",
    area: "Retention",
    bounds: "whole days, at least 1",
    input: "int",
  },
  retention_runs_days: {
    label: "Keep job run records for",
    area: "Retention",
    bounds: "whole days, at least 1",
    input: "int",
  },
  retention_news_days: {
    label: "Keep news items for",
    area: "Retention",
    bounds: "whole days, at least 1",
    input: "int",
  },
  pii_hash_after_revocation_days: {
    label: "Hash a revoked user's email and name after",
    area: "Retention",
    bounds: "fixed",
    input: "int",
  },
  backup_retention: {
    label: "Backups kept (daily, weekly, monthly)",
    area: "Backups",
    bounds: "each a whole number, at least 1",
    input: "object",
  },
  storage_warn_gb: {
    label: "Database storage warning",
    area: "Quotas",
    bounds: "above 0, not above the storage ceiling",
    input: "number",
  },
  storage_ceiling_gb: {
    label: "Database storage ceiling",
    area: "Quotas",
    bounds: "above 0, not below the storage warning",
    input: "number",
  },
  quota_thresholds: {
    label: "Quota notice, alert and degrade levels",
    area: "Quotas",
    bounds: "0 < notice < alert < degrade <= 1",
    input: "object",
  },
  turso_writes_ceiling_month: {
    label: "Database writes ceiling",
    area: "Quotas",
    bounds: "whole number, at least 1",
    input: "int",
  },
  turso_reads_ceiling_month: {
    label: "Database reads ceiling",
    area: "Quotas",
    bounds: "whole number, at least 1",
    input: "int",
  },
  turso_staging_share: {
    label: "Staging share of the database limits",
    area: "Quotas",
    bounds: "above 0, at most 1",
    input: "number",
  },
  actions_minutes_soft_ceiling: {
    label: "GitHub Actions soft ceiling",
    area: "Quotas",
    bounds: "whole number, at least 1",
    input: "int",
  },
  llm_daily_budget_total: {
    label: "Daily LLM token budget",
    area: "Quotas",
    bounds: "150,000 to 300,000",
    input: "int",
  },
  session_lifetime_days: {
    label: "Sign-in session lifetime",
    area: "Sessions & limits",
    bounds: "1 to 14 days",
    input: "int",
  },
  rate_limits: {
    label: "Rate limits (sign-ins, writes, exports)",
    area: "Sessions & limits",
    bounds: "each a whole number, at least 1",
    input: "object",
  },
  hmac_max_age_s: {
    label: "Signed-request maximum age",
    area: "Sessions & limits",
    bounds: "fixed",
    input: "int",
  },
  token_warning_days: {
    label: "Token expiry warnings (days before)",
    area: "Other",
    bounds: "strictly descending whole days",
    input: "list",
  },
  what_if_daily_limit_per_user: {
    label: "What-if runs per user per day",
    area: "Other",
    bounds: "0 to 20",
    input: "int",
  },
  sentinel_blind_alert_min: {
    label: "Sentinel blind alert after",
    area: "Other",
    bounds: "whole minutes, at least 1",
    input: "int",
  },
  yahoo_chunk_size: {
    label: "Yahoo tickers per request",
    area: "Other",
    bounds: "whole number, 10 to 500",
    input: "int",
  },
  yahoo_min_gap_s: {
    label: "Pause between Yahoo requests",
    area: "Other",
    bounds: "whole seconds, 1 to 60",
    input: "int",
  },
  refetch_diff_flag: {
    label: "Flag a re-fetched bar that differs by more than",
    area: "Other",
    bounds: "percent, 0.01 to 5",
    input: "number",
  },
  suspect_move: {
    label: "Treat a one-day close move above this as suspect",
    area: "Other",
    bounds: "percent, 10 to 90",
    input: "number",
  },
  u1_quality_gate: {
    label: "Block new entries when U1 data quality is below",
    area: "Other",
    bounds: "percent, 50 to 100",
    input: "number",
  },
  retention_flag_days: {
    label: "Keep data-quality flags for (unless they blocked a decision)",
    area: "Retention",
    bounds: "whole days, at least 180",
    input: "int",
  },
  corporate_action_auto_apply_sessions: {
    label: "Apply an unresolved corporate action on best evidence after (sessions)",
    area: "Other",
    bounds: "whole sessions, 1 to 60",
    input: "int",
  },
  corporate_action_price_tolerance: {
    label: "Corporate action: price move may differ from the announced ratio by up to",
    area: "Other",
    bounds: "percent, 1 to 50",
    input: "number",
  },
  market_mode: {
    label: "Market mode (changed only in System Health, Data controls)",
    area: "Other",
    bounds: "off, data_only or full per market (full needs the go-live sign-off in production)",
    input: "object",
  },
  cost_profile_default: {
    label: "Brokerage cost profile for new cohorts",
    area: "Other",
    bounds: "one of P0, P1, P2, P3, P4, P5, P5b",
    input: "text",
  },
  stall_floor_bps: {
    label: "Entry slippage inside the stall floor (or one tick, if larger)",
    area: "Other",
    bounds: "fixed",
    input: "int",
  },
  stall_sessions: {
    label: "Stalled: sessions below the stall floor with no position",
    area: "Other",
    bounds: "whole sessions, 3 to 10",
    input: "int",
  },
  stall_parcel_rejections: {
    label: "Stalled: sessions of signals rejected only for the parcel rule",
    area: "Other",
    bounds: "whole sessions, 10 to 40",
    input: "int",
  },
  timeout_sessions: {
    label: "Cohort timeout",
    area: "Other",
    bounds: "whole sessions, 20 to 1000",
    input: "int",
  },
  c1_etf_code: {
    label: "C1 control: broad-index ETF code [VERIFY]",
    area: "Other",
    bounds: "1 to 12 capitals, digits or hyphens; the placeholder means unset",
    input: "text",
  },
  untradeable_adv_pct: {
    label: 'Label a trade "possibly un-tradeable" above this share of daily volume',
    area: "Other",
    bounds: "percent of ADV, 0.1 to 5",
    input: "number",
  },
};

/** Every key added in M5 (docs/M5_design.md 4.11): the tables above plus the explicit entries. */
export const M5_KEY_NAMES: readonly ConfigKey[] = [
  ...M5_RANGED.map((r) => r[0]),
  ...M5_FIXED.map((r) => r[0]),
  "evening_review_time",
  "partial_at",
  "send_by",
  "watchdog_times",
  "attention_reminder_enabled",
  "attention_reminder_time",
  "morning_brief_enabled",
  "morning_brief_time",
  "evening_review_paused",
  "email_retry_policy",
];

/** Every key added in M6 (docs/M6_design.md 4.12 and D-111): the tables above plus the explicit entries. */
export const M6_KEY_NAMES: readonly ConfigKey[] = [
  ...M6_RANGED.map((r) => r[0]),
  ...M6_FIXED.map((r) => r[0]),
  ...(Object.keys(M6_EXPLICIT_KEYS) as ConfigKey[]),
];

/** Every key added in M7 (docs/M7_design.md 2.11, D-128): the tables above plus the strategy-name table. */
export const M7_KEY_NAMES: readonly ConfigKey[] = [
  ...M7_RANGED.map((r) => r[0]),
  ...M7_FIXED.map((r) => r[0]),
  ...(Object.keys(M7_EXPLICIT_KEYS) as ConfigKey[]),
];

/** Every key added in M14 (docs/M14_design.md 2.7, D-250): the tables above plus the enum keys. */
export const M14_KEY_NAMES: readonly ConfigKey[] = [
  ...M14_RANGED.map((r) => r[0]),
  ...M14_FIXED.map((r) => r[0]),
  ...(Object.keys(M14_ENUM_KEYS) as ConfigKey[]),
];

/** Every key added in M15 (docs/M15_requirements.md, D-257 to D-306): the tables above. */
export const M15_KEY_NAMES: readonly ConfigKey[] = [
  ...M15_RANGED.map((r) => r[0]),
  ...M15_FIXED.map((r) => r[0]),
];

/**
 * The Cortex keys whose Owner edit is a charged trial and refits the map (CTX-072): every editable
 * M15 key. The fixed pair never changes, so it is not listed.
 */
export const CORTEX_REFIT_KEYS: readonly ConfigKey[] = M15_RANGED.map((r) => r[0]);
