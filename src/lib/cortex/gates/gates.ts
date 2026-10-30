// Night gates G01…G10 (M15 C3c; docs/M15_design.md 3b; spec ch. 17 CTX-013 steps 1–10). One pure
// function per gate, each returning a `GateResult` whose failure carries the gate id and the plain
// label from list.ts. Every gate reads plain inputs the night (night.ts) has already gathered from
// the as-of view, the score layer, the economics and the state machines — nothing here touches the
// view, a store or a clock. Money is integer micro / Rational, statistics are floats, the text in
// `value` is exact (bigint decimal, fixed decimals for floats).
import type { ViewBar } from "@/lib/agents/decisionView";
import { REGIME_BLOCKS } from "@/lib/agents/families/constants";
import { stopDistance } from "@/lib/agents/families/stopCap";
import type { Family, IndexChangeFact, RegimeLabel, StopSpec } from "@/lib/agents/families/types";
import type { Micro } from "@/lib/money/micro";
import { cmpRat, type Rational } from "@/lib/money/rational";
import {
  economicGate,
  type CellStatistic,
  type EconomicGateResult,
  type GateOptions,
} from "@/lib/stats/cells";
import type { AngleCluster } from "../angles/types";
import { costFraction, type CostPerOrder } from "../economics/cost";
import { gapCapTest, stopDistanceRat } from "../economics/gapCap";
import { hasNullClose } from "../pit/integrity";
import type { EventRow } from "../pit/types";
import type { Eligibility } from "../score/eligibility";
import type { MapGuard } from "../score/map";
import { disagreementTest } from "../score/disagreement";
import type { Score } from "../score/score";
import {
  ECONOMIC_LABEL,
  FAMILY_STATUS_LABEL,
  G08_LABELS,
  L0_CODE_LABEL,
  L0_NIGHT_LABEL,
  NOT_ENOUGH_HISTORY_LABEL,
  REGIME_LABEL,
  STOP_CAP_LABEL,
} from "./list";
import { fail, pass, type G08SubId, type GateResult } from "./types";

const FLOAT_DP = 6;
const fmt = (x: number): string => x.toFixed(FLOAT_DP);
const ratText = (r: Rational): string => `${r.num}/${r.den}`;

// ---- G01 L0 vetoes -----------------------------------------------------------------------------------

export type NightStatus =
  { readonly status: "ran" } | { readonly status: "abstain_all"; readonly reason: string };

/** G01, night level: an abstain-all night fails every code with the night label and its reason. */
export function gateL0Night(night: NightStatus): GateResult {
  if (night.status === "ran") return pass();
  return fail("G01_l0_veto", L0_NIGHT_LABEL, night.reason);
}

export type L0CodeInput = {
  /** The D bar of the code (raw); null = no bar tonight. */
  readonly bar: ViewBar | null;
  /** Tonight's adjusted close (CTX-050 basis); null / non-positive is rejected (CTX-010). */
  readonly adjClose: bigint | null | undefined;
  /** Flags raised by D9 gate angles (A-D9-01 stale input, A-D9-06 known_at guard, …), sorted. */
  readonly vetoFlags: readonly string[];
};

/** A bar whose prices are positive and ordered (low <= open, close <= high). */
export function barWellFormed(bar: ViewBar): boolean {
  const { open, high, low, close, volume } = bar;
  if (open <= 0n || high <= 0n || low <= 0n || close <= 0n || volume < 0n) return false;
  return low <= high && open >= low && open <= high && close >= low && close <= high;
}

/** G01, code level: no bar, a null or malformed close, or a data-quality flag vetoes the code. */
export function gateL0Code(input: L0CodeInput): GateResult {
  if (input.bar === null) return fail("G01_l0_veto", L0_CODE_LABEL, "no_bar");
  if (hasNullClose({ adjClose: input.adjClose })) {
    return fail("G01_l0_veto", L0_CODE_LABEL, "null_close");
  }
  if (!barWellFormed(input.bar)) return fail("G01_l0_veto", L0_CODE_LABEL, "malformed_bar");
  if (input.vetoFlags.length > 0) {
    return fail("G01_l0_veto", L0_CODE_LABEL, `flag:${[...input.vetoFlags].sort().join(",")}`);
  }
  return pass();
}

