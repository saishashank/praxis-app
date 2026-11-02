// Family fit (D-514, D-515). Pure. A cluster is screenable only as a parameter set of a v1 family F1..F6:
// the full canonical Lane-B key set, every value inside its registry bounds, structural switches (if any) from
// their allowed words. Anything else is parked with a reason; a wrong fit is caught here at run time.
import {
  FAMILY_OPTIONAL_KEYS,
  FAMILY_PARAM_KEYS,
  checkStructuralParams,
  paramBounds,
} from "@/lib/agents/families/ruleSchema";
import { FAMILIES, type Family } from "@/lib/agents/schema";
import type { ClusterRow } from "./types";

/** A Lane-B value: a number, a structural word, or (F6 only) the insider score weights object. */
export type ParamValue = number | boolean | string | Readonly<Record<string, number>>;

/** F6 `insider_score_weights` has no numeric range; the registry validator wants these keys, each 0 to 1. */
const WEIGHT_KEYS = ["director_net", "holder_new_or_increase", "holder_decrease"] as const;
const WEIGHT_OPTIONAL = ["director_sale"] as const;
function weightsProblem(v: unknown): string | null {
  if (!isObj(v)) return "insider_score_weights must be an object of weights";
  for (const k of WEIGHT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) return `insider_score_weights missing ${k}`;
  }
  for (const [k, w] of Object.entries(v)) {
    const known =
      (WEIGHT_KEYS as readonly string[]).includes(k) ||
      (WEIGHT_OPTIONAL as readonly string[]).includes(k);
    if (!known) return `insider_score_weights has unknown ${k}`;
    if (typeof w !== "number" || !Number.isFinite(w) || w < 0 || w > 1)
      return `insider_score_weights.${k} must be 0 to 1`;
  }
  return null;
}

export type FitFailure = "invalid_fit" | "unknown_family" | "key_set" | "bounds";
export type FitOk = {
  readonly ok: true;
  readonly family: Family;
  readonly params: Readonly<Record<string, ParamValue>>;
};
export type FitResult =
  FitOk | { readonly ok: false; readonly reason: FitFailure; readonly detail: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (reason: FitFailure, detail: string): FitResult => ({ ok: false, reason, detail });

export function fitCheck(fit: unknown): FitResult {
  if (!isObj(fit) || !isObj(fit.params))
    return bad("invalid_fit", "fit must be { family, params }");
  const family = fit.family;
  if (typeof family !== "string" || !(FAMILIES as readonly string[]).includes(family))
    return bad("unknown_family", `family must be one of ${FAMILIES.join(", ")}`);
  const f = family as Family;
  const params = fit.params;
  const required = FAMILY_PARAM_KEYS[f];
  const optional = FAMILY_OPTIONAL_KEYS[f].map((s) => s.key);
  const missing = required.filter((k) => !Object.prototype.hasOwnProperty.call(params, k));
  if (missing.length > 0) return bad("key_set", `missing ${missing.join(", ")}`);
  const extra = Object.keys(params).filter((k) => !required.includes(k) && !optional.includes(k));
  if (extra.length > 0) return bad("key_set", `unknown ${extra.join(", ")}`);
  for (const k of required) {
    const v = params[k];
    if (k === "insider_score_weights") {
      const w = weightsProblem(v);
      if (w !== null) return bad("bounds", w);
      continue;
    }
    const b = paramBounds(k);
    if (typeof v !== "number" || !Number.isFinite(v))
      return bad("bounds", `${k} must be a finite number`);
    if (b === null) return bad("bounds", `${k} has no registry bounds`);
    if (v < b[0] || v > b[1]) return bad("bounds", `${k} outside ${b[0]}..${b[1]}`);
  }
  const structural = checkStructuralParams(f, params);
  if (structural.length > 0) return bad("bounds", structural[0]!);
  return { ok: true, family: f, params: params as FitOk["params"] };
}

export type ParkReason =
  | "needs_new_lineage"
  | "overlay_only"
  | "vocabulary_gap"
  | "not_testable"
  | "needs_new_data"
  | "invalid_fit";

/** Why a cluster cannot be screened (null = it can, as far as its own columns say). D-515. */
export function parkReason(
  cluster: Pick<ClusterRow, "testability" | "closestFamily" | "vocabularyGaps" | "familyFit">,
): ParkReason | null {
  if (cluster.testability === "not_testable") return "not_testable";
  if (cluster.testability !== "testable_eod") return "needs_new_data"; // needs_new_data and needs_intraday
  if (cluster.familyFit !== null && cluster.familyFit !== undefined) {
    return fitCheck(cluster.familyFit).ok ? null : "invalid_fit";
  }
  if (cluster.closestFamily === "overlay") return "overlay_only";
  if (cluster.closestFamily === "new") return "needs_new_lineage";
  if (cluster.vocabularyGaps > 0) return "vocabulary_gap";
  return "needs_new_lineage";
}
