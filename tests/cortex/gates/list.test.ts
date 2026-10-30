// @vitest-environment node
// The gate lists (M15 C3c; CTX-013 order, CTX-028 open-time list, CTX-070 plain words once).
import { describe, expect, it } from "vitest";
import { GAP_CAP_LABEL } from "@/lib/cortex/economics/gapCap";
import {
  G08_LABELS,
  GATE_IDS,
  GATE_LABELS,
  GATE_LIST,
  OPEN_IDS,
  OPEN_LABELS,
  OPEN_LIST,
  gateIndex,
} from "@/lib/cortex/gates";
import { DISAGREEMENT_LABEL } from "@/lib/cortex/score/disagreement";
import { WARMING_UP_LABEL } from "@/lib/cortex/score/eligibility";

describe("GATE_LIST (CTX-013)", () => {
  it("has the twelve steps in the spec's order with their ids", () => {
    expect(GATE_LIST.map((g) => g.id)).toEqual([
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
    ]);
    expect(GATE_LIST.map((g) => g.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(GATE_IDS).toHaveLength(12);
    expect(gateIndex("G12_settled_cash")).toBe(11);
    expect(() => gateIndex("G13" as never)).toThrow(RangeError);
  });

  it("every gate but the informational cost gate has a plain label; imported phrases exist once", () => {
    for (const g of GATE_LIST) {
      if (g.id === "G05_cost") expect(g.label).toBe("");
      else expect(g.label.length).toBeGreaterThan(10);
      expect(GATE_LABELS[g.id]).toBe(g.label);
    }
    expect(GATE_LABELS.G02_eligibility).toBe(WARMING_UP_LABEL);
    expect(GATE_LABELS.G07_gap_cap).toBe(GAP_CAP_LABEL);
    expect(GATE_LABELS.G10_disagreement).toBe(DISAGREEMENT_LABEL);
    expect(Object.keys(G08_LABELS)).toEqual([
      "8a_index_change",
      "8b_promotion_flag",
      "8c_halt_suspension",
      "8d_unresolved_action",
      "8e_event_date_veto",
    ]);
  });

  it("labels use plain words (no gate ids, no jargon tokens)", () => {
    const all = [
      ...Object.values(GATE_LABELS),
      ...Object.values(G08_LABELS),
      ...Object.values(OPEN_LABELS),
    ];
    for (const l of all) {
      expect(l).not.toMatch(/G\d\d|CTX-|n_eff|Platt|bootstrap|p_be/);
    }
  });
});

describe("OPEN_LIST (CTX-028)", () => {
  it("has the seven open-time checks in order, each with a label", () => {
    expect(OPEN_LIST.map((o) => o.id)).toEqual([
      "O01_kill",
      "O02_source_off",
      "O03_shock_block",
      "O04_stale_universe",
      "O05_gap_cap",
      "O06_stop_gap95",
      "O07_recheck_missing",
    ]);
    expect(OPEN_IDS).toHaveLength(7);
    for (const o of OPEN_LIST) expect(o.label.length).toBeGreaterThan(10);
    expect(OPEN_LABELS.O06_stop_gap95).toBe(GAP_CAP_LABEL);
  });
});