// ---- G02 eligibility ----------------------------------------------------------------------------------

/** G02: the score layer's eligibility verdict (CTX-012); the missing ids are the value. */
export function gateEligibility(elig: Eligibility): GateResult {
  if (elig.eligible) return pass();
  return fail("G02_eligibility", elig.label, elig.missing.join(","));
}

// ---- G03 family status -------------------------------------------------------------------------------

export type FamilyStatus = "shadow" | "allowed" | "suspended";

export type FamilyStatusInput = {
  readonly status: FamilyStatus;
  /** Owner kill: the whole arena or this family (CTX-072). */
  readonly killed: boolean;
  /** CTX-055 cold start: the family is outside the cold-start set (F1, F4) in the cold phase. */
  readonly coldStartExcluded: boolean;
};

/** G03: live decisions only for `allowed` families (CTX-053), not killed, inside the cold-start set. */
export function gateFamilyStatus(input: FamilyStatusInput): GateResult {
  if (input.killed) return fail("G03_family_status", FAMILY_STATUS_LABEL, "kill");
  if (input.status !== "allowed") {
    return fail("G03_family_status", FAMILY_STATUS_LABEL, input.status);
  }
  if (input.coldStartExcluded) {
    return fail("G03_family_status", FAMILY_STATUS_LABEL, "cold_start");
  }
  return pass("allowed");
}

// ---- G04 economic gate --------------------------------------------------------------------------------

export type EconomicInput = {
  /**
   * The family's map under the refit guard; a missing or stale map is "not enough history" (D-281).
   * null = not applied (the shadow arm scores without a p so shadow rows exist on a map-less night).
   */
  readonly map: MapGuard | null;
  /** The matched pooled top-3 cell `family|top3|volBucket|liqTier`; undefined = no such cell. */
  readonly cell: CellStatistic | undefined;
  /** The night's regime (CTX-021 fail-closed regime check). */
  readonly regime: RegimeLabel;
  /**
   * The candidate's S is in the pooled top-3 band (cut on the development quantiles); null when the
   * rule version states no band edge, in which case every scored candidate is matched.
   */
  readonly inBand: boolean | null;
  readonly opts?: GateOptions;
};

/** The plain label of an `economicGate` reason. */
export function economicLabel(
  reason: Exclude<EconomicGateResult, { pass: true }>["reason"],
): string {
  return reason === "not_enough_history" ? NOT_ENOUGH_HISTORY_LABEL : ECONOMIC_LABEL;
}

/** G04 (CTX-021): map present, candidate matched, cell big enough, bound > 0, regime fail-closed. */
export function gateEconomic(input: EconomicInput): GateResult {
  if (input.map !== null && !input.map.ok) {
    return fail("G04_economic", NOT_ENOUGH_HISTORY_LABEL, input.map.reason);
  }
  if (input.inBand === false) return fail("G04_economic", ECONOMIC_LABEL, "not_matched");
  if (input.cell === undefined) {
    return fail("G04_economic", NOT_ENOUGH_HISTORY_LABEL, "no_cell");
  }
  const r = economicGate(input.cell, input.regime, input.opts);
  if (r.pass) return pass(`lower90=${fmt(r.lower90)}`);
  return fail("G04_economic", economicLabel(r.reason), `${r.reason}: ${r.detail}`);
}

// ---- G05 cost gate (informational) ---------------------------------------------------------------------

export type CostInput = {
  readonly cost: CostPerOrder;
  /** `cost_gate_k`. */
  readonly costGateK: number;
  /** The matched cell's mean net (fraction); undefined without a cell. */
  readonly cellMeanNet: number | undefined;
};

/**
 * G05 (CTX-022a): `cost_gate_k × C` beside the cell's mean outcome — informational. Always passes;
 * the value is what the card shows (the economic gate already nets every cost).
 */
