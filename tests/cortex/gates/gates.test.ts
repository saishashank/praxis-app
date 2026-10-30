// @vitest-environment node
// Night gates G01…G10 (M15 C3c; CTX-013 steps 1–10): one pass and one fail per gate with the exact
// id and plain label; AT-52 "the 40/60 cell fails G04_economic"; AT-56 fixture 11 regime matrix.
import { describe, expect, it } from "vitest";
import type { ViewBar } from "@/lib/agents/decisionView";
import { REGIME_BLOCKS } from "@/lib/agents/families/constants";
import type { Family, RegimeLabel, StopSpec } from "@/lib/agents/families/types";
import { COST_PROFILES } from "@/lib/arena/costs";
import { costPerOrder } from "@/lib/cortex/economics/cost";
import { GAP_CAP_LABEL } from "@/lib/cortex/economics/gapCap";
import {
  ECONOMIC_LABEL,
  EVENT_VETO_CATEGORIES,
  F7_CLUSTER_FAMILY,
  FAMILY_STATUS_LABEL,
  G08_LABELS,
  L0_CODE_LABEL,
  L0_NIGHT_LABEL,
  NOT_ENOUGH_HISTORY_LABEL,
  REGIME_LABEL,
  STOP_CAP_LABEL,
  barWellFormed,
  gateCost,
  gateDisagreement,
  gateEconomic,
  gateEligibility,
  gateEventState,
  gateFamilyStatus,
  gateGapCap,
  gateL0Code,
  gateL0Night,
  gateRegime,
  gateStopCap,
  regimeBlocked,
  type EventStateInput,
} from "@/lib/cortex/gates";
import { eligibility, WARMING_UP_LABEL } from "@/lib/cortex/score/eligibility";
import { DISAGREEMENT_LABEL } from "@/lib/cortex/score/disagreement";
import type { MapGuard } from "@/lib/cortex/score/map";
import type { Score } from "@/lib/cortex/score/score";
import { makeRational } from "@/lib/money/rational";
import { cellStat, mapFor } from "../night/zzNight";

const M = 1_000_000n;
const bar: ViewBar = {
  d: "2026-03-02",
  open: 20n * M,
  high: 21n * M,
  low: 19n * M,
  close: 20n * M,
  volume: 100_000n,
};
const okMap: MapGuard = { ok: true, map: mapFor("F1") };

describe("G01_l0_veto", () => {
  it("night: ran passes; abstain-all fails with the night label and the reason", () => {
    expect(gateL0Night({ status: "ran" })).toEqual({ pass: true });
    expect(gateL0Night({ status: "abstain_all", reason: "late_bar" })).toEqual({
      pass: false,
      gateId: "G01_l0_veto",
      label: L0_NIGHT_LABEL,
      value: "late_bar",
    });
  });

  it("code: a sound bar passes; no bar, a null close, a malformed bar or a D9 flag fails with the code label", () => {
    expect(gateL0Code({ bar, adjClose: 20n * M, vetoFlags: [] })).toEqual({ pass: true });
    expect(gateL0Code({ bar: null, adjClose: 20n * M, vetoFlags: [] })).toMatchObject({
      pass: false,
      gateId: "G01_l0_veto",
      label: L0_CODE_LABEL,
      value: "no_bar",
    });
    expect(gateL0Code({ bar, adjClose: null, vetoFlags: [] })).toMatchObject({
      value: "null_close",
    });
    expect(gateL0Code({ bar, adjClose: 0n, vetoFlags: [] })).toMatchObject({ value: "null_close" });
    expect(
      gateL0Code({ bar: { ...bar, low: 22n * M }, adjClose: 20n * M, vetoFlags: [] }),
    ).toMatchObject({
      value: "malformed_bar",
    });
    expect(barWellFormed({ ...bar, open: 0n })).toBe(false);
    expect(
      gateL0Code({ bar, adjClose: 20n * M, vetoFlags: ["A-D9-06:known_at", "A-D9-01:stale"] }),
    ).toEqual({
      pass: false,
      gateId: "G01_l0_veto",
      label: L0_CODE_LABEL,
      value: "flag:A-D9-01:stale,A-D9-06:known_at",
    });
  });
});

describe("G02_eligibility", () => {
  const scored = [
    { id: "A-D1-01", version: 1, cluster: "momentum" as const },
    { id: "A-D1-02", version: 1, cluster: "momentum" as const },
  ];
  it("every angle defined passes; one undefined fails with the warming-up label and the ids", () => {
    expect(
      gateEligibility(
        eligibility(
          new Map([
            ["A-D1-01", 0.2],
            ["A-D1-02", -0.1],
          ]),
          scored,
        ),
      ),
    ).toEqual({
      pass: true,
    });
    expect(gateEligibility(eligibility(new Map([["A-D1-01", 0.2]]), scored))).toEqual({
      pass: false,
      gateId: "G02_eligibility",
      label: WARMING_UP_LABEL,
      value: "A-D1-02",
    });
  });
});

