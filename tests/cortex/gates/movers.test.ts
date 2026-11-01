// @vitest-environment node
// The movers gap gate additions (CR-MOV-A2, A4; D-745, D-747): the results window and the known-date
// prediction, the short-risk flag, the three G08 sub-checks and the byte-for-byte rule (a night without
// the movers input gives the original verdict). Synthetic ZZ data only.
import { describe, expect, it } from "vitest";
import { gateEventState, type EventStateInput } from "@/lib/cortex/gates";
import { moversSubFail, type MoversGateInput } from "@/lib/cortex/gates/movers";
import {
  inResultsWindow,
  isResultsAnnouncement,
  predictResultsDates,
  sessionsToNextDate,
} from "@/lib/cortex/gates/resultsSeason";
import { DEFAULT_MOVERS_PARAMS } from "@/lib/cortex/moversParams";
import { NO_SHORT_RISK, shortRisk } from "@/lib/cortex/states/shortRisk";
import type { CalendarRow } from "@/lib/data/calendar";

const P = DEFAULT_MOVERS_PARAMS;
const CAL: CalendarRow[] = [];

describe("inResultsWindow", () => {
  it("February and August, whole month by default; the keys narrow it", () => {
    expect(inResultsWindow("2030-02-14", P)).toBe(true);
    expect(inResultsWindow("2030-08-30", P)).toBe(true);
    expect(inResultsWindow("2030-03-01", P)).toBe(false);
    expect(inResultsWindow("2030-07-31", P)).toBe(false);
    const narrow = { resultsWindowStartDay: 10, resultsWindowEndDay: 20 };
    expect(inResultsWindow("2030-02-09", narrow)).toBe(false);
    expect(inResultsWindow("2030-02-10", narrow)).toBe(true);
    expect(inResultsWindow("2030-08-21", narrow)).toBe(false);
  });
});

describe("predictResultsDates (needs a year of archive)", () => {
  const history = [
    { sessionD: "2029-08-22", type: "Full Year Report", title: "ZZA full year results" },
    { sessionD: "2030-02-20", type: "Half Yearly Report", title: "ZZA half year results" },
    { sessionD: "2029-11-05", type: "Quarterly Activities Report", title: "ZZA quarterly" },
    { sessionD: "2029-12-01", type: "Trading Halt", title: "ZZA trading halt" },
  ];
  const at = (d: string, archiveSinceD: string | null) =>
    predictResultsDates({ d, history, archiveSinceD, params: P });

  it("shifts each result-type row by 52 weeks and keeps those still ahead", () => {
    // 2029-08-22, 2029-11-05 and 2030-02-20, each plus 364 days
    expect(at("2030-08-01", "2029-07-01")).toEqual(["2030-08-21", "2030-11-04", "2031-02-19"]);
    expect(at("2030-10-01", "2029-07-01")).toEqual(["2030-11-04", "2031-02-19"]);
    // the trading halt of 2029-12-01 is no result date (2030-11-30 is absent above)
  });

  it("is empty until the archive spans known_date_min_history_days, and with no archive", () => {
    expect(at("2030-08-01", "2029-09-01")).toEqual([]); // 334 days of archive < 365
    expect(at("2030-08-01", null)).toEqual([]);
  });

  it("isResultsAnnouncement matches the periodic-report words only", () => {
    expect(isResultsAnnouncement("Half Yearly Report", "x")).toBe(true);
    expect(isResultsAnnouncement(null, "Appendix 4E preliminary final report")).toBe(true);
    expect(isResultsAnnouncement("Trading Halt", "x")).toBe(false);
  });

  it("sessionsToNextDate counts sessions from tonight; 0 is today; null when none", () => {
    expect(sessionsToNextDate("2030-08-19", ["2030-08-21"], CAL)).toBe(2); // Tue, Wed
    expect(sessionsToNextDate("2030-08-21", ["2030-08-21"], CAL)).toBe(0);
    expect(sessionsToNextDate("2030-08-22", ["2030-08-21"], CAL)).toBeNull();
  });
});

