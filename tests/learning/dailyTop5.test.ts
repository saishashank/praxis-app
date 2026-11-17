// @vitest-environment node
// D-990…D-997: the nightly top-5 gainer measure (pure). Which of the five biggest liquid gainers were
// named before they moved (evening-before picks of any source, or an intraday find below half of the
// final move), the losers we had picked, the picks' day, the chance baseline, the four-week rate and the
// Owner's words. Synthetic ZZ data only.
import { describe, expect, it } from "vitest";
import { cleanWords } from "@/lib/cortex/learn/learnWords";
import {
  chanceDays,
  missCause,
  parseTop5,
  rollingLine,
  top5Lines,
  top5Movers,
  top5Night,
  type MoveLike,
  type PickedBefore,
} from "@/lib/learning/dailyTop5";

const moves: MoveLike[] = [
  { code: "ZZG1", movePpm: 120_000 },
  { code: "ZZU3", movePpm: 300_000 }, // a small share: not liquid
  { code: "ZZG2", movePpm: 90_000 },
  { code: "ZZG3", movePpm: 80_000 },
  { code: "ZZG4", movePpm: 70_000 },
  { code: "ZZG5", movePpm: 60_000 },
  { code: "ZZG6", movePpm: 50_000 },
  { code: "ZZF0", movePpm: 0 },
  { code: "ZZL1", movePpm: -100_000 },
  { code: "ZZL2", movePpm: -80_000 },
];
const liquid = moves.map((m) => m.code).filter((c) => c !== "ZZU3");
const LIQUID = [...liquid, ...Array.from({ length: 90 }, (_, i) => `ZZQ${i}`)];

const causes: Record<string, string> = {
  ZZG1: "news_before_open",
  ZZG2: "sector_move",
  ZZG3: "stock_specific",
  ZZG4: "volume_no_news",
  ZZG5: "market_move",
};

const explain = (code: string) => ({
  cause: (causes[code] ?? "stock_specific") as never,
  name: code === "ZZG2" ? "Zz Second Limited" : null,
});

describe("top5Movers", () => {
  it("takes the five biggest liquid gainers and losers, a small share left out, ties by code", () => {
    const s = top5Movers(moves, liquid);
    expect(s.gainers.map((m) => m.code)).toEqual(["ZZG1", "ZZG2", "ZZG3", "ZZG4", "ZZG5"]);
    expect(s.losers.map((m) => m.code)).toEqual(["ZZL1", "ZZL2"]);
    const tie = top5Movers(
      [
        { code: "ZZB", movePpm: 1 },
        { code: "ZZA", movePpm: 1 },
      ],
      ["ZZA", "ZZB"],
    );
    expect(tie.gainers.map((m) => m.code)).toEqual(["ZZA", "ZZB"]);
  });
});

