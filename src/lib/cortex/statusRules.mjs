// CTX-053 / CTX-082 rules as plain data functions (M15 P6). No imports, so the Owner-run import
// script (scripts/cortex/import.mjs, plain node) and the typed facades status.ts / statements.ts share
// one implementation. A parity test pins `cellGate` to the C2 `economicGate`.
//
// CTX-053 "allowed to trade (weak test)": own n_eff >= cortex_min_neff_trade; one-sided 90 % lower
// bound of the Brier skill > 0; the CTX-021 gate passes on the pooled top-3 cell with regime stability.
// The calibration slope is a diagnostic with the over-confidence monitor (upper bound < hideUb hides p,
// D-300: an undefined slope hides p); it is NOT a permission condition. F7 is never allowed (CTX-054).
// D-305: A-D5-08 stays at most `measured` until 60 live sessions exist.

export const FAMILIES = ["F1", "F2", "F3", "F4", "F5", "F6", "F7"];
export const DEFAULT_MIN_NEFF_TRADE = 200;
export const MIN_NEFF_TRADE_BOUNDS = [150, 400];
export const DEFAULT_HIDE_UB = 1.0;
export const GATE_DEFAULTS = { cellMinSetups: 60, cellMinBlocks: 20, regimeMinSetups: 30 };
export const A_D5_08 = "A-D5-08";
export const A_D5_08_MIN_LIVE_SESSIONS = 60;
/** CTX-002: seven lineages, tested one-sided at 90 % (weak) and family-wise 0.05 (strict). */
export const LINEAGES = 7;
export const WEAK_LEVEL = 0.1;
export const STRICT_LEVEL = 0.05;
export const LIVE_TESTED_MIN_NEFF = 150;
export const LIVE_PENDING_LABEL = "live-tested pending (n_eff_live = 0)";
export const PROJECTION_TARGETS = [100, 150];

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** CTX-021 on one pooled cell for one regime; mirrors stats/cells.ts `economicGate`. */
export function cellGate(cell, regime, opts = {}) {
  const minSetups = opts.cellMinSetups ?? GATE_DEFAULTS.cellMinSetups;
  const minBlocks = opts.cellMinBlocks ?? GATE_DEFAULTS.cellMinBlocks;
  const regimeMin = opts.regimeMinSetups ?? GATE_DEFAULTS.regimeMinSetups;
  if (cell.n < minSetups) return { pass: false, reason: "not_enough_history" };
  if (!isNum(cell.nEff) || !isNum(cell.lower90))
    return { pass: false, reason: "not_enough_history" };
  if (cell.blocks < minBlocks) return { pass: false, reason: "not_enough_history" };
  if (!(cell.lower90 > 0)) return { pass: false, reason: "bound_not_positive" };
  const r = cell.byRegime?.[regime];
  if (!r || r.n < regimeMin || !(r.meanNet >= 0)) return { pass: false, reason: "regime_blocked" };
  return { pass: true };
}

/**
 * Regime stability: every regime that holds at least `regimeMinSetups` setups of the cell passes the
 * gate (non-negative mean net), and at least one such regime exists.
 */
export function regimeStable(cell, opts = {}) {
  const regimeMin = opts.regimeMinSetups ?? GATE_DEFAULTS.regimeMinSetups;
  const regimes = Object.keys(cell.byRegime ?? {})
    .filter((k) => cell.byRegime[k].n >= regimeMin)
    .sort();
  const perRegime = regimes.map((r) => ({ regime: r, ...cellGate(cell, r, opts) }));
  const stable = perRegime.length > 0 && perRegime.every((x) => x.pass);
  return { stable, perRegime };
}

/** The over-confidence monitor (D-300): p is hidden when the slope's 90 % upper bound is < hideUb or undefined. */
export function slopeHiddenFromUb(ub, hideUb = DEFAULT_HIDE_UB) {
  return !isNum(ub) || ub < hideUb;
}

/**
 * The CTX-053 verdict. `cell` is the pre-registered pooled top-3 cell statistic (or null).
 * `status` is `allowed` or `shadow`; `failed` lists the reasons (empty when allowed).
 */
export function decideFamily(input) {
  const minNEff = input.minNEff ?? DEFAULT_MIN_NEFF_TRADE;
  const failed = [];
  if (input.family === "F7") failed.push("f7_never_allowed");
  const nEff = isNum(input.nEff) ? input.nEff : null;
  if (nEff === null || nEff < minNEff) failed.push("calibration_untestable");
  if (!isNum(input.brierLo90) || !(input.brierLo90 > 0)) failed.push("brier_skill_not_positive");
  let gate = null;
  if (!input.cell) {
    failed.push("economic_gate:not_enough_history");
  } else {
    const rs = regimeStable(input.cell, input.gateOpts);
    gate = { stable: rs.stable, regimes: rs.perRegime };
    if (!rs.stable) {
      // History / bound failures do not depend on the regime; take them first.
      const any = cellGate(input.cell, rs.perRegime[0]?.regime ?? "", input.gateOpts);
      const reason = any.pass || any.reason === "regime_blocked" ? "regime_blocked" : any.reason;
      failed.push(`economic_gate:${reason}`);
    }
  }
  const pHidden = slopeHiddenFromUb(input.slopeUb90, input.hideUb);
  return {
    family: input.family,
    status: failed.length === 0 ? "allowed" : "shadow",
    allowed: failed.length === 0,
    failed,
    pHidden,
    evidence: {
      n_eff: nEff,
      min_neff_trade: minNEff,
      brier_skill_lo90: isNum(input.brierLo90) ? input.brierLo90 : null,
      slope_ub90: isNum(input.slopeUb90) ? input.slopeUb90 : null,
      p_hidden: pHidden,
      gate,
      failed,
    },
  };
}

