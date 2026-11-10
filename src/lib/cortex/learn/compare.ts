// Champion / challenger duel (cortex_learning_architecture C.5, C.7 `compare.ts`; D-927).
//
//   matureComparisons  the paired top picks of the fixed and the learner rule on one decision night,
//                      written once the 20-session leg has matured (both legs' forward returns known).
//   duelDeltas         the paired Δ series over the nights the two rules disagreed (agree nights carry
//                      no information about which rule is better, so they do not enter the test); an
//                      abstention earns 0 (cash).
//   eProcess           a one-sided normal-mixture mSPRT e-value (Johari–Pekelis–Walsh; Robbins): with
//                      θ ~ half-normal(τ) on the side under test, Λ_n = 2·√(σ²/(σ²+nτ²))·exp(z²/2)·Φ(±z)
//                      where z² = n²τ²x̄² / (σ²(σ²+nτ²)) and the sign picks the side. Under H0 (no edge
//                      on that side) Λ is a non-negative supermartingale, so P(sup Λ ≥ 1/α) ≤ α however
//                      often it is peeked at (every checkpoint). σ² is the null's own estimate, the mean
//                      square of Δ about 0, floored at τ² (the pre-registered per-trade sd), so a short
//                      quiet series cannot fake evidence; the plain sample sd was anti-conservative in
//                      simulation (≈ 7–29 % false crossings at α = 5 %), the null estimate ≈ 1–2 %.
//                      lo90 is the matching anytime-valid lower confidence-sequence bound at α = 0.10.
//   leaderDecision     switch / fallback / stay (C.5): switch at e ≥ 1/α_switch with ≥ min matured
//                      disagreement nights, regimes ok and no leader change inside the cool-down; fall
//                      back at e ≥ 1/α_fb, immediately (protective: the cool-down never delays it); the
//                      Owner kill forces the fixed rule. Asymmetric levels + cool-down = hysteresis.
//
// Pure: plain rows in, numbers out; no randomness.
import { normalCdf } from "@/lib/stats/normal";
import type { LearnConfig } from "./config";
import type { CompareRow, Horizon, Leader } from "./types";

const PPM = 1_000_000; // threshold-ok: ppm to fraction
const CS_ALPHA = 0.1; // threshold-ok: 90 % confidence sequence
const HALF = 0.5; // threshold-ok: the ½ of the normal-mixture formula
const LOG_FLOOR = 1e-300; // threshold-ok: log(0) guard
const EXP_CAP = 700; // threshold-ok: exp overflow guard
const H20: Horizon = 20; // threshold-ok: the 20-session leg is the default duel series

/** One family-book's top picks on a decision night (fixed and learner rule). */
export type DuelPick = {
  readonly decisionD: string;
  readonly family: string;
  readonly bookId: string;
  readonly fixedRuleVersion: string;
  readonly learnerRuleVersion: string;
  readonly learnerGeneration: number;
  readonly fixedCode: string | null;
  readonly learnerCode: string | null;
  readonly regime: string;
};

export type ForwardReturns = {
  readonly ret1Ppm: number | null;
  readonly ret20Ppm: number | null;
};

/** The lookup key of a code's forward returns from a decision night. */
export function forwardKey(code: string, decisionD: string): string {
  return `${code}@${decisionD}`;
}

/**
 * Compare rows for the picks whose 20-session leg has matured tonight (`maturedD`): a pick is matured
 * when every non-null code has a known 20-session return. Sorted by (decisionD, family, bookId).
 */
