// The score S (M15 C3a; spec ch. 17 CTX-012 "Score", CTX-011; learner weights: design C.3, D-923, D-926).
//
//   S = (1/K) Σ_c mean(f_i : i ∈ c)   over the FIXED, declared K clusters of the rule version.
//
// Cluster means are over the scored angles of that cluster. A flag or bucket value is a defined,
// flag-zeroed contribution of 0 (CTX-023: "flag-zeroed clusters count as non-opposing"); an undefined
// value must have been caught by `eligibility` first and is a programming error here. An empty
// cluster (every angle of it absent from the scored set) is 0 and K stays fixed.
//
// Weights (a learner rule version only; the fixed Cortex has none and its bytes are unchanged, LRN-AT-1):
//   mean_c = Σ w_i·f_i / Σ w_i over the cluster's scored angles (w absent = 1). An angle with w = 0 is
//            still computed and must be defined (eligibility is unchanged, D-926); a cluster whose every
//            angle has w = 0 contributes 0.
//   S      = Σ cw_c·mean_c / Σ cw_c over the declared clusters (cw absent = 1; K stays fixed).
// With every weight 1 both formulas are exactly the equal-weight ones (Σ 1·x = Σ x and Σ 1 = n in
// floating point), so no weight gives the same bytes as today. `cluster_weight_max` caps a cluster's
// share cw_c / Σ cw; a violation is `map_invalid` (the refit guard reports it; here it throws), never
// silently fixed. Statistics are floats.
import type { AngleCluster, AngleValue, CodeFeatures, ScoredAngle, ScoreWeights } from "./types";

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

/** Relative float tolerance of the cluster cap check (a share at the cap passes). */
const CAP_TOLERANCE = 1e-9; // threshold-ok: float tolerance of the cap comparison, not a rule

/** The numeric contribution of one defined angle value: a number as is, a flag or bucket as 0. */
export function contributionOf(value: Exclude<AngleValue, undefined>): number {
  return typeof value === "number" ? value : 0;
}

const badWeight = (w: unknown): boolean => typeof w !== "number" || !Number.isFinite(w) || w < 0;

/**
 * Why a set of weights cannot be scored (null = it can): a weight that is not a finite number ≥ 0, a
 * cluster weight for a cluster the rule does not declare, no positive cluster weight, or (when
 * `clusterWeightMax` is given) a cluster whose share cw_c / Σ cw exceeds the cap. The cap is
 * max(cluster_weight_max, 1/K): with K clusters at equal weight no share can be below 1/K, so equal
 * weights are never a violation (D-933 proposed).
 */
export function weightsProblem(
  weights: ScoreWeights,
  clusters: readonly AngleCluster[],
  clusterWeightMax?: number,
): string | null {
  for (const [id, w] of Object.entries(weights.angle ?? {})) {
    if (badWeight(w)) return `angle weight ${id} is not a number >= 0`;
  }
  const cw = weights.cluster ?? {};
  for (const [c, w] of Object.entries(cw)) {
    if (!(clusters as readonly string[]).includes(c)) return `cluster weight for undeclared ${c}`;
    if (badWeight(w)) return `cluster weight ${c} is not a number >= 0`;
  }
  let total = 0;
  for (const c of clusters) total += cw[c] ?? 1;
  if (!(total > 0)) return "no cluster has a positive weight";
  if (clusterWeightMax !== undefined && clusters.length > 0) {
    const cap = Math.max(clusterWeightMax, 1 / clusters.length);
    for (const c of clusters) {
      const share = (cw[c] ?? 1) / total;
      if (share > cap * (1 + CAP_TOLERANCE)) {
        return `cluster ${c} carries ${share.toFixed(4)} of the score, above the cap ${cap.toFixed(4)}`;
      }
    }
  }
  return null;
}

/** Cluster means over the scored set, in the declared cluster order (weights from `ScoredAngle.weight`). */
export function clusterMeans(
  features: CodeFeatures,
  scored: readonly ScoredAngle[],
  clusters: readonly AngleCluster[],
): readonly ClusterMean[] {
  // Sorted by id once so S is the same bytes whatever order the scored set arrives in (AT-50, review S2).
  const ordered = [...scored].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return clusters.map((cluster) => {
    let n = 0;
    let wsum = 0;
    let sum = 0;
    for (const a of ordered) {
      if (a.cluster !== cluster) continue;
      const v = features.get(a.id);
      if (v === undefined) throw new RangeError(`${a.id} is undefined: run eligibility first`);
      const w = a.weight ?? 1;
      if (badWeight(w)) throw new RangeError(`${a.id} has a weight that is not a number >= 0`);
      n += 1;
      wsum += w;
      sum += w * contributionOf(v);
    }
    return { cluster, n, mean: wsum > 0 ? sum / wsum : 0 };
  });
}

/**
 * S over the map's fixed K clusters. `clusters.length` must equal K (the declared set is data of the
 * rule version; a mismatch is a stale map, caught by the refit guard before this is called).
 * `weights` (a learner rule version) weigh angles within and clusters across; absent = equal.
 */
export function scoreOf(
  features: CodeFeatures,
  scored: readonly ScoredAngle[],
  clusters: readonly AngleCluster[],
  K: number = clusters.length,
  weights?: ScoreWeights,
  clusterWeightMax?: number,
): Score {
  if (!Number.isInteger(K) || K < 1 || K > 6) throw new RangeError("K must be an integer in 1..6");
  if (clusters.length !== K) throw new RangeError("the declared clusters must number K");
  if (new Set(clusters).size !== K) throw new RangeError("clusters must be distinct");
  if (weights !== undefined) {
    const problem = weightsProblem(weights, clusters, clusterWeightMax);
    if (problem !== null) throw new RangeError(`map_invalid: ${problem}`);
  }
  const angleW = weights?.angle;
  const set =
    angleW === undefined ? scored : scored.map((a) => ({ ...a, weight: angleW[a.id] ?? a.weight }));
  const means = clusterMeans(features, set, clusters);
  const cw = weights?.cluster ?? {};
  let sum = 0;
  let den = 0;
  for (const c of means) {
    const w = cw[c.cluster] ?? 1;
    sum += w * c.mean;
    den += w;
  }
  const s = sum / den;
  return { s: s === 0 ? 0 : s, K, clusters: means }; // never -0
}
