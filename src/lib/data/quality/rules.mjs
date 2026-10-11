// Data quality rules (M2 T7): pure evaluators for DAT-200 (per-bar checks), DAT-201 (score) and
// DAT-210 (entry blocking, the U1 gate). Plain ESM + JSDoc so the Actions CLI runs it without a TS
// build, like ../pipeline/rules.mjs. No database, no clock, no network: every function is a pure
// function of its arguments. Synthetic data only in tests (SEC-110).
//
// Verbatim quotes (grep -n; spec/ and docs/M2_design.md):
//
// spec/06_data_layer.md:86 DAT-200:
//   "Per-bar checks: high ≥ max(open, close); low ≤ min(open, close); prices > 0; volume ≥ 0;
//   trading day; no duplicate; |close-to-close move| > 40% without a corporate action or
//   price-sensitive announcement → suspect; zero volume on a non-halted U1 code → suspect;
//   identical OHLCV to the previous day → suspect; first-seen vs re-fetch difference > 0.1% →
//   suspect."
// spec/06_data_layer.md:87 DAT-201:
//   "Quality score per market-day = valid expected bars ÷ expected bars, reported for U1, U2, U3,
//   plus counts of suspect, missing, cross-source disagreements and unresolved corporate actions."
// spec/06_data_layer.md:88 DAT-210:
//   "Suspect/missing bars block new entries on those codes (exits still process, flagged). If U1
//   score < 95% the market makes **no new entries** that night (open positions still marked; exits
//   processed); the review says why. Two consecutive failing nights → incident (EML-021)."
// spec/06_data_layer.md:89 DAT-211:
//   "Every check is stored and summarised on System Health and in review section 9."
// spec/06_data_layer.md:12 DAT-004:
//   "Fail visible. Missing/suspect inputs create a quality record and block affected decisions
//   (DAT-210); never silently filled."
// spec/06_data_layer.md:10 DAT-002 (the re-fetch is "a flag only"):
//   "a difference > 0.1% on any field flags the bar and every decision made on it (...) — a flag
//   only, since the resulting order has already been placed."
// spec/06_data_layer.md:47 DAT-102 (needs two sources; one source in M2, so the count is 0):
//   "U1 closes are cross-checked daily when two sources exist; disagreement > 0.5% flags the bar
//   and blocks new entries until resolved."
// spec/06_data_layer.md:127 DAT-127 (Yahoo off):
//   "no new bars → DAT-210 blocks all new entries; open positions are marked at the last price and
//   flagged; exits resume when data returns."
// spec/06_data_layer.md:129 and :131 (acceptance, chapter 06):
//   "**Given** a re-fetch differing by 0.3% from the first-seen bar, **then** the bar and decisions
//   made on it are flagged (DAT-002)."
//   "**Given** U1 quality 93%, **then** no new entries, exits processed, review explains (DAT-210)."
// spec/14_system_acceptance.md:20 AT-07 (no golden numbers beyond these):
//   "| AT-07 | Quality gates | Injected bad bars (high<close, zero price, 60% unexplained jump) are
//   flagged; U1 score < 95% blocks new entries but not exits | DAT-200, DAT-210 |"
// spec/15_configuration_reference.md:132-134 (ch.15 keys, percent units, all Owner-editable):
//   "| refetch_diff_flag | 0.1% | O | DAT-002 |"
//   "| suspect_move | 40% | O | DAT-200 |"
//   "| u1_quality_gate | 95% | O | DAT-210 |"
//   Ch.15 gives no bounds; keys.ts uses 0.01-5, 10-90 and 50-100 (spec gap; decision D-063 proposed in the T7 report).
// docs/M2_design.md:43 (flag table), :153 decision 5 and :154 decision 6:
//   "180 days, except flags that blocked a decision, which are kept forever."
//   "one NULL→value update allowed by trigger; everything else append-only."
// U1 gate definition (DAT-210 + DAT-201): the U1 score of a market-day is valid U1 expected bars ÷
// U1 expected bars; the gate FAILS when that is below u1_quality_gate (so exactly 95% passes).
//
// There are no DAT-202..209 rules in the spec: the rules are DAT-200, DAT-201, DAT-210, DAT-211.
//
// Choices made where the spec is silent (proposed D-063, for the architect to record):
// - Which rules block new entries: every DAT-200 per-bar check except the re-fetch difference (the
//   spec calls them all "suspect" and DAT-210 blocks suspect bars; DAT-002 says a re-fetch
//   difference is "a flag only"), a missing bar (DAT-210), and the U1 gate (market-wide). Exits are
//   never blocked: `exitsAllowed()` in gate.ts is always true.
// - A "valid" bar is a stored bar with no entry-blocking flag. A code with a rejected row (bad
//   bar) has no stored bar and counts as missing.
// - An empty U1 tier (the universe has no U1 codes yet) scores 100 % and passes, with `empty: true`
//   recorded; the tier ranking arrives with the universe work (T9/T10).
// - The corporate-action / price-sensitive-announcement exemption covers the window from the
//   previous session's date to the bar date, both ends included.

