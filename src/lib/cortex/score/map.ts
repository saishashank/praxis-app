// Platt map apply with the refit guard (M15 C3a; spec ch. 17 CTX-012 "Map", CTX-060; design D-281).
//
//   p = logistic(a·S* + b), S* = (S − s_mean) / s_sd standardised within the family on the development
//   split (C2 `plattApply`). The map is data loaded by the import; it carries the hash of the scored
//   set it was fitted on. Refit guard: a map whose `activeSetHash` differs from tonight's scored set
//   (any change to the active set, weights, caps or thresholds, CTX-012/CTX-060) gives NO p: the
//   family runs in shadow until the charged-trial refit lands (P1 hook). A missing map is `map_missing`
//   (D-281). Never an exception on the night path: the result says why.
import { canonicalJson, sha256Hex } from "@/lib/arena/cohort";
import { plattApply } from "@/lib/stats/calibration";
import type { CortexMap, ScoredAngle } from "./types";

/**
 * The hash of a scored set: sha256 of the canonical JSON of `["id@version", ...]` sorted by id. The
 * same set in any order gives the same hash; a version bump or a status change changes it.
 */
export function activeSetHash(scored: readonly ScoredAngle[]): string {
  const ids = scored.map((a) => `${a.id}@${a.version}`).sort();
  if (new Set(ids).size !== ids.length) throw new RangeError("duplicate angle in the scored set");
  return sha256Hex(canonicalJson(ids));
}

/** Why a map yields no p tonight. */
export type MapGuardReason = "map_missing" | "map_stale" | "map_invalid";

export type MapGuard =
  | { readonly ok: true; readonly map: CortexMap }
  | { readonly ok: false; readonly reason: MapGuardReason; readonly detail: string };

/**
 * CTX-012 refit guard. `currentHash` is `activeSetHash` of tonight's scored set of the family;
 * `clustersDeclared` the clusters the rule version declares (must match the map's K and set).
 */
export function mapGuard(
  map: CortexMap | undefined,
  currentHash: string,
  clustersDeclared?: readonly string[],
): MapGuard {
  if (map === undefined) return { ok: false, reason: "map_missing", detail: "no map loaded" };
  if (map.activeSetHash !== currentHash) {
    return {
      ok: false,
      reason: "map_stale",
      detail: `map fitted on ${map.activeSetHash.slice(0, 12)}…, tonight ${currentHash.slice(0, 12)}…`,
    };
  }
  if (!Number.isInteger(map.K) || map.K < 1 || map.K > 6 || map.clusters.length !== map.K) {
    return {
      ok: false,
      reason: "map_invalid",
      detail: `K ${map.K} vs ${map.clusters.length} clusters`,
    };
  }
  if (!Number.isFinite(map.a) || !Number.isFinite(map.b) || !(map.sSd > 0)) {
    return { ok: false, reason: "map_invalid", detail: "non-finite Platt parameters or s_sd <= 0" };
  }
  if (clustersDeclared !== undefined) {
    const want = [...clustersDeclared].sort().join(",");
    const have = [...map.clusters].sort().join(",");
    if (want !== have) {
      return { ok: false, reason: "map_stale", detail: `clusters ${have} vs declared ${want}` };
    }
  }
  return { ok: true, map };
}

/** p for a raw S under a guarded map (C2 `plattApply`). */
export function pOf(map: Pick<CortexMap, "a" | "b" | "sMean" | "sSd">, s: number): number {
  if (!Number.isFinite(s)) throw new RangeError("S must be finite");
  return plattApply(map, s);
}
