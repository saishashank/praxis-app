// Typed, resolved parameters for the agents, families and replay engine (M4 T2, docs/M4_design.md
// section 6 decision 10: "every threshold used in code is a key", ch.15 AC). Every number the rule
// code needs is read from the config registry (src/lib/config/keys.ts) here and nowhere else, so a
// replay can record the whole parameter set and its hash (ARN-102).
//
// Exact domains (docs/M4_design.md 2.1): thresholds that are compared with prices, volumes or
// returns are exact rationals (money/rational.ts) built from the key's decimal text, never from
// float arithmetic; percent keys are divided by 100 exactly. Whole numbers (sessions, counts) stay
// `number`. Float64 thresholds (RSI levels, the statistics) stay `number` because the quantities
// they are compared with are float64 by design.
//
// An absent or invalid stored value falls back to the registry default (as the quality and
// corporate-action engines do); this module never throws on bad configuration.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import {
  CONFIG_KEYS,
  injectionPhrasesOf,
  type ConfigKey,
  type F1_MOMENTUM_VARIANTS,
  type F3_SURPRISE_MODES,
  type F4_ENTRY_VARIANTS,
  type F5_UNIVERSES,
  type RANK_VARIANTS,
  type SETTLEMENT_STATS_MODES,
  type VAL_ERROR_BUDGET_MODES,
} from "@/lib/config/keys";
import { parseRational, type Rational } from "@/lib/money/rational";

export type ConfigSource = (key: ConfigKey) => unknown;

// ---- exact conversion from a config number ----

/** Plain decimal text of a finite number (never exponent form), the input of parseRational. */
function decimalText(n: number): string {
  const text = String(n);
  if (!text.includes("e")) return text;
  const FORMAT_DIGITS = 20; // threshold-ok: text formatting width, not a rule
  return n.toFixed(FORMAT_DIGITS);
}

/** 1.5 -> 3/2. Exact: goes through the shortest decimal text, not through float arithmetic. */
export function ratFromNumber(n: number): Rational {
  return parseRational(decimalText(n));
}

/** A percent key: 3 -> 3/100, 2.5 -> 1/40. */
export function ratFromPercent(n: number): Rational {
  return parseRational(`${decimalText(n)}%`);
}

// ---- parameter shape ----

export type Windows = {
  atr: number;
  rsiShort: number;
  rsiLong: number;
  smaExit: number;
  smaMid: number;
  smaTrend: number;
  returnWindow: number;
  adv: number;
  volumeRatio: number;
  vol: number;
  regimeVolLookback: number;
  regimeFall: number;
  shortInterest: number;
  f4EventWindow: number;
  /** Minutes before the calendar close at which continuous trading ends (day-0 boundary) [VERIFY]. */
  day0CloseOffsetMin: number;
};

export type F1Params = {
  volumeRatioMin: Rational;
  rsTopFraction: Rational;
  initialStopAtr: Rational;
  trailAtr: Rational;
  timeStop: number;
  /** Gain (as a fraction) needed at the time stop. */
  minGain: Rational;
  maxHold: number;
  highLookback: number;
  /** KB-081: sessions of the relative-strength return window (126 = v1). */
  returnWindowSessions: number;
  /** KB-081: momentum variant (`v1` = v1 rule). */
  momentumVariant: (typeof F1_MOMENTUM_VARIANTS)[number];
  /** KB-081: rank variant (`v1` = v1 rule). */
  rankVariant: (typeof RANK_VARIANTS)[number];
};
export type F2Params = {
  eventArMin: Rational;
  lookbackSessions: number;
  stopAtr: Rational;
  timeStop: number;
};
export type F3Params = {
  eventArMin: Rational;
  volumeRatioMin: Rational;
  /** Gap above the day-0 close, as a fraction, at which the order is cancelled. */
  maxGap: Rational;
  trailAfter: Rational;
  trailAtr: Rational;
  timeExit: number;
  /** AGT-137: how the surprise is read (`category` = v1 rule). */
  surpriseMode: (typeof F3_SURPRISE_MODES)[number];
};
export type F4Params = {
  /** Float64 thresholds: compared with Wilder RSI values. */
  rsi2Max: number;
  rsi14Max: number;
  timeExit: number;
  stopAtr: Rational;
  /** KB-081: entry variant (`v1` = v1 rule). */
  entryVariant: (typeof F4_ENTRY_VARIANTS)[number];
  /** KB-081: rank variant (`v1` = v1 rule). */
  rankVariant: (typeof RANK_VARIANTS)[number];
};
export type F5Params = {
  volumeRatioMin: Rational;
  arMin: Rational;
  rangePosMin: Rational;
  stopAtr: Rational;
  /** Largest initial stop loss as a positive fraction (the spec's -20 % is 1/5). */
  stopCap: Rational;
  trailAtr: Rational;
  timeStop: number;
  /** O-49: the universe F5 trades (U2). U3 runs only as the replay stress variant. */
  defaultUniverse: (typeof F5_UNIVERSES)[number];
};
export type F6Params = {
  minClasses: number;
  /** Insider/flow score counted as evidence (0.5 = two quarter-units). */
  insiderMin: Rational;
  /** Short-interest fall in percentage points. */
  shortDropPp: Rational;
  stopAtr: Rational;
  timeStop: number;
};