export const DEFAULT_SUSPECT_MOVE_PCT = 40;
export const DEFAULT_U1_GATE_PCT = 95;
export const DEFAULT_REFETCH_DIFF_PCT = 0.1;
/** Scores are stored as fractions (0..1); the gate compares in percent. */
export const TIERS = ["U1", "U2", "U3"];

/**
 * The rule catalogue. `blocks` = blocks new entries on the code (or on the whole market for the
 * gate). `reevaluated` = recomputed from the stored bar on a re-run (can clear when it no longer
 * applies); the re-fetch difference is a fact about the past and is never cleared.
 */
export const RULES = {
  ohlc_inconsistent: { id: "DAT-200:ohlc_inconsistent", severity: "error", blocks: true },
  price_not_positive: { id: "DAT-200:price_not_positive", severity: "error", blocks: true },
  volume_negative: { id: "DAT-200:volume_negative", severity: "error", blocks: true },
  not_trading_day: { id: "DAT-200:not_trading_day", severity: "error", blocks: true },
  duplicate_bar: { id: "DAT-200:duplicate_bar", severity: "error", blocks: true },
  suspect_move: { id: "DAT-200:suspect_move", severity: "warning", blocks: true },
  zero_volume_u1: { id: "DAT-200:zero_volume_u1", severity: "warning", blocks: true },
  identical_ohlcv: { id: "DAT-200:identical_ohlcv", severity: "warning", blocks: true },
  refetch_diff: { id: "DAT-200:refetch_diff", severity: "warning", blocks: false },
  missing_bar: { id: "DAT-210:missing_bar", severity: "error", blocks: true },
  u1_gate: { id: "DAT-210:u1_gate", severity: "critical", blocks: true },
};
export const RULE_IDS = Object.values(RULES).map((r) => r.id);
/** Flags a re-run may clear. The re-fetch flag belongs to the previous date and is kept. */
export const REEVALUATED_IDS = RULE_IDS.filter((id) => id !== RULES.refetch_diff.id);

/** Map a bars.json reject reason (../pipeline/rules.mjs validateBar) to the DAT-200 rule. */
export const REJECT_RULE = {
  ohlc_inconsistent: RULES.ohlc_inconsistent,
  non_positive_price: RULES.price_not_positive,
  bad_volume: RULES.volume_negative,
  duplicate_key: RULES.duplicate_bar,
};

/**
 * @typedef {{ rule: string, severity: string, blocks_entries: boolean, detail: Record<string, unknown> }} Finding
 * @typedef {{ o: number, h: number, l: number, c: number, volume: number }} Bar
 */

const flag = (r, detail) => ({
  rule: r.id,
  severity: r.severity,
  blocks_entries: r.blocks,
  detail,
});

const round = (n) => Math.round(n * 1e6) / 1e6;

/** @param {Bar} a @param {Bar} b */
const sameOhlcv = (a, b) =>
  a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.volume === b.volume;

/**
 * DAT-200 per-bar checks for one stored bar.
 * @param {{
 *   bar: Bar,
 *   prev?: Bar | null,
 *   tradingDay?: boolean,
 *   tier?: string,
 *   halted?: boolean,
 *   explained?: boolean,
 *   suspectMovePct?: number,
 * }} i `explained` = a corporate action or price-sensitive announcement covers the move.
 * @returns {Finding[]}
 */
export function evaluateBar(i) {
  const { bar, prev = null } = i;
  const out = [];
  if (i.tradingDay === false) out.push(flag(RULES.not_trading_day, {}));
  if (bar.o <= 0 || bar.h <= 0 || bar.l <= 0 || bar.c <= 0) {
    out.push(flag(RULES.price_not_positive, {}));
  }
  if (bar.volume < 0) out.push(flag(RULES.volume_negative, {}));
  if (bar.h < Math.max(bar.o, bar.c) || bar.l > Math.min(bar.o, bar.c)) {
    out.push(flag(RULES.ohlc_inconsistent, {}));
  }
  if (prev && prev.c > 0) {
    const limit = i.suspectMovePct ?? DEFAULT_SUSPECT_MOVE_PCT;
    const movePct = (Math.abs(bar.c - prev.c) / prev.c) * 100;
    if (movePct > limit && !i.explained) {
      out.push(flag(RULES.suspect_move, { move_pct: round(movePct), limit_pct: limit }));
    }
  }
  if (bar.volume === 0 && i.tier === "U1" && i.halted !== true) {
    out.push(flag(RULES.zero_volume_u1, {}));
  }
  if (prev && sameOhlcv(bar, prev)) out.push(flag(RULES.identical_ohlcv, {}));
  return out;
}

/**
 * DAT-002 / DAT-200: a re-fetched bar differing by more than the threshold on any field. A flag
 * only: it never blocks entries.
 * @param {number} maxDiffPct @param {number} [thresholdPct]
 * @returns {Finding[]}
 */
