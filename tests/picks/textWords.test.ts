// @vitest-environment node
// The plain-words helpers of the Picks pages (text.ts): every branch of the wording, pure functions.
import { describe, expect, it } from "vitest";
import {
  capPerFamily,
  entryLabel,
  entryNote,
  exitWords,
  honestyLine,
  nowMaskedText,
  nowNote,
  nowPct,
  pct,
  ppText,
  profileHue,
  profileLabel,
  profileRules,
  profileSentence,
  replayLines,
  stateText,
  timeFrameText,
  vsMarketRowText,
  vsMarketSummaryLine,
  HONESTY_BASE,
  HONESTY_NOT_PROVEN,
  MISSED_NOT_BOUGHT,
  trackStateText,
  type ReplaySummaryLike,
} from "@/app/(app)/picks/text";

describe("profiles", () => {
  it("label and hue: empty stays empty, underscores become spaces, unknown names are grey", () => {
    expect(profileLabel("")).toBe("");
    expect(profileLabel("aggressive")).toBe("Aggressive");
    expect(profileLabel("very_safe")).toBe("Very safe");
    expect(profileHue("aggressive")).toBe("tier-p0");
    expect(profileHue("balanced")).toBe("tier-p1");
    expect(profileHue("conservative")).toBe("status-allowed");
    expect(profileHue("other")).toBe("outcome-flat");
  });

  it("profileRules validates the stored shape", () => {
    const cfg = {
      balanced: { tiers: ["U1", 7, "U2"], max_pct_per_pick: 10, risk_pct_per_pick: 1 },
      noTiers: { max_pct_per_pick: 5, risk_pct_per_pick: 0.5 },
      badCaps: { tiers: [], max_pct_per_pick: "10", risk_pct_per_pick: 1 },
      badRisk: { tiers: [], max_pct_per_pick: 10 },
    };
    expect(profileRules(null, "balanced")).toBeNull();
    expect(profileRules("x", "balanced")).toBeNull();
    expect(profileRules(cfg, "missing")).toBeNull();
    expect(profileRules({ balanced: null }, "balanced")).toBeNull();
    expect(profileRules({ balanced: 3 }, "balanced")).toBeNull();
    expect(profileRules(cfg, "badCaps")).toBeNull();
    expect(profileRules(cfg, "badRisk")).toBeNull();
    expect(profileRules(cfg, "balanced")).toEqual({ tiers: ["U1", "U2"], maxPct: 10, riskPct: 1 });
    expect(profileRules(cfg, "noTiers")).toEqual({ tiers: [], maxPct: 5, riskPct: 0.5 });
  });

  it("profileSentence: no rules, a known band, tiers in words (one, two, three, unknown)", () => {
    expect(profileSentence(null)).toBe("Rules for this profile are not available.");
    const r = { tiers: ["U1"], maxPct: 10, riskPct: 1 };
    const band = profileSentence(r, "balanced");
    expect(band).toContain("Middle-of-the-road companies");
    expect(band).toContain("No more than 10% of the portfolio");
    expect(band).toContain("at most about 1%");
    // a name without a band text falls back to the tier words
    expect(profileSentence(r, "custom")).toMatch(/^Picks from large companies\./);
    expect(profileSentence(r)).toMatch(/^Picks from large companies\./);
    expect(profileSentence({ ...r, tiers: ["U1", "U2"] })).toMatch(
      /^Picks from large and mid-size companies\./,
    );
    expect(profileSentence({ ...r, tiers: ["U1", "U2", "U3"] })).toMatch(
      /^Picks from large, mid-size and small companies\./,
    );
    expect(profileSentence({ ...r, tiers: ["UX"] })).toMatch(/^Picks from UX companies\./);
  });
});

