// The score S (M15 C3a; spec ch. 17 CTX-012 "Score", CTX-011).
//
//   S = (1/K) Σ_c mean(f_i : i ∈ c)   over the FIXED, declared K clusters of the rule version.
//
// Cluster means are over the scored angles of that cluster. A flag or bucket value is a defined,
// flag-zeroed contribution of 0 (CTX-023: "flag-zeroed clusters count as non-opposing"); an undefined
// value must have been caught by `eligibility` first and is a programming error here. An empty
// cluster (every angle of it absent from the scored set) is 0 and K stays fixed. Equal cluster weights
// (any other weighting is a counted challenger); `cluster_weight_max` is a fit-time constraint on the
// declared set, not applied here. Statistics are floats.
import type { AngleCluster, AngleValue, CodeFeatures, ScoredAngle } from "./types";

export type ClusterMean = {
  readonly cluster: AngleCluster;
  /** Scored angles in the cluster (0 → the mean is 0 and the cluster is "inactive"). */
  readonly n: number;
  readonly mean: number;
};

export type Score = {
  readonly s: number;
  readonly K: number;
  /** One entry per declared cluster, in the map's order. */
  readonly clusters: readonly ClusterMean[];
};

/** The numeric contribution of one defined angle value: a number as is, a flag or bucket as 0. */
export function contributionOf(value: Exclude<AngleValue, undefined>): number {
  return typeof value === "number" ? value : 0;
}

/** Cluster means over the scored set, in the declared cluster order. */
export function clusterMeans(
  features: CodeFeatures,
  scored: readonly ScoredAngle[],
  clusters: readonly AngleCluster[],
): readonly ClusterMean[] {
  return clusters.map((cluster) => {
    let n = 0;
    let sum = 0;
    for (const a of scored) {
      if (a.cluster !== cluster) continue;
      const v = features.get(a.id);
      if (v === undefined) throw new RangeError(`${a.id} is undefined: run eligibility first`);
      n += 1;
      sum += contributionOf(v);
    }
    return { cluster, n, mean: n > 0 ? sum / n : 0 };
  });
}

/**
 * S over the map's fixed K clusters. `clusters.length` must equal K (the declared set is data of the
 * rule version; a mismatch is a stale map, caught by the refit guard before this is called).
 */
export function scoreOf(
  features: CodeFeatures,
  scored: readonly ScoredAngle[],
  clusters: readonly AngleCluster[],
  K: number = clusters.length,
): Score {
  if (!Number.isInteger(K) || K < 1 || K > 6) throw new RangeError("K must be an integer in 1..6");
  if (clusters.length !== K) throw new RangeError("the declared clusters must number K");
  if (new Set(clusters).size !== K) throw new RangeError("clusters must be distinct");
  const means = clusterMeans(features, scored, clusters);
  let sum = 0;
  for (const c of means) sum += c.mean;
  const s = sum / K;
  return { s: s === 0 ? 0 : s, K, clusters: means }; // never -0
}