const RANK = { candidate: 0, measured: 1, watch: 1, active: 2, retired: -1 };

/** D-305: A-D5-08 is `measured` at most until 60 live sessions exist. Returns the status allowed. */
export function capAngleStatus(angleId, requested, liveSessions) {
  if (
    angleId === A_D5_08 &&
    liveSessions < A_D5_08_MIN_LIVE_SESSIONS &&
    (RANK[requested] ?? 0) > 1
  ) {
    return "measured";
  }
  return requested;
}

/** Chance that at least one of `lineages` independent tests at one-sided `level` passes by luck. */
export function luckChance(lineages = LINEAGES, level = WEAK_LEVEL) {
  return 1 - (1 - level) ** lineages;
}

/** D-277 / D-358: (ledger cells + Owner key edits) x ledger_fdr_q, "Of N ideas tried, about X ...". */
export function luckFigure(ledgerCells, keyEdits = 0, q = 0.1) {
  const trials = ledgerCells + keyEdits;
  const expected = trials * q;
  const shown = expected >= 10 ? String(Math.round(expected)) : expected.toFixed(1);
  return {
    trials,
    expected,
    text: `Of ${trials} ideas tried, about ${shown} would look good by luck alone.`,
  };
}

/** Sessions until the live n_eff reaches `target` at `perSession` (null when the pace is unknown). */
export function projectSessions(target, nEffLive, perSession) {
  if (!isNum(perSession) || perSession <= 0) return null;
  return Math.max(0, Math.ceil((target - nEffLive) / perSession));
}

const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const num = (v, d = 2) => v.toFixed(d);
const ci = (c, f) => `${f(c.lo)} to ${f(c.hi)}`;

function projectionSentence(perSession) {
  const s100 = projectSessions(100, 0, perSession);
  const s150 = projectSessions(150, 0, perSession);
  if (s100 === null || s150 === null) {
    return "The pace of live cases has not been measured yet, so no time to 100 or 150 comparable live cases can be given.";
  }
  return (
    `At the pace seen so far it needs about ${s100} sessions (roughly ${Math.ceil(s100 / 5)} weeks) to reach 100 ` +
    `comparable live cases and about ${s150} sessions (roughly ${Math.ceil(s150 / 5)} weeks) to reach 150.`
  );
}

/** CTX-053 statement (allowed to trade, weak test) marked live-tested pending. Plain words. */
export function allowedWeakStatement(input) {
  const chance = pct(luckChance(), 0);
  const text =
    `${input.family} is allowed to trade (weak test). On past data and shadow sessions its forecasts ` +
    `beat the base rate and its picks earned more than they cost. This is a frequency test of the past, ` +
    `not a promise about any single trade. Status: ${LIVE_PENDING_LABEL}. ${projectionSentence(input.nEffLivePerSession)} ` +
    `With seven families each tested at 90%, the chance that at least one is allowed to trade by luck alone is about ${chance}.`;
  return {
    kind: "allowed_weak",
    text,
    nEffLive: 0,
    numbers: {
      n_eff_live: 0,
      sessions_to_100: projectSessions(100, 0, input.nEffLivePerSession),
      sessions_to_150: projectSessions(150, 0, input.nEffLivePerSession),
      luck_chance_weak: luckChance(),
    },
  };
}

/**
 * CTX-082 live-tested statement (strict test). Not publishable until n_eff_live >= 150 and the four
 * criteria hold: Brier-skill lower bound > 0, slope CI covers 1, intercept CI covers 0, net-excess
 * lower bound > 0. ECE is reported with its CI, never a criterion.
 * `m` = { family, fromD, nCases, nEffLive, ece, slope, intercept, skill, excess, survivorship };
 * each interval has point, lo, hi.
 */
export function liveTestedStatement(m) {
  const criteria = {
    n_eff_live: m.nEffLive >= LIVE_TESTED_MIN_NEFF,
    brier_skill_lo_positive: m.skill.lo > 0,
    slope_covers_1: m.slope.lo <= 1 && m.slope.hi >= 1,
    intercept_covers_0: m.intercept.lo <= 0 && m.intercept.hi >= 0,
    net_excess_lo_positive: m.excess.lo > 0,
  };
  const publishable = Object.values(criteria).every(Boolean);
  const text =
    `On the live paper period from ${m.fromD} (${m.nCases} comparable cases), this family's forecasts were ` +
    `accurate to within ${pct(m.ece.point)} (slope ${num(m.slope.point)}, CI ${ci(m.slope, num)}; ` +
    `calibration error CI ${ci(m.ece, pct)}), its skill over the base rate was ${num(m.skill.point)} ` +
    `(CI ${ci(m.skill, num)}), and its net result over matched random picks after costs was ` +
    `${pct(m.excess.point)} (CI ${ci(m.excess, pct)}), with ${m.survivorship}. ` +
    `These are past frequencies; they do not predict any single trade.`;
  return {
    kind: "live_tested",
    family: m.family,
    publishable,
    criteria,
    text,
    nEffLive: m.nEffLive,
    numbers: {
      n_eff_live: m.nEffLive,
      n_cases: m.nCases,
      from_d: m.fromD,
      ece: m.ece,
      slope: m.slope,
      intercept: m.intercept,
      brier_skill: m.skill,
      net_excess: m.excess,
      luck_chance_strict: luckChance(LINEAGES, STRICT_LEVEL),
    },
  };
}
