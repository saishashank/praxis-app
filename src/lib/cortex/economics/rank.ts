// Ranking (M15 C3a; spec ch. 17 CTX-022; key `rank_shrink_n0`; AT-52 "ATR 4 %/6 % pair").
//
//   key = shrunk mean net ÷ L_real
//   shrunk mean net = w · cell mean net + (1 − w) · family mean net,  w = n_eff / (n_eff + rank_shrink_n0)
//   L_real = the matched setups' median realised loss (gap fills and slippage included, C2 `lReal`)
//
// computed on the candidate's own volatility-bucket cell; the cross-bucket order is by the same
// quantity, so one sort over every passing candidate. Ties (exact float equality of the key): smaller
// L_real, lower disagreement, higher ADV, then code (so the same inputs give the same bytes).
// Statistics are floats; ADV is money (bigint) and compared exactly.
import type { Micro } from "@/lib/money/micro";

/** Default `rank_shrink_n0` (60; 20–200). */
export const DEFAULT_RANK_SHRINK_N0 = 60;

export type RankCandidate = {
  readonly code: string;
  readonly volBucket: string;
  /** The matched cell's point estimate of mean net (fraction). */
  readonly meanNet: number;
  /** The cell's n_eff of the mean (undefined → full shrinkage to the family mean). */
  readonly nEff: number | undefined;
  /** The cell's median realised loss magnitude (fraction, ≥ 0). */
  readonly lReal: number;
  /** CTX-023 d of the candidate. */
  readonly disagreement: number;
  readonly advMicro: Micro;
};

export type Ranked<C extends RankCandidate = RankCandidate> = {
  readonly candidate: C;
  readonly rank: number;
  readonly shrinkWeight: number;
  readonly shrunkMeanNet: number;
  /** [key, −L_real, −d] — the ordered float keys; ADV and code break the remaining ties. */
  readonly rankKey: readonly number[];
};

export function shrinkWeight(
  nEff: number | undefined,
  n0: number = DEFAULT_RANK_SHRINK_N0,
): number {
  if (!(n0 > 0)) throw new RangeError("rank_shrink_n0 must be positive");
  if (nEff === undefined || !(nEff > 0)) return 0;
  return nEff / (nEff + n0);
}

/** shrunk mean net ÷ L_real; a cell with no realised loss ranks by the sign of its mean. */
export function rankKeyOf(shrunkMeanNet: number, lReal: number): number {
  if (!(lReal >= 0)) throw new RangeError("L_real must be >= 0");
  if (lReal > 0) return shrunkMeanNet / lReal;
  return shrunkMeanNet > 0 ? Infinity : shrunkMeanNet < 0 ? -Infinity : 0;
}

function cmpDesc(a: number, b: number): number {
  return a === b ? 0 : a > b ? -1 : 1;
}

/**
 * CTX-022 order of the passing candidates of one family (highest first). `familyMeanNet` is the
 * family's development-split mean net the shrinkage pulls towards.
 */
export function rankCandidates<C extends RankCandidate>(
  candidates: readonly C[],
  familyMeanNet: number,
  n0: number = DEFAULT_RANK_SHRINK_N0,
): readonly Ranked<C>[] {
  if (!Number.isFinite(familyMeanNet)) throw new RangeError("family mean net must be finite");
  const rows = candidates.map((candidate) => {
    if (!Number.isFinite(candidate.meanNet)) throw new RangeError(`${candidate.code}: mean net`);
    if (!(candidate.disagreement >= 0)) throw new RangeError(`${candidate.code}: disagreement`);
    const w = shrinkWeight(candidate.nEff, n0);
    const shrunk = w * candidate.meanNet + (1 - w) * familyMeanNet;
    const key = rankKeyOf(shrunk, candidate.lReal);
    return {
      candidate,
      shrinkWeight: w,
      shrunkMeanNet: shrunk,
      rankKey: [key, -candidate.lReal, -candidate.disagreement] as const,
    };
  });
  rows.sort((x, y) => {
    for (let i = 0; i < 3; i += 1) {
      const c = cmpDesc(x.rankKey[i]!, y.rankKey[i]!);
      if (c !== 0) return c;
    }
    const a = x.candidate.advMicro;
    const b = y.candidate.advMicro;
    if (a !== b) return a > b ? -1 : 1;
    return x.candidate.code < y.candidate.code ? -1 : x.candidate.code > y.candidate.code ? 1 : 0;
  });
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}
