// Null drivers and MDEs for the permission pipeline (M15 C2; spec ch. 17 CTX-035, AT-51).
//
//   placebo          the whole permission pipeline run on ≥ 50 shuffled-outcome replays must allow on
//                    average ≤ 0.35 families per run + 1.35 standard errors (sized so that a correctly
//                    calibrated 5 % pipeline passes about 90 % of the time, pass 28). `placeboRuns`
//                    shuffles the outcomes against the setups with the Prng and calls the caller's
//                    pipeline; `placeboTest` evaluates the rule on the per-run counts.
//   random-angle     the live score must rank above the 95th percentile of ≥ 1,000 matched random score
//                    sets. `randomAngleSets` draws K-subsets of the candidate pool (the
//                    `randomSignalSource` pattern of replay/nullRuns.ts); `randomAngleNull` applies
//                    the rule to the scores.
//   MDEs             minimum detectable effect of a statistic at n_eff 100, 150 and 300, from
//                    `minimumDetectableEffect` (stats/gates.ts) with se = sd / √n_eff.
//
// Pure; every random draw through the Prng argument; the caller's pipeline is a plain function.
import { mean, percentile, sampleSd } from "./bootstrap";
import { minimumDetectableEffect, POWER } from "./gates";
import { belowInt, type Prng } from "./rng";

/** CTX-035 placebo rule. */
export const PLACEBO_MIN_RUNS = 50;
export const PLACEBO_MAX_MEAN_ALLOWED = 0.35;
export const PLACEBO_SE_MULTIPLIER = 1.35;
/** CTX-035 random-angle rule. */
export const RANDOM_ANGLE_MIN_SETS = 1000;
export const RANDOM_ANGLE_QUANTILE = 0.95;
/** The n_eff values at which the page publishes MDEs (CTX-035). */
export const MDE_NEFF_LEVELS: readonly number[] = [100, 150, 300];
/** One-sided level of the permission statistics (the 90 % bounds). */
export const PERMISSION_LEVEL = 0.1;

/** Fisher–Yates permutation of 0..n−1, draws from the Prng in a fixed order. */
export function permutation(n: number, prng: Prng): Int32Array {
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i += 1) idx[i] = i;
  for (let i = n - 1; i > 0; i -= 1) {
    const j = belowInt(prng, i + 1);
    const t = idx[i]!;
    idx[i] = idx[j]!;
    idx[j] = t;
  }
  return idx;
}

/** `values` reordered by a fresh permutation (the shuffled-outcome replay's outcome column). */
export function shuffle<T>(values: readonly T[], prng: Prng): T[] {
  const idx = permutation(values.length, prng);
  return Array.from(idx, (i) => values[i]!);
}

export type PlaceboResult = {
  readonly runs: number;
  /** Mean number of families allowed per shuffled run. */
  readonly meanAllowed: number;
  /** Standard error of that mean (sample sd / √runs). */
  readonly se: number;
  /** The rule's bound: `maxMean` + `seMultiplier` × se. */
  readonly bound: number;
  readonly pass: boolean;
  /** False when fewer than `PLACEBO_MIN_RUNS` runs were supplied (the result is then not evidence). */
  readonly enoughRuns: boolean;
};

/** Evaluate the placebo rule on the families-allowed count of each shuffled run. */
export function placeboTest(
  allowedPerRun: readonly number[],
  opts: {
    readonly maxMean?: number;
    readonly seMultiplier?: number;
    readonly minRuns?: number;
  } = {},
): PlaceboResult {
  const runs = allowedPerRun.length;
  if (runs === 0) throw new RangeError("at least one run is required");
  const maxMean = opts.maxMean ?? PLACEBO_MAX_MEAN_ALLOWED;
  const mult = opts.seMultiplier ?? PLACEBO_SE_MULTIPLIER;
  const minRuns = opts.minRuns ?? PLACEBO_MIN_RUNS;
  const m = mean(allowedPerRun);
  const se = runs > 1 ? sampleSd(allowedPerRun) / Math.sqrt(runs) : 0;
  const bound = maxMean + mult * se;
  return { runs, meanAllowed: m, se, bound, pass: m <= bound, enoughRuns: runs >= minRuns };
}