describe("G03_family_status", () => {
  it("allowed passes; shadow, suspended, a kill and the cold-start set fail with the status label", () => {
    const base = { status: "allowed" as const, killed: false, coldStartExcluded: false };
    expect(gateFamilyStatus(base)).toEqual({ pass: true, value: "allowed" });
    expect(gateFamilyStatus({ ...base, status: "shadow" })).toEqual({
      pass: false,
      gateId: "G03_family_status",
      label: FAMILY_STATUS_LABEL,
      value: "shadow",
    });
    expect(gateFamilyStatus({ ...base, status: "suspended" })).toMatchObject({
      value: "suspended",
    });
    expect(gateFamilyStatus({ ...base, killed: true })).toMatchObject({ value: "kill" });
    expect(gateFamilyStatus({ ...base, coldStartExcluded: true })).toMatchObject({
      value: "cold_start",
    });
  });
});

describe("G04_economic (CTX-021)", () => {
  const cell = cellStat("F1|top3|v1|U1");
  it("a healthy cell under a guarded map passes with the bound as value", () => {
    expect(gateEconomic({ map: okMap, cell, regime: "NEUTRAL", inBand: null })).toEqual({
      pass: true,
      value: "lower90=0.010000",
    });
  });
  it("AT-52: the 40/60 cell (40 setups, 60 needed) fails with 'not enough history'", () => {
    const forty = cellStat("F1|top3|v1|U1", { n: 40 });
    expect(gateEconomic({ map: okMap, cell: forty, regime: "NEUTRAL", inBand: null })).toEqual({
      pass: false,
      gateId: "G04_economic",
      label: NOT_ENOUGH_HISTORY_LABEL,
      value: "not_enough_history: 40 setups < 60",
    });
  });
  it("a non-positive bound fails with the economic label; a thin regime fails closed", () => {
    const flat = cellStat("k", { lower90: -0.001 });
    expect(gateEconomic({ map: okMap, cell: flat, regime: "NEUTRAL", inBand: null })).toMatchObject(
      {
        pass: false,
        gateId: "G04_economic",
        label: ECONOMIC_LABEL,
      },
    );
    const thin = cellStat("k", { byRegime: { NEUTRAL: { n: 10, meanNet: 0.02 } } });
    expect(gateEconomic({ map: okMap, cell: thin, regime: "NEUTRAL", inBand: null })).toMatchObject(
      {
        label: ECONOMIC_LABEL,
        value: "regime_blocked: NEUTRAL: 10 setups, mean net 0.020000",
      },
    );
    expect(gateEconomic({ map: okMap, cell: thin, regime: "SHOCK", inBand: null })).toMatchObject({
      value: "regime_blocked: SHOCK: no setups",
    });
  });
  it("no map / stale map, no cell and an unmatched candidate fail before the cell statistic", () => {
    const missing: MapGuard = { ok: false, reason: "map_missing", detail: "no map loaded" };
    expect(gateEconomic({ map: missing, cell, regime: "NEUTRAL", inBand: null })).toEqual({
      pass: false,
      gateId: "G04_economic",
      label: NOT_ENOUGH_HISTORY_LABEL,
      value: "map_missing",
    });
    expect(
      gateEconomic({ map: okMap, cell: undefined, regime: "NEUTRAL", inBand: null }),
    ).toMatchObject({
      label: NOT_ENOUGH_HISTORY_LABEL,
      value: "no_cell",
    });
    expect(gateEconomic({ map: okMap, cell, regime: "NEUTRAL", inBand: false })).toMatchObject({
      label: ECONOMIC_LABEL,
      value: "not_matched",
    });
    // the shadow arm passes `null`: no map needed for a shadow row
    expect(gateEconomic({ map: null, cell, regime: "NEUTRAL", inBand: null }).pass).toBe(true);
  });
});

describe("G05_cost (informational)", () => {
  it("always passes and logs C, k×C and the cell mean", () => {
    const cost = costPerOrder({
      profile: COST_PROFILES.P1,
      notionalMicro: 500n * M,
      priceMicro: 20n * M,
      tier: "U1",
      advMicro: 2_000_000n * M,
    });
    const r = gateCost({ cost, costGateK: 2, cellMeanNet: 0.03 });
    expect(r.pass).toBe(true);
    expect(r.value).toMatch(/^C=0\.\d{6} kC=0\.\d{6} cell_mean_net=0\.030000$/);
    expect(gateCost({ cost, costGateK: 2, cellMeanNet: undefined }).value).toMatch(
      /cell_mean_net=n\/a$/,
    );
    expect(() => gateCost({ cost, costGateK: 0, cellMeanNet: 0 })).toThrow(RangeError);
  });
});

