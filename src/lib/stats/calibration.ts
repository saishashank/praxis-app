// Calibration statistics (M15 C2; spec ch. 17 CTX-012 "Map", CTX-053, CTX-082, AT-51).
//
//   plattFit            p = logistic(a·S* + b) by Platt scaling (Newton on the log-loss with Platt's
//                       smoothed targets t+ = (N+ + 1)/(N+ + 2), t− = 1/(N− + 2)) on S* standardised
//                       within the family (`standardise`).
//   plattFitPooled      one slope across the families of a pool group ({F1, F4}, {F2, F3, F5, F6}, F7
//                       alone), own intercept per family (≥ 60 outcomes each), pool n_eff ≥ 100.
//   brierSkill          BSS = 1 − BS / BS_ref with BS_ref = ȳ(1 − ȳ) (climatology); `brierSkillCi` gives
//                       the one-sided 90 % lower bound the permission test reads (CTX-053).
//   calibrationSlope    logistic regression of y on logit(p): slope and intercept with intervals (Cox
//                       1958); slope 1 and intercept 0 = calibrated. The over-confidence monitor hides p
//                       when the one-sided 90 % upper bound of the slope is below `cortex_slope_hide_ub`.
//   ece                 expected calibration error on equal-width bins, with an interval. Reported only:
//                       no gate reads it (AT-51; a static check over gates/** enforces this).
//
// Every interval comes from `bootstrapCi` (stationaryBootstrap.ts) with the statistic's influence values,
// so n_eff is per statistic (OI-15). Pure; all randomness through the `Prng` argument.
import { mean } from "./bootstrap";
import type { Prng } from "./rng";
import {
  type BlockLayout,
  type BootCi,
  type BootstrapOptions,
  bootstrapCi,
  bootstrapCiMany,
  effectiveN,
  isUndefined,
  type StatUndefined,
} from "./stationaryBootstrap";

/** Own outcomes a family needs before it gets its own intercept (CTX-012 "Map"). */
export const PLATT_MIN_OUTCOMES = 60;
/** The pool's n_eff floor before its slope may be shared (CTX-012 "Map"). */
export const PLATT_POOL_MIN_NEFF = 100;
/** Isotonic calibration is allowed only from this n_eff; below it Platt is the map (CTX-012). */
export const ISOTONIC_MIN_NEFF = 1000;
/** Slope-pool groups: slope shared within a group, intercept per family (CTX-012 "Map"). */
export const PLATT_POOL_GROUPS: readonly (readonly string[])[] = [
  ["F1", "F4"],
  ["F2", "F3", "F5", "F6"],
  ["F7"],
];
/** Default `cortex_slope_hide_ub` (D-257): p is hidden when the slope's upper bound is below it. */
export const DEFAULT_SLOPE_HIDE_UB = 1.0;
export const ECE_BINS = 10;

const NEWTON_MAX_ITER = 50;
const NEWTON_TOL = 1e-10;
const P_CLIP = 1e-6;

export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function logit(p: number): number {
  const q = Math.min(1 - P_CLIP, Math.max(P_CLIP, p));
  return Math.log(q / (1 - q));
}

/** The pool group of a family, or the family alone when it is in no group. */
export function plattPoolGroup(family: string): readonly string[] {
  return PLATT_POOL_GROUPS.find((g) => g.includes(family)) ?? [family];
}

/**
 * Solve A·x = b for a small dense system by Gauss–Jordan elimination with partial pivoting.
 * Returns null when the matrix is singular (pivot below `eps`).
 */
export function solveLinear(
  A: readonly (readonly number[])[],
  b: readonly number[],
  eps = 1e-12,
): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    if (Math.abs(M[piv]![c]!) < eps) return null;
    if (piv !== c) {
      const t = M[c]!;
      M[c] = M[piv]!;
      M[piv] = t;
    }
    const p = M[c]![c]!;
    for (let k = c; k <= n; k += 1) M[c]![k]! /= p;
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r]![c]!;
      if (f === 0) continue;
      for (let k = c; k <= n; k += 1) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row) => row[n]!);
}

