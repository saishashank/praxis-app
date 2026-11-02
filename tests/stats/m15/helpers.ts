// Synthetic generators for the M15 C2 statistics tests: every draw through a seeded Prng, so each test
// is reproducible. No market data, no real tickers.
import { scopedPrng, uniform01, type Prng } from "@/lib/stats/rng";
import { logistic } from "@/lib/stats/calibration";
import type { BlockLayout } from "@/lib/stats/stationaryBootstrap";

export function prngFor(scope: string): Prng {
  return scopedPrng(`m15-c2:${scope}`);
}

/** Standard normal by Box–Muller (two uniforms per draw; the second is discarded for simplicity). */
export function normal(prng: Prng): number {
  let u = uniform01(prng);
  if (u === 0) u = 1e-12;
  const v = uniform01(prng);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function bernoulli(prng: Prng, p: number): 0 | 1 {
  return uniform01(prng) < p ? 1 : 0;
}

/** One row per session, codes cycling through `nCodes` names. */
export function layoutOf(n: number, nCodes = 25): BlockLayout {
  return {
    sessions: Array.from({ length: n }, (_, i) => i),
    sessionCount: n,
    codes: Array.from({ length: n }, (_, i) => `ZZ${String(i % nCodes).padStart(2, "0")}`),
  };
}

export type Planted = {
  readonly z: number[];
  /** The true probability behind each outcome. */
  readonly pTrue: number[];
  readonly y: (0 | 1)[];
};

/** Outcomes drawn from logistic(slope · z) with z standard normal: a calibrated predictor is pTrue. */
export function plantedOutcomes(n: number, slope: number, prng: Prng): Planted {
  const z: number[] = [];
  const pTrue: number[] = [];
  const y: (0 | 1)[] = [];
  for (let i = 0; i < n; i += 1) {
    const zi = normal(prng);
    const p = logistic(slope * zi);
    z.push(zi);
    pTrue.push(p);
    y.push(bernoulli(prng, p));
  }
  return { z, pTrue, y };
}

/** Small bootstrap settings for tests: 20-session blocks over a 600-session window give 30 blocks. */
export const TEST_BOOT = { expectedBlock: 20, maxHold: 0, replicates: 200 } as const;
