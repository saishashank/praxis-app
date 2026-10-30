// The gate lists (M15 C3c; docs/M15_design.md 3b; spec ch. 17 CTX-013, CTX-028, CTX-070 "plain
// words"). `GATE_LIST` is the CTX-013 order and is never re-sorted; `GATE_LABELS` holds the plain
// label of each gate. Labels that C3a / C3b already define are imported so each phrase exists once
// (the warming-up line from score/eligibility, the gap line from economics/gapCap, the disagreement
// line from score/disagreement). Everything the abstain line may say is in this file or imported here.
import { GAP_CAP_LABEL } from "../economics/gapCap";
import { DISAGREEMENT_LABEL } from "../score/disagreement";
import { WARMING_UP_LABEL } from "../score/eligibility";
import { GATE_IDS, OPEN_IDS, type G08SubId, type GateId, type OpenId } from "./types";

export { DISAGREEMENT_LABEL, GAP_CAP_LABEL, WARMING_UP_LABEL };

// ---- G01 -----------------------------------------------------------------------------------------
/** Night-level L0 failure (late bar, quota, incomplete universe). */
export const L0_NIGHT_LABEL = "the data for tonight were not complete";
/** Code-level L0 failure (null or malformed close, data-quality veto). */
export const L0_CODE_LABEL = "this company's prices were not reliable";

// ---- G03 -----------------------------------------------------------------------------------------
export const FAMILY_STATUS_LABEL = "this strategy is not yet allowed to trade";

// ---- G04 -----------------------------------------------------------------------------------------
/** The bound is not positive, or the night's regime fails closed for the cell. */
export const ECONOMIC_LABEL = "setups like this have not come out ahead after costs";
/** Fewer setups / blocks / n_eff than the cell needs, no cell, or no map (D-281). */
export const NOT_ENOUGH_HISTORY_LABEL = "not enough history";

// ---- G06 -----------------------------------------------------------------------------------------
export const STOP_CAP_LABEL = "the stop would be too far away";

// ---- G08 -----------------------------------------------------------------------------------------
export const G08_LABELS: Readonly<Record<G08SubId, string>> = {
  "8a_index_change": "an index change is in the way",
  "8b_promotion_flag": "a promotion flag is in the way",
  "8c_halt_suspension": "a trading halt is in the way",
  "8d_unresolved_action": "an unresolved corporate action is in the way",
  "8e_event_date_veto": "a scheduled event is in the way",
};

// ---- G09 -----------------------------------------------------------------------------------------
export const REGIME_LABEL = "the market regime blocks this strategy tonight";

// ---- G11 -----------------------------------------------------------------------------------------
export const PORTFOLIO_CODE_LABEL = "we already hold enough of this company";
export const PORTFOLIO_INDUSTRY_LABEL = "we already hold enough of this industry";

// ---- G12 -----------------------------------------------------------------------------------------
export const SETTLED_CASH_LABEL = "the cash from the last sale has not settled yet";
/** The sizing engine refused the parcel (below A$500 or no whole share). */
export const PARCEL_LABEL = "the position would be too small to be worth placing";
/** The sizing engine refused on the participation cap (ARN-024). */
export const PARTICIPATION_LABEL = "this company does not trade enough for the size we would need";

/** The default plain label of each gate (variants above are chosen by the gate from its reason). */
export const GATE_LABELS: Readonly<Record<GateId, string>> = {
  G01_l0_veto: L0_NIGHT_LABEL,
  G02_eligibility: WARMING_UP_LABEL,
  G03_family_status: FAMILY_STATUS_LABEL,
  G04_economic: ECONOMIC_LABEL,
  G05_cost: "", // informational: never fails, no abstain line (CTX-022a)
  G06_stop_cap: STOP_CAP_LABEL,
  G07_gap_cap: GAP_CAP_LABEL,
  G08_event_state: G08_LABELS["8e_event_date_veto"],
  G09_regime: REGIME_LABEL,
  G10_disagreement: DISAGREEMENT_LABEL,
  G11_portfolio: PORTFOLIO_CODE_LABEL,
  G12_settled_cash: SETTLED_CASH_LABEL,
};

export type GateListEntry = { readonly id: GateId; readonly step: number; readonly label: string };

/** CTX-013 steps 1…12 with their ids and default labels, in order. */
export const GATE_LIST: readonly GateListEntry[] = GATE_IDS.map((id, i) => ({
  id,
  step: i + 1,
  label: GATE_LABELS[id],
}));

// ---- open-time list --------------------------------------------------------------------------------
export const OPEN_LABELS: Readonly<Record<OpenId, string>> = {
  O01_kill: "trading is switched off",
  O02_source_off: "a data source this strategy needs is off",
  O03_shock_block: "the market is in shock this morning",
  O04_stale_universe: "too much of the market has no fresh prices",
  O05_gap_cap: "the open was too far above last night's close",
  O06_stop_gap95: GAP_CAP_LABEL,
  O07_recheck_missing: "the morning re-check did not run",
};

export type OpenListEntry = { readonly id: OpenId; readonly step: number; readonly label: string };

export const OPEN_LIST: readonly OpenListEntry[] = OPEN_IDS.map((id, i) => ({
  id,
  step: i + 1,
  label: OPEN_LABELS[id],
}));
