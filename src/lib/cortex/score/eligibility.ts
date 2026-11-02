// Eligibility (M15 C3a; spec ch. 17 CTX-012 "Eligibility", CTX-013 step 2, CTX-055 "warming up").
// A candidate whose scored set holds ANY undefined angle (warming up, missing input, unlabelled text)
// is ineligible tonight: no partial set is ever scored. A flag or a bucket is a defined value.
import type { CodeFeatures, ScoredAngle } from "./types";

/** The plain label of the G02 failure (CTX-070 wording lives in gates/list.ts; this is its source). */
export const WARMING_UP_LABEL = "we do not have enough history on this company yet (warming up)";

export type Eligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason: "warming_up";
      /** The scored angles with no value tonight, sorted by id (same bytes for the same inputs). */
      readonly missing: readonly string[];
      readonly label: string;
    };

/** CTX-012: eligible only when every angle of the scored set has a defined value. */
export function eligibility(features: CodeFeatures, scored: readonly ScoredAngle[]): Eligibility {
  const missing: string[] = [];
  for (const a of scored) if (features.get(a.id) === undefined) missing.push(a.id);
  if (missing.length === 0) return { eligible: true };
  missing.sort();
  return { eligible: false, reason: "warming_up", missing, label: WARMING_UP_LABEL };
}
