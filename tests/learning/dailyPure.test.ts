// @vitest-environment node
// D-921: the pure parts of the daily learning loop: the honest feature test (no look-ahead, the base is
// ALL shares), the cause rule of a mover, the evening an announcement belongs to, and the improvement list.
import { describe, expect, it } from "vitest";
import type { DailyLearning, FeatureLesson, MoverExplanation } from "@/lib/learning/daily";
import {
  computeLessons,
  LESSON_SESSIONS,
  prepare,
  rawAt,
  verdictOf,
  withChange,
  type LBar,
  type LShare,
} from "@/lib/learning/dailyFeatures";
import { buildImprovements } from "@/lib/learning/dailyImprove";
import {
  classifyCause,
  evening,
  pct,
  splitNews,
  type CauseInput,
} from "@/lib/learning/dailyMovers";

const day = (i: number): string => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);

/** n bars from 100, each close the previous times (1 + step); open = previous close times (1 + gap). */
function walk(n: number, o: { step?: number; gap?: number; vol?: number }): LBar[] {
  const out: LBar[] = [];
  let prev = 100;
  for (let i = 0; i < n; i += 1) {
    const c = prev * (1 + (o.step ?? 0));
    out.push({
      d: day(i),
      o: prev * (1 + (o.gap ?? 0)),
      h: Math.max(c, prev) * 1.01,
      l: Math.min(c, prev) * 0.99,
      c,
      v: o.vol ?? 1000,
    });
    prev = c;
  }
  return out;
}
const share = (code: string, bars: LBar[]): LShare => ({ code, tier: "U1", bars });
const lessonOf = (xs: readonly FeatureLesson[], label: string): FeatureLesson =>
  xs.find((x) => x.feature === label)!;
const GAP = "gapped up more than 3% at the open";

// three gap-up shares that rise 1 % every day, nine flat shares
const world = (n = 50): LShare[] => [
  ...["W1", "W2", "W3"].map((c) => share(c, walk(n, { step: 0.01, gap: 0.05 }))),
  ...Array.from({ length: 9 }, (_, i) => share(`F${i + 1}`, walk(n, {}))),
];