export type RegimeParams = {
  smaSessions: number;
  volPctRiskOff: Rational;
  volPctShock: Rational;
  volPctRiskOn: Rational;
  /** The 5-session fall that gives SHOCK, as a fraction. */
  fall5: Rational;
  exitHysteresis: number;
};

/** ARN-011 filter thresholds (spec 05 l.41; keys arn011_*, D-085, D-111). */
export type Arn011Params = {
  gainSessions: number;
  gainMax: Rational;
  oneDayGain: Rational;
  volumeRatioMax: Rational;
  placementWindow: number;
  placementsMax: number;
  raiseWindow: number;
  queryWindow: number;
  consolidationWindow: number;
  rangeFraction: Rational;
  rangeDaysWindow: number;
  rangeDaysMin: number;
};

/** M14 entry gates and data rules (FAM-004/005/006, DAT-234, DAT-237; keys in config/keys.ts M14). */
export type EntryParams = {
  /** FAM-004: largest initial stop distance, as a fraction of the reference price (12 % = 3/25). */
  maxStopDistance: Rational;
  /** FAM-005: median gross return must be at least this multiple of the round-trip cost. */
  costGateK: Rational;
  /** FAM-005: ledger rows needed before the gate applies. */
  costGateMinRows: number;
  /** FAM-006: highest correlation of daily returns between two new positions. */
  secondPositionMaxCorr: number;
  secondPositionCorrSessions: number;
  /** DAT-237: duplicate announcement window and title similarity. */
  dedupWindowSessions: number;
  dedupMinhashThreshold: number;
  /** DAT-234: sessions around day 0 in which an index change excludes an F3 event. */
  indexChangeWindowSessions: number;
};

/** F5 volume exit (spec 07 l.56; keys f5_dry_up_*, D-085, D-111). */
export type SpecConstantParams = {
  f5DryUpRatio: Rational;
  f5DryUpSessions: number;
};

/** CIF horizons, interval confidence and the progress table buckets (D-091, D-111). */
export type CifParams = {
  horizons: readonly number[];
  confidence: number;
};
export type ProgressParams = {
  navEdgesPpm: readonly number[];
  sessionsEdges: readonly number[];
};

/** Learning and knowledge (M6 design 4.12, D-110, D-111). */
export type LearningParams = {
  maxChallengers: number;
  maxPromotionsPerWeek: number;
  shakedownSessions: number;
  criticLlmCallsPerNight: number;
  lessonL0MinN: number;
  lessonL1MinN: number;
  lessonBootstrapLevel: number;
  l2AlphaW0: number;
  l2AlphaPayout: number;
  /** VAL-116: share of the pool wealth spent on each lesson test. */
  l2AlphaSpendFraction: number;
  /** VAL-116: the pool is exhausted when the next test level would be below this. */
  l2AlphaExhaustedLevel: number;
  comparisonsFdrQ: number;
  comparisonLookAlpha: number;
  comparisonLockoutSessions: number;
  comparisonMinRows: number;
  playbookMaxTokens: number;
  learningLoopMinutes: number;
  challengerGeneratorPerWeek: number;
  /** "HH:MM" Melbourne time of the knowledge archive run. */
  kbArchiveTime: string;
  /** `none` or provider:model. */
  classifierModel: string;
};

export type PickProfileParams = {
  tiers: readonly string[];
  maxPctPerPick: number;
  riskPctPerPick: number;
};

/** Ch.16 factor data and picks (AGT-112, AGT-113, ARN-095). */
export type PicksParams = {
  factorMinBucketN: number;
  factorBuckets: "terciles" | "quintiles";
  picksPerProfile: number;
  picksMaxPerFamily: number;
  pickValidSessions: number;
  pickSuccessMinN: number;
  profiles: Readonly<Record<string, PickProfileParams>>;
  /** A$ per profile (sizing examples only). */
  portfolioAmounts: Readonly<Record<string, number>>;
};

