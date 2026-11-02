// Family constants that are not registry keys (M4 T7). Everything that has a key is read from
// AgentParams; the ARN-011 thresholds and the F5 volume exit now have keys (arn011_*, f5_dry_up_*,
// D-111) and reach the rules through AgentParams (injectable per call with FamilyOptions).
import type { RegimeLabel } from "../regime";
import type { Family } from "../schema";

/** Bumped when any family rule changes (AGT-002 agent_version). */
// families-2 (M14, D-216): FAM-004 stop-distance cap and the F5 universe change.
export const FAMILY_AGENT_VERSION = "families-2";

/** Rule version per family (the lineage's rule-version tree starts here, ch.05). */
export const FAMILY_RULE_VERSION: Readonly<Record<Family, string>> = {
  F1: "F1.v1",
  F2: "F2.v1",
  F3: "F3.v1",
  F4: "F4.v1",
  F5: "F5.v1",
  F6: "F6.v1",
};

/** Families in their fixed evaluation order (components before F6). */
export const FAMILY_ORDER: readonly Family[] = ["F1", "F2", "F3", "F4", "F5", "F6"];

/**
 * Regime gates (spec 7.4): the states in which a family makes no new entry. F4 has none ("All").
 * `unknown` (warm-up) blocks every family (design 4.3).
 */
export const REGIME_BLOCKS: Readonly<Record<Family, readonly RegimeLabel[]>> = {
  F1: ["RISK-OFF", "SHOCK", "unknown"],
  F2: ["SHOCK", "unknown"],
  F3: ["SHOCK", "unknown"],
  F4: ["unknown"],
  F5: ["RISK-OFF", "SHOCK", "unknown"],
  F6: ["RISK-OFF", "SHOCK", "unknown"],
};

/** Families whose entries need the ASX announcement source (DAT-127: ASX off -> no new entries). */
export const NEEDS_ASX: ReadonlySet<Family> = new Set<Family>(["F2", "F3", "F5", "F6"]);

/** Categories that qualify as the F3 price-sensitive event (spec 7.4). */
export const F3_CATEGORIES = ["results", "contract_win", "guidance_up", "takeover_target"] as const;

/** Categories that qualify as the F2 catalyst (results / guidance-up). */
export const F2_CATEGORIES = ["results", "guidance_up"] as const;
