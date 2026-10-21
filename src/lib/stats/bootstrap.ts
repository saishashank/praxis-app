// Circular block bootstrap over entry sessions (M4 design 4.8 item 2; ARN-081).
//
// The tested window's entry sessions are indexed 0..S-1. A replicate draws ceil(S/block) block starts
// uniformly from the PRNG; each block is `block` consecutive sessions, wrapping around the window; the
// rows whose entry session falls in a drawn block are collected (a session drawn twice counts twice).
// The statistic per replicate is the mean of the collected rows. A replicate with no rows is redrawn
// and counted. Iteration order is fixed (replicate, then block, then session, then row), so results
// are byte-identical for the same seed.
import { belowInt, type Prng } from "./rng";

export type BootstrapInput = {
  /** Entry-session index (0..S-1) of each row. */
  readonly sessions: readonly number[];
  /** Number of sessions S in the tested window. */
  readonly sessionCount: number;
  /** Block length in sessions (>= 1). */
  readonly block: number;
  /** Replicates B. */
  readonly replicates: number;
  /** One or more value series aligned to `sessions` (e.g. excess and net return); resampled together. */
  readonly series: readonly (readonly number[])[];
};

export type BootstrapReplicates = {
  /** replicateMeans[s][b]: mean of series s over the rows collected in replicate b. */
  readonly replicateMeans: readonly Float64Array[];
  /** Replicates redrawn because they collected no row. */
  readonly redraws: number;
  /** Independent blocks in the window, S / block (design: < 15 is "insufficient independent blocks"). */
  readonly blocks: number;
};

/** Draw B circular-block-bootstrap replicates. Pure given the PRNG state. */
export function circularBlockBootstrap(input: BootstrapInput, rng: Prng): BootstrapReplicates {
  const { sessions, sessionCount: S, block, replicates: B, series } = input;
  const n = sessions.length;
  if (!Number.isInteger(S) || S < 1)
    throw new RangeError("sessionCount must be a positive integer");
  if (!Number.isInteger(block) || block < 1)
    throw new RangeError("block must be a positive integer");
  if (!Number.isInteger(B) || B < 1) throw new RangeError("replicates must be a positive integer");
  if (n === 0) throw new RangeError("at least one row is required");
  for (const s of series) {
    if (s.length !== n) throw new RangeError("every series must have one value per row");
  }
  // Rows grouped by session, in input order (CSR layout).
  const offsets = new Int32Array(S + 1);
  for (const s of sessions) {
    if (!Number.isInteger(s) || s < 0 || s >= S) throw new RangeError("session out of range");
    offsets[s + 1]! += 1;
  }
  for (let i = 0; i < S; i += 1) offsets[i + 1]! += offsets[i]!;
  const fill = Int32Array.from(offsets.subarray(0, S));
  const rowAt = new Int32Array(n);
  for (let r = 0; r < n; r += 1) {
    const s = sessions[r]!;
    rowAt[fill[s]!] = r;
    fill[s]! += 1;
  }
  const draws = Math.ceil(S / block);
  const K = series.length;
  const out = Array.from({ length: K }, () => new Float64Array(B));
  const sums = new Float64Array(K);
  let redraws = 0;
  for (let b = 0; b < B; b += 1) {
    for (;;) {
      sums.fill(0);
      let count = 0;
      for (let d = 0; d < draws; d += 1) {
        const start = belowInt(rng, S);
        for (let o = 0; o < block; o += 1) {
          const sess = (start + o) % S;
          for (let p = offsets[sess]!; p < offsets[sess + 1]!; p += 1) {
            const row = rowAt[p]!;
            for (let k = 0; k < K; k += 1) sums[k]! += series[k]![row]!;
            count += 1;
          }
        }
      }
      if (count > 0) {
        for (let k = 0; k < K; k += 1) out[k]![b] = sums[k]! / count;
        break;
      }
      redraws += 1;
    }
  }
  return { replicateMeans: out, redraws, blocks: S / block };
}

export function mean(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i += 1) s += xs[i]!;
  return s / xs.length;
}

/** Sample standard deviation (n - 1 denominator), two-pass. */
export function sampleSd(xs: ArrayLike<number>): number {
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < xs.length; i += 1) s += (xs[i]! - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/** Nearest-rank percentile of replicate values: sorted[ceil(q * B) - 1], q in (0, 1]. */
export function percentile(values: ArrayLike<number>, q: number): number {
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length - 1e-9) - 1));
  return sorted[idx]!;
}

export type StudentisedTest = {
  readonly mean: number;
  readonly se: number;
  readonly t: number;
  /** One-sided p = (1 + #{t* >= t}) / (B + 1). */
  readonly p: number;
  readonly replicates: number;
};

/**
 * Studentised one-sided test of mean > 0 (ARN-081, design 4.8 item 2): the replicate means of the
 * series are centred on the observed mean (rawMean - mean), se = SD of the replicate means,
 * t = mean / se, null t* = centred replicate mean / se.
 */
export function studentisedTest(
  observedMean: number,
  replicateMeans: ArrayLike<number>,
): StudentisedTest {
  const B = replicateMeans.length;
  const se = sampleSd(replicateMeans);
  const t = observedMean / se;
  let ge = 0;
  for (let b = 0; b < B; b += 1) {
    const tStar = (replicateMeans[b]! - observedMean) / se;
    if (tStar >= t) ge += 1;
  }
  return { mean: observedMean, se, t, p: (1 + ge) / (B + 1), replicates: B };
}

export type BootstrapSummary = {
  readonly rows: number;
  readonly sessions: number;
  readonly block: number;
  readonly blocks: number;
  readonly insufficientBlocks: boolean;
  readonly redraws: number;
  readonly test: StudentisedTest;
  /** One-sided 90 % lower bound = 10th percentile of the uncentred replicate means (absolute gate). */
  readonly lower90: number;
  /** Two-sided 90 % interval = 5th and 95th percentiles of the uncentred replicate means. */
  readonly interval90: { readonly lower: number; readonly upper: number };
};

export const MIN_INDEPENDENT_BLOCKS = 15;

/** Bootstrap one series end to end: replicates, studentised test, percentile bounds. */
export function bootstrapSeries(
  sessions: readonly number[],
  values: readonly number[],
  sessionCount: number,
  block: number,
  replicates: number,
  rng: Prng,
): BootstrapSummary {
  const r = circularBlockBootstrap(
    { sessions, sessionCount, block, replicates, series: [values] },
    rng,
  );
  const means = r.replicateMeans[0]!;
  return {
    rows: values.length,
    sessions: sessionCount,
    block,
    blocks: r.blocks,
    insufficientBlocks: r.blocks < MIN_INDEPENDENT_BLOCKS,
    redraws: r.redraws,
    test: studentisedTest(mean(values), means),
    lower90: percentile(means, 0.1),
    interval90: { lower: percentile(means, 0.05), upper: percentile(means, 0.95) },
  };
}
