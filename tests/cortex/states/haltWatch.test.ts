// @vitest-environment node
// Halt-resolution watch (CR-MOV-A1; D-741…D-743): the fixed phrase classifier, the open / resumed
// machine and the resume-day rule. Synthetic ZZ titles only (SEC-110).
import { describe, expect, it } from "vitest";
import {
  armsToday,
  classifyHaltReason,
  haltResumeVeto,
  stepHaltWatch,
  watchNoticeKind,
  WATCH_NONE,
  type HaltWatchFacts,
  type HaltWatchView,
  type WatchNotice,
} from "@/lib/cortex/states/haltWatch";

const SESSIONS = [
  "2030-03-04",
  "2030-03-05",
  "2030-03-06",
  "2030-03-07",
  "2030-03-08",
  "2030-03-11",
];

describe("watchNoticeKind", () => {
  it("separates halt, suspension and reinstatement; other announcements are null", () => {
    expect(watchNoticeKind(null, "Trading Halt")).toBe("halt");
    expect(watchNoticeKind("Trading Halt", "ZZA Pause in trading")).toBe("halt");
    expect(watchNoticeKind(null, "Suspension from Official Quotation")).toBe("suspension");
    expect(watchNoticeKind(null, "Reinstatement to Official Quotation")).toBe("reinstatement");
    // a reinstatement "following suspension" is the end of it, not a new suspension
    expect(watchNoticeKind(null, "Reinstatement following suspension")).toBe("reinstatement");
    expect(watchNoticeKind("Quarterly Activities Report", "ZZA quarterly report")).toBeNull();
  });
});

describe("classifyHaltReason (fixed phrase list, no model call)", () => {
  it.each([
    [["Trading Halt", "Proposed capital raising"], "capital_raise", -1],
    [["Trading Halt", "Placement and entitlement offer"], "capital_raise", -1],
    [["Trading Halt", "Proposed acquisition of ZZ Mining"], "takeover", 1],
    [["Trading Halt", "Scheme of arrangement update"], "takeover", 1],
    [["Trading Halt", "Response to ASX price query"], "regulatory", 0],
    [["Trading Halt", "Trading update"], "material_announcement", 0],
    [["Trading Halt"], "unknown", 0],
  ] as const)("%j -> %s (%i)", (texts, cls, sign) => {
    expect(classifyHaltReason(texts)).toEqual({ reasonClass: cls, expectedSign: sign });
  });

  it("a raising that funds a deal is still a raising (precedence)", () => {
    expect(classifyHaltReason(["Trading Halt", "Acquisition and capital raising"])).toEqual({
      reasonClass: "capital_raise",
      expectedSign: -1,
    });
  });
});

const notice = (effectiveD: string, texts: string[] = ["Trading Halt"]): WatchNotice => ({
  kind: "halt",
  ref: `asx|n-${effectiveD}`,
  effectiveD,
  texts,
});
const facts = (over: Partial<HaltWatchFacts>): HaltWatchFacts => ({
  d: "2030-03-05",
  haltedNow: true,
  tradedNow: false,
  notices: [],
  lastResolvedSinceD: null,
  ...over,
});