export type LogisticFit = {
  readonly coef: readonly number[];
  /** Inverse of the observed information X'WX at the solution (for influence values). */
  readonly covariance: readonly (readonly number[])[];
  readonly iterations: number;
  readonly converged: boolean;
};

/** Coefficient magnitude beyond which a logistic fit is treated as (quasi-)separated (D-300). */
export const SEPARATION_COEF_LIMIT = 50;
const STEP_HALVINGS = 30;

/** Weighted log-likelihood Σ w (t log p + (1 − t) log(1 − p)) at `coef`. */
function logLikelihood(
  X: readonly (readonly number[])[],
  t: readonly number[],
  weights: readonly number[] | undefined,
  coef: readonly number[],
): number {
  let ll = 0;
  for (let i = 0; i < X.length; i += 1) {
    const x = X[i]!;
    let eta = 0;
    for (let j = 0; j < coef.length; j += 1) eta += coef[j]! * x[j]!;
    // log p = −log(1 + e^−η), log(1 − p) = −log(1 + e^η), both stable
    const logP = -Math.log1p(Math.exp(-eta));
    const log1mP = -Math.log1p(Math.exp(eta));
    ll += (weights?.[i] ?? 1) * (t[i]! * logP + (1 - t[i]!) * log1mP);
  }
  return ll;
}

/**
 * Maximum-likelihood logistic regression of targets `t` (in [0, 1]; fractional targets allowed, as
 * Platt's smoothing needs) on rows `X` (each with its own intercept column if wanted). Newton–Raphson
 * from zero with step-halving (the step is halved while the log-likelihood would decrease, D-300).
 * Returns null when the information matrix is singular (a constant column) or the fit separates
 * (a coefficient beyond `SEPARATION_COEF_LIMIT`, or no ascent direction).
 */
export function logisticFit(
  X: readonly (readonly number[])[],
  t: readonly number[],
  weights?: readonly number[],
): LogisticFit | null {
  const n = X.length;
  if (n === 0 || t.length !== n) throw new RangeError("X and t must have the same positive length");
  const k = X[0]!.length;
  let coef = new Array<number>(k).fill(0);
  let ll = logLikelihood(X, t, weights, coef);
  let converged = false;
  let it = 0;
  let cov: number[][] | null = null;
  for (; it < NEWTON_MAX_ITER; it += 1) {
    const grad = new Array<number>(k).fill(0);
    const info = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let i = 0; i < n; i += 1) {
      const x = X[i]!;
      let eta = 0;
      for (let j = 0; j < k; j += 1) eta += coef[j]! * x[j]!;
      const p = logistic(eta);
      const w = (weights?.[i] ?? 1) * p * (1 - p);
      const r = (weights?.[i] ?? 1) * (t[i]! - p);
      for (let j = 0; j < k; j += 1) {
        grad[j]! += r * x[j]!;
        for (let l = 0; l < k; l += 1) info[j]![l]! += w * x[j]! * x[l]!;
      }
    }
    const step = solveLinear(info, grad);
    if (step === null) return null;
    // Step-halving: shrink the Newton step until the log-likelihood does not decrease.
    let scale = 1;
    let next = coef.map((c, j) => c + scale * step[j]!);
    let nextLl = logLikelihood(X, t, weights, next);
    let halvings = 0;
    while (!(nextLl >= ll - 1e-12) && halvings < STEP_HALVINGS) {
      scale /= 2;
      next = coef.map((c, j) => c + scale * step[j]!);
      nextLl = logLikelihood(X, t, weights, next);
      halvings += 1;
    }
    if (!(nextLl >= ll - 1e-12)) return null; // no ascent direction: separated or degenerate
    let maxStep = 0;
    for (let j = 0; j < k; j += 1) maxStep = Math.max(maxStep, Math.abs(next[j]! - coef[j]!));
    coef = next;
    ll = nextLl;
    for (const c of coef)
      if (!Number.isFinite(c) || Math.abs(c) > SEPARATION_COEF_LIMIT) return null;
    if (maxStep < NEWTON_TOL) {
      converged = true;
      // covariance = inverse of the information at the solution
      cov = [];
      for (let j = 0; j < k; j += 1) {
        const e = new Array<number>(k).fill(0);
        e[j] = 1;
        const col = solveLinear(info, e);
        if (col === null) return null;
        cov.push(col);
      }
      break;
    }
  }
  if (!converged || cov === null) {
    // No convergence (typically quasi-separation): report the fit with an empty covariance.
    return { coef, covariance: [], iterations: it, converged: false };
  }
  // cov holds columns; the information matrix is symmetric so columns = rows.
  return { coef, covariance: cov, iterations: it + 1, converged: true };
}

