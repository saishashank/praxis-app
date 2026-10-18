import { COST_PROFILE_CODES } from "@/lib/arena/costs";

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
/** Modes that can be selected now. `full` needs the Arena and agents (M3). */
export const SELECTABLE_MODES = ["off", "data_only"] as const;

export function validateMarketModes(v: unknown): string | null {
  if (!isObj(v)) return "must list a mode for each market";
  const keys = Object.keys(v);
  if (keys.length === 0 || !keys.every((k) => (MODE_MARKETS as readonly string[]).includes(k))) {
    return "unknown market";
  }
  for (const x of Object.values(v)) {
    if (x === "full") return "full is not available until M3";
    if (!(SELECTABLE_MODES as readonly unknown[]).includes(x))
      return "mode must be off or data_only";
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
  ["f3_time_exit", "int", 20, 10, 40, "sessions", "B", FAM, "ch.15 15.3 F3 time_exit", "F3: time exit"],
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
  ["replay_full_minutes", "int", 90, 15, 360, "min", "O", REP, "ARN-100; ch.15 l.61 (bounds not in the extract, D-079)", "Monthly full replay budget"],
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
  if (!exactKeys(v, [...INSIDER_WEIGHT_NAMES])) return `needs ${INSIDER_WEIGHT_NAMES.join(", ")}`;
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

export const CONFIG_KEYS = {
  ...M4_RANGED_KEYS,
  ...M4_FIXED_KEYS,
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
  llm_daily_budget_total: {
    default: 150_000,
    unit: "tokens/day",
    editable: "O",
    ref: "LLM-050",
    validate: intRange(75_000, 225_000),
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
  | "Other";
export type ConfigInput = "int" | "number" | "list" | "object" | "text";
export type ConfigMeta = { label: string; area: ConfigArea; bounds: string; input: ConfigInput };

export const CONFIG_AREAS: ConfigArea[] = [
  "Retention",
  "Quotas",
  "Sessions & limits",
  "Backups",
  "Strategy families",
  "Regime and events",
  "Validation statistics",
  "Replay and compute",
  "Other",
];

export const CONFIG_META: Record<ConfigKey, ConfigMeta> = {
  ...M4_META,
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
    bounds: "JSON with director_net, holder_new_or_increase, holder_decrease, each 0 to 1",
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
    bounds: "75,000 to 225,000",
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
    bounds: "off or data_only per market; full from M3",
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