describe("shortRisk (a risk marker, not a direction)", () => {
  const pts = (latestPct: number, backPct: number | null) => {
    const out = [{ asOf: "2030-03-01", ppm: Math.round(latestPct * 10_000) }];
    for (let i = 1; i < 20; i += 1) out.push({ asOf: `2030-02-${10 + i}`, ppm: 0 });
    if (backPct !== null) out.push({ asOf: "2030-01-01", ppm: Math.round(backPct * 10_000) });
    return out;
  };
  it("flags the level at 5 % and the rise of 2 pp over 20 reports", () => {
    expect(shortRisk(pts(5, null), P)).toMatchObject({ flag: true, reason: "level", pct: 5 });
    expect(shortRisk(pts(4.9, 3), P)).toMatchObject({ flag: false });
    expect(shortRisk(pts(4.9, 2.9), P)).toMatchObject({ flag: true, reason: "rise" });
    expect(shortRisk([], P)).toEqual(NO_SHORT_RISK);
  });
});

const base = (over: Partial<MoversGateInput>): MoversGateInput => ({
  family: "F4",
  haltWatch: null,
  sessionsToKnownDate: null,
  inResultsWindow: false,
  shortRisk: false,
  sessions: ["2030-03-05", "2030-03-06"],
  d: "2030-03-06",
  params: P,
  ...over,
});

describe("moversSubFail", () => {
  it("8g: F4 only, inside results_pre_window_sessions of a known date; the window alone never vetoes", () => {
    expect(moversSubFail(base({ sessionsToKnownDate: 2 }))).toEqual({
      sub: "8g_known_date",
      value: "in:2",
    });
    expect(moversSubFail(base({ sessionsToKnownDate: 3 }))).toBeNull();
    expect(moversSubFail(base({ sessionsToKnownDate: 1, family: "F1" }))).toBeNull();
    expect(moversSubFail(base({ inResultsWindow: true }))).toBeNull();
    expect(
      moversSubFail(
        base({ sessionsToKnownDate: 0, params: { ...P, resultsPreWindowSessions: 0 } }),
      ),
    ).toBeNull();
  });

  it("8h: only when short_risk_f4_veto is on (default off: a smaller parcel instead)", () => {
    expect(moversSubFail(base({ shortRisk: true }))).toBeNull();
    expect(
      moversSubFail(base({ shortRisk: true, params: { ...P, shortRiskF4Veto: true } })),
    ).toEqual({ sub: "8h_short_risk", value: "heavily_shorted" });
  });

  it("8f comes first", () => {
    const w = {
      sinceD: "2030-03-05",
      status: "open" as const,
      reasonClass: "capital_raise" as const,
      expectedSign: -1 as const,
      resumeD: null,
    };
    expect(moversSubFail(base({ haltWatch: w, sessionsToKnownDate: 0 }))?.sub).toBe(
      "8f_halt_resume",
    );
  });
});

describe("gateEventState with the movers input", () => {
  const clear: EventStateInput = {
    d: "2030-03-06",
    fillD: "2030-03-07",
    indexChangesLoaded: true,
    indexChanges: [],
    sessions: ["2030-03-05", "2030-03-06"],
    indexChangeWindowSessions: 2,
    promotionState: "none",
    haltState: "none",
    haltedNow: false,
    corpActionState: "none",
    events: [],
  };

  it("without the movers input the verdict is the original one (a pass has no value)", () => {
    expect(gateEventState(clear)).toEqual({ pass: true });
  });

  it("a movers failure names its sub-id in the value and uses the plain label", () => {
    const r = gateEventState({ ...clear, movers: base({ sessionsToKnownDate: 1 }) });
    expect(r).toEqual({
      pass: false,
      gateId: "G08_event_state",
      label: "this company is about to report its results",
      value: "8g_known_date:in:1",
    });
  });

  it("the Feb / Aug window is a note on a pass, never a veto", () => {
    expect(gateEventState({ ...clear, movers: base({ inResultsWindow: true }) })).toEqual({
      pass: true,
      value: "results_window",
    });
  });

  it("an earlier sub-check wins over a movers one (order 8a…8e then 8f…8h)", () => {
    const r = gateEventState({
      ...clear,
      haltedNow: true,
      movers: base({ sessionsToKnownDate: 1 }),
    });
    expect(r).toMatchObject({ pass: false, value: "8c_halt_suspension:halted" });
  });
});
