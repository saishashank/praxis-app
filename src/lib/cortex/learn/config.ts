// Learning-loop configuration (cortex_learning_architecture C.9; D-929). Every level the pure cores use
// is here, pre-registered, with its bounds; an Owner edit inside the bounds is a charged trial that
// starts a new learner generation (CTX-072), an edit outside them is refused. The C.9 table is
// reproduced row by row; the rows marked "derived" are the few constants the design states in prose
// (B.2/B.4/C.3/C.5) and that this build made explicit so that no number lives inside the algorithms.
// Pure: no I/O.

export type LearnConfig = {
  /** C.9 learn_window_sessions: sessions in the weekly reweight window. */
  readonly windowSessions: number;
  /** C.9 learn_null_sessions: nights in the Page–Hinkley null calibration. */
  readonly nullSessions: number;
  /** C.9 learn_shrink_n0: prior strength (nights) of the shrunk IC. */
  readonly shrinkN0: number;
  /** C.9 learn_dev_haircut: prior mean = development IC × haircut (post-publication decay). */
  readonly devHaircut: number;
  /** C.9 learn_max_step: trust region, share of the way to the target per generation. */
  readonly maxStep: number;
  /** C.9 learn_weight_floor: weight floor × equal weight (1). */
  readonly weightFloor: number;
  /** C.9 learn_band_pp: rebalancing band, percentage points of weight (2 = 0.02). */
  readonly bandPp: number;
  /** C.9 learn_fdr_q: BH q of the weekly findings. */
  readonly fdrQ: number;
  /** C.9 learn_probe_q: BH q of a probe promotion (v1.1; carried for the probe builder). */
  readonly probeQ: number;
  /** C.9 learn_ph_delta: Page–Hinkley drift allowance per night. */
  readonly phDelta: number;
  /** C.9 learn_ph_fa_pct: percentile of the null statistic that sets the alarm level. */
  readonly phFaPct: number;
  /** C.9 learn_cap_sessions: checkpoint cap expiry. */
  readonly capSessions: number;
  /** C.9 learn_actions_week_max: checkpoint actions (watch / cap / rollback) per ISO week. */
  readonly actionsWeekMax: number;
  /** C.9 learn_switch_alpha: e ≥ 1/α to switch to the learner. */
  readonly switchAlpha: number;
  /** C.9 learn_fallback_alpha: e ≥ 1/α to fall back to the fixed rule. */
  readonly fallbackAlpha: number;
  /** C.9 learn_switch_min_nights: matured disagreement nights before a switch. */
  readonly switchMinNights: number;
  /** C.9 learn_cooldown_sessions: sessions after any leader change before a switch. */
  readonly cooldownSessions: number;
  /** C.9 learn_psi_break: PSI above which a night is a data break, not learning. */
  readonly psiBreak: number;
  /** C.9 learner_off: Owner kill (1 = shadow only, the learner may never lead). */
  readonly learnerOff: 0 | 1;
  // ---- derived (stated in the design's prose) ----
  /** C.3 / CTX-012 `cluster_weight_max`: largest share of the score one cluster may carry. */
  readonly clusterWeightMax: number;
  /** B.2 / SPIBB: fewest defined nights in the window before an angle's weight may be learned. */
  readonly minNights: number;
  /** B.2: expected block length (sessions) of the reweight bootstrap = the 20-session overlap. */
  readonly bootBlockSessions: number;
  /** B.4: expected block length of the Page–Hinkley null bootstrap on daily IC (one week). */
  readonly phBlockSessions: number;
  /** B.4: fewest nights of daily IC before Page–Hinkley may alarm (also the smallest null pool). */
  readonly phMinNights: number;
  /** B.4: latest nights left out of the Page–Hinkley null pool, so a fresh change cannot set its own level. */
  readonly phRecentNights: number;
  /** B.4 form rule: k of the last n nights below the angle's median. */
  readonly formK: number;
  readonly formN: number;
  /** B.4 data break: universe size vs its median, relative band. */
  readonly universeBand: number;
  /** C.5: normal-mixture scale τ of the mSPRT (per-trade sd); also the floor of the plug-in sd. */
  readonly duelTau: number;
  /** C.5: regimes with at least this many disagreement nights must not be negative. */
  readonly regimeMinNights: number;
  /** C.8: bootstrap replicates (stationaryBootstrap default). */
  readonly replicates: number;
};