export type StatsParams = {
  alpha: number;
  bootstrapReplicationsMin: number;
  bootstrapReplicationsFactor: number;
  bootstrapSizeCheckReplications: number;
  bootstrapBlockMinSessions: number;
  bootstrapBlockPercentile: number;
  minBlocks: number;
  minTrades: number;
  c2ControlsPerRow: number;
  activeLineagesFloor: number;
  trialBudgetPerLineage: number;
  splitHoldoutMinSessions: number;
  splitValidationMinSessions: number;
  splitBlockMultiple: number;
  splitDevelopmentMinSessions: number;
  purgeExtraSessions: number;
  survivorshipFlagShare: Rational;
  survivorshipMinAnnouncements: number;
  survivorshipWindowSessions: number;
  usefulEdgeMin: Rational;
  forwardAlphaTotal: number;
  forwardLookTrades: number;
  forwardMinMonths: number;
  safetyCheckMinNeff: number;
  deltaBustTolerance: Rational;
  pboMax: number;
  pboMinVariants: number;
  pboBlocks: number;
  dsrMin: number;
  minCohortsRanked: number;
  progressMinNeff: number;
  scenarioMinN: number;
  costFeasibilityRatio: Rational;
  stressCostProfile: string;
  stressSlippageExtraPct: number;
  barrierKUp: Rational;
  barrierKDown: Rational;
  barrierHorizonSessions: number;
  eventCoverageMin: Rational;
  /** D-090: a gap of this many sessions with a name change flags a reused code. */
  codeReuseGapSessions: number;
  /** VAL-110 (vi): variance of the daily Sharpe when fewer than 2 families have development rows. */
  dsrDefaultSrVariance: number;
  /** VAL-112: how the validation error budget is spent (O-43). */
  valErrorBudgetMode: (typeof VAL_ERROR_BUDGET_MODES)[number];
  /** VAL-112: family-wise error per lineage and split version (W0). */
  valFwerPerLineage: number;
  /** ARN-109: settlement used for replay statistics (O-48). */
  settlementStatsMode: (typeof SETTLEMENT_STATS_MODES)[number];
  /** VAL-115: annual Sharpe the minimum backtest length is computed for. */
  minbtlTargetSharpe: number;
  /** VAL-114: daily rank quality. */
  rankIcMinCodes: number;
  rankIcBootstrapReplicates: number;
  rankIcBootstrapBlocks: "monthly" | "weekly";
};

export type KillswitchParams = {
  tradesPerLook: number;
  alphaTotal: number;
  criteria: number;
  maxLooksPerYear: number;
  quietSessions: number;
};

export type ReplayParams = {
  rollingStartStep: number;
  c2LivePerFamily: number;
  zeroEdgeTrials: number;
  zeroEdgeSeed: number;
  sleeveLeverage: number;
  realityCap: number;
  lightMinutes: number;
  fullMinutes: number;
  nightlyMinutes: number;
  tursoRecentSessions: number;
  eventBackfillYears: number;
  /** Signal-ledger notional per row, micro-AUD (A$600 -> 600,000,000). */
  ledgerNotionalMicro: bigint;
};

export type LlmParams = {
  roleDailyTokens: { R1: number; R2: number; R3: number; R5: number; R6: number };
  dailyTotal: number;
  nightlyTokensPerMarket: number;
  /** Per market, as an exact fraction. */
  marketShare: Readonly<Record<string, Rational>>;
  cacheTtlHours: number;
  r2MaterialityMin: number;
  /** The phrases of llm_injection_phrases and their list version (LLM-035). */
  injectionPhrases: readonly string[];
  injectionPhrasesVersion: string;
};

/**
 * M15 Cortex parameters (CTX rows, docs/M15_requirements.md; keys in config/keys.ts M15). Shares of
 * money and loss caps are exact Rationals; counts, multiples and statistical levels are numbers.
 */