describe("G06_stop_cap (FAM-004)", () => {
  const cap = makeRational(12n, 100n);
  const spec = (k: bigint): StopSpec => ({
    atr_micro: 1n * M,
    k: makeRational(k),
    cap: null,
    level_micro: null,
  });
  it("2 × ATR at A$20 (10 %) passes, 3 × ATR (15 %) fails with the stop label", () => {
    expect(gateStopCap(spec(2n), 20n * M, cap)).toEqual({ pass: true, value: "1/10" });
    expect(gateStopCap(spec(3n), 20n * M, cap)).toEqual({
      pass: false,
      gateId: "G06_stop_cap",
      label: STOP_CAP_LABEL,
      value: "3/20 > 3/25",
    });
  });
  it("exactly the cap passes (12 % at a 12 % cap)", () => {
    const s: StopSpec = {
      atr_micro: 1_200_000n,
      k: makeRational(2n),
      cap: null,
      level_micro: null,
    };
    expect(gateStopCap(s, 20n * M, cap).pass).toBe(true);
  });
});

describe("G07_gap_cap (CTX-022b)", () => {
  const maxLoss = makeRational(18n, 100n);
  it("14 % stop + 4 % gap95 = 18 % passes exactly; 16 % + 3 % fails with the gap label", () => {
    expect(gateGapCap({ refMicro: 100n * M, stopMicro: 86n * M, gap95: 0.04, maxLoss })).toEqual({
      pass: true,
      value: "9/50 vs 9/50",
    });
    expect(gateGapCap({ refMicro: 100n * M, stopMicro: 84n * M, gap95: 0.03, maxLoss })).toEqual({
      pass: false,
      gateId: "G07_gap_cap",
      label: GAP_CAP_LABEL,
      value: "19/100 vs 9/50",
    });
  });
  it("no gap95 fails closed as not enough history", () => {
    expect(
      gateGapCap({ refMicro: 100n * M, stopMicro: 90n * M, gap95: undefined, maxLoss }),
    ).toMatchObject({
      pass: false,
      gateId: "G07_gap_cap",
      label: NOT_ENOUGH_HISTORY_LABEL,
      value: "gap95_unknown",
    });
  });
});

describe("G08_event_state", () => {
  const sessions = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"];
  const clear: EventStateInput = {
    d: "2026-03-06",
    indexChangesLoaded: true,
    indexChanges: [],
    sessions,
    indexChangeWindowSessions: 2,
    promotionState: "none",
    haltState: null,
    haltedNow: false,
    corpActionState: "none",
    events: [],
  };
  const ev = (category: string, day0: string) => ({
    id: `asx|ZZA-${day0}-${category}`,
    code: "ZZA",
    day0,
    groupKey: `ZZA|${day0}`,
    category: category as never,
    priceSensitive: true,
    polarity: 0 as const,
    ar: null,
    volRatio: null,
    timed: true,
    day0LowMicro: null,
    publishedAt: `${day0}T00:30:00.000Z`,
  });

  it("nothing in the way passes", () => {
    expect(gateEventState(clear)).toEqual({ pass: true });
  });
  it("8a fails closed when the DAT-234 list is missing, and on a change inside the window or still ahead", () => {
    expect(gateEventState({ ...clear, indexChangesLoaded: false })).toEqual({
      pass: false,
      gateId: "G08_event_state",
      label: G08_LABELS["8a_index_change"],
      value: "8a_index_change:list_missing",
    });
    const change = {
      indexName: "ZZ200",
      kind: "add" as const,
      announced: "2026-03-02",
      effective: "2026-03-05",
    };
    expect(gateEventState({ ...clear, indexChanges: [change] })).toMatchObject({
      value: "8a_index_change:ZZ200:add:2026-03-05",
    });
    expect(
      gateEventState({ ...clear, indexChanges: [{ ...change, effective: "2026-03-10" }] }).pass,
    ).toBe(false);
    expect(
      gateEventState({ ...clear, indexChanges: [{ ...change, effective: "2026-03-02" }] }).pass,
    ).toBe(true);
  });
  it("8b promotion flag or move block, 8c halt / suspension (state row or tonight's flag), 8d unresolved action", () => {
    expect(gateEventState({ ...clear, promotionState: "flagged" })).toMatchObject({
      label: G08_LABELS["8b_promotion_flag"],
      value: "8b_promotion_flag:flagged",
    });
    expect(gateEventState({ ...clear, haltState: "suspension" })).toMatchObject({
      label: G08_LABELS["8c_halt_suspension"],
      value: "8c_halt_suspension:suspension",
    });
    expect(gateEventState({ ...clear, haltedNow: true })).toMatchObject({
      value: "8c_halt_suspension:halted",
    });
    expect(gateEventState({ ...clear, corpActionState: "candidate" })).toMatchObject({
      label: G08_LABELS["8d_unresolved_action"],
      value: "8d_unresolved_action:candidate",
    });
    expect(gateEventState({ ...clear, corpActionState: "unknown_provenance" }).pass).toBe(false);
    expect(gateEventState({ ...clear, corpActionState: "confirmed" }).pass).toBe(true);
  });
  it("8e: a veto-category event with day 0 tonight fails; other categories and earlier days pass", () => {
    expect(EVENT_VETO_CATEGORIES.has("capital_raising")).toBe(true);
    expect(gateEventState({ ...clear, events: [ev("capital_raising", "2026-03-06")] })).toEqual({
      pass: false,
      gateId: "G08_event_state",
      label: G08_LABELS["8e_event_date_veto"],
      value: "8e_event_date_veto:capital_raising:asx|ZZA-2026-03-06-capital_raising",
    });
    expect(gateEventState({ ...clear, events: [ev("results", "2026-03-06")] }).pass).toBe(true);
    expect(gateEventState({ ...clear, events: [ev("capital_raising", "2026-03-05")] }).pass).toBe(
      true,
    );
  });
  it("sub-checks are tested in order: the first failing sub-id names the failure", () => {
    expect(
      gateEventState({ ...clear, haltedNow: true, promotionState: "move_block" }),
    ).toMatchObject({
      value: "8b_promotion_flag:move_block",
    });
  });
});