describe("feature lessons", () => {
  it("measure the next-day move of the feature share-days against ALL liquid share-days", () => {
    const ls = computeLessons(world().map(prepare), new Map(), new Map(), day(49));
    const g = lessonOf(ls, GAP);
    expect(g.sessions).toBe(LESSON_SESSIONS);
    expect(g.n).toBe(3 * LESSON_SESSIONS);
    expect(g.nextDayAvgPpm).toBe(10_000); // +1 % a day
    // the base is the mean over every share-day: 3 of 12 shares move +1 %, the rest 0 -> 0.25 %, not the winners' 1 %
    expect(g.baseAvgPpm).toBe(2_500);
    expect(g.liftPpm).toBe(7_500);
    expect(g.hitRatePpm).toBe(1_000_000);
    expect(g.verdict).toBe("beats the market");
    // a feature nobody has stays empty and never claims an edge
    const none = lessonOf(ls, "oversold (RSI below 30)");
    expect(none).toMatchObject({ n: 0, liftPpm: 0, verdict: "no clear edge yet" });
  });

  it("need at least 100 share-days and 0.3 % to call a verdict", () => {
    expect(verdictOf(3_001, 100)).toBe("beats the market");
    expect(verdictOf(3_000, 100)).toBe("no clear edge yet");
    expect(verdictOf(5_000, 99)).toBe("no clear edge yet");
    expect(verdictOf(-3_001, 100)).toBe("lags the market");
    expect(verdictOf(-3_001, 99)).toBe("no clear edge yet");
    // one gap-up share: only 40 share-days, so no verdict however big the lift
    const one = [world()[0]!, ...world().slice(3)];
    expect(
      lessonOf(computeLessons(one.map(prepare), new Map(), new Map(), day(49)), GAP).verdict,
    ).toBe("no clear edge yet");
  });

  it("have no look-ahead: bars after D change nothing, and a close uses bars up to itself", () => {
    const base = computeLessons(world().map(prepare), new Map(), new Map(), day(49));
    // the same world with 5 more sessions of wild prices after D, asked for D
    const longer = world(55).map((s) => ({
      ...s,
      bars: s.bars.map((b, i) =>
        i >= 50 ? { ...b, o: 1, h: 1000, l: 1, c: 1000 * (i % 2 === 0 ? 1 : 0.001) } : b,
      ),
    }));
    expect(computeLessons(longer.map(prepare), new Map(), new Map(), day(49))).toEqual(base);
    // the readings of one close are the same with and without the later bars
    const full = world()[0]!;
    const cut = prepare({ ...full, bars: full.bars.slice(0, 41) });
    expect(rawAt(prepare(full), 40)).toEqual(rawAt(cut, 40));
  });

  it("cap one bad bar so it cannot swamp a mean", () => {
    const bad = world().map((s, i) =>
      i === 5 ? { ...s, bars: s.bars.map((b, k) => (k === 30 ? { ...b, c: b.c * 1000 } : b)) } : s,
    );
    const g = lessonOf(computeLessons(bad.map(prepare), new Map(), new Map(), day(49)), GAP);
    expect(g.baseAvgPpm).toBeLessThan(50_000);
  });

  it("compare with the night before: new, stronger, weaker, unchanged", () => {
    const mk = (
      feature: string,
      liftPpm: number,
      verdict: FeatureLesson["verdict"],
    ): FeatureLesson => ({
      feature,
      sessions: 40,
      n: 200,
      nextDayAvgPpm: liftPpm,
      baseAvgPpm: 0,
      liftPpm,
      hitRatePpm: 600_000,
      verdict,
      change: "new",
    });
    const prev = [
      mk("a", 5_000, "beats the market"),
      mk("b", 5_000, "beats the market"),
      mk("c", 5_000, "beats the market"),
      mk("d", -5_000, "lags the market"),
    ];
    const now = [
      mk("a", 7_000, "beats the market"),
      mk("b", 3_500, "beats the market"),
      mk("c", 5_300, "beats the market"),
      mk("d", -7_000, "lags the market"),
      mk("e", 0, "no clear edge yet"),
    ];
    expect(withChange(now, prev).map((x) => x.change)).toEqual([
      "stronger",
      "weaker",
      "unchanged",
      "stronger",
      "new",
    ]);
    expect(withChange(now, null).every((x) => x.change === "new")).toBe(true);
  });
});

const base: CauseInput = {
  movePpm: 50_000,
  indexMovePpm: 2_000,
  sectorName: null,
  sectorMovePpm: null,
  sectorShares: 0,
  volumeVsUsualPpm: 1_000_000,
  newsBefore: [],
  newsDuring: [],
};
const news = { publishedAt: "2026-11-09T22:00:00.000Z", title: "Trading update" };

