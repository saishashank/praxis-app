// Multiplicity for the Cortex trial ledger (M15 C2; spec ch. 17 CTX-031, AT-53; D-258).
//
//   benjaminiHochberg   "measured" is granted under Benjamini–Hochberg at q = `ledger_fdr_q` across the
//                       run's cells under a stated PRDS assumption (positive dependence across angle
//                       cells). `dependence: "arbitrary"` applies the Benjamini–Yekutieli correction
//                       (q / H_m) for completeness; AT-53's "BY" reads as BH under PRDS (D-258).
//   splitHalfSign       the split-half sign-agreement test: a cell's statistic must carry the same sign
//                       in both halves of the development split (and the sign the orientation expects).
//   measuredCells       the two combined: measured = BH-rejected and sign-agreeing.
//
// Pure functions over plain arrays; no randomness.

/** Default `ledger_fdr_q` (CTX-031). */
export const DEFAULT_FDR_Q = 0.1;

export type Dependence = "prds" | "arbitrary";

export type BhResult = {
  /** Rejected (significant) per input p-value, in input order. */
  readonly rejected: readonly boolean[];
  /** BH-adjusted p-values (step-up monotone), in input order. */
  readonly adjusted: readonly number[];
  /** Number of rejections k. */
  readonly k: number;
  /** The largest p-value rejected (0 when none). */
  readonly threshold: number;
  readonly q: number;
  readonly dependence: Dependence;
};

/**
 * Benjamini–Hochberg step-up at level q over `pValues` (m tests). Sorted p_(i) is rejected for every
 * i ≤ k where k = max{ i : p_(i) ≤ i·q / (m·c) }, c = 1 under PRDS and c = H_m = Σ 1/j under
 * arbitrary dependence (Benjamini–Yekutieli). Adjusted p_(i) = min_{j ≥ i} (m·c·p_(j) / j), capped at 1.
 */
export function benjaminiHochberg(
  pValues: readonly number[],
  q: number = DEFAULT_FDR_Q,
  dependence: Dependence = "prds",
): BhResult {
  if (!(q > 0 && q < 1)) throw new RangeError("q must be in (0, 1)");
  const m = pValues.length;
  for (const p of pValues)
    if (!(p >= 0 && p <= 1)) throw new RangeError("p-values must be in [0, 1]");
  let c = 1;
  if (dependence === "arbitrary") {
    c = 0;
    for (let j = 1; j <= m; j += 1) c += 1 / j;
  }
  const order = pValues.map((_, i) => i).sort((a, b) => pValues[a]! - pValues[b]! || a - b);
  const adjustedSorted = new Array<number>(m).fill(1);
  let running = 1;
  for (let r = m - 1; r >= 0; r -= 1) {
    const i = r + 1;
    running = Math.min(running, (m * c * pValues[order[r]!]!) / i);
    adjustedSorted[r] = Math.min(1, running);
  }
  let k = 0;
  for (let r = 0; r < m; r += 1) {
    const i = r + 1;
    if (pValues[order[r]!]! <= (i * q) / (m * c)) k = i;
  }
  const rejected = new Array<boolean>(m).fill(false);
  const adjusted = new Array<number>(m).fill(1);
  for (let r = 0; r < m; r += 1) {
    rejected[order[r]!] = r < k;
    adjusted[order[r]!] = adjustedSorted[r]!;
  }
  const threshold = k > 0 ? pValues[order[k - 1]!]! : 0;
  return { rejected, adjusted, k, threshold, q, dependence };
}

/**
 * Split-half sign agreement: true when both halves' statistics are finite, non-zero and share the
 * expected sign (`orientation` +1 = both positive, −1 = both negative).
 */
export function splitHalfSign(first: number, second: number, orientation: 1 | -1 = 1): boolean {
  if (!Number.isFinite(first) || !Number.isFinite(second)) return false;
  return Math.sign(first) === orientation && Math.sign(second) === orientation;
}

export type LedgerCellTest = {
  readonly id: string;
  /** One-sided p-value of the cell's statistic in the expected direction. */
  readonly p: number;
  /** The statistic on the first and second half of the development split. */
  readonly firstHalf: number;
  readonly secondHalf: number;
  readonly orientation?: 1 | -1;
};

export type MeasuredCell = {
  readonly id: string;
  readonly p: number;
  readonly adjustedP: number;
  readonly bhRejected: boolean;
  readonly signAgrees: boolean;
  /** Measured = BH-rejected under PRDS at q and split-half sign agreement (CTX-031). */
  readonly measured: boolean;
};

export function measuredCells(
  cells: readonly LedgerCellTest[],
  q: number = DEFAULT_FDR_Q,
  dependence: Dependence = "prds",
): { readonly cells: readonly MeasuredCell[]; readonly bh: BhResult } {
  const bh = benjaminiHochberg(
    cells.map((c) => c.p),
    q,
    dependence,
  );
  return {
    bh,
    cells: cells.map((c, i) => {
      const signAgrees = splitHalfSign(c.firstHalf, c.secondHalf, c.orientation ?? 1);
      const bhRejected = bh.rejected[i]!;
      return {
        id: c.id,
        p: c.p,
        adjustedP: bh.adjusted[i]!,
        bhRejected,
        signAgrees,
        measured: bhRejected && signAgrees,
      };
    }),
  };
}
