// Seeded randomness for the statistics library (M4 design 2.8, decision 8). Re-uses the SplitMix64
// PRNG of the arena cohort module (never copied). No Math.random, no clock.
import { createPrng, deriveRngSeed, type Prng } from "../arena/cohort";

export type { Prng };

/** Fixed master seed for statistics scopes unless the caller passes its own (the arena master seed in M4). */
export const STATS_MASTER_SEED = 20_261_018n;

/** A PRNG for a scope string such as `boot:<test_id>` or `null:<run>:<i>` (design 2.8). */
export function scopedPrng(scope: string, masterSeed: bigint = STATS_MASTER_SEED): Prng {
  return createPrng(deriveRngSeed(masterSeed, scope));
}

const TWO_POW_53 = 9_007_199_254_740_992;

/** Uniform double in [0, 1) from the top 53 bits of the next output. */
export function uniform01(rng: Prng): number {
  return Number(rng.nextU64() >> 11n) / TWO_POW_53;
}

/** Uniform integer in [0, n) for a safe-integer n. */
export function belowInt(rng: Prng, n: number): number {
  return Number(rng.below(BigInt(n)));
}