export type CortexParams = {
  /** CTX-021: fewest matched setups a cell needs. */
  cellMinSetups: number;
  /** CTX-012: fewest independent time blocks. */
  cellMinBlocks: number;
  /** CTX-053: effective sample size a family needs before it may trade. */
  minNeffTrade: number;
  /** CTX-022: shrinkage pseudo-sample of the ranking. */
  rankShrinkN0: number;
  /** CTX-022b: largest loss (stop distance plus overnight gap), fraction of the reference price. */
  maxLoss: Rational;
  /** CTX-022b / CTX-028: highest open above the close at which a limit order still buys, fraction. */
  entryGapCap: Rational;
  /** CTX-023: evidence disagreement above which a candidate is not taken. */
  disagreementMax: number;
  /** CTX-012: largest score share of one angle cluster. */
  clusterWeightMax: number;
  /** CTX-025: sector tilt margin (shadow), percentage points. */
  sectorTiltMarginPp: number;
  /** CTX-026 caps across the 12 books. */
  maxBooksSameCode: number;
  maxBooksSameIndustry: number;
  maxCodeNavShare: Rational;
  maxIndustryNavShare: Rational;
  /** CTX-015: loss at which a frozen position is sold (fraction) and sessions of the freeze. */
  freezeMaxLoss: Rational;
  unresolvedFreezeSessions: number;
  /** CTX-043 / CTX-044. */
  persistVolumeMult: number;
  pumpVolumeMult: number;
  pumpAr: Rational;
  promotionFlagSessions: number;
  /** CTX-023: sessions of abstaining in a row that raise the alarm. */
  abstainAlarmSessions: number;
  /** CTX-028 / D-289: share of the universe without a fresh bar above which the night abstains. */
  staleUniverseMaxShare: number;
  /** CTX-060: settled opinions needed. */
  opinionMinN: number;
  /** CTX-031: BH false-discovery rate (PRDS). */
  ledgerFdrQ: number;
  /** CTX-012: expected block length of the stationary bootstrap, sessions. */
  bootstrapBlockSessions: number;
  /** CTX-053 / D-257: p is hidden when the slope's upper bound is below this. */
  slopeHideUb: number;
  /** D-289: minutes the nightly stage may run before it abstains. */
  stageMinutes: number;
  /** CTX-050: survivorship haircut, percentage points per holding year (fixed). */
  survivorshipHaircutPp: number;
  /** CTX-016: suspension mark policy (fixed text). */
  suspensionMarkPolicy: string;
};

export type AgentParams = {
  windows: Windows;
  f1: F1Params;
  f2: F2Params;
  f3: F3Params;
  f4: F4Params;
  f5: F5Params;
  f6: F6Params;
  reentryBlock: number;
  maxOpenPositions: number;
  /** AGT-020: |AR| above this gives a results/other event its polarity (fraction). */
  eventPolarityThreshold: Rational;
  insiderWindowSessions: number;
  insiderWeights: {
    directorNet: Rational;
    holderNewOrIncrease: Rational;
    holderDecrease: Rational;
    /** AGT-136: weight of a net director sale; equals directorNet unless set (v1). */
    directorSale: Rational;
  };
  regime: RegimeParams;
  /** "HH:MM" Melbourne time of the decision cut-off. */
  decisionCutoff: string;
  thesisBreakersMin: number;
  thesisBreakersMax: number;
  thesisAmberFraction: Rational;
  /** D-096 #16: nights a keyword breaker waits for its confirmation before it reads green again. */
  tbKwConfirmSessions: number;
  arn011: Arn011Params;
  entry: EntryParams;
  specConstants: SpecConstantParams;
  cif: CifParams;
  progress: ProgressParams;
  stats: StatsParams;
  learning: LearningParams;
  picks: PicksParams;
  killswitch: KillswitchParams;
  replay: ReplayParams;
  llm: LlmParams;
  cortex: CortexParams;
};

// ---- building ----