export type LearnConfigKey = keyof LearnConfig;

export type LearnConfigSpec = {
  /** The §17.11-style key name (C.9) or, for a derived row, the key it would carry. */
  readonly key: string;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly source: "C.9" | "derived";
};

/** The defaults and bounds (C.9), one row per key (one line each, so every row carries its marker). */
// prettier-ignore
export const LEARN_CONFIG_SPEC: { readonly [K in LearnConfigKey]: LearnConfigSpec } = {
  windowSessions: { key: "learn_window_sessions", default: 60, min: 40, max: 120, source: "C.9" }, // threshold-ok: C.9 row
  nullSessions: { key: "learn_null_sessions", default: 120, min: 60, max: 250, source: "C.9" }, // threshold-ok: C.9 row
  shrinkN0: { key: "learn_shrink_n0", default: 60, min: 20, max: 200, source: "C.9" }, // threshold-ok: C.9 row
  devHaircut: { key: "learn_dev_haircut", default: 0.5, min: 0.3, max: 1, source: "C.9" }, // threshold-ok: C.9 row
  maxStep: { key: "learn_max_step", default: 0.25, min: 0.1, max: 0.5, source: "C.9" }, // threshold-ok: C.9 row
  weightFloor: { key: "learn_weight_floor", default: 0.25, min: 0, max: 0.5, source: "C.9" }, // threshold-ok: C.9 row
  bandPp: { key: "learn_band_pp", default: 2, min: 0, max: 5, source: "C.9" }, // threshold-ok: C.9 row
  fdrQ: { key: "learn_fdr_q", default: 0.1, min: 0.05, max: 0.2, source: "C.9" }, // threshold-ok: C.9 row
  probeQ: { key: "learn_probe_q", default: 0.05, min: 0.01, max: 0.1, source: "C.9" }, // threshold-ok: C.9 row
  phDelta: { key: "learn_ph_delta", default: 0.005, min: 0.001, max: 0.02, source: "C.9" }, // threshold-ok: C.9 row
  phFaPct: { key: "learn_ph_fa_pct", default: 99, min: 95, max: 99.9, source: "C.9" }, // threshold-ok: C.9 row
  capSessions: { key: "learn_cap_sessions", default: 10, min: 5, max: 20, source: "C.9" }, // threshold-ok: C.9 row
  actionsWeekMax: { key: "learn_actions_week_max", default: 3, min: 1, max: 6, source: "C.9" }, // threshold-ok: C.9 row
  switchAlpha: { key: "learn_switch_alpha", default: 0.05, min: 0.01, max: 0.1, source: "C.9" }, // threshold-ok: C.9 row
  fallbackAlpha: { key: "learn_fallback_alpha", default: 0.1, min: 0.05, max: 0.25, source: "C.9" }, // threshold-ok: C.9 row
  switchMinNights: { key: "learn_switch_min_nights", default: 40, min: 20, max: 100, source: "C.9" }, // threshold-ok: C.9 row
  cooldownSessions: { key: "learn_cooldown_sessions", default: 20, min: 10, max: 60, source: "C.9" }, // threshold-ok: C.9 row
  psiBreak: { key: "learn_psi_break", default: 0.25, min: 0.1, max: 0.5, source: "C.9" }, // threshold-ok: C.9 row
  learnerOff: { key: "learner_off", default: 0, min: 0, max: 1, source: "C.9" },
  clusterWeightMax: { key: "cluster_weight_max", default: 0.35, min: 0.2, max: 0.35, source: "derived" }, // threshold-ok: existing CTX-012 key and bounds
  minNights: { key: "learn_min_nights", default: 40, min: 20, max: 120, source: "derived" }, // threshold-ok: SPIBB n_min, two thirds of the window
  bootBlockSessions: { key: "learn_boot_block_sessions", default: 20, min: 5, max: 60, source: "derived" }, // threshold-ok: the 20-session return overlap
  phBlockSessions: { key: "learn_ph_block_sessions", default: 5, min: 1, max: 21, source: "derived" }, // threshold-ok: VAL-114 weekly block
  phMinNights: { key: "learn_ph_min_nights", default: 30, min: 20, max: 120, source: "derived" }, // threshold-ok: six weeks of daily IC
  phRecentNights: { key: "learn_ph_recent_nights", default: 20, min: 0, max: 60, source: "derived" }, // threshold-ok: the AT-5 detection horizon (four weeks)
  formK: { key: "learn_form_k", default: 8, min: 6, max: 10, source: "derived" }, // threshold-ok: B.4 "8 of the last 10"
  formN: { key: "learn_form_n", default: 10, min: 8, max: 20, source: "derived" }, // threshold-ok: B.4 "8 of the last 10"
  universeBand: { key: "learn_universe_band", default: 0.1, min: 0.05, max: 0.25, source: "derived" }, // threshold-ok: B.4 "± 10 %"
  duelTau: { key: "learn_duel_tau", default: 0.02, min: 0.005, max: 0.1, source: "derived" }, // threshold-ok: C.7 τ = 0.02 per-trade sd
  regimeMinNights: { key: "learn_regime_min_nights", default: 10, min: 5, max: 40, source: "derived" }, // threshold-ok: C.5 "≥ 10 disagreement nights"
  replicates: { key: "learn_replicates", default: 2000, min: 100, max: 10000, source: "derived" }, // threshold-ok: stationaryBootstrap DEFAULT_REPLICATES and sane bounds
};

