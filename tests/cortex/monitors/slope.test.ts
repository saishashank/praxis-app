// @vitest-environment node
// CXA-010 monitor 3 (M23 M1; D-1617): the slope's upper bound against 0.7. The existing hide rule at 1.0 is unchanged.
import { describe, expect, it } from "vitest";
import { SLOPE_ALARM_UB, slopeAlarm, slopeMonitor } from "@/lib/cortex/monitors/slope";
import { DEFAULT_HIDE_UB, slopeHiddenFromUb } from "@/lib/cortex/statusRules.mjs";

describe("monitor 3: the alarm line is 0.7", () => {
  it("below alarms, exactly at and above do not, an undefined bound does not", () => {
    expect(SLOPE_ALARM_UB).toBe(0.7);
    expect(slopeAlarm(0.6999)).toBe(true);
    expect(slopeAlarm(0.7)).toBe(false);
    expect(slopeAlarm(0.7001)).toBe(false);
    expect(slopeAlarm(null)).toBe(false);
  });

  it("the code rule is untouched: p stays hidden below 1.0, shown at 1.0", () => {
    expect(DEFAULT_HIDE_UB).toBe(1.0);
    expect(slopeHiddenFromUb(0.99)).toBe(true);
    expect(slopeHiddenFromUb(1.0)).toBe(false);
    expect(slopeHiddenFromUb(null)).toBe(true);
  });
});

describe("monitor 3: the row and the Owner lines", () => {
  const r = slopeMonitor([
    { family: "F3", slopeUb90: 0.7 },
    { family: "F1", slopeUb90: 0.6 },
    { family: "F2", slopeUb90: 0.95 },
    { family: "F4", slopeUb90: null },
  ]);
  it("one alarm, named in plain words (no family code), families in order", () => {
    expect(r.alarm).toBe(true);
    expect(r.ownerItems).toEqual(["Confidence figures are over-stated for Breakout"]);
    const fam = (
      r.value as { families: Array<{ family: string; alarm: boolean; hidden: boolean }> }
    ).families;
    expect(fam.map((f) => f.family)).toEqual(["F1", "F2", "F3", "F4"]);
    expect(fam.map((f) => f.alarm)).toEqual([true, false, false, false]);
    // hidden follows the unchanged 1.0 rule: 0.6, 0.95, 0.7 and the undefined bound are all hidden
    expect(fam.map((f) => f.hidden)).toEqual([true, true, true, true]);
  });

  it("no family below the line: no alarm, no item", () => {
    const q = slopeMonitor([{ family: "F1", slopeUb90: 0.7 }]);
    expect(q.alarm).toBe(false);
    expect(q.ownerItems).toEqual([]);
  });
});