export function matureComparisons(input: {
  readonly market: string;
  readonly maturedD: string;
  readonly picks: readonly DuelPick[];
  readonly forward: ReadonlyMap<string, ForwardReturns>;
}): CompareRow[] {
  const out: CompareRow[] = [];
  for (const p of input.picks) {
    const f = p.fixedCode === null ? null : input.forward.get(forwardKey(p.fixedCode, p.decisionD));
    const l =
      p.learnerCode === null ? null : input.forward.get(forwardKey(p.learnerCode, p.decisionD));
    if (p.fixedCode !== null && (f === undefined || f === null || f.ret20Ppm === null)) continue;
    if (p.learnerCode !== null && (l === undefined || l === null || l.ret20Ppm === null)) continue;
    out.push({
      market: input.market,
      decisionD: p.decisionD,
      family: p.family,
      bookId: p.bookId,
      fixedRuleVersion: p.fixedRuleVersion,
      learnerRuleVersion: p.learnerRuleVersion,
      learnerGeneration: p.learnerGeneration,
      fixedCode: p.fixedCode,
      learnerCode: p.learnerCode,
      agree: p.fixedCode === p.learnerCode ? 1 : 0,
      fixedRet1Ppm: f?.ret1Ppm ?? null,
      learnerRet1Ppm: l?.ret1Ppm ?? null,
      fixedRet20Ppm: f?.ret20Ppm ?? null,
      learnerRet20Ppm: l?.ret20Ppm ?? null,
      maturedD: input.maturedD,
      regime: p.regime,
    });
  }
  const key = (r: CompareRow) => `${r.decisionD}\u0000${r.family}\u0000${r.bookId}`;
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * Paired learner − fixed deltas (fractions) over the disagreement rows, in decision order. An abstained
 * side earns 0; a row whose picked side has no return for the horizon is skipped.
 */
export function duelDeltas(rows: readonly CompareRow[], horizon: Horizon = H20): number[] {
  const sorted = [...rows].sort((a, b) =>
    a.decisionD < b.decisionD ? -1 : a.decisionD > b.decisionD ? 1 : 0,
  );
  const out: number[] = [];
  for (const r of sorted) {
    if (r.agree === 1) continue;
    const fr = horizon === 1 ? r.fixedRet1Ppm : r.fixedRet20Ppm;
    const lr = horizon === 1 ? r.learnerRet1Ppm : r.learnerRet20Ppm;
    if ((r.fixedCode !== null && fr === null) || (r.learnerCode !== null && lr === null)) continue;
    const f = r.fixedCode === null ? 0 : fr! / PPM;
    const l = r.learnerCode === null ? 0 : lr! / PPM;
    out.push(l - f);
  }
  return out;
}

/** Per-regime disagreement count and mean Δ (C.5 "no regime with ≥ 10 nights negative"). */
export function regimeOk(rows: readonly CompareRow[], minNights: number, horizon: Horizon = H20) {
  const by = new Map<string, CompareRow[]>();
  for (const r of rows) {
    const list = by.get(r.regime) ?? [];
    list.push(r);
    by.set(r.regime, list);
  }
  for (const list of by.values()) {
    const d = duelDeltas(list, horizon);
    if (d.length >= minNights && d.reduce((s, x) => s + x, 0) < 0) return false;
  }
  return true;
}

export type EProcess = {
  /** The e-value (≥ 0; 1 = no evidence); "chance of luck about 1 in e". */
  readonly e: number;
  readonly n: number;
  readonly mean: number;
  /** Anytime-valid lower 90 % bound of the mean Δ (−Infinity when n = 0). */
  readonly lo90: number;
};

function sdOf(xs: readonly number[], m: number): number {
  if (xs.length < 2) return 0;
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/**
 * Normal-mixture mSPRT e-value that the mean of `deltas` is > 0 (`side` 'better': learner ahead) or
 * < 0 ('worse': learner behind), with mixture scale `tau`. See the header for the formula.
 */
export function eProcess(
  deltas: readonly number[],
  side: "better" | "worse",
  tau: number,
): EProcess {
  if (!(tau > 0)) throw new RangeError("tau must be > 0");
  const n = deltas.length;
  if (n === 0) return { e: 1, n: 0, mean: 0, lo90: -Infinity };
  const mean = deltas.reduce((s, x) => s + x, 0) / n;
  // σ² under the null (θ = 0): the mean square about 0, floored at τ² (D-note in the header).
  let sq = 0;
  for (const x of deltas) sq += x * x;
  const s2 = Math.max(sq / n, tau * tau);
  const v = s2 + n * tau * tau;
  const z = (n * tau * mean) / Math.sqrt(s2 * v);
  const signed = side === "better" ? z : -z;
  const logE =
    Math.log(2) +
    HALF * Math.log(s2 / v) +
    (z * z) / 2 +
    Math.log(Math.max(normalCdf(signed), LOG_FLOOR));
  const e = Math.exp(Math.min(logE, EXP_CAP));
  // Confidence sequence around the mean: σ² = sample variance about the mean, floored at τ².
  const c2 = Math.max(sdOf(deltas, mean) ** 2, tau * tau);
  const cv = c2 + n * tau * tau;
  const radius = Math.sqrt(
    ((2 * c2 * cv) / (n * n * tau * tau)) * (Math.log(1 / CS_ALPHA) + HALF * Math.log(cv / c2)),
  );
  return { e, n, mean, lo90: mean - radius };
}

export type LeaderDecision = "switch" | "fallback" | "stay";

/** C.5 leader rule; see the header. `sinceLastChange` null = the leader never changed. */
export function leaderDecision(input: {
  readonly leader: Leader;
  readonly eLearnerBetter: number;
  readonly eLearnerWorse: number;
  readonly disagreeNights: number;
  readonly regimeOk: boolean;
  readonly sinceLastChange: number | null;
  readonly config: LearnConfig;
  /** The learner's own CTX-053 verdict is not worse than the fixed rule's (default true). */
  readonly verdictOk?: boolean;
}): LeaderDecision {
  const { config } = input;
  if (input.leader === "learner") {
    if (config.learnerOff === 1) return "fallback";
    return input.eLearnerWorse >= 1 / config.fallbackAlpha ? "fallback" : "stay";
  }
  if (config.learnerOff === 1) return "stay";
  const cooled = input.sinceLastChange === null || input.sinceLastChange >= config.cooldownSessions;
  const ok =
    input.eLearnerBetter >= 1 / config.switchAlpha &&
    input.eLearnerWorse < 1 / config.fallbackAlpha &&
    input.disagreeNights >= config.switchMinNights &&
    input.regimeOk &&
    (input.verdictOk ?? true) &&
    cooled;
  return ok ? "switch" : "stay";
}
