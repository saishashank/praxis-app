// D8 Timing, calendar and execution: registry entries (M15 C1c; angles_D8.md; CTX-011, CTX-014,
// CTX-022b, CTX-024, CTX-028; D-292). Every D8 angle is a gate. Where the rule already exists in v1
// (the gap cap, one-session validity, the re-entry block, the time-stop comparator) the entry has no
// `compute` and cites the module; three are computable from the vendor actions, the DAT-234 list
// and the trading calendar (ex-date flag, index-event window, weekday / holiday bucket); the three
// that need results dates or the announcement archive carry `needsData` (CTX-051).
import { addDays, isWeekend } from "@/lib/data/calendar";
import { ANNOUNCEMENT_ARCHIVE } from "./d3";
import { nightMemo } from "./d5";
import type { AngleDef, AsOfView } from "./types";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const INDEX_WINDOW_BEFORE = 1; // threshold-ok: sessions before D in the index-event window
const INDEX_WINDOW_AFTER = 20; // threshold-ok: sessions after D in the index-event window

function weekdayOf(d: string): string {
  return WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]!;
}

/** The nearest weekday strictly before (step -1) or after (step +1) `d`. */
function adjacentWeekday(d: string, step: 1 | -1): string {
  let x = addDays(d, step);
  while (isWeekend(x)) x = addDays(x, step);
  return x;
}

/**
 * Session dates of the calendar (every row that is not a holiday) strictly after sessions[t], up to
 * `count`. The calendar is known at load, so reading forward dates is not look-ahead; when it ends
 * early (a short forward calendar) fewer dates come back and the window is shorter than asked.
 */
function sessionsAfter(view: AsOfView, t: number, count: number): string[] {
  const d = view.sessions[t]!;
  const out: string[] = [];
  for (const row of view.calendar) {
    if (row.d <= d || row.kind === "holiday") continue;
    out.push(row.d);
    if (out.length >= count) break;
  }
  return out;
}

