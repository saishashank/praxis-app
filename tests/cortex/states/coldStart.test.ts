// @vitest-environment node
// CTX-055 cold start (M15 C3b; AT-56 fixture 9 "cold-start session 3 -> warming up, no fault").
import { describe, expect, it } from "vitest";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import {
  COLD_START_FAMILIES,
  coldStartAt,
  populationStabilityIndex,
  sessionNumberAt,
  WARMING_UP_LABEL,
} from "@/lib/cortex/states/coldStart";
import { path, SESSIONS, statesWorld } from "./zzStates";

const view = buildAsOfView(
  statesWorld([{ code: "ZZA", tier: "U1", bars: { closesCents: path(1000, 0, []) } }]),
);
const GO_LIVE = SESSIONS[0]!;

describe("fixture 9: session 3 after go-live", () => {
  it("is 'warming up' with F1 and F4 only and no refit, and nothing is a fault", () => {
    const r = coldStartAt(view, 2, { goLiveD: GO_LIVE, abstainRatePct: 100 }, false);
    expect(r.state).toEqual({
      phase: "cold",
      sessionNumber: 3,
      familiesAllowed: COLD_START_FAMILIES,
      refitAllowed: false,
      label: "warming up (session 3 of 20)",
      reason: "cold_start",
    });
    expect(r.state.familiesAllowed).toEqual(["F1", "F4"]);
    expect(r.eligible).toBe(true);
    expect(r.abstainAlarm).toBe(false); // a 100 % abstain rate is no alarm inside the cold phase
    expect(r.populationStable).toBeNull();
    expect(r.psi).toBeNull();
  });

  it("a candidate with an undefined angle is ineligible ('warming up') in every phase", () => {
    expect(coldStartAt(view, 2, { goLiveD: GO_LIVE }, true).eligible).toBe(false);
    expect(coldStartAt(view, 25, { goLiveD: GO_LIVE }, true).eligible).toBe(false);
    expect(WARMING_UP_LABEL).toBe("we do not have enough history on this company yet (warming up)");
  });
});

describe("session arithmetic and the later checks", () => {
  it("counts sessions from the go-live date; before it the number is 0", () => {
    expect(sessionNumberAt(view, 0, GO_LIVE)).toBe(1);
    expect(sessionNumberAt(view, 19, GO_LIVE)).toBe(20);
    expect(sessionNumberAt(view, 5, SESSIONS[3]!)).toBe(3);
    expect(sessionNumberAt(view, 2, SESSIONS[3]!)).toBe(0);
    expect(coldStartAt(view, 2, { goLiveD: SESSIONS[3]! }, false).state).toMatchObject({
      sessionNumber: 0,
      reason: "before_go_live",
      familiesAllowed: [],
    });
  });

  it("session 20 is the last cold session; session 21 is warm with every family and refits allowed", () => {
    expect(coldStartAt(view, 19, { goLiveD: GO_LIVE }, false).state).toMatchObject({
      phase: "cold",
      sessionNumber: 20,
    });
    const warm = coldStartAt(view, 20, { goLiveD: GO_LIVE }, false).state;
    expect(warm).toMatchObject({
      phase: "warm",
      sessionNumber: 21,
      refitAllowed: true,
      label: "live",
    });
    expect(warm.familiesAllowed).toEqual(["F1", "F2", "F3", "F4", "F5", "F6"]);
  });

  it("an abstain rate above 95 % after session 20 raises the Owner item", () => {
    expect(
      coldStartAt(view, 20, { goLiveD: GO_LIVE, abstainRatePct: 96 }, false).abstainAlarm,
    ).toBe(true);
    expect(
      coldStartAt(view, 20, { goLiveD: GO_LIVE, abstainRatePct: 95 }, false).abstainAlarm,
    ).toBe(false);
    expect(
      coldStartAt(view, 20, { goLiveD: GO_LIVE, abstainRatePct: null }, false).abstainAlarm,
    ).toBe(false);
  });

  it("the session-20 population-stability check runs once, on session 20", () => {
    const same = { baseline: [0.25, 0.25, 0.25, 0.25], tonight: [0.25, 0.25, 0.25, 0.25] };
    const shifted = { baseline: [0.25, 0.25, 0.25, 0.25], tonight: [0.7, 0.1, 0.1, 0.1] };
    expect(coldStartAt(view, 19, { goLiveD: GO_LIVE, population: same }, false)).toMatchObject({
      populationStable: true,
      psi: 0,
    });
    const bad = coldStartAt(view, 19, { goLiveD: GO_LIVE, population: shifted }, false);
    expect(bad.populationStable).toBe(false);
    expect(bad.psi).toBeGreaterThan(0.25);
    expect(
      coldStartAt(view, 18, { goLiveD: GO_LIVE, population: shifted }, false).populationStable,
    ).toBeNull();
    expect(
      coldStartAt(view, 20, { goLiveD: GO_LIVE, population: shifted }, false).populationStable,
    ).toBeNull();
    expect(populationStabilityIndex([0.5, 0.5], [0.5, 0.5])).toBe(0);
    expect(() => populationStabilityIndex([0.5], [0.5, 0.5])).toThrow(RangeError);
  });
});