describe("G09_regime (CTX-017; AT-56 fixture 11)", () => {
  const regimes: readonly RegimeLabel[] = ["SHOCK", "RISK-OFF", "RISK-ON", "NEUTRAL", "unknown"];
  const families: readonly Family[] = ["F1", "F2", "F3", "F4", "F5", "F6"];

  it("the gate equals the one CTX-017 table for every family × regime", () => {
    for (const f of families) {
      for (const r of regimes) {
        const g = gateRegime(f, r);
        expect(g.pass).toBe(!REGIME_BLOCKS[f].includes(r));
        if (!g.pass)
          expect(g).toMatchObject({ gateId: "G09_regime", label: REGIME_LABEL, value: r });
      }
    }
  });
  it("fixture 11: F3 never enters SHOCK; F2 enters RISK-OFF", () => {
    expect(gateRegime("F3", "SHOCK")).toEqual({
      pass: false,
      gateId: "G09_regime",
      label: REGIME_LABEL,
      value: "SHOCK",
      halfSize: false,
    });
    expect(gateRegime("F2", "RISK-OFF")).toEqual({
      pass: true,
      value: "RISK-OFF",
      halfSize: false,
    });
    expect(gateRegime("F1", "RISK-OFF").pass).toBe(false);
  });
  it("F4 passes SHOCK at half size; unknown blocks everyone", () => {
    expect(gateRegime("F4", "SHOCK")).toEqual({
      pass: true,
      value: "SHOCK:half_size",
      halfSize: true,
    });
    for (const f of families) expect(gateRegime(f, "unknown").pass).toBe(false);
  });
  it("F7 inherits its strongest cluster's rule", () => {
    expect(regimeBlocked("F7", "event")).toBe(REGIME_BLOCKS[F7_CLUSTER_FAMILY.event]);
    expect(gateRegime("F7", "RISK-OFF", "low_volatility").pass).toBe(true); // F4's rule
    expect(gateRegime("F7", "RISK-OFF", "momentum").pass).toBe(false); // F1's rule
    expect(gateRegime("F7", "RISK-OFF").pass).toBe(false); // no cluster: the strictest rule
  });
});

describe("G10_disagreement (CTX-023)", () => {
  const score = (means: number[]): Score => ({
    s: means.reduce((a, b) => a + b, 0) / means.length,
    K: means.length,
    clusters: means.map((mean, i) => ({
      cluster: ["momentum", "liquidity", "event", "quality"][i] as never,
      n: 1,
      mean,
    })),
  });
  it("one of four clusters opposing (d = 0.25) passes; two of four (0.5) fails with the label", () => {
    expect(gateDisagreement(score([0.5, 0.4, 0.3, -0.1]), 0.4)).toEqual({
      pass: true,
      value: "0.250000",
    });
    expect(gateDisagreement(score([0.5, 0.4, -0.3, -0.1]), 0.4)).toEqual({
      pass: false,
      gateId: "G10_disagreement",
      label: DISAGREEMENT_LABEL,
      value: "0.500000 > 0.400000",
    });
  });
  it("d equal to the maximum passes (strict comparison)", () => {
    expect(gateDisagreement(score([0.5, 0.4, -0.3, -0.1]), 0.5).pass).toBe(true);
  });
});