export function gateCost(input: CostInput): GateResult {
  if (!(input.costGateK > 0)) throw new RangeError("cost_gate_k must be positive");
  const c = costFraction(input.cost);
  const kc = input.costGateK * c;
  const mean = input.cellMeanNet === undefined ? "n/a" : fmt(input.cellMeanNet);
  return pass(`C=${fmt(c)} kC=${fmt(kc)} cell_mean_net=${mean}`);
}

// ---- G06 stop-distance cap -----------------------------------------------------------------------------

/** G06 (FAM-004): initial stop distance at the reference close within `max_stop_distance_pct`. */
export function gateStopCap(stopSpec: StopSpec, refMicro: Micro, cap: Rational): GateResult {
  const dist = stopDistance({ stopSpec }, refMicro);
  if (cmpRat(dist, cap) > 0) {
    return fail("G06_stop_cap", STOP_CAP_LABEL, `${ratText(dist)} > ${ratText(cap)}`);
  }
  return pass(ratText(dist));
}

// ---- G07 gap-risk cap ------------------------------------------------------------------------------

export type GapCapGateInput = {
  readonly refMicro: Micro;
  readonly stopMicro: Micro;
  /** The matched cell's gap95 (fraction); undefined = unknown, fails closed. */
  readonly gap95: number | undefined;
  readonly maxLoss: Rational;
};

/** G07 (CTX-022b): stop distance + cell gap95 <= `max_loss_pct`, exactly; no cell = fail closed. */
export function gateGapCap(input: GapCapGateInput): GateResult {
  if (input.gap95 === undefined) {
    return fail("G07_gap_cap", NOT_ENOUGH_HISTORY_LABEL, "gap95_unknown");
  }
  const r = gapCapTest({
    stopDistance: stopDistanceRat(input.refMicro, input.stopMicro),
    gap95: input.gap95,
    maxLoss: input.maxLoss,
  });
  const text = `${ratText(r.total)} vs ${ratText(r.maxLoss)}`;
  return r.pass ? pass(text) : fail("G07_gap_cap", r.label, text);
}

// ---- G08 event and state vetoes -------------------------------------------------------------------------

export type EventStateInput = {
  readonly d: string;
  /** DAT-234 list loaded (false = 8a fails closed). */
  readonly indexChangesLoaded: boolean;
  readonly indexChanges: readonly IndexChangeFact[];
  /** Session dates up to and including `d` (the view's sessions truncated at t), oldest first. */
  readonly sessions: readonly string[];
  /** `index_change_window_sessions`: an effective date within this many sessions of `d` excludes. */
  readonly indexChangeWindowSessions: number;
  /** `cortex_state` promotion state word; "none" / null = clear. */
  readonly promotionState: string | null;
  /** `cortex_state` halt state word; "none" / null = clear. */
  readonly haltState: string | null;
  /** The view's halted flag tonight (null = unknown, treated as not halted here; the state row rules). */
  readonly haltedNow: boolean | null;
  /** `cortex_state` corporate-action state word; "none" / "confirmed" clear the way. */
  readonly corpActionState: string | null;
  /** Events of the code usable at the cut-off. */
  readonly events: readonly EventRow[];
};

/** Event categories whose day 0 on D vetoes a next-open entry (8e). */
export const EVENT_VETO_CATEGORIES: ReadonlySet<string> = new Set([
  "halt_suspension",
  "exchange_query",
  "capital_raising",
]);

const CORP_ACTION_CLEAR: ReadonlySet<string> = new Set(["none", "confirmed", "disconfirmed"]);
const PROMOTION_CLEAR: ReadonlySet<string> = new Set(["none"]);
const HALT_CLEAR: ReadonlySet<string> = new Set(["none"]);

/** Sessions between two dates in the session list (|index difference|); Infinity when either is absent. */
function sessionDistance(sessions: readonly string[], a: string, b: string): number {
  const ia = sessions.indexOf(a);
  const ib = sessions.indexOf(b);
  if (ia < 0 || ib < 0) return Infinity;
  return Math.abs(ia - ib);
}

