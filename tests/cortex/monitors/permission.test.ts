// @vitest-environment node
// CXA-010 monitor 2 (M23 M1; D-1616): the permission rule's operating point by seeded simulation through `decideFamily`.
// Hand-checked: with the planted edge at the minimum detectable effect the true-pass rate sits near the planning power
// (0.8) and the false-pass rate near the one-sided level (0.1) or below; a sample under the trade floor never passes.
import { describe, expect, it } from "vitest";
import {
  mdeFactor,
  passRate,
  permissionMonitor,
  SIMULATED_FAMILIES,
} from "@/lib/cortex/monitors/permission";

const F = { family: "F1", nEff: 300, mde: 0.1 };

describe("monitor 2", () => {
  it("the factor of the minimum detectable effect is (z 90 % + z 80 %) = about 2.1224", () => {
    expect(mdeFactor()).toBeCloseTo(1.2815515655 + 0.8416212336, 6);
  });

  it("simulates 2,000 families a condition", () => {
    expect(SIMULATED_FAMILIES).toBe(2000);
  });

  it("false pass is at most the one-sided level and true pass is near the power at the planted edge", () => {
    const falsePass = passRate(F, 0, "t:null");
    const truePass = passRate(F, F.mde, "t:edge");
    expect(falsePass).toBeGreaterThan(0);
    expect(falsePass).toBeLessThan(0.15);
    expect(truePass).toBeGreaterThan(0.7);
    expect(truePass).toBeLessThan(0.9);
  });

  it("is seeded: the same scope gives the same rate, another scope may differ", () => {
    expect(passRate(F, 0, "t:s", 400)).toBe(passRate(F, 0, "t:s", 400));
  });

  it("a family under the trade floor (n_eff 150 against 200) cannot pass at any edge", () => {
    expect(passRate({ family: "F2", nEff: 150, mde: 0.1 }, 0.5, "t:low")).toBe(0);
  });

  it("a family with no sample or no minimum detectable effect passes at rate 0", () => {
    expect(passRate({ family: "F3", nEff: 0, mde: 0.1 }, 0.5, "t:z")).toBe(0);
    expect(passRate({ family: "F3", nEff: 300, mde: 0 }, 0.5, "t:z")).toBe(0);
  });

  it("the row has one entry per family, in order, and never an alarm", () => {
    const r = permissionMonitor(
      [
        { family: "F2", nEff: 300, mde: 0.1 },
        { family: "F1", nEff: 300, mde: 0.1 },
      ],
      "t:row",
      200,
    );
    expect(r.alarm).toBe(false);
    expect(r.ownerItems).toEqual([]);
    const v = r.value as {
      simulated: number;
      families: Array<{ family: string; false_pass: number; true_pass: number }>;
    };
    expect(v.simulated).toBe(200);
    expect(v.families.map((f) => f.family)).toEqual(["F1", "F2"]);
    for (const f of v.families) {
      expect(f.true_pass).toBeGreaterThan(f.false_pass);
    }
  });
});