/**
 * Run the permission pipeline on `runs` shuffled-outcome replays. `pipeline(outcomes)` receives the
 * outcome column permuted against the (fixed) setups and returns the number of families it allowed.
 */
export function placeboRuns<T>(
  outcomes: readonly T[],
  pipeline: (shuffled: readonly T[], run: number) => number,
  runs: number,
  prng: Prng,
): number[] {
  if (!Number.isInteger(runs) || runs < 1) throw new RangeError("runs must be a positive integer");
  const out = new Array<number>(runs);
  for (let r = 0; r < runs; r += 1) out[r] = pipeline(shuffle(outcomes, prng), r);
  return out;
}

/** Draw `sets` distinct-member subsets of size `k` from `pool` (members in pool order within a set). */
export function randomAngleSets<T>(pool: readonly T[], k: number, sets: number, prng: Prng): T[][] {
  if (!Number.isInteger(k) || k < 1 || k > pool.length)
    throw new RangeError("k must be in 1..pool.length");
  if (!Number.isInteger(sets) || sets < 1) throw new RangeError("sets must be a positive integer");
  const out: T[][] = new Array(sets);
  for (let s = 0; s < sets; s += 1) {
    // Partial Fisher–Yates: the first k of a permutation, then restored to pool order.
    const idx = permutation(pool.length, prng).subarray(0, k);
    const chosen = Array.from(idx).sort((a, b) => a - b);
    out[s] = chosen.map((i) => pool[i]!);
  }
  return out;
}

export type RandomAngleNullResult = {
  readonly liveScore: number;
  readonly sets: number;
  /** The 95th percentile of the random-set scores. */
  readonly q95: number;
  /** Share of random sets scoring below the live score. */
  readonly liveRank: number;
  readonly pass: boolean;
  /** False below `RANDOM_ANGLE_MIN_SETS` sets (the result is then not evidence). */
  readonly enoughSets: boolean;
};

/** CTX-035: pass when the live score is above the 95th percentile of the random-set scores. */
export function randomAngleNull(
  liveScore: number,
  randomScores: readonly number[],
  opts: { readonly quantile?: number; readonly minSets?: number } = {},
): RandomAngleNullResult {
  if (randomScores.length === 0) throw new RangeError("at least one random set is required");
  if (!Number.isFinite(liveScore)) throw new RangeError("liveScore must be finite");
  const q = opts.quantile ?? RANDOM_ANGLE_QUANTILE;
  const q95 = percentile(randomScores, q);
  let below = 0;
  for (const s of randomScores) if (s < liveScore) below += 1;
  return {
    liveScore,
    sets: randomScores.length,
    q95,
    liveRank: below / randomScores.length,
    pass: liveScore > q95,
    enoughSets: randomScores.length >= (opts.minSets ?? RANDOM_ANGLE_MIN_SETS),
  };
}

/**
 * Score ≥ `sets` random K-subsets of `pool` with the caller's `scoreOf` (the same map + permission
 * pipeline the live set went through) and apply the rule.
 */
export function randomAngleNullRun<T>(
  liveScore: number,
  pool: readonly T[],
  k: number,
  sets: number,
  scoreOf: (set: readonly T[], index: number) => number,
  prng: Prng,
): RandomAngleNullResult {
  const scores = randomAngleSets(pool, k, sets, prng).map((set, i) => scoreOf(set, i));
  return randomAngleNull(liveScore, scores);
}

export type MdeRow = { readonly nEff: number; readonly mde: number };

/**
 * MDE of a statistic whose per-row sd is `sdPerRow`, at each n_eff level: (z_{1−level} + z_power) ×
 * sd / √n_eff. For the Brier skill use the sd of its influence values; for the slope likewise.
 */
export function mdeRows(
  sdPerRow: number,
  opts: {
    readonly level?: number;
    readonly power?: number;
    readonly nEffs?: readonly number[];
  } = {},
): MdeRow[] {
  if (!(sdPerRow >= 0)) throw new RangeError("sdPerRow must not be negative");
  const level = opts.level ?? PERMISSION_LEVEL;
  const power = opts.power ?? POWER;
  return (opts.nEffs ?? MDE_NEFF_LEVELS).map((nEff) => ({
    nEff,
    mde: minimumDetectableEffect(level, sdPerRow / Math.sqrt(nEff), power),
  }));
}
