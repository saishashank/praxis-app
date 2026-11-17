// @vitest-environment node
// CXA-010 monitor 8 (M23 M2; D-1622, D-1703): the share of gate-passing setups the fill model leaves unfilled, against the
// quarter before; the alarm at 5 points exactly and not at 4.99; the floor.
import { describe, expect, it } from "vitest";
import {
  MIN_SETUPS,
  fillExclusionMonitor,
  fillExclusionText,
} from "@/lib/cortex/monitors/fillExclusion";

const fc = (family: string, scored: number, unfilled: number) => ({ family, scored, unfilled });

describe("monitor 8: the rise over the previous quarter", () => {
  it("4.5 points does not alarm, exactly 5 does, 5.5 does", () => {
    const before = [fc("F1", 200, 20)]; // 10 %
    const now = (unfilled: number) => fillExclusionMonitor([fc("F1", 200, unfilled)], before, 5);
    expect(now(29).alarm).toBe(false); // 14.5 %
    expect(now(30).alarm).toBe(true); // 15 %
    expect(now(31).alarm).toBe(true);
    expect(now(30).ownerItems).toEqual([fillExclusionText("F1")]);
    expect(now(30).ownerItems[0]).toBe(
      "More Breakout setups went unfilled than last quarter: the published figures cover fewer setups than they appear to",
    );
  });

  it("a fall, no change, a family new this quarter, and a thin quarter never alarm", () => {
    const before = [fc("F1", 200, 40)];
    expect(fillExclusionMonitor([fc("F1", 200, 20)], before, 5).alarm).toBe(false);
    expect(fillExclusionMonitor([fc("F1", 200, 40)], before, 5).alarm).toBe(false);
    expect(fillExclusionMonitor([fc("F2", 200, 100)], before, 5).alarm).toBe(false);
    expect(MIN_SETUPS).toBe(20);
    expect(
      fillExclusionMonitor([fc("F1", MIN_SETUPS - 1, MIN_SETUPS - 1)], [fc("F1", 200, 0)], 5).alarm,
    ).toBe(false);
    expect(fillExclusionMonitor([fc("F1", 200, 100)], [fc("F1", MIN_SETUPS - 1, 0)], 5).alarm).toBe(
      false,
    );
  });

  it("records the share and the previous share per family, in order", () => {
    const r = fillExclusionMonitor([fc("F3", 100, 10), fc("F1", 100, 50)], [fc("F1", 100, 25)], 5);
    const f = r.value.families as Array<{
      family: string;
      unfilled_share: number;
      previous_share: number | null;
    }>;
    expect(f.map((x) => x.family)).toEqual(["F1", "F3"]);
    expect(f[0]).toMatchObject({ unfilled_share: 0.5, previous_share: 0.25 });
    expect(f[1]!.previous_share).toBe(null);
  });
});
