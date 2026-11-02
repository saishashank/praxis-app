// M13-lite domain types (docs/M13L_design.md "Interfaces"; migration 0022_experts). Pure types and constants:
// no I/O. Nothing in this folder may be imported by the trading side (PRD-035, D-525).
import type { Family } from "@/lib/agents/schema";

export type { Family };

export const CLAIM_STATUSES = [
  "extracted",
  "owner_checked",
  "formalised",
  "screened",
  "challenger",
  "promoted",
  "rejected",
  "parked",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CLUSTER_STATES = ["proposed", "confirmed", "merged", "parked"] as const;
export type ClusterState = (typeof CLUSTER_STATES)[number];

export const CATEGORIES = [
  "candlesticks",
  "chart_patterns",
  "trend_momentum",
  "mean_reversion",
  "volume",
  "events_news",
  "macro",
  "risk_rules",
  "fundamentals_value",
  "calendar",
  "none",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const TESTABILITIES = [
  "testable_eod",
  "needs_new_data",
  "needs_intraday",
  "not_testable",
] as const;
export type Testability = (typeof TESTABILITIES)[number];

export const CLAIM_TYPES = ["method", "event_link", "call", "risk_rule"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export type ClusterRole = "supports" | "contradicts";
export type ExternalGrade = "supports" | "mixed" | "contradicts" | "none" | "not_searched";
export type ExpertStatus = "candidate" | "tracked" | "paused" | "retired";
export type LicenceStatus = "unchecked" | "registered" | "not_registered" | "not_applicable";
export type ExpertGrade = "L0" | "L1" | "L2";

/** D-514: a cluster is screenable only as a parameter set of a v1 family F1..F6. */
export type FamilyFit = {
  readonly family: Family;
  readonly params: Readonly<
    Record<string, number | boolean | string | Readonly<Record<string, number>>>
  >;
};

export type ExpertRow = {
  readonly id: string;
  readonly name: string;
  readonly platforms: readonly string[];
  readonly markets: readonly string[];
  readonly focus: readonly string[];
  readonly licenceStatus: LicenceStatus;
  readonly status: ExpertStatus;
  readonly tier: "core" | "discovered";
  readonly noFeed: boolean;
  readonly audienceSize: number | null;
  readonly audienceD: string | null;
};

export type ClusterRow = {
  readonly id: string;
  readonly name: string;
  readonly category: Category;
  readonly statement: string;
  readonly canonicalText: string | null;
  readonly testability: Testability;
  readonly externalGrade: ExternalGrade;
  readonly vocabularyGaps: number;
  readonly closestFamily: string | null;
  /** Raw parsed `family_fit_json`; `fitCheck` judges it (never trust the shape here). */
  readonly familyFit: unknown;
};

/** A claim with its current text (max claim_revision) and current status (max claim_status). */
export type ClaimView = {
  readonly id: string;
  readonly type: ClaimType;
  readonly testability: Testability;
  readonly clusterId: string | null;
  readonly status: ClaimStatus;
  readonly statement: string;
  readonly formalisationText: string | null;
  readonly vocabularyGapText: string | null;
  readonly claimedEdgeText: string | null;
};

/** What the scorecard needs from a screening result row. */
export type ScreeningResultView = { readonly clusterId: string; readonly survived: boolean };

export type CallState = "closed_target" | "closed_stop" | "closed_horizon" | "no_bars";
export type CallOutcomeView = {
  readonly claimId: string;
  readonly state: CallState;
  readonly vsMarketPpm: number | null;
  readonly luckPct: number | null;
};

/** The tables the expert code may write (D-525): the boundary test reads this list. */
export const EXPERT_TABLES = [
  "expert",
  "expert_red_flag",
  "source_item",
  "claim",
  "claim_revision",
  "claim_expert",
  "claim_item",
  "claim_status",
  "cluster",
  "cluster_state",
  "claim_cluster",
  "screening_run",
  "screening_result",
  "expert_proposal",
  "expert_call",
  "expert_call_outcome",
] as const;
export type ExpertTable = (typeof EXPERT_TABLES)[number];
