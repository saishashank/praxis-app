// Score layer (M15 C3a): eligibility → cluster means and S → Platt p under the refit guard →
// disagreement. Pure (D-279); the one-call wrapper `scoreCode` is what night.ts (C3c) uses per code.
export * from "./types";
export * from "./eligibility";
export * from "./score";
export * from "./map";
export * from "./disagreement";

import { disagreement, type Disagreement } from "./disagreement";
import { eligibility, type Eligibility } from "./eligibility";
import { mapGuard, pOf, type MapGuard } from "./map";
import { scoreOf, type Score } from "./score";
import type { CodeFeatures, CortexMap, ScoredAngle } from "./types";

export type CodeScore =
  | {
      readonly status: "ineligible";
      readonly eligibility: Extract<Eligibility, { eligible: false }>;
    }
  | {
      readonly status: "scored";
      readonly score: Score;
      readonly disagreement: Disagreement;
      /** null when the map guard fails (`guard` says why): the code is scored but has no p. */
      readonly p: number | null;
      readonly guard: MapGuard;
    };

/**
 * One code tonight: ineligible on any undefined scored angle; else S over the map's clusters (or the
 * declared clusters when no map is loaded), d, and p when the map passes the refit guard.
 * `currentHash` = `activeSetHash(scored)`, computed once per family by the caller.
 */
export function scoreCode(
  features: CodeFeatures,
  scored: readonly ScoredAngle[],
  map: CortexMap | undefined,
  currentHash: string,
  clustersDeclared: readonly CortexMap["clusters"][number][],
): CodeScore {
  const elig = eligibility(features, scored);
  if (!elig.eligible) return { status: "ineligible", eligibility: elig };
  const guard = mapGuard(map, currentHash, clustersDeclared);
  const clusters = guard.ok ? guard.map.clusters : clustersDeclared;
  const score = scoreOf(features, scored, clusters, clusters.length);
  return {
    status: "scored",
    score,
    disagreement: disagreement(score),
    p: guard.ok ? pOf(guard.map, score.s) : null,
    guard,
  };
}