/** Builds the typed parameters from one value per key (pure, no I/O). */
export function buildAgentParams(value: ConfigSource): AgentParams {
  const num = (k: ConfigKey): number => value(k) as number;
  const str = (k: ConfigKey): string => value(k) as string;
  const rat = (k: ConfigKey): Rational => ratFromNumber(num(k));
  const pct = (k: ConfigKey): Rational => ratFromPercent(num(k));
  const obj = (k: ConfigKey): Record<string, number> => value(k) as Record<string, number>;

  const regime = obj("regime_params");
  const weights = obj("insider_score_weights");
  const share = obj("llm_market_share");
  const list = (k: ConfigKey): number[] => value(k) as number[];
  const profiles = value("pick_profiles") as Record<
    string,
    { tiers: string[]; max_pct_per_pick: number; risk_pct_per_pick: number }
  >;
  const injection = value("llm_injection_phrases") as { version: string };
  const MICRO_PER_AUD = 1_000_000n; // threshold-ok: unit conversion A$ -> micro-AUD, not a rule

  return {
    windows: {
      atr: num("atr_period"),
      rsiShort: num("rsi_short_period"),
      rsiLong: num("rsi_long_period"),
      smaExit: num("sma_exit_period"),
      smaMid: num("sma_mid_period"),
      smaTrend: num("sma_trend_period"),
      returnWindow: num("return_window_sessions"),
      adv: num("adv_window_sessions"),
      volumeRatio: num("volume_ratio_window_sessions"),
      vol: num("vol_window_sessions"),
      regimeVolLookback: num("regime_vol_lookback_sessions"),
      regimeFall: num("regime_fall_window_sessions"),
      shortInterest: num("short_interest_window_sessions"),
      f4EventWindow: num("f4_event_window_sessions"),
      day0CloseOffsetMin: num("day0_close_offset_min"),
    },
    f1: {
      volumeRatioMin: rat("f1_volume_ratio_min"),
      rsTopFraction: rat("f1_rs_top_fraction"),
      initialStopAtr: rat("f1_initial_stop_atr"),
      trailAtr: rat("f1_trail_atr"),
      timeStop: num("f1_time_stop"),
      minGain: pct("f1_min_gain_pct"),
      maxHold: num("f1_max_hold"),
      highLookback: num("f1_high_lookback"),
      returnWindowSessions: num("f1_return_window_sessions"),
      momentumVariant: str("f1_momentum_variant") as F1Params["momentumVariant"],
      rankVariant: str("f1_rank_variant") as F1Params["rankVariant"],
    },
    f2: {
      eventArMin: pct("f2_event_ar_min_pct"),
      lookbackSessions: num("f2_lookback_sessions"),
      stopAtr: rat("f2_stop_atr"),
      timeStop: num("f2_time_stop"),
    },
    f3: {
      eventArMin: pct("f3_event_ar_min_pct"),
      volumeRatioMin: rat("f3_volume_ratio_min"),
      maxGap: pct("f3_max_gap_pct"),
      trailAfter: pct("f3_trail_after_pct"),
      trailAtr: rat("f3_trail_atr"),
      timeExit: num("f3_time_exit"),
      surpriseMode: str("f3_surprise_mode") as F3Params["surpriseMode"],
    },
    f4: {
      rsi2Max: num("f4_rsi2_max"),
      rsi14Max: num("f4_rsi14_max"),
      timeExit: num("f4_time_exit"),
      stopAtr: rat("f4_stop_atr"),
      entryVariant: str("f4_entry_variant") as F4Params["entryVariant"],
      rankVariant: str("f4_rank_variant") as F4Params["rankVariant"],
    },
    f5: {
      volumeRatioMin: rat("f5_volume_ratio_min"),
      arMin: pct("f5_ar_min_pct"),
      rangePosMin: rat("f5_range_pos_min"),
      stopAtr: rat("f5_stop_atr"),
      stopCap: pct("f5_stop_cap_pct"),
      trailAtr: rat("f5_trail_atr"),
      timeStop: num("f5_time_stop"),
      defaultUniverse: str("f5_default_universe") as F5Params["defaultUniverse"],
    },
    f6: {
      minClasses: num("f6_min_classes"),
      insiderMin: rat("f6_insider_min"),
      shortDropPp: rat("f6_short_drop_pp"),
      stopAtr: rat("f6_stop_atr"),
      timeStop: num("f6_time_stop"),
    },
    reentryBlock: num("reentry_block"),
    maxOpenPositions: num("max_open_positions"),
    eventPolarityThreshold: pct("event_polarity_threshold_pct"),
    insiderWindowSessions: num("insider_window_sessions"),
    insiderWeights: {
      directorNet: ratFromNumber(weights.director_net),
      holderNewOrIncrease: ratFromNumber(weights.holder_new_or_increase),
      holderDecrease: ratFromNumber(weights.holder_decrease),
      // AGT-136: absent = follows director_net (v1 behaviour).
      directorSale: ratFromNumber(weights.director_sale ?? weights.director_net),
    },
    regime: {
      smaSessions: regime.sma_sessions,
      volPctRiskOff: ratFromNumber(regime.vol_pct_riskoff),
      volPctShock: ratFromNumber(regime.vol_pct_shock),
      volPctRiskOn: ratFromNumber(regime.vol_pct_riskon),
      fall5: ratFromPercent(regime.fall5_pct),
      exitHysteresis: regime.exit_hysteresis,
    },
    decisionCutoff: str("decision_cutoff"),
    thesisBreakersMin: num("thesis_breakers_min"),
    thesisBreakersMax: num("thesis_breakers_max"),
    thesisAmberFraction: rat("thesis_amber_fraction"),
    tbKwConfirmSessions: num("tb_kw_confirm_sessions"),
    arn011: {
      gainSessions: num("arn011_gain_sessions"),
      gainMax: rat("arn011_gain_max"),
      oneDayGain: rat("arn011_one_day_gain"),
      volumeRatioMax: rat("arn011_volume_ratio_max"),
      placementWindow: num("arn011_placement_window"),
      placementsMax: num("arn011_placements_max"),
      raiseWindow: num("arn011_raise_window"),
      queryWindow: num("arn011_query_window"),
      consolidationWindow: num("arn011_consolidation_window"),
      rangeFraction: rat("arn011_range_fraction"),
      rangeDaysWindow: num("arn011_range_days_window"),
      rangeDaysMin: num("arn011_range_days_min"),
    },
    entry: {
      maxStopDistance: pct("max_stop_distance_pct"),
      costGateK: rat("cost_gate_k"),
      costGateMinRows: num("cost_gate_min_rows"),
      secondPositionMaxCorr: num("second_position_max_corr"),
      secondPositionCorrSessions: num("second_position_corr_sessions"),
      dedupWindowSessions: num("dedup_window_sessions"),
      dedupMinhashThreshold: num("dedup_minhash_threshold"),
      indexChangeWindowSessions: num("index_change_window_sessions"),
    },
    specConstants: {
      f5DryUpRatio: rat("f5_dry_up_ratio"),
      f5DryUpSessions: num("f5_dry_up_sessions"),
    },
    cif: { horizons: list("cif_horizons_sessions"), confidence: num("cif_confidence") },
    progress: {
      navEdgesPpm: list("progress_nav_edges_ppm"),
      sessionsEdges: list("progress_sessions_edges"),
    },
    learning: {
      maxChallengers: num("max_challengers"),
      maxPromotionsPerWeek: num("max_promotions_per_week"),
      shakedownSessions: num("shakedown_sessions"),
      criticLlmCallsPerNight: num("critic_llm_calls_per_night"),
      lessonL0MinN: num("lesson_L0_min_n"),
      lessonL1MinN: num("lesson_L1_min_n"),
      lessonBootstrapLevel: num("lesson_bootstrap_level"),
      l2AlphaW0: num("l2_alpha_w0"),
      l2AlphaPayout: num("l2_alpha_payout"),
      l2AlphaSpendFraction: num("l2_alpha_spend_fraction"),
      l2AlphaExhaustedLevel: num("l2_alpha_exhausted_level"),
      comparisonsFdrQ: num("comparisons_fdr_q"),
      comparisonLookAlpha: num("comparison_look_alpha"),
      comparisonLockoutSessions: num("comparison_lockout_sessions"),
      comparisonMinRows: num("comparison_min_rows"),
      playbookMaxTokens: num("playbook_max_tokens"),
      learningLoopMinutes: num("learning_loop_minutes"),
      challengerGeneratorPerWeek: num("challenger_generator_per_week"),
      kbArchiveTime: str("kb_archive_time"),
      classifierModel: str("llm_classifier_model"),
    },
    picks: {
      factorMinBucketN: num("factor_min_bucket_n"),
      factorBuckets: str("factor_buckets") as "terciles" | "quintiles",
      picksPerProfile: num("picks_per_profile"),
      picksMaxPerFamily: num("picks_max_per_family"),
      pickValidSessions: num("pick_valid_sessions"),
      pickSuccessMinN: num("pick_success_min_n"),
      profiles: Object.fromEntries(
        Object.keys(profiles)
          .sort()
          .map((n) => [
            n,
            {
              tiers: profiles[n].tiers,
              maxPctPerPick: profiles[n].max_pct_per_pick,
              riskPctPerPick: profiles[n].risk_pct_per_pick,
            },
          ]),
      ),
      portfolioAmounts: Object.fromEntries(
        Object.entries(obj("profile_portfolio_amount")).sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
    },
    stats: {
      alpha: num("alpha"),
      bootstrapReplicationsMin: num("bootstrap_replications_min"),
      bootstrapReplicationsFactor: num("bootstrap_replications_factor"),
      bootstrapSizeCheckReplications: num("bootstrap_size_check_replications"),
      bootstrapBlockMinSessions: num("bootstrap_block_min_sessions"),
      bootstrapBlockPercentile: num("bootstrap_block_percentile"),
      minBlocks: num("min_blocks"),
      minTrades: num("min_trades"),
      c2ControlsPerRow: num("c2_controls_per_row"),
      activeLineagesFloor: num("active_lineages_floor"),
      trialBudgetPerLineage: num("trial_budget_per_lineage"),
      splitHoldoutMinSessions: num("split_holdout_min_sessions"),
      splitValidationMinSessions: num("split_validation_min_sessions"),
      splitBlockMultiple: num("split_block_multiple"),
      splitDevelopmentMinSessions: num("split_development_min_sessions"),
      purgeExtraSessions: num("purge_extra_sessions"),
      survivorshipFlagShare: pct("survivorship_flag_share_pct"),
      survivorshipMinAnnouncements: num("survivorship_min_announcements"),
      survivorshipWindowSessions: num("survivorship_window_sessions"),
      usefulEdgeMin: pct("useful_edge_min_pct"),
      forwardAlphaTotal: num("forward_alpha_total"),
      forwardLookTrades: num("forward_look_trades"),
      forwardMinMonths: num("forward_min_months"),
      safetyCheckMinNeff: num("safety_check_min_neff"),
      deltaBustTolerance: rat("delta_bust_tolerance"),
      pboMax: num("pbo_max"),
      pboMinVariants: num("pbo_min_variants"),
      pboBlocks: num("pbo_blocks"),
      dsrMin: num("dsr_min"),
      minCohortsRanked: num("min_cohorts_ranked"),
      progressMinNeff: num("progress_min_neff"),
      scenarioMinN: num("scenario_min_n"),
      costFeasibilityRatio: rat("cost_feasibility_ratio"),
      stressCostProfile: str("stress_cost_profile"),
      stressSlippageExtraPct: num("stress_slippage_extra_pct"),
      barrierKUp: rat("barrier_k_up"),
      barrierKDown: rat("barrier_k_down"),
      barrierHorizonSessions: num("barrier_horizon_sessions"),
      eventCoverageMin: pct("event_coverage_min_pct"),
      codeReuseGapSessions: num("code_reuse_gap_sessions"),
      dsrDefaultSrVariance: num("dsr_default_sr_variance"),
      valErrorBudgetMode: str("val_error_budget_mode") as StatsParams["valErrorBudgetMode"],
      valFwerPerLineage: num("val_fwer_per_lineage"),
      settlementStatsMode: str("settlement_stats_mode") as StatsParams["settlementStatsMode"],
      minbtlTargetSharpe: num("minbtl_target_sharpe"),
      rankIcMinCodes: num("rank_ic_min_codes"),
      rankIcBootstrapReplicates: num("rank_ic_bootstrap_replicates"),
      rankIcBootstrapBlocks: str(
        "rank_ic_bootstrap_blocks",
      ) as StatsParams["rankIcBootstrapBlocks"],
    },
    killswitch: {
      tradesPerLook: num("killswitch_trades_per_look"),
      alphaTotal: num("killswitch_alpha_total"),
      criteria: num("killswitch_criteria"),
      maxLooksPerYear: num("killswitch_max_looks_per_year"),
      quietSessions: num("killswitch_quiet_sessions"),
    },
    replay: {
      rollingStartStep: num("rolling_start_step"),
      c2LivePerFamily: num("c2_live_per_family"),
      zeroEdgeTrials: num("zero_edge_trials"),
      zeroEdgeSeed: num("zero_edge_seed"),
      sleeveLeverage: num("sleeve_leverage"),
      realityCap: num("reality_cap"),
      lightMinutes: num("replay_light_minutes"),
      fullMinutes: num("replay_full_minutes"),
      nightlyMinutes: num("nightly_compute_minutes"),
      tursoRecentSessions: num("turso_recent_sessions"),
      eventBackfillYears: num("event_backfill_years"),
      ledgerNotionalMicro: BigInt(num("ledger_notional_aud")) * MICRO_PER_AUD,
    },
    cortex: {
      cellMinSetups: num("cell_min_setups"),
      cellMinBlocks: num("cell_min_blocks"),
      minNeffTrade: num("cortex_min_neff_trade"),
      rankShrinkN0: num("rank_shrink_n0"),
      maxLoss: pct("max_loss_pct"),
      entryGapCap: pct("entry_gap_cap_pct"),
      disagreementMax: num("cortex_disagreement_max"),
      clusterWeightMax: num("cluster_weight_max"),
      sectorTiltMarginPp: num("sector_tilt_margin_pp"),
      maxBooksSameCode: num("max_books_same_code"),
      maxBooksSameIndustry: num("max_books_same_industry"),
      maxCodeNavShare: rat("max_code_nav_share"),
      maxIndustryNavShare: rat("max_industry_nav_share"),
      freezeMaxLoss: pct("freeze_max_loss_pct"),
      unresolvedFreezeSessions: num("unresolved_freeze_sessions"),
      persistVolumeMult: num("persist_volume_mult"),
      pumpVolumeMult: num("pump_volume_mult"),
      pumpAr: pct("pump_ar_pct"),
      promotionFlagSessions: num("promotion_flag_sessions"),
      abstainAlarmSessions: num("abstain_alarm_sessions"),
      staleUniverseMaxShare: num("stale_universe_max_share"),
      opinionMinN: num("opinion_min_n"),
      ledgerFdrQ: num("ledger_fdr_q"),
      bootstrapBlockSessions: num("bootstrap_block_sessions"),
      slopeHideUb: num("cortex_slope_hide_ub"),
      stageMinutes: num("cortex_stage_minutes"),
      survivorshipHaircutPp: num("survivorship_haircut_pp"),
      suspensionMarkPolicy: str("suspension_mark_policy"),
    },
    llm: {
      roleDailyTokens: {
        R1: num("llm_budget_r1_daily"),
        R2: num("llm_budget_r2_daily"),
        R3: num("llm_budget_r3_daily"),
        R5: num("llm_budget_r5_daily"),
        R6: num("llm_budget_r6_steelman_daily"),
      },
      dailyTotal: num("llm_daily_budget_total"),
      nightlyTokensPerMarket: num("nightly_tokens_per_market"),
      marketShare: Object.fromEntries(
        Object.keys(share)
          .sort()
          .map((m) => [m, ratFromNumber(share[m])]),
      ),
      cacheTtlHours: num("llm_cache_ttl_hours"),
      r2MaterialityMin: num("r2_materiality_min"),
      injectionPhrases: injectionPhrasesOf(value("llm_injection_phrases")),
      injectionPhrasesVersion: injection.version,
    },
  };
}

/** The parameters at their registry defaults. */
export function defaultAgentParams(): AgentParams {
  return buildAgentParams((k) => CONFIG_KEYS[k].default);
}

/** Every registry key that buildAgentParams reads (so a caller can fetch exactly these). */
export function agentParamKeys(): ConfigKey[] {
  const seen = new Set<ConfigKey>();
  buildAgentParams((k) => {
    seen.add(k);
    return CONFIG_KEYS[k].default;
  });
  return [...seen].sort();
}

/**
 * Resolves the parameters from a value source (a config read). A missing or invalid value falls
 * back to the registry default; the source is read once per key, in key order.
 */
export async function resolveAgentParams(
  get: (key: ConfigKey) => Promise<unknown> | unknown,
): Promise<AgentParams> {
  const resolved = new Map<ConfigKey, unknown>();
  const effective = async (k: ConfigKey): Promise<unknown> => {
    if (resolved.has(k)) return resolved.get(k);
    let v: unknown;
    try {
      v = await get(k);
    } catch {
      v = undefined;
    }
    const ok = v !== undefined && (await CONFIG_KEYS[k].validate(v, effective)) === null;
    const out = ok ? v : CONFIG_KEYS[k].default;
    resolved.set(k, out);
    return out;
  };
  for (const k of agentParamKeys()) await effective(k);
  return buildAgentParams((k) => resolved.get(k) ?? CONFIG_KEYS[k].default);
}

/** Reads the parameters from the config store (global scope, optionally a market scope). */
export async function loadAgentParams(db: Client, scope = "global"): Promise<AgentParams> {
  const keys = agentParamKeys();
  const rows = (
    await db.execute({
      sql: `SELECT key, scope, value_json FROM config_version
            WHERE id IN (SELECT MAX(id) FROM config_version WHERE scope IN ('global', ?) GROUP BY key, scope)`,
      args: [scope],
    })
  ).rows;
  const byKey = new Map<string, unknown>();
  // Global rows first, then the market-scope rows, which win.
  for (const want of ["global", scope]) {
    for (const r of rows) {
      if (String(r.scope) === want) byKey.set(String(r.key), JSON.parse(String(r.value_json)));
    }
  }
  return resolveAgentParams((k) => (keys.includes(k) ? byKey.get(k) : undefined));
}

// ---- hashing (ARN-102: a replay records its parameter hash) ----

function plain(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.num === "bigint" && typeof o.den === "bigint") return `${o.num}/${o.den}`;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, plain(o[k])]),
    );
  }
  return v;
}

