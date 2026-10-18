// Family constants that are not (yet) registry keys (M4 T7). Everything that has a key is read from
// AgentParams; the values below are spec text without a key, listed as missing keys in D-085. They
// are injectable (FamilyOptions) so a later task can wire keys without touching the rules.
import { makeRational, parseRational } from "@/lib/money/rational";
import type { RegimeLabel } from "../regime";
import type { Family } from "../schema";
import type { Arn011Thresholds, SpecConstants } from "./types";

/** Bumped when any family rule changes (AGT-002 agent_version). */
export const FAMILY_AGENT_VERSION = "families-1";

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

/** ARN-011 (spec 05 l.41), Owner-only thresholds. */
export const ARN011_V1: Arn011Thresholds = {
  gainSessions: 5, // threshold-ok: ARN-011 "+100% in 5 sessions" window
  gainMax: parseRational("1"), // threshold-ok: ARN-011 +100 % (a gain of 1.00)
  oneDayGain: parseRational("0.3"), // threshold-ok: ARN-011 +30 % in one session
  volumeRatioMax: parseRational("10"), // threshold-ok: ARN-011 volume ratio > 10
  placementWindow: 120, // threshold-ok: ARN-011 placements in 120 sessions
  placementsMax: 2, // threshold-ok: ARN-011 two or more placements block
  raiseWindow: 60, // threshold-ok: ARN-011 deep-discount raise in 60 sessions
  queryWindow: 2, // threshold-ok: ARN-011 query on D or D-1 (two sessions)
  consolidationWindow: 90, // threshold-ok: ARN-011 consolidation in 90 sessions
  rangeFraction: makeRational(1n, 4n), // threshold-ok: ARN-011 range > 25 % of price
  rangeDaysWindow: 5, // threshold-ok: ARN-011 last 5 sessions
  rangeDaysMin: 3, // threshold-ok: ARN-011 on at least 3 of them
};

/** Spec 7.4 F5 exit "volume ratio < 0.5 for 3 sessions": no keys yet. */
export const SPEC_CONSTANTS_V1: SpecConstants = {
  f5DryUpRatio: parseRational("0.5"), // threshold-ok: F5 CS volume ratio below 0.5
  f5DryUpSessions: 3, // threshold-ok: F5 CS for 3 sessions
};
