// @vitest-environment node
// The learning Cortex's Owner words (design C.11, LRN-AT-9; D-923): plain market words, angle titles
// instead of ids, "Tue 10 Nov" instead of ISO dates, none of the banned terms.
import { describe, expect, it } from "vitest";
import { scorecardNight, type AngleDayRow, type MoverCoverage } from "@/lib/cortex/learn/scorecard";
import {
  angleName,
  coverageWords,
  eventWords,
  hasBannedTerm,
  pctAbs,
  scorecardWords,
} from "@/lib/cortex/learn/words";
import { D, input, PREV } from "./zzLearn";

const NOW = new Date(`${D}T00:00:00.000Z`);

const r = (over: Partial<AngleDayRow>): AngleDayRow => ({
  market: "AU",
  d: D,
  angleId: "A-D1-02",
  angleVersion: 1,
  horizon: 1,
  featureD: PREV,
  n: 40,
  ic: 0.1,
  topExcessPpm: 11_000,
  bottomExcessPpm: -4_000,
  basePpm: 1_000,
  regime: "RISK-ON",
  resultsSeason: 0,
  psiPpm: 0,
  excludedNews: 0,
  activeSetHash: "h",
  manifestId: "m",
  ...over,
});

const cov = (over: Partial<MoverCoverage> = {}): MoverCoverage => ({
  gainers: 20,
  gainersInTop: 6,
  losers: 20,
  losersInTop: 5,
  newsBeforeOpen: 9,
  newsInTop: 2,
  scored: 400,
  ...over,
});

describe("scorecardWords", () => {
  it("LRN-AT-9: a full night in plain words, with no banned term", () => {
    const card = scorecardNight(input());
    const s = scorecardWords({ d: D, rows: card.rows, coverage: cov(), now: NOW });
    expect(s.lines[0]).toBe(
      "Of the 20 biggest gainers on Tue 10 Nov, the Cortex had 6 in its top tenth the evening before, and 5 of the 20 biggest losers. Its favourite shares moved both ways. 9 of the 40 moved on company news published before the open, which nothing in prices could have seen (the Cortex had 2 of those in its top tenth).",
    );
    expect(s.lines[1]).toBe(
      "For the next day, 1 of the 2 angles pointed the right way; the clearest was '52-week-high proximity', whose favourite shares beat the average share by 1.8%.",
    );
    expect(s.lines[2]).toBe(
      "Over the last four weeks, the shares '52-week-high proximity' liked most beat the average share by 3.6%; those 'Volume ratio and volume trend' liked most lagged it by 3.6%.",
    );
    expect(s.lines[s.lines.length - 1]).toMatch(/^No weight changed tonight/);
    expect(s.numbers).toEqual({
      rows: 6,
      angles: 3,
      nextDayOf: 2,
      nextDayRight: 1,
      dataBreaks: 0,
      coverage: cov(),
    });
    for (const l of s.lines) expect(hasBannedTerm(l), l).toBe(false);
    expect(eventWords(s)).toBe(`${s.lines[0]} ${s.lines[1]}`);
  });

  it("says so when nothing can be judged", () => {
    const s = scorecardWords({ d: D, rows: [], coverage: null, now: NOW });
    expect(s.lines).toEqual([
      "The Cortex stored no scores for the evening before Tue 10 Nov, so the day's biggest movers cannot be checked against it.",
      "No angle had enough scored shares to judge the next day.",
      "There are not yet four weeks of stored Cortex scores to judge the angles over a month.",
      "No weight changed tonight; the Cortex is never re-weighted on one night's results.",
    ]);
    for (const l of s.lines) expect(hasBannedTerm(l)).toBe(false);
  });

  it("no angle right, a single month angle, a losing month and data breaks", () => {
    const rows = [
      r({ ic: -0.2, topExcessPpm: -3_000 }),
      r({ angleId: "A-D2-01", ic: 0, topExcessPpm: null, psiPpm: 300_000 }),
      r({ angleId: "A-D1-06", ic: null, psiPpm: 260_000 }),
      r({ angleId: "A-D1-10", psiPpm: 900_000, ic: -0.01 }),
      r({ angleId: "A-D2-03", psiPpm: 250_000, ic: -0.01 }),
      r({ horizon: 20, featureD: "2026-10-12", topExcessPpm: -12_345, psiPpm: null }),
    ];
    const s = scorecardWords({
      d: D,
      rows,
      coverage: cov({ gainersInTop: 0, newsBeforeOpen: 0 }),
      now: NOW,
    });
    expect(s.lines[0]).not.toContain("both ways");
    expect(s.lines[0]).not.toContain("news");
    expect(s.lines[1]).toBe("For the next day, 0 of the 4 angles pointed the right way.");
    expect(s.lines[2]).toBe(
      "Over the last four weeks, the shares '52-week-high proximity' liked most lagged the average share by 1.2%.",
    );
    expect(s.lines[3]).toBe(
      "The inputs of 'Volume ratio and volume trend', 'Stock volatility regime (ATR percentile)', 'Relative strength vs sector and index' and 1 more look different from the last three months, so their results read as a data change tonight, not a lesson.",
    );
    expect(s.numbers.dataBreaks).toBe(4);
    for (const l of s.lines) expect(hasBannedTerm(l), l).toBe(false);
  });

  it("one angle, one data break, the year when it differs", () => {
    const s = scorecardWords({
      d: D,
      rows: [r({ psiPpm: 400_000, topExcessPpm: null })],
      coverage: cov({ newsInTop: 0, newsBeforeOpen: 1 }),
      now: new Date("2027-01-05T00:00:00.000Z"),
    });
    expect(s.lines[0]).toContain("on Tue 10 Nov 2026,");
    expect(s.lines[0]).toMatch(/1 of the 40 moved on company news .* could have seen\.$/);
    expect(s.lines[1]).toBe("For the next day, 1 of the 1 angle pointed the right way.");
    expect(s.lines[3]).toBe(
      "The inputs of '52-week-high proximity' look different from the last three months, so its result reads as a data change tonight, not a lesson.",
    );
  });

  it("names angles by title only, and percentages without a sign", () => {
    expect(angleName("A-D1-02")).toBe("'52-week-high proximity'");
    expect(angleName("A-D9-99")).toBe("an unnamed angle");
    expect(pctAbs(-12_345)).toBe("1.2%");
    expect(pctAbs(0)).toBe("0.0%");
    expect(coverageWords("Tue 10 Nov", cov({ newsInTop: 1 }))).toContain(
      "(the Cortex had 1 of that one in its top tenth)",
    );
  });

  it("the ban list catches ids, ISO dates and the statistics words", () => {
    for (const bad of [
      "A-D1-02 rose",
      "on 2026-11-10",
      "the IC was",
      "top decile",
      "n_eff 20",
      "lower bound",
      "20 sessions",
      "PSI",
    ])
      expect(hasBannedTerm(bad), bad).toBe(true);
  });
});
