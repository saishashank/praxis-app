// VAL-114 daily rank quality (M14, D-232; docs/M14_design.md 2.2). Pure and deterministic: the only
// random draw is the seeded block bootstrap, and every iteration is sorted.
//   dailyRankIc    Spearman rank correlation (ties share the average rank) between the family's scores on
//                  D and the close(D+1) -> close(D+2) return minus the U1 median of the same return,
//                  on split-adjusted closes. A day with fewer than `minCodes` (10) scored codes is skipped.
//   summariseRankIc  circular block bootstrap of the daily IC series (21-session blocks = monthly,
//                  5 = weekly, B = 2,000): median IC, mean IC and the 90 % interval of the median.
import { mean, percentile } from "./bootstrap";
import { belowInt, scopedPrng, STATS_MASTER_SEED } from "./rng";

export const RANK_IC_MIN_CODES = 10; // threshold-ok: rank_ic_min_codes default (D-232)
export const RANK_IC_BLOCK_SESSIONS = { monthly: 21, weekly: 5 } as const; // threshold-ok: VAL-114 block lengths
export const RANK_IC_REPLICATES = 2000; // threshold-ok: rank_ic_bootstrap_replicates default

/** Average ranks (1-based); equal values share the mean of the ranks they span. */
export function averageRanks(values: readonly number[]): number[] {
  const idx = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]! || a - b);
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && values[idx[j + 1]!] === values[idx[i]!]) j += 1;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[idx[k]!] = r;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rho = Pearson correlation of the average ranks; null when either side is constant. */
export function spearman(x: readonly number[], y: readonly number[]): number | null {
  if (x.length !== y.length) throw new RangeError("x and y must have the same length");
  const n = x.length;
  if (n < 2) return null;
  const rx = averageRanks(x);
  const ry = averageRanks(y);
  const mx = mean(rx);
  const my = mean(ry);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = rx[i]! - mx;
    const dy = ry[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export type DailyIc = { readonly n: number; readonly ic: number | null };

/**
 * The IC of one day. `forward` is the close(D+1) -> close(D+2) return of each code on adjusted closes;
 * `u1Codes` are the U1 codes whose median forward return is subtracted. Codes without a forward
 * return are dropped (n counts the scored codes that have one).
 */
export function dailyRankIc(
  scores: readonly { readonly code: string; readonly score: number }[],
  forward: ReadonlyMap<string, number>,
  u1Codes: readonly string[],
  minCodes: number = RANK_IC_MIN_CODES,
): DailyIc {
  const u1 = median([...u1Codes].sort().flatMap((c) => (forward.has(c) ? [forward.get(c)!] : [])));
  if (u1 === null) return { n: 0, ic: null };
  const rows = [...scores]
    .filter((s) => forward.has(s.code) && Number.isFinite(s.score))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  if (rows.length < minCodes) return { n: rows.length, ic: null };
  const ic = spearman(
    rows.map((r) => r.score),
    rows.map((r) => forward.get(r.code)! - u1),
  );
  return { n: rows.length, ic };
}

export type RankIcSummary = {
  readonly nDays: number;
  readonly medianIc: number | null;
  readonly meanIc: number | null;
  readonly lower90: number | null;
  readonly upper90: number | null;
};

export type RankIcBootstrapOptions = {
  /** Seed scope, `rank_ic:<lineage>`. */
  readonly scope: string;
  readonly block?: number;
  readonly replicates?: number;
  readonly masterSeed?: bigint;
};

/**
 * Circular block bootstrap of the median of a daily IC series (oldest first): ceil(T / block) block
 * starts per replicate, blocks of consecutive days wrapping around the series, trimmed to T. The 90 %
 * interval is the 5th and 95th percentile of the replicate medians. Days without an IC are not passed in.
 */
export function summariseRankIc(
  ics: readonly number[],
  opts: RankIcBootstrapOptions,
): RankIcSummary {
  const T = ics.length;
  if (T === 0) return { nDays: 0, medianIc: null, meanIc: null, lower90: null, upper90: null };
  const block = Math.min(opts.block ?? RANK_IC_BLOCK_SESSIONS.monthly, T);
  const B = opts.replicates ?? RANK_IC_REPLICATES;
  if (!Number.isInteger(block) || block < 1)
    throw new RangeError("block must be a positive integer");
  const rng = scopedPrng(opts.scope, opts.masterSeed ?? STATS_MASTER_SEED);
  const draws = Math.ceil(T / block);
  const medians = new Float64Array(B);
  const sample = new Array<number>(draws * block);
  for (let b = 0; b < B; b += 1) {
    let k = 0;
    for (let d = 0; d < draws; d += 1) {
      const start = belowInt(rng, T);
      for (let o = 0; o < block; o += 1) sample[k++] = ics[(start + o) % T]!;
    }
    medians[b] = median(sample.slice(0, T))!;
  }
  return {
    nDays: T,
    medianIc: median(ics),
    meanIc: mean(ics),
    lower90: percentile(medians, 0.05),
    upper90: percentile(medians, 0.95),
  };
}