describe("small words", () => {
  it("honesty line shows the not-proven part until the luck check is beaten", () => {
    expect(honestyLine(true)).toBe(HONESTY_BASE);
    expect(honestyLine(false)).toBe(`${HONESTY_BASE} · ${HONESTY_NOT_PROVEN}`);
  });

  it("capPerFamily keeps the first N per family in order", () => {
    const rows = ["a", "b", "a", "a", "b"].map((family, i) => ({ family, i }));
    expect(capPerFamily(rows, 2).map((r) => r.i)).toEqual([0, 1, 2, 4]);
    expect(capPerFamily([], 2)).toEqual([]);
  });

  it("timeFrameText: null, days, one week, weeks", () => {
    expect(timeFrameText(null)).toBeNull();
    expect(timeFrameText(1)).toBe("about 1 day");
    expect(timeFrameText(3)).toBe("about 3 days");
    expect(timeFrameText(5)).toBe("about 1 week");
    expect(timeFrameText(14)).toBe("about 3 weeks");
  });

  it("exit words and percent", () => {
    expect(exitWords(null)).toBeNull();
    expect(exitWords("stop")).toBe("stop-loss hit");
    expect(exitWords("aim")).toBe("aim reached");
    expect(exitWords("odd")).toBe("odd");
    expect(pct(50_000)).toBe("+5%");
  });

  it("stateText: every state, and a withdrawal with a known, unknown or no reason", () => {
    expect(stateText(null)).toBe("Not tracked yet");
    expect(stateText({ state: "waiting" })).toBe("Waiting to buy");
    expect(stateText({ state: "bought" })).toBe("Bought");
    expect(stateText({ state: "closed" })).toBe("Closed");
    expect(stateText({ state: "weird" })).toBe("Not tracked yet");
    expect(stateText({ state: "missed" })).toBe("Withdrawn");
    expect(stateText({ state: "missed", withdrawnReason: null })).toBe("Withdrawn");
    expect(stateText({ state: "missed", withdrawnReason: "below_stop" })).toBe(
      "Withdrawn — the price fell to the stop-loss",
    );
    expect(stateText({ state: "missed", withdrawnReason: "other" })).toBe("Withdrawn — other");
    expect(trackStateText({ state: "bought" } as never)).toBe("Bought");
  });
});

describe("against the market", () => {
  it("ppText: not measured, a plus or a minus, one decimal", () => {
    expect(ppText(null)).toBe("not measured");
    expect(ppText(25_000)).toBe("+2.5 pp");
    expect(ppText(-31_000)).toBe("-3.1 pp");
    expect(ppText(0)).toBe("+0.0 pp");
  });

  it("row text: a missed pick says it was not bought, a bought one shows both figures", () => {
    const base = { vsPpm: 20_000, marketRetPpm: 10_000 };
    expect(vsMarketRowText({ ...base, missed: true } as never)).toBe(
      `market +1.0 pp over the window; ${MISSED_NOT_BOUGHT}`,
    );
    expect(vsMarketRowText({ ...base, missed: false } as never)).toBe(
      "vs market +2.0 pp (market +1.0 pp)",
    );
  });

  it("summary line: insufficient history, or the median and the share beating the market", () => {
    expect(
      vsMarketSummaryLine({ n: 3, medianPpm: null, beatingPct: null, insufficient: true }),
    ).toBe("Vs market: insufficient history (n = 3).");
    expect(
      vsMarketSummaryLine({ n: 40, medianPpm: 15_000, beatingPct: 55, insufficient: false }),
    ).toBe("Median vs market +1.5 pp; 55% of picks beat the market; n = 40.");
  });
});

