// Distinctness of a family's active angle set (M15 C2; spec ch. 17 CTX-033, AT-53).
//
//   residualiseFeatures   each feature regressed (OLS with intercept) on sector dummies, index beta and
//                         size (log market cap); the residuals are the distinct part, the beta and size
//                         coefficients are the published loadings.
//   rankCorrelationMatrix Spearman correlations between residualised features (rankIc.ts `spearman`).
//   vif                   variance inflation factor of each feature against the others, 1 / (1 − R²).
//   partialIc             Spearman IC of a feature's residual on the other features against the forward
//                         return, next to its raw IC; the rule is partial ≥ 0.5 × raw.
//   clusterMeanCorrelation max |corr| between cluster means on RAW features across clusters.
//   effectiveNumber       effective number of independent angles from the correlation matrix's
//                         eigenvalues, (Σλ)² / Σλ² (participation ratio), via Jacobi rotations.
//   distinctnessReport    the whole CTX-033 check with its pass flags.
//
// Layout: `features[a][i]` = value of angle a for code i (one night, or stacked nights). Pure, no
// randomness. `solveLinear` comes from calibration.ts (one small dense solver for C2).
import { mean } from "./bootstrap";
import { solveLinear } from "./calibration";
import { spearman } from "./rankIc";

/** CTX-033 thresholds. */
export const MAX_RANK_CORRELATION = 0.6;
export const MAX_CLUSTER_MEAN_CORRELATION = 0.6;
export const MAX_VIF = 5;
export const MIN_PARTIAL_IC_RATIO = 0.5;

export type OlsFit = {
  readonly coef: readonly number[];
  readonly residuals: number[];
  readonly r2: number;
};

