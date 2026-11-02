// Disagreement (M15 C3a; spec ch. 17 CTX-023, CTX-013 step 10; key `cortex_disagreement_max`).
//
//   d = (number of score clusters whose signed mean opposes the sign of S) ÷ K (fixed).
//
// Inactive (empty), zero-mean and flag-zeroed clusters count as non-opposing; when S is exactly 0
// nothing opposes it (d = 0). Abstain when d > `cortex_disagreement_max` (0.4; 0.25–0.6). Floats.
import type { Score } from "./score";

/** Default `cortex_disagreement_max` (ch. 17 §17.11). */
export const DEFAULT_DISAGREEMENT_MAX = 0.4;

/** The plain label of the G10 failure. */
export const DISAGREEMENT_LABEL = "the evidence disagreed too much";

export type Disagreement = {
  readonly d: number;
  readonly opposing: number;
  readonly K: number;
  /** Clusters that opposed, in the map's order. */
  readonly opposingClusters: readonly string[];
};

export function disagreement(score: Score): Disagreement {
  const sign = Math.sign(score.s);
  const opposingClusters: string[] = [];
  if (sign !== 0) {
    for (const c of score.clusters) {
      if (c.n === 0 || c.mean === 0) continue; // inactive / zero-mean: non-opposing
      if (Math.sign(c.mean) === -sign) opposingClusters.push(c.cluster);
    }
  }
  return {
    d: opposingClusters.length / score.K,
    opposing: opposingClusters.length,
    K: score.K,
    opposingClusters,
  };
}

export type DisagreementTest =
  | { readonly pass: true; readonly d: number }
  | { readonly pass: false; readonly d: number; readonly max: number; readonly label: string };

/** CTX-023: abstain when d > max (strictly; d = max passes). */
export function disagreementTest(
  score: Score,
  max: number = DEFAULT_DISAGREEMENT_MAX,
): DisagreementTest {
  if (!(max >= 0 && max <= 1)) throw new RangeError("cortex_disagreement_max must be in [0, 1]");
  const { d } = disagreement(score);
  return d > max ? { pass: false, d, max, label: DISAGREEMENT_LABEL } : { pass: true, d };
}