describe("mover cause rule", () => {
  it("applies the rules in order, first fit wins", () => {
    const sector = { sectorName: "Materials", sectorMovePpm: 50_000, sectorShares: 5 };
    expect(
      classifyCause({ ...base, ...sector, newsBefore: [news], newsDuring: [news] }).cause,
    ).toBe("news_before_open");
    expect(classifyCause({ ...base, ...sector, newsDuring: [news] }).cause).toBe("news_during_day");
    const sec = classifyCause({
      ...base,
      movePpm: 41_000,
      sectorName: "Materials",
      sectorMovePpm: 41_000,
      sectorShares: 4,
      indexMovePpm: 30_000,
    });
    expect(sec).toEqual({
      cause: "sector_move",
      causeText: "Sector-wide: Materials +4.1% on the day; it moved with its sector (+4.1%).",
    });
    // the sector moved 58 % of the share's move (under 60 %), the index 52 %: a market move
    expect(
      classifyCause({
        ...base,
        sectorName: "Materials",
        sectorMovePpm: 29_000,
        sectorShares: 4,
        indexMovePpm: 26_000,
      }).cause,
    ).toBe("market_move");
    expect(
      classifyCause({ ...base, indexMovePpm: 25_000, volumeVsUsualPpm: 3_000_000 }).cause,
    ).toBe("market_move"); // exactly half
    expect(classifyCause({ ...base, volumeVsUsualPpm: 2_000_000 }).cause).toBe("volume_no_news");
    expect(classifyCause({ ...base, volumeVsUsualPpm: 1_999_999 }).cause).toBe("stock_specific");
  });

  it("needs a sector of 3 shares, the same direction, and 60 % of the move", () => {
    const s = { ...base, sectorName: "Energy", sectorMovePpm: 30_000, sectorShares: 3 };
    expect(classifyCause(s).cause).toBe("sector_move");
    expect(classifyCause({ ...s, sectorShares: 2 }).cause).toBe("stock_specific");
    expect(classifyCause({ ...s, sectorMovePpm: 29_999 }).cause).toBe("stock_specific");
    expect(classifyCause({ ...s, sectorMovePpm: -40_000 }).cause).toBe("stock_specific");
    // a loser that fell with the index
    expect(classifyCause({ ...base, movePpm: -30_000, indexMovePpm: -16_000 }).cause).toBe(
      "market_move",
    );
  });

  it("writes one definite sentence with the numbers and no question mark", () => {
    const all = [
      classifyCause({ ...base, newsBefore: [news] }),
      classifyCause({ ...base, newsDuring: [news] }),
      classifyCause({ ...base, indexMovePpm: 30_000 }),
      classifyCause({ ...base, volumeVsUsualPpm: 3_400_000 }),
      classifyCause({ ...base, indexMovePpm: null }),
      classifyCause({ ...base, sectorName: "Energy", sectorMovePpm: 1_000, sectorShares: 6 }),
    ];
    for (const c of all) {
      expect(c.causeText).not.toContain("?");
      expect(c.causeText).toMatch(/[.]$/);
      expect(c.causeText).toMatch(/\d/);
    }
    expect(all[3]!.causeText).toContain("3.4x its usual level");
    expect(all[5]!.causeText).toContain("Energy +0.1%");
    expect(pct(-12_345)).toBe("-1.2%");
  });
});

describe("announcement timing", () => {
  const cal = [] as const; // weekdays only
  it("belongs to the evening before when it came after the close or before the open", () => {
    expect(evening("2026-11-10T06:00:00.000Z", cal)).toBe("2026-11-10"); // Tue 17:00 Sydney
    expect(evening("2026-11-09T22:30:00.000Z", cal)).toBe("2026-11-09"); // Tue 09:30 Sydney, before the open
    expect(evening("2026-11-10T01:00:00.000Z", cal)).toBeNull(); // Tue 12:00, in trading hours
    expect(evening("2026-11-14T01:00:00.000Z", cal)).toBe("2026-11-13"); // Saturday waits for the open after Friday
  });
  it("splits a mover's news into before the open and during the day", () => {
    const anns = [
      { publishedAt: "2026-11-09T22:00:00.000Z", title: "Before" }, // Tue 09:00
      { publishedAt: "2026-11-10T01:00:00.000Z", title: "During" }, // Tue 12:00
      { publishedAt: "2026-11-09T01:00:00.000Z", title: "Day before" }, // Mon 12:00: knowable already
      { publishedAt: "2026-11-10T06:00:00.000Z", title: "After the close" }, // Tue 17:00
    ];
    const s = splitNews(anns, "2026-11-10", "2026-11-09", cal);
    expect(s.before.map((x) => x.title)).toEqual(["Before"]);
    expect(s.during.map((x) => x.title)).toEqual(["During"]);
  });
});