/** Influence values of logistic coefficient `which`: n · (X'WX)⁻¹ x_i (t_i − p_i). */
export function logisticInfluence(
  X: readonly (readonly number[])[],
  t: readonly number[],
  fit: LogisticFit,
  which: number,
): Float64Array {
  const n = X.length;
  const k = fit.coef.length;
  const out = new Float64Array(n);
  if (fit.covariance.length !== k) return out;
  for (let i = 0; i < n; i += 1) {
    const x = X[i]!;
    let eta = 0;
    for (let j = 0; j < k; j += 1) eta += fit.coef[j]! * x[j]!;
    const r = t[i]! - logistic(eta);
    let v = 0;
    for (let j = 0; j < k; j += 1) v += fit.covariance[which]![j]! * x[j]!;
    out[i] = n * v * r;
  }
  return out;
}

export type Standardised = { readonly mean: number; readonly sd: number; readonly z: number[] };

/** Standardise S within a family: z = (S − mean) / sd with the sample sd (n − 1); sd 0 → z = 0. */
export function standardise(s: readonly number[]): Standardised {
  if (s.length === 0) throw new RangeError("at least one score is required");
  const m = mean(s);
  let ss = 0;
  for (const v of s) ss += (v - m) ** 2;
  const sd = s.length > 1 ? Math.sqrt(ss / (s.length - 1)) : 0;
  return { mean: m, sd, z: s.map((v) => (sd > 0 ? (v - m) / sd : 0)) };
}

/** Platt's smoothed targets (Platt 1999 §2.2): the fit never sees a 0 or a 1. */
export function plattTargets(y: readonly (0 | 1)[]): number[] {
  let nPos = 0;
  for (const v of y) nPos += v;
  const nNeg = y.length - nPos;
  const tPos = (nPos + 1) / (nPos + 2);
  const tNeg = 1 / (nNeg + 2);
  return y.map((v) => (v === 1 ? tPos : tNeg));
}

/** The Platt map of one family (`cortex_map.params_json`: a, b, s_mean, s_sd). */
export type PlattMap = {
  readonly a: number;
  readonly b: number;
  readonly sMean: number;
  readonly sSd: number;
  readonly n: number;
};

/**
 * Fit p = logistic(a·z + b) on z = S standardised within the family. Requires ≥ `PLATT_MIN_OUTCOMES`
 * outcomes with both classes present.
 */
export function plattFit(s: readonly number[], y: readonly (0 | 1)[]): PlattMap | StatUndefined {
  if (s.length !== y.length) throw new RangeError("s and y must have the same length");
  if (s.length < PLATT_MIN_OUTCOMES)
    return { undefined: `fewer than ${PLATT_MIN_OUTCOMES} outcomes` };
  const { mean: sMean, sd: sSd, z } = standardise(s);
  if (sSd === 0) return { undefined: "constant score" };
  const t = plattTargets(y);
  const fit = logisticFit(
    z.map((v) => [v, 1]),
    t,
  );
  if (fit === null || !fit.converged) return { undefined: "logistic fit did not converge" };
  return { a: fit.coef[0]!, b: fit.coef[1]!, sMean, sSd, n: s.length };
}

/** p for a raw S under a family's map. */
export function plattApply(map: Pick<PlattMap, "a" | "b" | "sMean" | "sSd">, s: number): number {
  const z = map.sSd > 0 ? (s - map.sMean) / map.sSd : 0;
  return logistic(map.a * z + map.b);
}

export type PooledPlattInput = {
  readonly family: string;
  readonly s: readonly number[];
  readonly y: readonly (0 | 1)[];
};