describe("stepHaltWatch", () => {
  it("opens on a halt notice while the code is halted, with the class from the neighbours", () => {
    const s = stepHaltWatch(
      WATCH_NONE,
      facts({ notices: [notice("2030-03-05", ["Trading Halt", "Capital raising"])] }),
    );
    expect(s.next).toMatchObject({ state: "open", sinceD: "2030-03-05", expectedSign: -1 });
    expect(s.row).toMatchObject({ status: "open", reasonClass: "capital_raise", resumeD: null });
  });

  it("opens on the notice day even when the bar traded (a halt that began mid-session)", () => {
    const s = stepHaltWatch(
      WATCH_NONE,
      facts({ haltedNow: false, tradedNow: true, notices: [notice("2030-03-05")] }),
    );
    expect(s.row?.status).toBe("open");
  });

  it("does not open on an old notice of a code that trades normally, or on a future one", () => {
    expect(
      stepHaltWatch(
        WATCH_NONE,
        facts({ haltedNow: false, tradedNow: true, notices: [notice("2030-03-04")] }),
      ).row,
    ).toBeNull();
    expect(stepHaltWatch(WATCH_NONE, facts({ notices: [notice("2030-03-06")] })).row).toBeNull();
  });

  it("resumes on the first traded session after the notice, once, and never reopens that notice", () => {
    const open = stepHaltWatch(WATCH_NONE, facts({ notices: [notice("2030-03-05")] })).next;
    const stay = stepHaltWatch(open, facts({ d: "2030-03-06", haltedNow: true }));
    expect(stay.row).toBeNull();
    const done = stepHaltWatch(
      stay.next,
      facts({ d: "2030-03-07", haltedNow: false, tradedNow: true }),
    );
    expect(done.row).toMatchObject({
      status: "resumed",
      resumeD: "2030-03-07",
      sinceD: "2030-03-05",
    });
    expect(done.next).toEqual(WATCH_NONE);
    const again = stepHaltWatch(
      done.next,
      facts({ d: "2030-03-08", notices: [notice("2030-03-05")], lastResolvedSinceD: "2030-03-05" }),
    );
    expect(again.row).toBeNull();
  });

  it("a reinstatement notice alone opens nothing", () => {
    const n: WatchNotice = { ...notice("2030-03-05"), kind: "reinstatement" };
    expect(stepHaltWatch(WATCH_NONE, facts({ notices: [n] })).row).toBeNull();
  });
});

const view = (over: Partial<HaltWatchView>): HaltWatchView => ({
  sinceD: "2030-03-04",
  status: "open",
  reasonClass: "capital_raise",
  expectedSign: -1,
  resumeD: null,
  ...over,
});
const params = { haltResumeBlockSessions: 1, haltWatchExpirySessions: 3 };

describe("haltResumeVeto (the resume-day rule, sub-check 8f)", () => {
  const veto = (w: HaltWatchView | null, family: string, d: string, p = params) =>
    haltResumeVeto({ watch: w, family, d, sessions: SESSIONS, params: p });

  it("blocks F4 and F6 while an expectation <= 0 watch is open, not the other families", () => {
    expect(veto(view({}), "F4", "2030-03-05")).toBe("open:capital_raise");
    expect(veto(view({}), "F6", "2030-03-05")).toBe("open:capital_raise");
    expect(veto(view({}), "F1", "2030-03-05")).toBeNull();
    expect(veto(view({}), "F3", "2030-03-05")).toBeNull();
  });

  it("a positive expectation (takeover) never blocks; an expired watch does not either", () => {
    expect(veto(view({ expectedSign: 1, reasonClass: "takeover" }), "F4", "2030-03-05")).toBeNull();
    expect(veto(view({}), "F4", "2030-03-11")).toBeNull(); // 5 sessions on: the halt machine owns it
  });

  it("blocks on the resume day itself and not the day after (haltResumeBlockSessions 1)", () => {
    const resumed = view({ status: "resumed", resumeD: "2030-03-06" });
    expect(veto(resumed, "F4", "2030-03-06")).toBe("resumed:capital_raise");
    expect(veto(resumed, "F4", "2030-03-07")).toBeNull();
    expect(veto(resumed, "F4", "2030-03-07", { ...params, haltResumeBlockSessions: 2 })).toBe(
      "resumed:capital_raise",
    );
    expect(veto(resumed, "F4", "2030-03-06", { ...params, haltResumeBlockSessions: 0 })).toBeNull();
  });
});

describe("armsToday", () => {
  it("arms an open watch from the session after the notice until the expiry", () => {
    const w = view({ sinceD: "2030-03-05" });
    expect(armsToday(w, "2030-03-05", SESSIONS, 3)).toBe(false); // the notice day itself
    expect(armsToday(w, "2030-03-06", SESSIONS, 3)).toBe(true);
    expect(armsToday(w, "2030-03-11", SESSIONS, 3)).toBe(false);
    expect(
      armsToday(view({ status: "resumed", resumeD: "2030-03-06" }), "2030-03-07", SESSIONS, 3),
    ).toBe(false);
  });
});