const mover = (o: Partial<MoverExplanation>): MoverExplanation => ({
  code: "AAA",
  name: null,
  side: "gainer",
  movePpm: 50_000,
  cause: "stock_specific",
  causeText: "x",
  indexMovePpm: null,
  sectorName: null,
  sectorMovePpm: null,
  volumeVsUsualPpm: null,
  setupBefore: [],
  caughtBy: null,
  nearMiss: null,
  ...o,
});
const night = (d: string, movers: MoverExplanation[]): DailyLearning => ({
  d,
  summary: [],
  movers,
  lessons: [],
  improvements: [],
  hypothesesOpened: [],
});
const beats: FeatureLesson = {
  feature: "volume at least 2x usual",
  sessions: 40,
  n: 150,
  nextDayAvgPpm: 9_000,
  baseAvgPpm: 1_000,
  liftPpm: 8_000,
  hitRatePpm: 600_000,
  verdict: "beats the market",
  change: "stronger",
};

describe("improvement list", () => {
  const input = {
    d: "2026-11-10",
    lessons: [beats],
    opened: [] as string[],
    alreadyOpen: new Set<string>(),
    pickSessions: [
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-09",
      "2026-11-10",
    ],
    noPickDays: ["2026-11-03", "2026-11-09"],
    blocked: {
      signals: 12,
      byReason: new Map([
        ["skipped_stop_distance", 10],
        ["skipped_cost_gate", 1],
      ]),
    },
    history: [
      night("2026-11-09", [
        mover({ cause: "sector_move", sectorName: "Materials" }),
        mover({ cause: "sector_move", sectorName: "Materials" }),
        mover({ cause: "sector_move", sectorName: "Energy" }),
        mover({ caughtBy: "Picked (Balanced #1)", cause: "sector_move" }),
      ]),
    ],
    gapMovers: 3,
    moversChecked: 40,
  };

  it("lists the findings with numbers, plain words and an action, most important first", () => {
    const items = buildImprovements(input);
    expect(items.map((i) => i.area)).toEqual([
      "picks",
      "learning",
      "strategies",
      "strategies",
      "data",
    ]);
    expect(items[0]!.evidence).toBe(
      "2 of the last 7 sessions had no published pick (Tue 3 Nov, Mon 9 Nov).",
    );
    expect(items[2]!.evidence).toBe(
      "10 of 12 strategy signals in the last 10 sessions were blocked: the stop was too far away.",
    );
    expect(items[2]!.action).toContain("wider-stop");
    expect(items[3]!.evidence).toBe(
      "3 of 4 top gainers in the last 1 session were sector-wide moves (most in Materials), and no strategy, pick or shortlist had them the evening before.",
    );
    expect(items[3]!.action).toContain("sector-strength");
    expect(items[4]!.evidence).toBe(
      "3 of the 40 biggest movers had missing price bars in the last 30 sessions.",
    );
    for (const i of items)
      expect(`${i.title} ${i.evidence} ${i.action}`).not.toMatch(/\?|skipped_|F\d\b|sig:/);
  });

  it("says a beating feature was proposed when its hypothesis was opened or is already open", () => {
    const opened = buildImprovements({ ...input, opened: [beats.feature] }).find(
      (i) => i.area === "learning",
    )!;
    expect(opened.action).toContain("hypothesis was opened");
    const open = buildImprovements({ ...input, alreadyOpen: new Set([beats.feature]) }).find(
      (i) => i.area === "learning",
    )!;
    expect(open.action).toContain("already open");
  });

  it("keeps at most 6 items and skips what is not known or not found", () => {
    const many = buildImprovements({
      ...input,
      lessons: [beats, { ...beats, feature: "b" }, { ...beats, feature: "c" }],
      gapMovers: 1,
    });
    expect(many.length).toBeLessThanOrEqual(6);
    const quiet = buildImprovements({
      ...input,
      pickSessions: null,
      noPickDays: [],
      lessons: [],
      blocked: { signals: 0, byReason: new Map() },
      history: [],
      gapMovers: 0,
    });
    expect(quiet).toEqual([]);
  });
});