function defaults(): LearnConfig {
  const out: Record<string, number> = {};
  for (const [k, spec] of Object.entries(LEARN_CONFIG_SPEC)) out[k] = spec.default;
  return out as LearnConfig;
}

/** The pre-registered defaults (C.9). */
export const LEARN_CONFIG: LearnConfig = Object.freeze(defaults());

/** Integer-valued keys (counts of sessions, nights, actions, replicates). */
const INTEGER_KEYS: ReadonlySet<LearnConfigKey> = new Set<LearnConfigKey>([
  "windowSessions",
  "nullSessions",
  "shrinkN0",
  "capSessions",
  "actionsWeekMax",
  "switchMinNights",
  "cooldownSessions",
  "learnerOff",
  "minNights",
  "bootBlockSessions",
  "phBlockSessions",
  "phMinNights",
  "phRecentNights",
  "formK",
  "formN",
  "regimeMinNights",
  "replicates",
]);

/** Keys whose bounds are for production; tests may pass a smaller replicate count (documented). */
const TEST_RELAXED: ReadonlySet<LearnConfigKey> = new Set<LearnConfigKey>(["replicates"]);

/**
 * The defaults with `overrides` applied; throws a RangeError naming the key when an override is not a
 * finite number inside its bounds (or not an integer where one is required), or when formK > formN.
 * `relaxed` lets tests lower `replicates` below its production floor (still ≥ 1).
 */
export function learnConfig(
  overrides: Partial<LearnConfig> = {},
  opts: { readonly relaxed?: boolean } = {},
): LearnConfig {
  const out: Record<string, number> = { ...defaults() };
  for (const [k, v] of Object.entries(overrides) as [LearnConfigKey, number | undefined][]) {
    if (v === undefined) continue;
    const spec = LEARN_CONFIG_SPEC[k];
    if (spec === undefined) throw new RangeError(`unknown learning key ${k}`);
    const min = opts.relaxed === true && TEST_RELAXED.has(k) ? 1 : spec.min;
    if (!Number.isFinite(v) || v < min || v > spec.max)
      throw new RangeError(`${spec.key} must be in [${min}, ${spec.max}]`);
    if (INTEGER_KEYS.has(k) && !Number.isInteger(v))
      throw new RangeError(`${spec.key} must be an integer`);
    out[k] = v;
  }
  if (out.formK! > out.formN!) throw new RangeError("learn_form_k must not exceed learn_form_n");
  return Object.freeze(out) as LearnConfig;
}