export type PooledPlattResult = {
  /** The shared slope. */
  readonly a: number;
  readonly maps: ReadonlyMap<string, PlattMap>;
  /** Families left out (fewer than 60 outcomes or a constant score), with the reason. */
  readonly excluded: ReadonlyMap<string, string>;
  /** n_eff of the slope over the pooled rows when a layout was given. */
  readonly poolNEff: number | undefined;
};

/**
 * Pooled Platt fit for one slope group: one slope a across the included families, one intercept per
 * family, each family's S standardised within itself. Families with fewer than `PLATT_MIN_OUTCOMES`
 * outcomes are excluded (they stay in shadow). When `layout` (over the concatenated included rows, in
 * input order) is given, the pool's n_eff of the slope is computed and the fit is undefined below
 * `PLATT_POOL_MIN_NEFF` (CTX-012 "Map": "otherwise the family is in shadow").
 */
export function plattFitPooled(
  families: readonly PooledPlattInput[],
  layout?: BlockLayout,
  opts: BootstrapOptions = {},
): PooledPlattResult | StatUndefined {
  const excluded = new Map<string, string>();
  const included: { family: string; z: number[]; t: number[]; sMean: number; sSd: number }[] = [];
  for (const f of families) {
    if (f.s.length !== f.y.length) throw new RangeError(`${f.family}: s and y lengths differ`);
    if (f.s.length < PLATT_MIN_OUTCOMES) {
      excluded.set(f.family, `fewer than ${PLATT_MIN_OUTCOMES} outcomes`);
      continue;
    }
    const st = standardise(f.s);
    if (st.sd === 0) {
      excluded.set(f.family, "constant score");
      continue;
    }
    included.push({ family: f.family, z: st.z, t: plattTargets(f.y), sMean: st.mean, sSd: st.sd });
  }
  if (included.length === 0) return { undefined: "no family with enough outcomes" };
  const G = included.length;
  const X: number[][] = [];
  const t: number[] = [];
  included.forEach((f, g) => {
    for (let i = 0; i < f.z.length; i += 1) {
      const row = new Array<number>(1 + G).fill(0);
      row[0] = f.z[i]!;
      row[1 + g] = 1;
      X.push(row);
      t.push(f.t[i]!);
    }
  });
  const fit = logisticFit(X, t);
  if (fit === null || !fit.converged) return { undefined: "pooled logistic fit did not converge" };
  let poolNEff: number | undefined;
  if (layout) {
    if (layout.sessions.length !== X.length)
      throw new RangeError("layout must cover the included rows");
    poolNEff = effectiveN(layout, logisticInfluence(X, t, fit, 0), opts).nEff;
    if (poolNEff === undefined || poolNEff < PLATT_POOL_MIN_NEFF)
      return { undefined: `pool n_eff below ${PLATT_POOL_MIN_NEFF}` };
  }
  const maps = new Map<string, PlattMap>();
  included.forEach((f, g) =>
    maps.set(f.family, {
      a: fit.coef[0]!,
      b: fit.coef[1 + g]!,
      sMean: f.sMean,
      sSd: f.sSd,
      n: f.z.length,
    }),
  );
  return { a: fit.coef[0]!, maps, excluded, poolNEff };
}

function checkPy(p: readonly number[], y: readonly (0 | 1)[]): void {
  if (p.length !== y.length) throw new RangeError("p and y must have the same length");
  if (p.length === 0) throw new RangeError("at least one outcome is required");
  for (const v of p) if (!(v >= 0 && v <= 1)) throw new RangeError("p must be in [0, 1]");
}

/** Brier score, mean (p − y)². */
export function brier(p: readonly number[], y: readonly (0 | 1)[]): number {
  checkPy(p, y);
  let s = 0;
  for (let i = 0; i < p.length; i += 1) s += (p[i]! - y[i]!) ** 2;
  return s / p.length;
}

/** Brier skill against climatology: 1 − BS / (ȳ(1 − ȳ)); NaN when every outcome is the same. */
export function brierSkill(p: readonly number[], y: readonly (0 | 1)[]): number {
  checkPy(p, y);
  const yBar = mean(y);
  const ref = yBar * (1 - yBar);
  return ref > 0 ? 1 - brier(p, y) / ref : NaN;
}