describe("top5Night", () => {
  const picked = new Map<string, PickedBefore>([
    ["ZZG2", { where: "Balanced #2", source: "shortlist" }],
    ["ZZL1", { where: "Growth #1", source: "strategy" }],
    ["ZZQ1", { where: "Balanced #4", source: "candidate" }],
  ]);
  const night = (history = [] as Parameters<typeof top5Night>[0]["history"]) =>
    top5Night({
      d: "2026-11-10",
      sets: top5Movers(moves, LIQUID),
      liquid: LIQUID,
      allMoves: [...moves, { code: "ZZQ1", movePpm: 10_000 }],
      picked,
      intraday: [
        // ZZG3 found at +3 % of its +8 %: counts; a later find of the same share does not matter
        { code: "ZZG3", foundAt: "2026-11-10T01:00:00.000Z", movePpm: 30_000 },
        { code: "ZZG3", foundAt: "2026-11-10T03:00:00.000Z", movePpm: 70_000 },
        // ZZG4 found at +5 % of its +7 %: most of the move was made, does not count
        { code: "ZZG4", foundAt: "2026-11-10T02:00:00.000Z", movePpm: 50_000 },
        // a loser found intraday is never counted (an intraday candidate is not a short)
        { code: "ZZL2", foundAt: "2026-11-10T02:00:00.000Z", movePpm: -10_000 },
      ],
      explain,
      history,
    });

  it("names the picked and early-found gainers, says why the others were missed", () => {
    const t = night();
    expect(t.gainers.map((g) => [g.code, g.via, g.missed])).toEqual([
      ["ZZG1", null, "news_before_open"],
      ["ZZG2", "shortlist", null],
      ["ZZG3", "intraday", null],
      ["ZZG4", null, "no_measure"],
      ["ZZG5", null, "market_move"],
    ]);
    expect(t.gainersHad).toBe(2);
    expect(t.losers.map((l) => [l.code, l.via])).toEqual([
      ["ZZL1", "strategy"],
      ["ZZL2", null],
    ]);
    expect(t.losersHad).toBe(1);
    // named: ZZG2, ZZL1, ZZQ1 (picks) + ZZG3, ZZG4, ZZL2 (intraday) = 6 of 99 liquid shares
    expect(t.liquid).toBe(99);
    expect(t.named).toBe(6);
    expect(t.chanceHits).toBeCloseTo((6 / 99) * 5, 10);
    // the evening-before picks on the day: +9 %, -10 %, +1 %
    expect(t.picks).toEqual({ n: 3, up: 2, down: 1, meanMovePpm: 0 });
    expect(t.rolling).toEqual({ nights: 1, gainers: 5, had: 2, chanceHits: t.chanceHits });
  });

  it("the words: tonight, the losers, the picks' day and the four-week rate, in plain market terms", () => {
    const lines = top5Lines(night());
    expect(lines[0]).toBe(
      "Top 5 gainers today: we had two (Zz Second Limited (ZZG2) in the picks, from the shortlist; ZZG3 as an intraday alert before most of its move); one moved on news before the open; two we missed (no measure, market move). A random list as long as ours would hold one about 1 day in 3.",
    );
    expect(lines[1]).toBe("One of the two biggest losers was in our picks (ZZL1).");
    expect(lines[2]).toContain("made money on the day overall: 0.0% on average (2 up, 1 down)");
    expect(lines[3]).toBe(
      "Top 5 gainers named before they moved, tonight only: 2 of 5 (40%), against about 0.3 by chance (6%).",
    );
    for (const l of lines) {
      expect(cleanWords(l), l).toBe(true);
      expect(l).not.toMatch(/\d{4}-\d{2}-\d{2}|\?/);
    }
  });

  it("the rolling rate sums the stored nights (at most 19 before tonight)", () => {
    const old = { gainers: [{}, {}, {}, {}, {}] as never, gainersHad: 1, chanceHits: 0.5 };
    const t = night(Array.from({ length: 25 }, () => old));
    expect(t.rolling.nights).toBe(20);
    expect(t.rolling.gainers).toBe(19 * 5 + 5);
    expect(t.rolling.had).toBe(19 + 2);
    expect(t.rolling.chanceHits).toBeCloseTo(19 * 0.5 + t.chanceHits, 10);
    expect(rollingLine(t.rolling)).toContain("the last 20 trading days: 21 of 100 (21%)");
  });

  it("a night without risers, without picks or with nothing named", () => {
    const flat = top5Night({
      d: "2026-11-10",
      sets: { gainers: [], losers: [] },
      liquid: [],
      allMoves: [],
      picked: new Map(),
      intraday: [],
      explain,
      history: [],
    });
    expect(flat.chanceHits).toBe(0);
    expect(flat.picks.meanMovePpm).toBeNull();
    expect(top5Lines(flat)).toEqual([
      "Top 5 gainers today: no large or mid-size share rose, so there was nothing to catch.",
    ]);
    expect(rollingLine(flat.rolling)).toBe(
      "Top 5 gainers over the last four weeks: nothing stored yet.",
    );
    const none = top5Night({
      d: "2026-11-10",
      sets: { gainers: [{ code: "ZZG1", movePpm: 1 }], losers: [{ code: "ZZL1", movePpm: -1 }] },
      liquid: ["ZZG1", "ZZL1"],
      allMoves: [{ code: "ZZP", movePpm: -5 }],
      picked: new Map([["ZZP", { where: "Balanced #1", source: "strategy" as const }]]),
      intraday: [],
      explain: () => ({ cause: null, name: "n/a" }),
      history: [],
    });
    const l = top5Lines(none);
    expect(l[0]).toBe("Top gainer today: we had none; one we missed (no measure).");
    expect(l[1]).toBe("The biggest loser was not in our picks.");
    expect(l[2]).toContain("lost money on the day overall: 0.0% on average (0 up, 1 down)");
    const losers = [
      { code: "ZZL1", movePpm: -2 },
      { code: "ZZL2", movePpm: -1 },
    ];
    const both = (picked: ReadonlyMap<string, PickedBefore>) =>
      top5Lines(
        top5Night({
          d: "2026-11-10",
          sets: { gainers: [{ code: "ZZG1", movePpm: 5 }], losers },
          liquid: ["ZZG1", "ZZL1", "ZZL2"],
          allMoves: [],
          picked,
          intraday: [],
          explain: () => ({ cause: null, name: null }),
          history: [],
        }),
      )[1];
    expect(
      both(
        new Map([
          ["ZZL1", { where: "Balanced #1", source: "strategy" as const }],
          ["ZZL2", { where: "Balanced #2", source: "candidate" as const }],
        ]),
      ),
    ).toBe("Two of the two biggest losers were in our picks (ZZL1 and ZZL2).");
    expect(both(new Map())).toBe("None of the two biggest losers was in our picks.");
  });
});

describe("helpers", () => {
  it("chance days, the miss causes and a stored night read back", () => {
    expect(chanceDays(0)).toBe("never by chance");
    expect(chanceDays(1.2)).toBe("about every day by chance");
    expect(chanceDays(0.25)).toBe("about 1 day in 4 by chance");
    expect(missCause("news_during_day")).toBe("news_during_day");
    expect(missCause("sector_move")).toBe("sector_move");
    expect(missCause(null)).toBe("no_measure");
    expect(parseTop5(null)).toBeNull();
    expect(parseTop5({ d: "x" })).toBeNull();
    expect(parseTop5({ d: "x", gainers: [], gainersHad: 0, chanceHits: Number.NaN })).toBeNull();
    const ok = { d: "x", gainers: [], gainersHad: 0, chanceHits: 0, rolling: {} };
    expect(parseTop5(ok)).toEqual(ok);
  });
});
