// @vitest-environment node
// CXA-010 monitor 1 (M23 M1; D-1615): the promotion-flag hit rate and the event-entry gap between smaller and large
// companies. Hand-checked values at the thresholds: a lower bound exactly 0 is no alarm, below is one; the group floor
// (20 setups each) exactly met and one short; a flag return exactly 0 is not a hit.
import { describe, expect, it } from "vitest";
import {
  MIN_SETUPS_PER_GROUP,
  PROMOTION_ALARM_TEXT,
  diffAlarm,
  groupDiffLowerBound,
  promotionMonitor,
  type EntryRead,
} from "@/lib/cortex/monitors/promotion";
import { addDays, previousQuarter, quarterOf, quarterRange } from "@/lib/cortex/monitors/store";

/** n entries of one tier, each on its own session, all with the same net. */
function entries(tier: EntryRead["tier"], n: number, netPpm: number, offset = 0): EntryRead[] {
  return Array.from({ length: n }, (_, i) => ({
    tier,
    netPpm,
    session: addDays("2030-01-01", i * 2 + offset),
  }));
}

describe("quarter helpers", () => {
  it("quarterOf, previousQuarter and quarterRange at the edges", () => {
    expect(quarterOf("2030-01-01")).toBe("2030-Q1");
    expect(quarterOf("2030-03-31")).toBe("2030-Q1");
    expect(quarterOf("2030-04-01")).toBe("2030-Q2");
    expect(quarterOf("2030-12-31")).toBe("2030-Q4");
    expect(previousQuarter("2030-04-01")).toBe("2030-Q1");
    expect(previousQuarter("2030-01-02")).toBe("2029-Q4");
    expect(quarterRange("2030-Q2")).toEqual({ from: "2030-04-01", to: "2030-06-30" });
    expect(() => quarterRange("2030-Q5")).toThrow();
  });
});

describe("monitor 1: the alarm line", () => {
  it("a lower bound of exactly 0 is no alarm; below 0 is; above 0 is not; no bound is not", () => {
    expect(diffAlarm(0)).toBe(false);
    expect(diffAlarm(-1e-9)).toBe(true);
    expect(diffAlarm(1e-9)).toBe(false);
    expect(diffAlarm(null)).toBe(false);
  });
});

describe("monitor 1: the bound with fixed groups (hand-checked)", () => {
  it("smaller 20 at -1000, large 20 at +500: every replicate is -1500, so the bound is -1500 and the alarm fires", () => {
    const e = [...entries("U2", 20, -1000), ...entries("U1", 20, 500, 1)];
    expect(groupDiffLowerBound(e, "t:a", 200)).toBe(-1500);
    const r = promotionMonitor({ flagReturns: [], entries: e, scope: "t:a", replicates: 200 });
    expect(r.alarm).toBe(true);
    expect(r.ownerItems).toEqual([PROMOTION_ALARM_TEXT]);
    expect(r.value).toMatchObject({
      entries: { smaller_n: 20, large_n: 20, diff_ppm: -1500, lower90_ppm: -1500 },
    });
  });

  it("equal means in both groups: the bound is exactly 0 and there is no alarm", () => {
    const e = [...entries("U3", 20, 700), ...entries("U1", 20, 700, 1)];
    expect(groupDiffLowerBound(e, "t:b", 200)).toBe(0);
    expect(
      promotionMonitor({ flagReturns: [], entries: e, scope: "t:b", replicates: 200 }).alarm,
    ).toBe(false);
  });

  it("smaller companies ahead (+500 against -1000): bound +1500, no alarm", () => {
    const e = [...entries("U2", 20, 500), ...entries("U1", 20, -1000, 1)];
    expect(groupDiffLowerBound(e, "t:c", 200)).toBe(1500);
    expect(
      promotionMonitor({ flagReturns: [], entries: e, scope: "t:c", replicates: 200 }).alarm,
    ).toBe(false);
  });

  it("the group floor: 20 each gives a bound, 19 in one group gives none and no alarm", () => {
    expect(MIN_SETUPS_PER_GROUP).toBe(20);
    const ok = [...entries("U2", 20, -1000), ...entries("U1", 20, 500, 1)];
    const short = [...entries("U2", 19, -1000), ...entries("U1", 20, 500, 1)];
    expect(groupDiffLowerBound(ok, "t:d", 100)).not.toBeNull();
    expect(groupDiffLowerBound(short, "t:d", 100)).toBeNull();
    const r = promotionMonitor({ flagReturns: [], entries: short, scope: "t:d", replicates: 100 });
    expect(r.alarm).toBe(false);
    expect(r.value).toMatchObject({ entries: { lower90_ppm: null } });
  });

  it("the same input and scope give the same bound (seeded)", () => {
    const e = [
      ...entries("U2", 25, -300).map((x, i) => ({ ...x, netPpm: x.netPpm + (i % 5) * 400 })),
      ...entries("U1", 25, 100, 1).map((x, i) => ({ ...x, netPpm: x.netPpm + (i % 4) * 300 })),
    ];
    expect(groupDiffLowerBound(e, "t:e", 300)).toBe(groupDiffLowerBound(e, "t:e", 300));
  });
});

describe("monitor 1: the flag hit rate", () => {
  it("a hit is a return below 0; exactly 0 is not; the rate is hits over matured flags", () => {
    const r = promotionMonitor({
      flagReturns: [-0.05, -0.0001, 0, 0.02],
      entries: [],
      scope: "t:f",
    });
    expect(r.value).toMatchObject({ flags: { matured: 4, hits: 2, hit_rate: 0.5 } });
    expect(r.alarm).toBe(false);
  });

  it("no flags: a null rate, no alarm", () => {
    const r = promotionMonitor({ flagReturns: [], entries: [], scope: "t:g" });
    expect(r.value).toMatchObject({ flags: { matured: 0, hits: 0, hit_rate: null } });
    expect(r.alarm).toBe(false);
    expect(r.ownerItems).toEqual([]);
  });
});