/** OLS of y on X (an intercept column is added); null when the normal equations are singular. */
export function ols(y: readonly number[], X: readonly (readonly number[])[]): OlsFit | null {
  const n = y.length;
  if (X.length !== n) throw new RangeError("X must have one row per y");
  const k = (X[0]?.length ?? 0) + 1;
  const XtX = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const Xty = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i += 1) {
    const row = [1, ...X[i]!];
    for (let a = 0; a < k; a += 1) {
      Xty[a]! += row[a]! * y[i]!;
      for (let b = 0; b < k; b += 1) XtX[a]![b]! += row[a]! * row[b]!;
    }
  }
  const coef = solveLinear(XtX, Xty);
  if (coef === null) return null;
  const residuals = new Array<number>(n);
  const yBar = mean(y);
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const row = [1, ...X[i]!];
    let fit = 0;
    for (let a = 0; a < k; a += 1) fit += coef[a]! * row[a]!;
    residuals[i] = y[i]! - fit;
    ssRes += residuals[i]! ** 2;
    ssTot += (y[i]! - yBar) ** 2;
  }
  return { coef, residuals, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

export type Factors = {
  readonly sector: readonly string[];
  readonly beta: readonly number[];
  /** log market cap */
  readonly size: readonly number[];
};

export type Loadings = { readonly beta: number; readonly size: number };

export type Residualised = {
  readonly residuals: number[][];
  readonly loadings: Loadings[];
};

/** Sector dummies (first sector in sorted order is the base level), beta, size: the factor matrix. */
export function factorMatrix(factors: Factors): number[][] {
  const n = factors.sector.length;
  if (factors.beta.length !== n || factors.size.length !== n)
    throw new RangeError("factor columns must have the same length");
  const levels = [...new Set(factors.sector)].sort();
  const dummies = levels.slice(1);
  return Array.from({ length: n }, (_, i) => [
    ...dummies.map((l) => (factors.sector[i] === l ? 1 : 0)),
    factors.beta[i]!,
    factors.size[i]!,
  ]);
}

/** Residualise every feature on sector, beta and size; loadings are the beta and size coefficients. */
export function residualiseFeatures(
  features: readonly (readonly number[])[],
  factors: Factors,
): Residualised {
  const X = factorMatrix(factors);
  const residuals: number[][] = [];
  const loadings: Loadings[] = [];
  for (const f of features) {
    if (f.length !== X.length) throw new RangeError("every feature needs one value per code");
    const fit = ols(f, X);
    if (fit === null)
      throw new RangeError("factor matrix is singular (a constant or duplicated factor)");
    const k = fit.coef.length;
    residuals.push(fit.residuals);
    loadings.push({ beta: fit.coef[k - 2]!, size: fit.coef[k - 1]! });
  }
  return { residuals, loadings };
}

/** Pairwise Spearman matrix; a constant feature gives NaN against everything (and 1 on its diagonal). */
export function rankCorrelationMatrix(features: readonly (readonly number[])[]): number[][] {
  const A = features.length;
  const M = Array.from({ length: A }, () => new Array<number>(A).fill(1));
  for (let a = 0; a < A; a += 1) {
    for (let b = a + 1; b < A; b += 1) {
      const r = spearman(features[a]!, features[b]!);
      M[a]![b] = r ?? NaN;
      M[b]![a] = r ?? NaN;
    }
  }
  return M;
}

/** Largest |off-diagonal| of a square matrix, ignoring NaN. */
export function maxOffDiagonal(M: readonly (readonly number[])[]): number {
  let m = 0;
  for (let a = 0; a < M.length; a += 1) {
    for (let b = 0; b < M.length; b += 1) {
      if (a === b) continue;
      const v = Math.abs(M[a]![b]!);
      if (Number.isFinite(v) && v > m) m = v;
    }
  }
  return m;
}

/** VIF of each feature regressed on the others; Infinity when the regression is exact or singular. */
export function vif(features: readonly (readonly number[])[]): number[] {
  const A = features.length;
  return features.map((f, a) => {
    if (A === 1) return 1;
    const n = f.length;
    const X = Array.from({ length: n }, (_, i) =>
      features.flatMap((g, b) => (b === a ? [] : [g[i]!])),
    );
    const fit = ols(f, X);
    if (fit === null) return Infinity;
    return fit.r2 >= 1 - 1e-12 ? Infinity : 1 / (1 - fit.r2);
  });
}

export type PartialIc = {
  readonly raw: number | null;
  readonly partial: number | null;
  /** partial / raw when both are defined and raw ≠ 0. */
  readonly ratio: number | null;
  readonly pass: boolean;
};

/** Raw and partial Spearman IC of `feature` against `forward`, residualising on `others`. */
export function partialIc(
  feature: readonly number[],
  others: readonly (readonly number[])[],
  forward: readonly number[],
  minRatio: number = MIN_PARTIAL_IC_RATIO,
  /** The RAW feature for the raw IC (CTX-033 "partial IC ≥ 0.5 × raw IC"); default = `feature`. */
  rawFeature: readonly number[] = feature,
): PartialIc {
  const raw = spearman(rawFeature, forward);
  let residual = feature;
  if (others.length > 0) {
    const X = feature.map((_, i) => others.map((o) => o[i]!));
    const fit = ols(feature, X);
    residual = fit ? fit.residuals : feature;
  }
  const partial = spearman(residual, forward);
  const ratio = raw !== null && partial !== null && raw !== 0 ? partial / raw : null;
  // Pass when the partial keeps at least `minRatio` of the raw IC in the same direction.
  const pass =
    raw !== null && partial !== null && Math.sign(partial) === Math.sign(raw) && ratio !== null
      ? ratio >= minRatio
      : false;
  return { raw, partial, ratio, pass };
}

/** Eigenvalues of a symmetric matrix by cyclic Jacobi rotations (small matrices). */
export function symmetricEigenvalues(M: readonly (readonly number[])[], maxSweeps = 100): number[] {
  const n = M.length;
  const A = M.map((r) => [...r]);
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let off = 0;
    for (let p = 0; p < n; p += 1) for (let q = p + 1; q < n; q += 1) off += A[p]![q]! ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = A[p]![q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (A[q]![q]! - A[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const akp = A[k]![p]!;
          const akq = A[k]![q]!;
          A[k]![p] = c * akp - s * akq;
          A[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = A[p]![k]!;
          const aqk = A[q]![k]!;
          A[p]![k] = c * apk - s * aqk;
          A[q]![k] = s * apk + c * aqk;
        }
      }
    }
  }
  return A.map((r, i) => r[i]!).sort((a, b) => b - a);
}

/** Effective number of independent angles: (Σλ)² / Σλ² of the correlation matrix (1 ≤ N_eff ≤ A). */
export function effectiveNumber(correlation: readonly (readonly number[])[]): number {
  const C = correlation.map((r) => r.map((v) => (Number.isFinite(v) ? v : 0)));
  const lambda = symmetricEigenvalues(C);
  let s1 = 0;
  let s2 = 0;
  for (const l of lambda) {
    s1 += l;
    s2 += l * l;
  }
  return s2 > 0 ? (s1 * s1) / s2 : 0;
}

/** Cluster means of RAW features per code, then the max |Spearman| across clusters (CTX-033). */
export function clusterMeanCorrelation(
  features: readonly (readonly number[])[],
  clusters: readonly string[],
): { readonly clusters: string[]; readonly matrix: number[][]; readonly max: number } {
  if (clusters.length !== features.length) throw new RangeError("one cluster per feature");
  const names = [...new Set(clusters)].sort();
  const n = features[0]?.length ?? 0;
  const means = names.map((c) => {
    const members = features.filter((_, a) => clusters[a] === c);
    return Array.from({ length: n }, (_, i) => mean(members.map((m) => m[i]!)));
  });
  const matrix = rankCorrelationMatrix(means);
  return { clusters: names, matrix, max: maxOffDiagonal(matrix) };
}

export type DistinctnessInput = {
  readonly angleIds: readonly string[];
  readonly clusters: readonly string[];
  /** features[a][i]: angle a, code i. */
  readonly features: readonly (readonly number[])[];
  readonly factors: Factors;
  /** Forward return per code (for the partial IC). */
  readonly forward: readonly number[];
};

export type DistinctnessReport = {
  readonly angleIds: readonly string[];
  readonly loadings: readonly Loadings[];
  readonly rankCorrelation: number[][];
  readonly maxRankCorrelation: number;
  readonly clusterMeanCorrelation: number;
  readonly vif: number[];
  readonly partialIc: PartialIc[];
  readonly effectiveNumber: number;
  readonly checks: {
    readonly rankCorrelation: boolean;
    readonly clusterMeanCorrelation: boolean;
    readonly vif: boolean;
    readonly partialIc: boolean;
  };
  readonly pass: boolean;
};

/** The whole CTX-033 check on one family's active set. */
export function distinctnessReport(input: DistinctnessInput): DistinctnessReport {
  const A = input.features.length;
  if (input.angleIds.length !== A || input.clusters.length !== A)
    throw new RangeError("angleIds, clusters and features must align");
  const { residuals, loadings } = residualiseFeatures(input.features, input.factors);
  const rankCorrelation = rankCorrelationMatrix(residuals);
  const maxRank = maxOffDiagonal(rankCorrelation);
  const cmc = clusterMeanCorrelation(input.features, input.clusters).max;
  const v = vif(residuals);
  // Raw IC on the raw feature; partial IC on the factor-residualised feature, residualised again on
  // the other residualised features of the set.
  const pics = residuals.map((r, a) =>
    partialIc(
      r,
      residuals.filter((_, b) => b !== a),
      input.forward,
      MIN_PARTIAL_IC_RATIO,
      input.features[a]!,
    ),
  );
  const checks = {
    rankCorrelation: maxRank <= MAX_RANK_CORRELATION,
    clusterMeanCorrelation: cmc <= MAX_CLUSTER_MEAN_CORRELATION,
    vif: v.every((x) => x <= MAX_VIF),
    partialIc: pics.every((p) => p.pass),
  };
  return {
    angleIds: input.angleIds,
    loadings,
    rankCorrelation,
    maxRankCorrelation: maxRank,
    clusterMeanCorrelation: cmc,
    vif: v,
    partialIc: pics,
    effectiveNumber: effectiveNumber(rankCorrelation),
    checks,
    pass: checks.rankCorrelation && checks.clusterMeanCorrelation && checks.vif && checks.partialIc,
  };
}