export function evaluateRefetch(maxDiffPct, thresholdPct = DEFAULT_REFETCH_DIFF_PCT) {
  return maxDiffPct > thresholdPct
    ? [flag(RULES.refetch_diff, { max_diff_pct: round(maxDiffPct), limit_pct: thresholdPct })]
    : [];
}

/**
 * DAT-210 / DAT-004: an expected bar that is absent (never silently filled).
 * @param {{ rejectReasons?: string[] }} [i] reasons the code's rows were rejected, if any
 * @returns {Finding[]}
 */
export function evaluateMissing(i = {}) {
  const reasons = [...new Set(i.rejectReasons ?? [])].sort();
  return [flag(RULES.missing_bar, reasons.length ? { rejected: reasons } : {})];
}

/**
 * Findings for rejected rows of a code that DO have a stored bar (a duplicate row is the case:
 * the first row wins, the second is a duplicate). Rows of a code with no stored bar are reported by
 * `evaluateMissing`, with their DAT-200 rule as additional findings here.
 * @param {string[]} reasons
 * @returns {Finding[]}
 */
export function evaluateRejects(reasons) {
  const seen = new Set();
  const out = [];
  for (const reason of reasons) {
    const rule = REJECT_RULE[reason];
    if (!rule || seen.has(rule.id)) continue;
    seen.add(rule.id);
    out.push(flag(rule, { reason }));
  }
  return out;
}

/**
 * DAT-201 score for one tier. `invalid` is the count of expected codes with no valid bar.
 * @param {number} expected @param {number} valid
 */
export function tierScore(expected, valid) {
  if (expected <= 0) return { expected: 0, valid: 0, score: 1, empty: true };
  return { expected, valid, score: round(valid / expected), empty: false };
}

/**
 * DAT-210 U1 gate: fails when valid / expected is below the gate, in exact integer arithmetic so
 * that exactly 95% passes.
 * @param {{ expected: number, valid: number }} u1 @param {number} [gatePct]
 */
export function gateFails(u1, gatePct = DEFAULT_U1_GATE_PCT) {
  if (u1.expected <= 0) return false; // empty tier: nothing to fail (see header)
  return u1.valid * 100 < gatePct * u1.expected;
}

/**
 * Whole-day evaluation: scores per tier, the gate verdict and (when it fails) the market-wide flag.
 * @param {{
 *   expected: { code: string, tier: string }[],
 *   invalid: ReadonlySet<string>,   codes with no valid bar (missing or entry-blocking flag)
 *   gatePct?: number,
 * }} i
 */
export function scoreDay(i) {
  /** @type {Record<string, { expected: number, valid: number, score: number, empty: boolean, gate_pass: boolean }>} */
  const tiers = {};
  for (const t of TIERS) {
    const codes = i.expected.filter((e) => e.tier === t);
    const valid = codes.filter((e) => !i.invalid.has(e.code)).length;
    tiers[t] = { ...tierScore(codes.length, valid), gate_pass: true };
  }
  const failed = gateFails(tiers.U1, i.gatePct);
  // Only U1 carries a gate (DAT-210); U2/U3 are reported.
  tiers.U1.gate_pass = !failed;
  return { tiers, gateFailed: failed };
}

/** The market-wide gate flag (code = null). */
export function gateFinding(u1, gatePct = DEFAULT_U1_GATE_PCT) {
  return flag(RULES.u1_gate, {
    score_pct: round((u1.valid / u1.expected) * 100),
    valid: u1.valid,
    expected: u1.expected,
    gate_pct: gatePct,
  });
}

/**
 * Validate a stored percent config value; absent or out of bounds falls back to the default
 * (same pattern as throttleFrom). Bounds mirror src/lib/config/keys.ts (parity test).
 * @param {unknown} raw @param {number} def @param {[number, number]} bounds
 */
export function boundedPct(raw, def, [lo, hi]) {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= lo && raw <= hi ? raw : def;
}

export const PCT_BOUNDS = {
  refetch_diff_flag: /** @type {[number, number]} */ ([0.01, 5]),
  suspect_move: /** @type {[number, number]} */ ([10, 90]),
  u1_quality_gate: /** @type {[number, number]} */ ([50, 100]),
};

/** @param {{ refetch_diff_flag?: unknown, suspect_move?: unknown, u1_quality_gate?: unknown }} raw */
export function qualityConfigFrom(raw) {
  return {
    refetchDiffPct: boundedPct(
      raw.refetch_diff_flag,
      DEFAULT_REFETCH_DIFF_PCT,
      PCT_BOUNDS.refetch_diff_flag,
    ),
    suspectMovePct: boundedPct(raw.suspect_move, DEFAULT_SUSPECT_MOVE_PCT, PCT_BOUNDS.suspect_move),
    u1GatePct: boundedPct(raw.u1_quality_gate, DEFAULT_U1_GATE_PCT, PCT_BOUNDS.u1_quality_gate),
  };
}
