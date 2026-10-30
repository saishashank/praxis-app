// Stationary block bootstrap with per-statistic n_eff (M15 C2; spec ch. 17 CTX-012 "Intervals and
// n_eff", OI-15; docs/M15_design.md §3a, §3c "Bootstrap"). Sits beside `circularBlockBootstrap`
// (bootstrap.ts, v1 ARN-081) and reuses its CSR row layout, `percentile` and `mean`.
//
//   Replicate (Politis–Romano 1994): blocks of geometric length (mean L, p = 1/L) starting at uniform
//   sessions, concatenated with circular wrap until S sessions have been drawn — drawn as block lengths
//   directly, len = 1 + floor(log(u) / log(1 − p)), the same distribution as one coin per session at
//   a fraction of the draws. The rows whose entry session was drawn are collected, with multiplicity,
//   and the statistic is evaluated on them. A replicate with no rows is redrawn and counted. Expected
//   block length L = max(`expectedBlock`, `maxHold`): the embargo is the block floor, so a block is
//   never shorter than the longest outcome window it must contain.
//
//   n_eff per statistic (OI-15, D-298, D-299): n_eff,s = R·u_s / D_s from the statistic's influence
//   values ψ_i, with R = rows and
//       D_s = max(1, Σ_b T_b² / Σ_i ψ_i²),  T_b = Σ_{i in block b} ψ_i      (same-date correlation)
//       u_s = min(1, Σ_i ψ_i² / Σ_c T_c²),  T_c = Σ_{i: code_i = c} ψ_i    (same-code correlation)
//   over contiguous fixed calendar blocks of L sessions (period = L, every row counted once in both
//   sums; D-299 — the out-of-fold purge/embargo lives in `purgeEmbargo` only). u_s is the inverse of
//   the same-code design effect, so a family whose codes carry no shared component has u ≈ 1 and one
//   whose outcomes repeat within a code has u ≈ codes / rows (D-298; the literal "share of unique
//   codes" would cap n_eff at the code count). Only blocks that hold a row count; with fewer than
//   `MIN_BLOCKS_FOR_NEFF` (10) such blocks n_eff is undefined ("not enough history").
//
//   Intervals: two-sided 90 % = 5th and 95th percentiles of the uncentred replicate statistics; the
//   one-sided 90 % bounds are the 10th and 90th percentiles (the economic gate reads `oneSidedLo`,
//   CTX-021; the over-confidence monitor reads `oneSidedHi`, CTX-053).
//
// Pure: plain arrays in, numbers out; every random draw comes from the `Prng` argument; iteration order
// is fixed, so results are byte-identical for a seed. Money never enters here (callers convert micro
// integers to float returns at their boundary).
import { mean, percentile } from "./bootstrap";
import { belowInt, type Prng, uniform01 } from "./rng";

/** Default expected block length in sessions (`bootstrap_block_sessions`, CTX-012). */
export const DEFAULT_BLOCK_SESSIONS = 120;
/** Default replicates for production cells (docs/M15_design.md §6). Tests pass a small R. */
export const DEFAULT_REPLICATES = 2000;
/** Below this many populated calendar blocks n_eff is undefined (OI-15, pass 28). */
export const MIN_BLOCKS_FOR_NEFF = 10;
export const CI_LEVEL = 0.9 as const;

/** The shared interval shape (docs/M15_design.md §3a). */
export type Ci = {
  readonly point: number;
  readonly lo: number;
  readonly hi: number;
  readonly level: typeof CI_LEVEL;
  readonly nEff: number | undefined;
};

/** A statistic that could not be computed, with the plain reason. */
export type StatUndefined = { readonly undefined: string };

export function isUndefined<T>(x: T | StatUndefined): x is StatUndefined {
  return typeof x === "object" && x !== null && "undefined" in x;
}