describe("entry and current price words", () => {
  it("entry label and note: bought shows no close; a missing day shows none either", () => {
    expect(entryLabel(true)).toBe("Bought at");
    expect(entryLabel(false)).toBe("Entry about");
    expect(entryNote(true, "2026-11-12")).toBe("");
    expect(entryNote(false, null)).toBe("");
    expect(entryNote(false, "2026-11-12")).toMatch(/^ \(last close Thu 12 Nov( \d{4})?\)$/);
  });

  it("now note: change and label, either or neither", () => {
    expect(nowPct(57_000)).toBe("+5.7%");
    expect(nowPct(-21_000)).toMatch(/^[−-]2\.1%$/);
    expect(nowNote(57_000, "Delayed, 13:05")).toBe(" (+5.7%), Delayed, 13:05");
    expect(nowNote(null, "End of day, Fri 6 Nov")).toBe(", End of day, Fri 6 Nov");
    expect(nowNote(57_000, null)).toBe(" (+5.7%)");
    expect(nowNote(null, "")).toBe("");
    expect(nowMaskedText(57_000)).toBe("Now +5.7% from entry");
  });
});

describe("replay lines", () => {
  const cortex = {
    days: 0,
    gainers: 0,
    gainersInTop: 0,
    chanceGainers: 0,
    losers: 0,
    losersInBottom: 0,
    gapDays: 0,
    gapSumPpm: 0,
    gapUpDays: 0,
  };
  const empty: ReplaySummaryLike = {
    days: 0,
    picksN: 0,
    gainers: { total: 0, hits: 0, daysWithHit: 0 },
    chanceHits: 0,
    losers: { total: 0, hits: 0, daysWithHit: 0 },
    profiles: {},
    misses: {},
    cortex,
  };

  it("no days: chance none expected, no strategy line, no misses line", () => {
    const l = replayLines(empty);
    expect(l.gainers).toContain("chance: none expected");
    expect(l.strategy).toBeNull();
    expect(l.misses).toBeNull();
    expect(l.profiles).toEqual([]);
  });

  it("a profile with no known next day or five-day result says so; unknown outcomes are counted", () => {
    const l = replayLines({
      ...empty,
      days: 4,
      profiles: {
        aggressive: {
          n: 3,
          nextN: 0,
          nextSumPpm: 0,
          nextUp: 0,
          fiveN: 0,
          fiveSumPpm: 0,
          fiveUp: 0,
          aim: 1,
          stop: 1,
          neither: 0,
          unknown: 1,
        },
      },
    });
    expect(l.profiles[0]).toBe(
      "Aggressive: 3 picks; average next day n/a, 5 sessions not yet known; n/a up next day; aim reached 1, stop hit 1, 1 not yet known.",
    );
  });

  it("the Cortex gap sentence needs gap days; misses sort by count then name", () => {
    const l = replayLines({
      ...empty,
      days: 10,
      chanceHits: 2.34,
      strategyNights: 6,
      misses: { sector_move: 2, no_measure: 2, market_move: 5, news_before_open: 0, odd_key: 1 },
      cortex: {
        ...cortex,
        days: 10,
        gainers: 50,
        gainersInTop: 9,
        chanceGainers: 5,
        losers: 50,
        losersInBottom: 8,
        gapDays: 10,
        gapSumPpm: 30_000,
        gapUpDays: 7,
        liveNights: 4,
        goLiveNights: 6,
      },
    });
    expect(l.cortex).toHaveLength(3);
    expect(l.cortex[0]).toBe("Cortex: 4 nights live, 6 nights replayed with its go-live measures.");
    expect(l.cortex[2]).toContain("beat its bottom tenth by +0.3% a day on average (7 of 10 days)");
    expect(l.gainers).toContain("chance would give about 2.3");
    expect(l.strategy).toBe("Strategy picks: 6 of 10 nights (others had only shortlist picks).");
    expect(l.misses).toBe(
      "Gainers we missed, by reason: market move 5, no measure 2, sector move 2, no measure 1.",
    );
    const noGap = replayLines({ ...empty, days: 1, cortex: { ...cortex, days: 1 } });
    expect(noGap.cortex[0]).toBe(
      "Cortex: 1 nights live, 0 nights replayed with its go-live measures.",
    );
    expect(noGap.cortex[2]).not.toContain("Next day");
  });
});
