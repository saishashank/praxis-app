// @vitest-environment node
// D-1060…D-1069 (Owner O-84): the pure scoring of the pick scorecard on a small synthetic calendar
// (ZZ codes, invented numbers): known top-5 gainers and losers give known hits and chance, every pick
// is followed through the bars after the pick night, the Cortex line reuses the scorecard's evening
// score, and the nights add up.
import { describe, expect, it } from "vitest";
import {
  cortexDay,
  followPick,
  HORIZON,
  parseSummary,
  scoreDay,
  summarise,
  type LaterBar,
  type ScoredPick,
} from "@/lib/scorecard/pickScorecard";
import { featureNight, rankVal } from "../cortex/learn/zzLearn";

const codes = Array.from({ length: 40 }, (_, i) => `ZZ${String(i + 1).padStart(3, "0")}`);
// ZZ040 rose most (+2.0 %), ZZ001 fell most (-1.9 %)
const moves = codes.map((code, i) => ({ code, movePpm: (i + 1 - 20) * 1000 }));
const m = (n: number): bigint => BigInt(Math.round(n * 1_000_000));
const bar = (d: string, o: number, h: number, l: number, c: number): LaterBar => ({
  d,
  open: m(o),
  high: m(h),
  low: m(l),
  close: m(c),
});
const flat = (n: number, price = 10): LaterBar[] =>
  Array.from({ length: n }, (_, i) =>
    bar(`2026-11-${String(16 + i).padStart(2, "0")}`, price, price, price, price),
  );
const pick = (code: string, profile: string, rank: number, stop = 9, aim = 11): ScoredPick => ({
  profile,
  rank,
  code,
  source: "strategy",
  stopMicro: m(stop),
  aimMicro: m(aim),
});

describe("followPick", () => {
  it("next day is open to close; 5 sessions is open to the 5th close; the aim first is an aim", () => {
    const later = [
      bar("2026-11-16", 10, 10.5, 9.9, 10.2), // +2 % open to close
      bar("2026-11-17", 10.2, 11.2, 10.1, 11), // touches the aim
      ...flat(3, 11),
    ];
    const o = followPick(pick("ZZ001", "balanced", 1), later);
    expect(o).toMatchObject({ nextPpm: 20_000, fivePpm: 100_000, race: "aim" });
  });

  it("a bar that touches both the stop and the aim counts as the stop", () => {
    const o = followPick(pick("ZZ001", "balanced", 1), [
      bar("2026-11-16", 10, 11.5, 8.5, 10),
      ...flat(4),
    ]);
    expect(o.race).toBe("stop");
  });

  it("neither within five sessions is 'neither'; fewer than five and neither is 'not yet known'", () => {
    expect(followPick(pick("ZZ001", "balanced", 1), flat(HORIZON)).race).toBe("neither");
    const part = followPick(pick("ZZ001", "balanced", 1), flat(3));
    expect(part).toMatchObject({ race: "unknown", fivePpm: null, nextPpm: 0 });
    // a stop or an aim inside the partial window is still known
    expect(
      followPick(pick("ZZ001", "balanced", 1), [bar("2026-11-16", 10, 10, 8, 9), ...flat(1)]).race,
    ).toBe("stop");
    // no bar after the pick night at all
    expect(followPick(pick("ZZ001", "balanced", 1), [])).toMatchObject({
      nextPpm: null,
      fivePpm: null,
      race: "unknown",
    });
  });
});

