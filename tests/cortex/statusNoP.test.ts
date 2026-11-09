// D-892 (O-79c): a rule version that claims no calibrated p binds on the economic gate alone; its
// n_eff and Brier bound are diagnostics, its p is hidden and its statement never claims forecast skill.
import { describe, expect, it } from "vitest";
import {
  allowedWeakStatement,
  decideFamily,
  LINEAGES,
  luckChance,
  NO_P_RULE_VERSIONS,
} from "@/lib/cortex/statusRules.mjs";

const cell = (lower90: number) => ({
  n: 200,
  nEff: 120,
  blocks: 40,
  lower90,
  meanNet: 0.04,
  byRegime: { NEUTRAL: { n: 120, meanNet: 0.03 }, "RISK-ON": { n: 80, meanNet: 0.05 } },
});

describe("decideFamily with claimsP: false", () => {
  it("is allowed on a passing cell even with a small n_eff and a negative Brier bound", () => {
    const d = decideFamily({
      family: "F1",
      nEff: 40,
      brierLo90: -0.05,
      slopeUb90: 2,
      cell: cell(0.01),
      claimsP: false,
    });
    expect(d).toMatchObject({ status: "allowed", allowed: true, failed: [], pHidden: true });
    expect(d.evidence).toMatchObject({ n_eff: 40, brier_skill_lo90: -0.05, p_hidden: true });
  });

  it("still fails the economic gate, regime stability and F7", () => {
    expect(
      decideFamily({
        family: "F1",
        nEff: 40,
        brierLo90: null,
        slopeUb90: null,
        cell: cell(-0.01),
        claimsP: false,
      }).failed,
    ).toEqual(["economic_gate:bound_not_positive"]);
    const unstable = {
      ...cell(0.01),
      byRegime: { NEUTRAL: { n: 120, meanNet: 0.03 }, "RISK-OFF": { n: 40, meanNet: -0.02 } },
    };
    expect(
      decideFamily({
        family: "F1",
        nEff: 40,
        brierLo90: null,
        slopeUb90: null,
        cell: unstable,
        claimsP: false,
      }).status,
    ).toBe("shadow");
    expect(
      decideFamily({
        family: "F7",
        nEff: 400,
        brierLo90: 1,
        slopeUb90: 2,
        cell: cell(0.01),
        claimsP: false,
      }).failed,
    ).toContain("f7_never_allowed");
    expect(
      decideFamily({
        family: "F1",
        nEff: 40,
        brierLo90: null,
        slopeUb90: null,
        cell: null,
        claimsP: false,
      }).failed,
    ).toEqual(["economic_gate:not_enough_history"]);
  });

  it("is today's rule when claimsP is absent or true", () => {
    const base = { family: "F1", nEff: 40, brierLo90: -0.05, slopeUb90: 2, cell: cell(0.01) };
    for (const d of [decideFamily(base), decideFamily({ ...base, claimsP: true })]) {
      expect(d.status).toBe("shadow");
      expect(d.failed).toEqual(["calibration_untestable", "brier_skill_not_positive"]);
      expect(d.pHidden).toBe(false);
    }
  });

  it("lists only F1.v2-mom and counts eight lineages", () => {
    expect(NO_P_RULE_VERSIONS).toEqual(["F1.v2-mom"]);
    expect(LINEAGES).toBe(8);
    expect(luckChance()).toBeCloseTo(1 - 0.9 ** 8, 12);
  });
});

describe("allowedWeakStatement wording", () => {
  it("the no-p statement claims a random-pick comparison, never forecast skill", () => {
    const s = allowedWeakStatement({ family: "F1", nEffLivePerSession: null, claimsP: false });
    expect(s.text).toContain("beat a random pick of the same kind by more than they cost");
    expect(s.text).toContain("gives no chance of a gain for any single trade");
    expect(s.text).not.toContain("forecasts beat the base rate");
    expect(s.text).toContain("With 8 lineages");
    for (const banned of ["certain", "guaranteed", "99%", "certified"]) {
      expect(s.text.toLowerCase()).not.toContain(banned);
    }
  });
  it("the calibrated statement is unchanged apart from the lineage count", () => {
    const s = allowedWeakStatement({ family: "F4", nEffLivePerSession: 2 });
    expect(s.text).toContain(
      "its forecasts beat the base rate and its picks earned more than they cost",
    );
    expect(s.text).toContain("With 8 lineages");
  });
});