/** Influence values of the Brier skill (delta method on B̄ and ȳ). */
export function brierSkillInfluence(p: readonly number[], y: readonly (0 | 1)[]): Float64Array {
  const n = p.length;
  const yBar = mean(y);
  const ref = yBar * (1 - yBar);
  const b = p.map((v, i) => (v - y[i]!) ** 2);
  const bBar = mean(b);
  const out = new Float64Array(n);
  if (ref <= 0) return out;
  for (let i = 0; i < n; i += 1) {
    out[i] = -(b[i]! - bBar) / ref + (bBar * (1 - 2 * yBar) * (y[i]! - yBar)) / (ref * ref);
  }
  return out;
}

/** Brier skill with its bootstrap interval; `oneSidedLo > 0` is the CTX-053 permission statistic. */
export function brierSkillCi(
  p: readonly number[],
  y: readonly (0 | 1)[],
  layout: BlockLayout,
  prng: Prng,
  opts: BootstrapOptions = {},
): BootCi | StatUndefined {
  checkPy(p, y);
  const stat = (rows: Int32Array): number => {
    let yPos = 0;
    let bs = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i]!;
      yPos += y[r]!;
      bs += (p[r]! - y[r]!) ** 2;
    }
    const yBar = yPos / rows.length;
    const ref = yBar * (1 - yBar);
    return ref > 0 ? 1 - bs / rows.length / ref : NaN;
  };
  return bootstrapCi(layout, stat, brierSkillInfluence(p, y), prng, opts);
}

export type CalibrationFit = {
  readonly slope: number;
  readonly intercept: number;
};

/** Cox calibration: logistic regression of y on logit(p); slope 1, intercept 0 = calibrated. */
export function calibrationSlope(
  p: readonly number[],
  y: readonly (0 | 1)[],
): CalibrationFit | StatUndefined {
  checkPy(p, y);
  const fit = logisticFit(
    p.map((v) => [logit(v), 1]),
    y,
  );
  if (fit === null || !fit.converged) return { undefined: "calibration fit did not converge" };
  return { slope: fit.coef[0]!, intercept: fit.coef[1]! };
}

export type CalibrationCi = {
  readonly slope: BootCi;
  readonly intercept: BootCi;
  /** The over-confidence monitor: the slope's one-sided 90 % upper bound is below `hideUb`. */
  readonly pHidden: boolean;
  /** Replicates whose fit failed (separated / not converged), dropped from the percentiles. */
  readonly nonFiniteReplicates: number;
};

/** Share of replicates a slope interval may lose to failed fits before it is undefined (D-300). */
export const SLOPE_MAX_NON_FINITE_SHARE = 0.005;

/**
 * Slope and intercept with bootstrap intervals. A replicate whose fit fails (separation, no
 * convergence) contributes NaN; up to `SLOPE_MAX_NON_FINITE_SHARE` of R such replicates are dropped
 * from the percentiles and counted in `nonFiniteReplicates`; beyond that the statistic is undefined.
 * The CTX-053 evaluator treats an undefined slope as hidden p: use `slopeHidden(result)`.
 */
export function calibrationSlopeCi(
  p: readonly number[],
  y: readonly (0 | 1)[],
  layout: BlockLayout,
  prng: Prng,
  opts: BootstrapOptions & { readonly hideUb?: number } = {},
): CalibrationCi | StatUndefined {
  checkPy(p, y);
  const X = p.map((v) => [logit(v), 1]);
  const full = logisticFit(X, y);
  if (full === null || !full.converged) return { undefined: "calibration fit did not converge" };
  // Slope and intercept are fitted once per replicate on the same drawn rows.
  const both = (rows: Int32Array): readonly number[] => {
    const Xr: number[][] = new Array(rows.length);
    const yr: number[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
      Xr[i] = X[rows[i]!]!;
      yr[i] = y[rows[i]!]!;
    }
    const f = logisticFit(Xr, yr);
    return f === null || !f.converged ? [NaN, NaN] : [f.coef[0]!, f.coef[1]!];
  };
  const [slope, intercept] = bootstrapCiMany(
    layout,
    both,
    [logisticInfluence(X, y, full, 0), logisticInfluence(X, y, full, 1)],
    prng,
    { ...opts, maxNonFiniteShare: opts.maxNonFiniteShare ?? SLOPE_MAX_NON_FINITE_SHARE },
  );
  if (isUndefined(slope!)) return slope;
  if (isUndefined(intercept!)) return intercept;
  const hideUb = opts.hideUb ?? DEFAULT_SLOPE_HIDE_UB;
  return {
    slope,
    intercept,
    pHidden: slope.oneSidedHi < hideUb,
    nonFiniteReplicates: slope.nonFinite,
  };
}