export const D8_ANGLES: readonly AngleDef[] = [
  {
    id: "A-D8-01",
    version: 1,
    domain: 8,
    title: "Next-open fill expectation and gap cap",
    definition:
      "g = open(D+1) / close(D) - 1; a buy is cancelled at the open when g >= G, G = entry_gap_cap_pct = 8 % for every family (CTX-022b, CTX-028); a lower G for F1 and F4 is a counted challenger; g is a display value.",
    kind: "gate",
    cluster: "risk",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 1,
    inputs: ["bar_au"],
    grid: { gap_cap_pct: [8, 3, 4, 5, 6, 7] },
    existing: [
      "CTX-022b",
      "CTX-028",
      "ARN-020",
      "src/lib/agents/families/exits.ts gapCancelLevel",
      "src/lib/arena/fills.ts",
      "G09_open_time",
    ],
  },
  {
    id: "A-D8-02",
    version: 1,
    domain: 8,
    title: "Entry delay: D+1 open versus D+2 open",
    definition:
      "decay_k = mean of open(D+k) / close(D) - 1 on the development split for k = 1..3 (a diagnostic); the fill model is D+1 (CTX-028) and D+2 entries exist only on the CTX-043 U2/U3 event path; the delayed variant is a counted challenger.",
    kind: "gate",
    cluster: "risk",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 3,
    inputs: ["bar_au"],
    grid: { k: [1, 2, 3] },
    existing: ["CTX-028", "CTX-043", "VAL-114", "P-02-5", "src/lib/arena/fills.ts fillEntryAtOpen"],
  },
  {
    id: "A-D8-03",
    version: 1,
    domain: 8,
    title: "Ex-dividend calendar and turn-of-month effects",
    definition:
      "flag ex_date_adjusted when tonight's session is the ex-date of a cash dividend known at the cut-off (FAM-007: the stop is compared with close + the credited dividend, CTX-024), else none; day-of-month effects are descriptive only. A vendor row is known from the start of the session before its ex-date, so ex_offset >= 2 fires only on rows with a GL-02 known_at stamp (D-327).",
    kind: "gate",
    cluster: "calendar",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 0,
    inputs: ["corp_action", "bar_au", "calendar"],
    grid: { ex_offset: [0, -2, -1, 1, 2] },
    historyFields: [
      "12 monthly plus day-of-month tests inflate the trial count (ARN-085): one descriptive trial",
    ],
    existing: ["FAM-007", "CTX-024", "P-06-5", "K-056", "src/lib/arena/exDividend.ts"],
    compute: (view, code, t, grid) => {
      const d = view.sessions[t]!;
      const offset = grid.ex_offset!;
      for (const a of view.corpActions(code, t)) {
        if (a.type !== "cash_dividend") continue;
        if (offset === 0 ? a.exDate === d : offsetMatches(view, t, a.exDate, offset))
          return { flag: "ex_date_adjusted" };
      }
      return { flag: "none" };
    },
  },
  {
    id: "A-D8-04",
    version: 1,
    domain: 8,
    title: "Results-season timing",
    definition:
      "bucket in_season / out: the session lies inside the market's half-year or full-year reporting window; the F5 challenger enters 5 to 15 sessions before a results date (P-08-7); a timing and capacity flag only.",
    kind: "gate",
    cluster: "calendar",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 0,
    inputs: ["announcement", "calendar"],
    grid: { pre_results_window: [10, 5, 15] },
    needsData: "results-date calendar (DAT-125) and the announcement archive (CTX-051)",
    historyFields: ["season and regime are confounded (August to September)"],
    existing: ["K-024", "P-08-7", "CTX-026"],
  },
  {
    id: "A-D8-05",
    version: 1,
    domain: 8,
    title: "Index-change and rebalance dates",
    definition:
      "flag excluded_index_event when an S&P/ASX add or delete of the code (DAT-234) has its effective date inside [D - 1, D + 20] sessions, unknown when the list is missing (fail closed, CTX-013 step 8), else none; F3 triggers are excluded and tagged; the review-date veto (review_veto sessions before a quarterly effective date) is a challenger.",
    kind: "gate",
    cluster: "calendar",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 1,
    // Inputs = what the compute reads (N3); the archive needsData keeps the entry candidate (CTX-051).
    inputs: ["index_change", "calendar"],
    grid: { review_veto: [1, 2] },
    needsData: ANNOUNCEMENT_ARCHIVE,
    historyFields: [
      "the free list may be incomplete or late (DAT-234 [VERIFY]); few events, small n",
    ],
    existing: ["DAT-234", "P-06-4", "R-06-8", "CTX-013 step 8", "G08_event_state"],
    compute: (view, code, t) => {
      if (!view.indexChangesLoaded) return { flag: "unknown" };
      const from = view.sessions[Math.max(0, t - INDEX_WINDOW_BEFORE)]!;
      const ahead = sessionsAfter(view, t, INDEX_WINDOW_AFTER);
      const to = ahead.length > 0 ? ahead[ahead.length - 1]! : view.sessions[t]!;
      for (const c of view.indexChanges(code, t)) {
        if (c.effective >= from && c.effective <= to) return { flag: "excluded_index_event" };
      }
      return { flag: "none" };
    },
  },
  {
    id: "A-D8-06",
    version: 1,
    domain: 8,
    title: "Days-to-scheduled-event veto",
    definition:
      "veto_event_window when the next scheduled event of the code (results date, ex-date, index review) or the market (RBA decision) is within k sessions of the fill; k = 0 at go-live (no veto), each k a charged cell.",
    kind: "gate",
    cluster: "calendar",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 0,
    inputs: ["announcement", "corp_action", "index_change", "calendar"],
    grid: { k: [0, 1, 2, 3, 4, 5] },
    needsData:
      "results dates (DAT-125), index review dates (DAT-234), RBA board dates (DAT-236 terms) and the announcement archive (CTX-051)",
    historyFields: ["unscheduled news dominates and is not vetoed"],
    existing: ["K-026", "K-024", "CTX-013 step 8"],
  },
  {
    id: "A-D8-07",
    version: 1,
    domain: 8,
    title: "Day-of-week and holiday effects (expected null)",
    definition:
      "bucket of tonight's session: pre_holiday when the next weekday is an ASX holiday, post_holiday when the previous weekday was one, else the weekday (mon..fri); descriptive only, seven tests logged before results are opened; no rule in V2.",
    kind: "gate",
    cluster: "calendar",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 0,
    inputs: ["calendar"],
    grid: {},
    historyFields: ["K-056: ASX weekday effects weaken after 1987; expected null"],
    existing: ["K-056", "R-06-4"],
    compute: (view, _code, t) => {
      const d = view.sessions[t]!;
      const holidays = nightMemo(
        view,
        "holidays",
        () => new Set(view.calendar.filter((r) => r.kind === "holiday").map((r) => r.d)),
      );
      if (holidays.has(adjacentWeekday(d, 1))) return { bucket: "pre_holiday" };
      if (holidays.has(adjacentWeekday(d, -1))) return { bucket: "post_holiday" };
      return { bucket: weekdayOf(d) };
    },
  },
  {
    id: "A-D8-08",
    version: 1,
    domain: 8,
    title: "Stale-signal expiry",
    definition:
      "A buy is valid for one fill at the D+1 open only (FAM-008, CTX-014); an unfilled one expires with its reason (gap cap, halt, parcel, participation cap, pre-open cancel) and is never queued; carry-over needs a fresh signal and is a counted challenger.",
    kind: "gate",
    cluster: "risk",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 0,
    inputs: ["bar_au", "calendar"],
    grid: { validity_sessions: [1, 2] },
    existing: ["FAM-008", "CTX-014", "ARN-020a", "src/lib/arena/preopen.ts", "G09_open_time"],
  },
  {
    id: "A-D8-09",
    version: 1,
    domain: 8,
    title: "Re-entry cooling-off",
    definition:
      "The same execution may not re-enter a code for block_k sessions after an exit by type: IS stop = reentry_block (10, FAM-002); CS and time-limit exits = cs_block; target = 0; the consecutive-stop pause is a counted trial.",
    kind: "gate",
    cluster: "risk",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 0,
    inputs: ["bar_au"],
    grid: { cs_block: [0, 5, 10] },
    existing: ["FAM-002", "ARN-080", "src/lib/agents/batch2b.ts reentryBlocked", "G02_eligibility"],
  },
  {
    id: "A-D8-10",
    version: 1,
    domain: 8,
    title: "Exit timing: time stop versus trailing stop",
    definition:
      "Comparator = time-stop-only exit at the family limit on the same entries (ARN-106); a trail is kept only when its net excess beats the comparator with a bootstrap interval (ARN-081); the trail only moves up (CTX-024); give-back ratio = 1 - realised / MFE shown beside it.",
    kind: "gate",
    cluster: "risk",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 20,
    inputs: ["bar_au"],
    grid: { trail_atr: [3, 2, 2.5] },
    existing: [
      "ARN-106",
      "ARN-081",
      "CTX-024",
      "R-07-4",
      "src/lib/agents/families/exits.ts evaluateExit",
    ],
  },
];

/** True when the ex-date sits `offset` sessions from sessions[t] (negative = before tonight). */
function offsetMatches(view: AsOfView, t: number, exDate: string, offset: number): boolean {
  if (offset < 0) {
    const i = t + offset;
    return i >= 0 && view.sessions[i] === exDate;
  }
  const ahead = sessionsAfter(view, t, offset);
  return ahead.length === offset && ahead[offset - 1] === exDate;
}
