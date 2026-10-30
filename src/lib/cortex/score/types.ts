// Score-layer shapes (M15 C3a; docs/M15_design.md 3a "night": CortexMap; spec ch. 17 CTX-012, CTX-023).
import type { AngleCluster, AngleValue } from "../angles/types";

export type { AngleCluster, AngleValue };

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
};

/** The scored set tonight: the active (or watch) score angles with their cluster and version. */
export type ScoredAngle = {
  readonly id: string;
  readonly version: number;
  readonly cluster: AngleCluster;
};

/** One code's features tonight: angle id → value (after rank standardisation). */
export type CodeFeatures = ReadonlyMap<string, AngleValue>;
