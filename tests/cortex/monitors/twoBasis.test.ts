// @vitest-environment node
// CXA-010 monitor 4 (M23 M1; D-1618): two-basis stop conflicts. Count above 0 with at least one close on the stop alarms.
import { describe, expect, it } from "vitest";
import {
  candidateWindows,
  twoBasisMonitor,
  type HeldPosition,
} from "@/lib/cortex/monitors/twoBasis";

const Q = { from: "2030-01-01", to: "2030-03-31" };
const W = [{ code: "Z1", from: "2030-02-01", to: "2030-02-20" }];
const pos = (p: Partial<HeldPosition>): HeldPosition => ({
  code: "Z1",
  fillD: "2030-01-15",
  exitD: "2030-02-10",
  exitRule: "level",
  ...p,
});

describe("candidateWindows", () => {
  it("a candidate row opens a window, the next row of the code closes it, an open one runs on", () => {
    expect(
      candidateWindows([
        { code: "Z1", fromD: "2030-02-01", state: "candidate" },
        { code: "Z1", fromD: "2030-02-05", state: "candidate_owner_alert" },
        { code: "Z1", fromD: "2030-02-20", state: "none" },
        { code: "Z2", fromD: "2030-03-01", state: "candidate" },
      ]),
    ).toEqual([
      { code: "Z1", from: "2030-02-01", to: "2030-02-20" },
      { code: "Z2", from: "2030-03-01", to: "9999-12-31" },
    ]);
  });
});

describe("monitor 4: thresholds", () => {
  it("no position held through a window: 0 and 0, no alarm", () => {
    const r = twoBasisMonitor(W, [pos({ code: "Z9" })], Q);
    expect(r.value).toEqual({ held_through_unconfirmed: 0, closed_on_stop: 0 });
    expect(r.alarm).toBe(false);
  });

  it("held through a window but not closed on a stop: count 1, closed 0, no alarm", () => {
    const r = twoBasisMonitor(W, [pos({ exitD: "2030-02-25", exitRule: "level" })], Q);
    expect(r.value).toEqual({ held_through_unconfirmed: 1, closed_on_stop: 0 });
    expect(r.alarm).toBe(false);
    const open = twoBasisMonitor(W, [pos({ exitD: null, exitRule: null })], Q);
    expect(open.value).toEqual({ held_through_unconfirmed: 1, closed_on_stop: 0 });
    expect(open.alarm).toBe(false);
  });

  it("closed on a stop inside the window: count 1, closed 1, alarm in plain words", () => {
    const r = twoBasisMonitor(W, [pos({})], Q);
    expect(r.value).toEqual({ held_through_unconfirmed: 1, closed_on_stop: 1 });
    expect(r.alarm).toBe(true);
    expect(r.ownerItems).toHaveLength(1);
    expect(r.ownerItems[0]).toMatch(/closed on a stop/);
  });

  it("a close by another rule inside the window is not a stop close; the window edge days count", () => {
    expect(twoBasisMonitor(W, [pos({ exitRule: "close_signal" })], Q).alarm).toBe(false);
    expect(twoBasisMonitor(W, [pos({ exitD: "2030-02-01", exitRule: "gap_open" })], Q).alarm).toBe(
      true,
    );
    expect(twoBasisMonitor(W, [pos({ exitD: "2030-02-20", exitRule: "level" })], Q).alarm).toBe(
      true,
    );
    expect(twoBasisMonitor(W, [pos({ exitD: "2030-02-21", exitRule: "level" })], Q).alarm).toBe(
      false,
    );
  });

  it("a position that closed before the quarter is not counted", () => {
    const r = twoBasisMonitor(W, [pos({ fillD: "2029-11-01", exitD: "2029-12-20" })], Q);
    expect(r.value).toEqual({ held_through_unconfirmed: 0, closed_on_stop: 0 });
  });
});
