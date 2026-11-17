// @vitest-environment node
// CXA-010 monitor 7 (M23 M2; D-1621, D-1702): realised against expected stall rate; the Owner item at expected + 5 points
// exactly and not at 4.99; the fallback expected rate; the floor.
import { describe, expect, it } from "vitest";
import {
  ALARM_PP_DEFAULT,
  EXPECTED_CALIBRATION,
  EXPECTED_FALLBACK,
  MIN_COHORTS,
  stallMonitor,
  stallText,
} from "@/lib/cortex/monitors/stall";

const cal = (family: string, rate: number) =>
  ({
    family,
    rate,
    cohorts: 0,
    source: EXPECTED_CALIBRATION,
  }) as const;

describe("monitor 7: the alarm line", () => {
  it("is 5 points and the floor is the cell floor", () => {
    expect(ALARM_PP_DEFAULT).toBe(5);
    expect(MIN_COHORTS).toBe(20);
  });

  it("realised minus expected: 4.99 points does not alarm, exactly 5 does, more does", () => {
    // 200 cohorts: each stalled cohort is half a point; expected 10 % (calibrated)
    const at = (stalled: number) =>
      stallMonitor([{ family: "F1", cohorts: 200, stalled }], [cal("F1", 0.1)], 5);
    expect(at(29).alarm).toBe(false); // 14.5 %: 4.5 points
    expect(at(30).alarm).toBe(true); // 15 %: exactly 5 points
    expect(at(31).alarm).toBe(true);
    const r = at(30);
    expect(r.ownerItems).toEqual([stallText("F1")]);
    expect(r.ownerItems[0]).toBe(
      "Trades are stalling more than expected for Breakout: the parcel rule may need a review",
    );
  });

  it("the alarm width follows the configured points", () => {
    const rows = [{ family: "F1", cohorts: 100, stalled: 13 }];
    expect(stallMonitor(rows, [cal("F1", 0.1)], 5).alarm).toBe(false);
    expect(stallMonitor(rows, [cal("F1", 0.1)], 3).alarm).toBe(true);
  });
});

describe("monitor 7: the expected rate and the floors", () => {
  it("a family with no expected rate, or fewer than the floor of cohorts, is recorded and never alarms", () => {
    const none = stallMonitor([{ family: "F2", cohorts: 100, stalled: 90 }], [], 5);
    expect(none.alarm).toBe(false);
    expect((none.value.families as Array<{ expected_rate: number | null }>)[0]!.expected_rate).toBe(
      null,
    );
    const thin = stallMonitor(
      [{ family: "F2", cohorts: MIN_COHORTS - 1, stalled: MIN_COHORTS - 1 }],
      [cal("F2", 0)],
      5,
    );
    expect(thin.alarm).toBe(false);
  });

  it("the shadow-history fallback is labelled, and needs the floor of cohorts behind it", () => {
    const fb = (cohorts: number) =>
      ({
        family: "F4",
        rate: 0.1,
        cohorts,
        source: EXPECTED_FALLBACK,
      }) as const;
    const rows = [{ family: "F4", cohorts: 100, stalled: 20 }];
    const ok = stallMonitor(rows, [fb(MIN_COHORTS)], 5);
    expect(ok.alarm).toBe(true);
    expect((ok.value.families as Array<{ expected_source: string }>)[0]!.expected_source).toBe(
      "shadow, previous four quarters",
    );
    expect(stallMonitor(rows, [fb(MIN_COHORTS - 1)], 5).alarm).toBe(false);
  });
});