/** A bootstrap interval with its one-sided bounds and the n_eff bookkeeping. */
export type BootCi = Ci & {
  /** One-sided 90 % lower bound (10th percentile of the replicates). */
  readonly oneSidedLo: number;
  /** One-sided 90 % upper bound (90th percentile of the replicates). */
  readonly oneSidedHi: number;
  readonly rows: number;
  /** u_s = min(1, Σψ² / Σ_c T_c²): the inverse same-code design effect of the influence values (D-298). */
  readonly uniqueShare: number;
  /** Block-variance ratio D_s (floor 1): same-date correlation on contiguous L-session blocks (D-299). */
  readonly designEffect: number;
  /** Populated calendar blocks used for D_s. */
  readonly blocks: number;
  readonly replicates: number;
  /** Replicates with a non-finite statistic, dropped from the percentiles (≤ `maxNonFiniteShare`). */
  readonly nonFinite: number;
  readonly redraws: number;
};

export type BlockLayout = {
  /** Entry-session index (0..S−1) of each row. */
  readonly sessions: readonly number[];
  /** Number of sessions S in the window. */
  readonly sessionCount: number;
  /** Code of each row (for u); omit when every row is its own code. */
  readonly codes?: readonly string[];
};

export type BootstrapOptions = {
  /** Expected block length in sessions; default `DEFAULT_BLOCK_SESSIONS`. */
  readonly expectedBlock?: number;
  /** Longest hold in sessions: the block floor (embargo). Default 0. */
  readonly maxHold?: number;
  readonly replicates?: number;
  /** Share of replicates a statistic may lose to non-finite values before it is undefined. Default 0. */
  readonly maxNonFiniteShare?: number;
};

/** A statistic over a multiset of row indexes (with repeats). */
export type RowStatistic = (rows: Int32Array) => number;

type Csr = { readonly offsets: Int32Array; readonly rowAt: Int32Array };

function csr(layout: BlockLayout): Csr {
  const { sessions, sessionCount: S } = layout;
  const n = sessions.length;
  if (!Number.isInteger(S) || S < 1)
    throw new RangeError("sessionCount must be a positive integer");
  if (n === 0) throw new RangeError("at least one row is required");
  if (layout.codes && layout.codes.length !== n)
    throw new RangeError("codes must have one entry per row");
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
  return { offsets, rowAt };
}

function resolve(opts: BootstrapOptions): {
  block: number;
  maxHold: number;
  replicates: number;
} {
  const maxHold = opts.maxHold ?? 0;
  const block = Math.max(opts.expectedBlock ?? DEFAULT_BLOCK_SESSIONS, maxHold);
  const replicates = opts.replicates ?? DEFAULT_REPLICATES;
  if (!Number.isInteger(block) || block < 1) throw new RangeError("expectedBlock must be >= 1");
  if (!Number.isInteger(maxHold) || maxHold < 0) throw new RangeError("maxHold must be >= 0");
  if (!Number.isInteger(replicates) || replicates < 1)
    throw new RangeError("replicates must be a positive integer");
  return { block, maxHold, replicates };
}

/** Several statistics evaluated on the same drawn rows (one value each). */
export type RowStatistics = (rows: Int32Array) => readonly number[];

/**
 * Draw `replicates` stationary-block-bootstrap replicates of `statistics` (several statistics share one
 * draw). Returns one Float64Array per statistic, in draw order, and the number of empty replicates
 * redrawn.
 */
