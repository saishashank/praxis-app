// Claim status machine (KB-073, D-530, D-536a). Pure. The edge set is the same as the claim_status_edge_guard
// trigger in migration 0022; tests/experts/status.test.ts checks all 64 pairs against the database.
import { CLAIM_STATUSES, type ClaimStatus } from "./types";

export const CLAIM_EDGES: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  extracted: ["owner_checked", "rejected", "parked"],
  owner_checked: ["formalised", "rejected", "parked"],
  formalised: ["screened", "parked"],
  screened: ["challenger", "parked", "rejected"],
  challenger: ["promoted", "rejected", "parked"],
  promoted: [],
  rejected: [],
  parked: ["owner_checked"],
};

export function isAllowedClaimEdge(from: ClaimStatus, to: ClaimStatus): boolean {
  return CLAIM_EDGES[from].includes(to);
}

/** Every (from, to) pair the machine allows, for tests and docs. */
export const ALL_CLAIM_PAIRS: readonly (readonly [ClaimStatus, ClaimStatus])[] =
  CLAIM_STATUSES.flatMap((a) => CLAIM_STATUSES.map((b) => [a, b] as const));

/** What happened to a claim or to the cluster it supports. */
export type ClaimEvent =
  | { readonly kind: "person_checked" } // Owner/Editor confirmed (or edited) the claim
  | { readonly kind: "cluster_confirmed"; readonly hasValidFit: boolean }
  | { readonly kind: "screened" } // a screening run covered the cluster
  | { readonly kind: "challenger_created" }
  | { readonly kind: "challenger_promoted" }
  | { readonly kind: "rejected" }
  | { readonly kind: "parked" }
  | { readonly kind: "reopened" }; // parked -> owner_checked

/**
 * The status a claim moves to for an event, or null when the event does nothing to a claim in `current`
 * (not an error: a cluster confirmed twice, a claim still waiting for its person). A cluster confirmed with a
 * valid fit emits `formalised` for an `owner_checked` claim, and only then can a run move it to `screened`
 * (D-536a: `screened` is reachable only from `formalised`). Illegal edges are never returned.
 */
export function nextStatusFor(current: ClaimStatus, event: ClaimEvent): ClaimStatus | null {
  let to: ClaimStatus | null;
  switch (event.kind) {
    case "person_checked":
      to = current === "extracted" || current === "parked" ? "owner_checked" : null;
      break;
    case "cluster_confirmed":
      to = event.hasValidFit && current === "owner_checked" ? "formalised" : null;
      break;
    case "screened":
      to = current === "formalised" ? "screened" : null;
      break;
    case "challenger_created":
      to = current === "screened" ? "challenger" : null;
      break;
    case "challenger_promoted":
      to = current === "challenger" ? "promoted" : null;
      break;
    case "rejected":
      to = "rejected";
      break;
    case "parked":
      to = "parked";
      break;
    case "reopened":
      to = current === "parked" ? "owner_checked" : null;
      break;
  }
  return to !== null && isAllowedClaimEdge(current, to) ? to : null;
}