/** Key-sorted JSON of the parameters (rationals as "num/den", bigint as text). */
export function agentParamsJson(p: AgentParams): string {
  return JSON.stringify(plain(p));
}

/** SHA-256 of agentParamsJson, recorded with every replay run. */
export function agentParamsSha(p: AgentParams): string {
  return createHash("sha256").update(agentParamsJson(p)).digest("hex");
}

// ---- rule versions (M6 T8, D-110 #32 / #44, D-115) ----

const FAMILY_SLICE = { F1: "f1", F2: "f2", F3: "f3", F4: "f4", F5: "f5", F6: "f6" } as const;

/**
 * The parameters with one family's rule-version values laid over them. A rule version holds the
 * family's Lane-B keys (`params_json`, ch.15 section 15.3); only the slice of AgentParams those keys
 * feed is replaced: the family's own struct, `reentry_block`, the shared event polarity threshold
 * and, for F6, the insider weights and window. Every other parameter keeps the base value.
 */
export function paramsWithVersion(
  base: AgentParams,
  family: keyof typeof FAMILY_SLICE,
  versionParams: Readonly<Record<string, unknown>>,
): AgentParams {
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(versionParams, k);
  const built = buildAgentParams((k) => (has(k) ? versionParams[k] : CONFIG_KEYS[k].default));
  const slice = FAMILY_SLICE[family];
  const next: AgentParams = { ...base, [slice]: built[slice] };
  if (has("reentry_block")) next.reentryBlock = built.reentryBlock;
  if (has("event_polarity_threshold_pct")) {
    next.eventPolarityThreshold = built.eventPolarityThreshold;
  }
  if (family === "F6") {
    if (has("insider_score_weights")) next.insiderWeights = built.insiderWeights;
    if (has("insider_window_sessions")) next.insiderWindowSessions = built.insiderWindowSessions;
  }
  return next;
}
