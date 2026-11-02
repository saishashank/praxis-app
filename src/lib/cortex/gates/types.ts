// Gate shapes (M15 C3c; docs/M15_design.md 3a `GateResult`, 3b "The gate lists"; spec ch. 17 CTX-013,
// CTX-028). The twelve night gates and the seven open-time checks are closed lists: an id here is a
// `cortex_abstain.gate_id` / `cortex_decision.first_fail_gate` value. Pure types and constants only.

/** The CTX-013 ids in the order the list runs (never re-sorted). */
export const GATE_IDS = [
  "G01_l0_veto",
  "G02_eligibility",
  "G03_family_status",
  "G04_economic",
  "G05_cost",
  "G06_stop_cap",
  "G07_gap_cap",
  "G08_event_state",
  "G09_regime",
  "G10_disagreement",
  "G11_portfolio",
  "G12_settled_cash",
] as const;
export type GateId = (typeof GATE_IDS)[number];

/** Step 8 sub-ids, in the order they are tested (the first failure names the sub-id in `value`). */
export const G08_SUB_IDS = [
  "8a_index_change",
  "8b_promotion_flag",
  "8c_halt_suspension",
  "8d_unresolved_action",
  "8e_event_date_veto",
  // Movers gap additions (D-743, D-745, D-747): run after the five above, only when the night carries them.
  "8f_halt_resume",
  "8g_known_date",
  "8h_short_risk",
] as const;
export type G08SubId = (typeof G08_SUB_IDS)[number];

/** The CTX-028 open-time list (run at 09:55 and again at the fill), after preopen.ts's own checks. */
export const OPEN_IDS = [
  "O01_kill",
  "O02_source_off",
  "O03_shock_block",
  "O04_stale_universe",
  "O05_gap_cap",
  "O06_stop_gap95",
  "O07_recheck_missing",
] as const;
export type OpenId = (typeof OPEN_IDS)[number];

/**
 * One gate's verdict. `value` is the figure or word the card and the trace show (exact text, never
 * a float formatted twice). A failure carries the plain label from `list.ts` — the only words the
 * abstain line may use (CTX-070).
 */
export type GateResult =
  | { readonly pass: true; readonly value?: string }
  | {
      readonly pass: false;
      readonly gateId: GateId;
      readonly label: string;
      readonly value?: string;
    };

/** A trace row: every evaluated gate, in list order, with its id (`cortex_decision.gate_trace_json`). */
export type GateTraceEntry = GateResult & { readonly gateId: GateId };

export type OpenResult =
  | { readonly pass: true; readonly value?: string }
  | {
      readonly pass: false;
      readonly openId: OpenId;
      readonly label: string;
      readonly value?: string;
    };

export type OpenTraceEntry = OpenResult & { readonly openId: OpenId };

/** Position of a gate in the CTX-013 order (0-based); used to pick "the gate that got furthest". */
export function gateIndex(id: GateId): number {
  const i = GATE_IDS.indexOf(id);
  if (i < 0) throw new RangeError(`not a gate id: ${id}`);
  return i;
}

export const pass = (value?: string): GateResult =>
  value === undefined ? { pass: true } : { pass: true, value };

export const fail = (gateId: GateId, label: string, value?: string): GateResult =>
  value === undefined ? { pass: false, gateId, label } : { pass: false, gateId, label, value };
