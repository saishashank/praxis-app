// @vitest-environment node
// D-922 Evening Review wording helpers: A$ amounts, plain exit reasons, the honest "what worked"
// headline, closed-trade lines and the plain lists of sections 4-6 built from the daily learning.
import { describe, expect, it } from "vitest";
import {
  aud,
  audWithPct,
  BRAIN_HEADING,
  TOP5_HEADING,
  closedLine,
  companyLabel,
  exitWords,
  pctPpm,
  reviewLists,
  sortClosed,
  workedHeadline,
  type ClosedTradeFact,
} from "@/lib/email/templates/reviewWords";
import type { DailyLearning } from "@/lib/learning/daily";

const t = (over: Partial<ClosedTradeFact>): ClosedTradeFact => ({
  strategy: "Follow the trend",
  code: "ZZA",
  company: "Zed Alpha Ltd",
  resultCents: -500,
  exit: "stop-loss hit",
  ...over,
});

describe("amounts", () => {
  it("formats A$ with and without a sign, and percentages", () => {
    expect(aud(2470)).toBe("A$24.70");
    expect(aud(2470, true)).toBe("+A$24.70");
    expect(aud(-175, true)).toBe("-A$1.75");
    expect(aud(0, true)).toBe("A$0.00");
    expect(pctPpm(12_000)).toBe("+1.2%");
    expect(pctPpm(-3_000)).toBe("-0.3%");
    expect(pctPpm(12_000, false)).toBe("1.2%");
    expect(audWithPct(2470, 12_000)).toBe("+A$24.70 (+1.2%)");
    expect(audWithPct(2470, null)).toBe("+A$24.70");
    expect(audWithPct(2470, undefined)).toBe("+A$24.70");
  });
  it("company label falls back to the code", () => {
    expect(companyLabel("BlueScope Steel", "BSL")).toBe("BlueScope Steel (BSL)");
    for (const n of [null, undefined, "", "n/a"]) expect(companyLabel(n, "BSL")).toBe("BSL");
  });
});

describe("exitWords", () => {
  it.each([
    ["IS", null, "level", "stop-loss hit"],
    ["IS", null, "gap_open", "price gapped past the stop-loss"],
    [
      "CS:close_above_sma",
      null,
      null,
      "closing signal: the price crossed its average (the trend turned)",
    ],
    ["CS:time_stop", null, null, "closing signal: the time limit ran out"],
    ["CS:something_new", null, null, "closing signal"],
    ["CS", null, null, "closing signal"],
    ["terminal:takeover", null, null, "closed because of a company event (such as a takeover)"],
    [null, "terminal", null, "closed because of a company event (such as a takeover)"],
    [null, "IS", "gap_open", "price gapped past the stop-loss"],
    [null, null, "gap_open", "price gapped past the stop-loss"],
    [null, null, null, "closed"],
  ])("%s / %s / %s -> %s", (reason, type, rule, want) => {
    expect(exitWords(reason, type, rule)).toBe(want);
  });
});

describe("what worked", () => {
  it("is honest when nothing finished or everything lost", () => {
    expect(workedHeadline([])).toEqual({
      worked: false,
      text: "Nothing worked today: no strategy finished a trade.",
    });
    expect(workedHeadline([t({})]).text).toBe(
      "Nothing worked today: the one trade that finished lost money (-A$5.00 in all).",
    );
    expect(workedHeadline([t({}), t({ code: "ZZB", resultCents: -300 })]).text).toBe(
      "Nothing worked today: all 2 trades that finished lost money (-A$8.00 in all).",
    );
  });
  it("counts the winners when some made money", () => {
    const h = workedHeadline([t({ resultCents: 900 }), t({ code: "ZZB" })]);
    expect(h).toEqual({ worked: true, text: "1 of 2 finished trades made money; +A$4.00 in all." });
    expect(workedHeadline([t({ resultCents: 100 })]).text).toBe(
      "1 of 1 finished trade made money; +A$1.00 in all.",
    );
  });
  it("sorts by strategy, then the biggest loss first, and writes plain lines", () => {
    const rows = [
      t({ strategy: "News jump", code: "ZZC", resultCents: 10 }),
      t({ code: "ZZB", resultCents: -900 }),
      t({ code: "ZZA", resultCents: -900 }),
    ];
    expect(sortClosed(rows).map((r) => r.code)).toEqual(["ZZA", "ZZB", "ZZC"]);
    expect(closedLine(t({ company: null }))).toBe("Follow the trend: ZZA -A$5.00, stop-loss hit.");
  });
});