/**
 * The over-confidence monitor as the CTX-053 evaluator applies it: p is hidden when the slope's
 * one-sided 90 % upper bound is below the threshold, and also when the slope could not be computed
 * (an undefined slope is treated as hidden, fail-closed; D-300).
 */
export function slopeHidden(result: CalibrationCi | StatUndefined): boolean {
  return isUndefined(result) ? true : result.pHidden;
}

export type EceResult = {
  readonly ece: number;
  readonly bins: readonly {
    readonly lo: number;
    readonly hi: number;
    readonly n: number;
    readonly meanP: number;
    readonly meanY: number;
  }[];
};

/** Expected calibration error on `bins` equal-width bins over [0, 1]: Σ (n_b / n) |p̄_b − ȳ_b|. */
export function ece(p: readonly number[], y: readonly (0 | 1)[], bins = ECE_BINS): EceResult {
  checkPy(p, y);
  if (!Number.isInteger(bins) || bins < 1) throw new RangeError("bins must be a positive integer");
  const n = new Array<number>(bins).fill(0);
  const sp = new Array<number>(bins).fill(0);
  const sy = new Array<number>(bins).fill(0);
  for (let i = 0; i < p.length; i += 1) {
    const b = Math.min(bins - 1, Math.floor(p[i]! * bins));
    n[b]! += 1;
    sp[b]! += p[i]!;
    sy[b]! += y[i]!;
  }
  let e = 0;
  const out = [];
  for (let b = 0; b < bins; b += 1) {
    const meanP = n[b]! > 0 ? sp[b]! / n[b]! : NaN;
    const meanY = n[b]! > 0 ? sy[b]! / n[b]! : NaN;
    if (n[b]! > 0) e += (n[b]! / p.length) * Math.abs(meanP - meanY);
    out.push({ lo: b / bins, hi: (b + 1) / bins, n: n[b]!, meanP, meanY });
  }
  return { ece: e, bins: out };
}

/**
 * ECE with a two-sided 90 % bootstrap interval. Reported on the statement rows only (CTX-082); the
 * influence values are the within-bin linearisation sign_b·((p_i − y_i) − (p̄_b − ȳ_b)), which omits
 * the bin-weight term (n_b / n varies across replicates), so the n_eff and the interval are slightly
 * narrow. Acceptable because ECE is reported, never gated (AT-51).
 */
export function eceCi(
  p: readonly number[],
  y: readonly (0 | 1)[],
  layout: BlockLayout,
  prng: Prng,
  opts: BootstrapOptions & { readonly bins?: number } = {},
): BootCi | StatUndefined {
  const bins = opts.bins ?? ECE_BINS;
  const full = ece(p, y, bins);
  const influence = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 1) {
    const b = Math.min(bins - 1, Math.floor(p[i]! * bins));
    const gap = full.bins[b]!.meanP - full.bins[b]!.meanY;
    influence[i] = Math.sign(gap) * (p[i]! - y[i]! - gap);
  }
  const n = new Float64Array(bins);
  const sp = new Float64Array(bins);
  const sy = new Float64Array(bins);
  const stat = (rows: Int32Array): number => {
    n.fill(0);
    sp.fill(0);
    sy.fill(0);
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i]!;
      const b = Math.min(bins - 1, Math.floor(p[r]! * bins));
      n[b]! += 1;
      sp[b]! += p[r]!;
      sy[b]! += y[r]!;
    }
    let e = 0;
    for (let b = 0; b < bins; b += 1) {
      if (n[b]! > 0) e += (n[b]! / rows.length) * Math.abs(sp[b]! / n[b]! - sy[b]! / n[b]!);
    }
    return e;
  };
  return bootstrapCi(layout, stat, influence, prng, opts);
}