export function stationaryBlockBootstrapMany(
  layout: BlockLayout,
  statistics: RowStatistics,
  count: number,
  prng: Prng,
  opts: BootstrapOptions = {},
): { readonly values: readonly Float64Array[]; readonly redraws: number; readonly block: number } {
  const { block, replicates: B } = resolve(opts);
  const S = layout.sessionCount;
  const { offsets, rowAt } = csr(layout);
  const n = layout.sessions.length;
  // Geometric block length with mean `block`: len = 1 + floor(log(u) / log(1 − p)), p = 1 / block
  // (block 1 → every length is 1).
  const logQ = block > 1 ? Math.log(1 - 1 / block) : -Infinity;
  const values = Array.from({ length: count }, () => new Float64Array(B));
  // Rows per drawn session vary, so the collected row list is grown as needed.
  let buf = new Int32Array(Math.max(16, 2 * n));
  let redraws = 0;
  for (let b = 0; b < B; b += 1) {
    for (;;) {
      let got = 0;
      let drawn = 0;
      while (drawn < S) {
        let len = 1;
        if (block > 1) {
          const u = Math.max(uniform01(prng), Number.MIN_VALUE);
          len = 1 + Math.floor(Math.log(u) / logQ);
        }
        if (len > S - drawn) len = S - drawn; // the last block is trimmed to S sessions
        let sess = belowInt(prng, S);
        for (let o = 0; o < len; o += 1) {
          const from = offsets[sess]!;
          const to = offsets[sess + 1]!;
          if (to > from) {
            if (got + (to - from) > buf.length) {
              const grown = new Int32Array(Math.max(2 * buf.length, got + (to - from)));
              grown.set(buf);
              buf = grown;
            }
            for (let p = from; p < to; p += 1) buf[got++] = rowAt[p]!;
          }
          sess += 1;
          if (sess === S) sess = 0;
        }
        drawn += len;
      }
      if (got > 0) {
        const v = statistics(buf.subarray(0, got));
        if (v.length !== count) throw new RangeError("statistics returned the wrong count");
        for (let k = 0; k < count; k += 1) values[k]![b] = v[k]!;
        break;
      }
      redraws += 1;
    }
  }
  return { values, redraws, block };
}

/** Draw `replicates` replicates of one statistic. */
export function stationaryBlockBootstrap(
  layout: BlockLayout,
  statistic: RowStatistic,
  prng: Prng,
  opts: BootstrapOptions = {},
): { readonly values: Float64Array; readonly redraws: number; readonly block: number } {
  const r = stationaryBlockBootstrapMany(layout, (rows) => [statistic(rows)], 1, prng, opts);
  return { values: r.values[0]!, redraws: r.redraws, block: r.block };
}

export type DesignEffect = {
  readonly designEffect: number;
  readonly blocks: number;
  readonly uniqueShare: number;
  readonly rows: number;
  /** R·u / D_s, or undefined below `MIN_BLOCKS_FOR_NEFF` populated blocks. */
  readonly nEff: number | undefined;
};

/**
 * n_eff of a statistic from its influence values (one per row, aligned with `layout.sessions`):
 * D_s on contiguous fixed calendar blocks of `block` = max(expectedBlock, maxHold) sessions (D-299),
 * u_s from the same influence values summed per code (D-298). Without `layout.codes` u_s = 1.
 */
export function effectiveN(
  layout: BlockLayout,
  influence: ArrayLike<number>,
  opts: BootstrapOptions = {},
): DesignEffect {
  const { block } = resolve(opts);
  const n = layout.sessions.length;
  if (influence.length !== n) throw new RangeError("influence must have one value per row");
  if (layout.codes && layout.codes.length !== n)
    throw new RangeError("codes must have one entry per row");
  const blockSums = new Map<number, number>();
  const codeSums = new Map<string, number>();
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    const psi = influence[i]!;
    sumSq += psi * psi;
    const b = Math.floor(layout.sessions[i]! / block);
    blockSums.set(b, (blockSums.get(b) ?? 0) + psi);
    if (layout.codes) {
      const c = layout.codes[i]!;
      codeSums.set(c, (codeSums.get(c) ?? 0) + psi);
    }
  }
  let sumBlockSq = 0;
  for (const t of blockSums.values()) sumBlockSq += t * t;
  let sumCodeSq = 0;
  for (const t of codeSums.values()) sumCodeSq += t * t;
  const designEffect = sumSq > 0 ? Math.max(1, sumBlockSq / sumSq) : 1;
  const uniqueShare = layout.codes && sumCodeSq > 0 ? Math.min(1, sumSq / sumCodeSq) : 1;
  const blocks = blockSums.size;
  const nEff = blocks >= MIN_BLOCKS_FOR_NEFF ? (n * uniqueShare) / designEffect : undefined;
  return { designEffect, blocks, uniqueShare, rows: n, nEff };
}

/**
 * Point estimate, bootstrap interval and n_eff of one statistic. `influence` gives the per-row influence
 * values of the statistic at the full sample (for the mean, x_i − x̄). Returns `{ undefined }` with the
 * reason when the sample cannot support an interval.
 */