/** The first failing sub-check of step 8 in list order, or null. */
export function eventStateSubFail(input: EventStateInput): { sub: G08SubId; value: string } | null {
  // 8a: fail closed when the list is missing; else any change effective inside the window, or an
  // announced change whose effective date is still ahead of d.
  if (!input.indexChangesLoaded) return { sub: "8a_index_change", value: "list_missing" };
  for (const ch of input.indexChanges) {
    const dist = sessionDistance(input.sessions, ch.effective, input.d);
    const ahead = ch.effective > input.d;
    if (ahead || dist <= input.indexChangeWindowSessions) {
      return { sub: "8a_index_change", value: `${ch.indexName}:${ch.kind}:${ch.effective}` };
    }
  }
  if (input.promotionState !== null && !PROMOTION_CLEAR.has(input.promotionState)) {
    return { sub: "8b_promotion_flag", value: input.promotionState };
  }
  if (input.haltedNow === true) return { sub: "8c_halt_suspension", value: "halted" };
  if (input.haltState !== null && !HALT_CLEAR.has(input.haltState)) {
    return { sub: "8c_halt_suspension", value: input.haltState };
  }
  if (input.corpActionState !== null && !CORP_ACTION_CLEAR.has(input.corpActionState)) {
    return { sub: "8d_unresolved_action", value: input.corpActionState };
  }
  const veto = [...input.events]
    .filter((e) => e.day0 === input.d && EVENT_VETO_CATEGORIES.has(e.category))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  if (veto !== undefined)
    return { sub: "8e_event_date_veto", value: `${veto.category}:${veto.id}` };
  return null;
}

/** G08: index change (fail-closed), promotion flag, halt / suspension, unresolved action, event veto. */
export function gateEventState(input: EventStateInput): GateResult {
  if (!Number.isInteger(input.indexChangeWindowSessions) || input.indexChangeWindowSessions < 0) {
    throw new RangeError("index_change_window_sessions must be a non-negative integer");
  }
  const f = eventStateSubFail(input);
  if (f === null) return pass();
  return fail("G08_event_state", G08_LABELS[f.sub], `${f.sub}:${f.value}`);
}

// ---- G09 regime ------------------------------------------------------------------------------------

/** F7 inherits the rule of its strongest cluster (CTX-017): the family whose evidence that cluster is. */
export const F7_CLUSTER_FAMILY: Readonly<Record<AngleCluster, Family>> = {
  momentum: "F1",
  liquidity: "F2",
  event: "F3",
  low_volatility: "F4",
  quality: "F5",
  sentiment: "F6",
};

/** The CTX-017 table for a family, or for F7 through its strongest cluster. */
export function regimeBlocked(
  family: Family | "F7",
  strongestCluster?: AngleCluster,
): readonly RegimeLabel[] {
  if (family !== "F7") return REGIME_BLOCKS[family];
  if (strongestCluster === undefined) return REGIME_BLOCKS.F1; // the strictest rule when no cluster is known
  return REGIME_BLOCKS[F7_CLUSTER_FAMILY[strongestCluster]];
}

export type RegimeGateResult = GateResult & { readonly halfSize: boolean };

/**
 * G09 (CTX-017): no entry in a blocked regime; F4 passes SHOCK at half size (FAM-009: the settled-
 * cash gate then needs two parcels). `unknown` blocks every family (the v1 table).
 */
export function gateRegime(
  family: Family | "F7",
  regime: RegimeLabel,
  strongestCluster?: AngleCluster,
): RegimeGateResult {
  const blocked = regimeBlocked(family, strongestCluster);
  if (blocked.includes(regime)) {
    return { ...fail("G09_regime", REGIME_LABEL, regime), halfSize: false };
  }
  const halfSize = family === "F4" && regime === "SHOCK";
  return { ...pass(halfSize ? `${regime}:half_size` : regime), halfSize };
}

// ---- G10 disagreement --------------------------------------------------------------------------------

/** G10 (CTX-023): d > `cortex_disagreement_max` abstains. */
export function gateDisagreement(score: Score, max: number): GateResult {
  const r = disagreementTest(score, max);
  if (r.pass) return pass(fmt(r.d));
  return fail("G10_disagreement", r.label, `${fmt(r.d)} > ${fmt(r.max)}`);
}