describe("reviewLists", () => {
  const learning: DailyLearning = {
    d: "2030-03-05",
    summary: ["Most of the biggest gains were sector-wide moves in Materials."],
    movers: [],
    lessons: [
      {
        feature: "3-month leader (top fifth)",
        sessions: 40,
        n: 320,
        nextDayAvgPpm: 4_000,
        baseAvgPpm: 1_000,
        liftPpm: 3_000,
        hitRatePpm: 560_000,
        verdict: "beats the market",
        change: "stronger",
      },
    ],
    improvements: [
      {
        title: "No picks for 6 nights",
        evidence: "The strategies raised 1 signal a night.",
        action: "The shortlist now supplies candidates.",
        area: "picks",
      },
    ],
    hypothesesOpened: ["3-month leaders keep beating the market the next day"],
  };
  it("builds sections 4-6 from the learning", () => {
    const l = reviewLists({ learning, closed: [], queuedOrders: 1 });
    expect(l.s4).toEqual([
      "Most of the biggest gains were sector-wide moves in Materials.",
      "3-month leader (top fifth): next day +0.4% against +0.1% for the market (320 cases), beats the market; stronger.",
      "New idea being tested: 3-month leaders keep beating the market the next day",
    ]);
    expect(l.s5).toEqual(["Nothing worked today: no strategy finished a trade."]);
    expect(l.s6).toEqual([
      "No picks for 6 nights: The strategies raised 1 signal a night. Next step: The shortlist now supplies candidates.",
      "1 order queued for the next session.",
    ]);
  });
  it("says plainly when the learning did not run, and counts queued orders", () => {
    const l = reviewLists({ learning: null, closed: [t({ resultCents: 50 })], queuedOrders: 0 });
    expect(l.s4).toEqual(["The learning step did not run tonight."]);
    expect(l.s5[0]).toBe("1 of 1 finished trade made money; +A$0.50 in all.");
    expect(l.s6).toEqual(["No orders are queued for the next session."]);
    expect(reviewLists({ learning: null, closed: [], queuedOrders: 3 }).s6).toEqual([
      "3 orders queued for the next session.",
    ]);
    expect(reviewLists({ learning: null, closed: [], queuedOrders: null }).s6).toEqual([]);
  });

  it("D-923: the learning Cortex's lines follow under their heading, and are left out when absent", () => {
    const cortex = {
      lines: [
        "Of the 20 biggest gainers on Tue 10 Nov, the Cortex had 6 in its top tenth.",
        "No weight changed tonight.",
      ],
      numbers: { rows: 6, angles: 3, nextDayOf: 2, nextDayRight: 1, dataBreaks: 0, coverage: null },
    };
    const l = reviewLists({ learning: { ...learning, cortex }, closed: [], queuedOrders: null });
    expect(l.s4.slice(-3)).toEqual([`${BRAIN_HEADING}:`, ...cortex.lines]);
    const empty = reviewLists({
      learning: { ...learning, cortex: { ...cortex, lines: [] } },
      closed: [],
      queuedOrders: null,
    });
    expect(empty.s4.join("\n")).not.toContain(BRAIN_HEADING);
    // D-993: the top-5 target comes first in the masked in-app list too
    const top5 = {
      d: "2026-11-10",
      liquid: 10,
      named: 0,
      gainers: [],
      gainersHad: 0,
      losers: [],
      losersHad: 0,
      picks: { n: 0, up: 0, down: 0, meanMovePpm: null },
      chanceHits: 0,
      rolling: { nights: 1, gainers: 0, had: 0, chanceHits: 0 },
    };
    const first = reviewLists({ learning: { ...learning, top5 }, closed: [], queuedOrders: null });
    expect(first.s4.slice(0, 2)).toEqual([
      `${TOP5_HEADING}:`,
      "Top 5 gainers today: no large or mid-size share rose, so there was nothing to catch.",
    ]);
    expect(reviewLists({ learning, closed: [], queuedOrders: null }).s4.join("\n")).not.toContain(
      BRAIN_HEADING,
    );
  });
});