export function bootstrapCi(
  layout: BlockLayout,
  statistic: RowStatistic,
  influence: ArrayLike<number>,
  prng: Prng,
  opts: BootstrapOptions = {},
): BootCi | StatUndefined {
  return bootstrapCiMany(layout, (rows) => [statistic(rows)], [influence], prng, opts)[0]!;
}

/**
 * Intervals of several statistics computed on the same replicate draws (e.g. a slope and its
 * intercept, or G and L of the break-even). One influence array per statistic, in the same order.
 */
export function bootstrapCiMany(
  layout: BlockLayout,
  statistics: RowStatistics,
  influences: readonly ArrayLike<number>[],
  prng: Prng,
  opts: BootstrapOptions = {},
): (BootCi | StatUndefined)[] {
  const n = layout.sessions.length;
  const K = influences.length;
  if (n === 0) return Array.from({ length: K }, () => ({ undefined: "no rows" }));
  const all = new Int32Array(n);
  for (let i = 0; i < n; i += 1) all[i] = i;
  const points = statistics(all);
  if (points.length !== K) throw new RangeError("one influence array per statistic is required");
  const { values, redraws } = stationaryBlockBootstrapMany(layout, statistics, K, prng, opts);
  return points.map((point, k) => {
    if (!Number.isFinite(point)) return { undefined: "statistic not finite on the full sample" };
    const all = values[k]!;
    const v = all.filter((x) => Number.isFinite(x));
    const nonFinite = all.length - v.length;
    if (nonFinite > (opts.maxNonFiniteShare ?? 0) * all.length) {
      return { undefined: `${nonFinite} of ${all.length} replicates not finite` };
    }
    const de = effectiveN(layout, influences[k]!, opts);
    return {
      point,
      lo: percentile(v, 0.05),
      hi: percentile(v, 0.95),
      level: CI_LEVEL,
      nEff: de.nEff,
      oneSidedLo: percentile(v, 0.1),
      oneSidedHi: percentile(v, 0.9),
      rows: n,
      uniqueShare: de.uniqueShare,
      designEffect: de.designEffect,
      blocks: de.blocks,
      replicates: all.length,
      nonFinite,
      redraws,
    };
  });
}

/** Mean of `values` over the drawn rows, as a RowStatistic. */
export function meanStatistic(values: ArrayLike<number>): RowStatistic {
  return (rows) => {
    let s = 0;
    for (let i = 0; i < rows.length; i += 1) s += values[rows[i]!]!;
    return s / rows.length;
  };
}

/** Influence values of the mean: x_i − x̄. */
export function meanInfluence(values: ArrayLike<number>): Float64Array {
  const m = mean(values);
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = values[i]! - m;
  return out;
}

/** Bootstrap interval of the mean of `values` (the CTX-021 gate statistic when `values` are net outcomes). */
export function bootstrapMean(
  layout: BlockLayout,
  values: readonly number[],
  prng: Prng,
  opts: BootstrapOptions = {},
): BootCi | StatUndefined {
  if (values.length !== layout.sessions.length)
    throw new RangeError("values must have one entry per row");
  return bootstrapCi(layout, meanStatistic(values), meanInfluence(values), prng, opts);
}

/**
 * Purge and embargo for out-of-fold evaluation (CTX-012 "out-of-fold, purged, time-blocked"): given
 * fold boundaries (session indexes where a fold starts), a row is purged when its outcome window
 * [session, session + hold] crosses a boundary and embargoed when its session lies within `hold`
 * sessions after a boundary. Returns the indexes of the rows kept, in input order.
 */
export function purgeEmbargo(
  sessions: readonly number[],
  boundaries: readonly number[],
  hold: number,
): number[] {
  if (!Number.isInteger(hold) || hold < 0) throw new RangeError("hold must be >= 0");
  const bs = [...boundaries].sort((a, b) => a - b);
  const kept: number[] = [];
  for (let i = 0; i < sessions.length; i += 1) {
    const s = sessions[i]!;
    let ok = true;
    for (const b of bs) {
      // purge: window straddles the boundary; embargo: starts within `hold` sessions after it
      if ((s < b && s + hold >= b) || (s >= b && s < b + hold)) {
        ok = false;
        break;
      }
    }
    if (ok) kept.push(i);
  }
  return kept;
}
