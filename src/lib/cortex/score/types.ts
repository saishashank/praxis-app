// Score-layer shapes (M15 C3a; docs/M15_design.md 3a "night": CortexMap; spec ch. 17 CTX-012, CTX-023).
import type { AngleCluster, AngleValue } from "../angles/types";

export type { AngleCluster, AngleValue };

/**
 * D-923 / C.3: the weights of a learner rule version (`cortex_map.params_json.weights`). An angle or a
 * cluster absent here weighs 1; a weight of 0 benches an angle but it is still computed and must be
 * defined (D-926). Absent weights = equal weights, the fixed Cortex's bytes (LRN-AT-1).
 */
export type ScoreWeights = {
  readonly angle?: Readonly<Record<string, number>>;
  readonly cluster?: Readonly<Record<string, number>>;
};

/** One family's fitted map (`cortex_map.params_json` + the row's `active_set_hash`), design 3a. */
export type CortexMap = {
  readonly family: string;
  readonly ruleVersion: string;
  readonly fittedAt: string;
  /** Platt slope and intercept on S standardised within the family (calibration.ts PlattMap). */
  readonly a: number;
  readonly b: number;
  readonly sMean: number;
  readonly sSd: number;
  /** The FIXED number of score clusters of the rule version (K ≤ 6, CTX-012). */
  readonly K: number;
  /** The declared clusters, length K, in a fixed order. */
  readonly clusters: readonly AngleCluster[];
  /** `activeSetHash` of the scored set the map was fitted on (CTX-012 refit guard, CTX-060). */
  readonly activeSetHash: string;
  readonly nEff: number;
  /** D-923: the learner's weights and the stored `weights_hash` (both or neither; LRN-AT-6). */
  readonly weights?: ScoreWeights;
  readonly weightsHash?: string;
  /** D-923: the learner's weight generation (one map row per generation). */
  readonly generation?: number;
  /** D-923: a learner rule version (`<family>.learn`), never the family's fixed rule. */
  readonly learner?: boolean;
};

/** The scored set tonight: the active (or watch) score angles with their cluster and version. */
export type ScoredAngle = {
  readonly id: string;
  readonly version: number;
  readonly cluster: AngleCluster;
  /** C.3: the angle's weight inside its cluster mean (absent = 1; 0 = benched, still required). */
  readonly weight?: number;
};

/** One code's features tonight: angle id → value (after rank standardisation). */
export type CodeFeatures = ReadonlyMap<string, AngleValue>;
