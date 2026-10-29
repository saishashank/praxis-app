// VAL-114 daily rank scores and the KB-081 rank variants (M14, D-232; docs/M14_design.md 2.2).
// WP0 SIGNATURE STUB: WP4 fills it in. Until then no code is scored, so no rank quality is computed.
//
// WP4 contract: `rankScores` gives a scalar score for every code of the family's tiers on D where the
// rank key is computable (the keys of rules.ts: F1 relative-strength percentile, F2/F3/F5 event AR or
// volume ratio, F4 minus RSI(2), F6 its first rank key). Entry thresholds are NOT applied. Event
// families score only codes with an eligible event group. The two KB-081 variants live here too:
//   composite3  equal-weight z-scores of 126-session momentum, minus 20-session volatility, and the
//               volume trend;
//   vol_scaled  the v1 score divided by the 20-session volatility.
// Pure and deterministic: sorted by code, no clock, no random source.
import type { RANK_VARIANTS } from "@/lib/config/keys";
import type { AgentParams } from "../params";
import type { Family } from "../schema";
import type { FamilyInputs } from "./types";

export type RankVariant = (typeof RANK_VARIANTS)[number];

export type RankScore = {
  readonly code: string;
  /** Higher = a better rank. A float: the IC is a rank statistic, so exactness is not needed. */
  readonly score: number;
};

/** Scores for one family on the session of `inputs`. STUB: none. */
export function rankScores(
  family: Family,
  inputs: FamilyInputs,
  params: AgentParams,
  variant: RankVariant = "v1",
): readonly RankScore[] {
  void family;
  void inputs;
  void params;
  void variant;
  return [];
}