describe("cortexDay", () => {
  const night = featureNight("2026-11-13", 40, (k, a) =>
    a === "A-D1-02" || a === "A-D2-01" ? rankVal(k) : a === "A-D1-06" ? { bucket: "mid" } : 1,
  );
  const returns = new Map(moves.map((x) => [x.code, x.movePpm / 1_000_000]));
  const sets = {
    gainers: [...moves].sort((a, b) => b.movePpm - a.movePpm).slice(0, 5),
    losers: [...moves].sort((a, b) => a.movePpm - b.movePpm).slice(0, 5),
  };

  it("counts the top-5 gainers in the top tenth and the top-5 losers in the bottom tenth", () => {
    const c = cortexDay(night, sets, codes, returns)!;
    // the score ranks ZZ040 first: the top tenth is ZZ040..ZZ037, the bottom tenth ZZ001..ZZ004
    expect(c).toMatchObject({
      scored: 40,
      gainersInTop: 4,
      gainersN: 5,
      losersInBottom: 4,
      losersN: 5,
    });
    // (20+19+18+17)/4 - (-19-18-17-16)/4 = 18.5 - (-17.5) = 36 per mille
    expect(c.gapPpm).toBe(36_000);
  });

  it("is null without a night or with too few liquid shares scored", () => {
    expect(cortexDay(null, sets, codes, returns)).toBeNull();
    expect(cortexDay(night, sets, codes.slice(0, 10), returns)).toBeNull();
  });
});

describe("scoreDay and summarise", () => {
  const picks = [
    pick("ZZ036", "aggressive", 1), // the 5th biggest gainer
    pick("ZZ005", "balanced", 1), // the 5th biggest loser
    { ...pick("ZZ020", "balanced", 2), source: "shortlist" as const },
  ];
  const later = (code: string): readonly LaterBar[] =>
    code === "ZZ036" ? [bar("2026-11-16", 10, 11.2, 9.9, 11), ...flat(4, 11)] : flat(5);
  const day = scoreDay({
    d: "2026-11-13",
    nextD: "2026-11-16",
    picks,
    moves,
    liquid: codes,
    explain: (code) => ({ cause: code === "ZZ040" ? "sector_move" : "stock_specific", name: null }),
    later,
    cortex: null,
  });

  it("hits and chance of the night follow the known top-5 sets", () => {
    expect(day).toMatchObject({
      picksN: 3,
      gainersN: 5,
      gainerHits: 1,
      losersN: 5,
      loserHits: 1,
      liquidN: 40,
      namedN: 3,
      // 3 named of 40 liquid x 5 = 0.375 of the five expected by chance
      chancePpm: 375_000,
    });
    expect(day.detail.gainers.map((g) => [g.code, g.via])).toEqual([
      ["ZZ040", null],
      ["ZZ039", null],
      ["ZZ038", null],
      ["ZZ037", null],
      ["ZZ036", "strategy"],
    ]);
    // the miss causes reuse dailyTop5's words: a sector move and four "no measure"
    expect(day.detail.gainers.filter((g) => g.missed !== null).map((g) => g.missed)).toEqual([
      "sector_move",
      "no_measure",
      "no_measure",
      "no_measure",
    ]);
    expect(day.profiles.aggressive).toMatchObject({ n: 1, aim: 1, fiveN: 1 });
    expect(day.profiles.balanced).toMatchObject({ n: 2, aim: 0, neither: 2 });
  });

  it("the run adds the nights up: hits, chance per day, profiles and misses", () => {
    const s = summarise([day, { ...day, d: "2026-11-12", nextD: "2026-11-13", gainerHits: 0 }], {
      sessions: 40,
    });
    expect(s).toMatchObject({
      v: 1,
      sessions: 40,
      days: 2,
      picksN: 6,
      gainers: { total: 10, hits: 1, daysWithHit: 1 },
      losers: { total: 10, hits: 2, daysWithHit: 2 },
      chanceHits: 0.75,
      misses: { sector_move: 2, no_measure: 6, news_before_open: 0 },
    });
    expect(s.profiles.balanced).toMatchObject({ n: 4, neither: 4 });
    expect(Object.keys(s.profiles)).toEqual(["aggressive", "balanced", "conservative"]); // profile order, an empty profile stays
    expect(s.skipped).toContain("candidate measures");
    expect(parseSummary(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parseSummary({ v: 2 })).toBeNull();
  });
});
