// @vitest-environment node
// The learning Cortex's pure nightly scorecard (design C.7, D-923): rank correlation, top and bottom
// tenth against the liquid base, the population check, the news-before-open exclusion, no look-ahead
// (LRN-AT-2) and the mover coverage. Synthetic ZZ data only.
import { describe, expect, it } from "vitest";
import {
  eveningScores,
  histogramOf,
  HIST_BINS,
  moverCoverage,
  psi,
  scoredAngles,
  scorecardNight,
  type AngleDayRow,
} from "@/lib/cortex/learn/scorecard";
import { AFTER, BACK21, bars, codes, D, featureNight, input, PREV, rankVal } from "./zzLearn";

const row = (rows: readonly AngleDayRow[], id: string, h: 1 | 20): AngleDayRow =>
  rows.find((r) => r.angleId === id && r.horizon === h)!;

describe("scorecardNight", () => {
  it("scores every scored angle on both horizons; gates are never scored", () => {
    const { rows } = scorecardNight(input());
    expect(rows.map((r) => `${r.angleId}:${r.horizon}`)).toEqual([
      "A-D1-02:1",
      "A-D1-02:20",
      "A-D1-06:1",
      "A-D1-06:20",
      "A-D2-01:1",
      "A-D2-01:20",
    ]);
    const a = row(rows, "A-D1-02", 1);
    expect(a).toMatchObject({
      market: "AU",
      d: D,
      featureD: PREV,
      n: 40,
      basePpm: 20_500,
      topExcessPpm: 18_000,
      bottomExcessPpm: -18_000,
      regime: "RISK-ON",
      resultsSeason: 0,
      excludedNews: 0,
      activeSetHash: "zzhash",
      manifestId: "zzmanifest",
      angleVersion: 2, // A-D1-02 is at version 2 in the registry
    });
    expect(a.ic).toBeCloseTo(1, 10);
    expect(row(rows, "A-D2-01", 1).ic).toBeCloseTo(-1, 10);
    expect(row(rows, "A-D1-06", 1).ic).toBeNull(); // every share the same value
    const m = row(rows, "A-D1-02", 20);
    expect(m).toMatchObject({ featureD: BACK21, n: 40, topExcessPpm: 36_000, psiPpm: null });
    expect(m.regime).toBe("unknown"); // no regime stored for that evening
    expect(m.ic).toBeCloseTo(1, 10);
  });

  it("leaves news-before-open movers out of the next-day result but not out of the base", () => {
    const { rows } = scorecardNight(
      input({
        movers: [
          { code: "ZZ040", side: "gainer", cause: "news_before_open" },
          { code: "ZZ001", side: "loser", cause: "sector_move" },
        ],
      }),
    );
    const a = row(rows, "A-D1-02", 1);
    expect(a.n).toBe(39);
    expect(a.excludedNews).toBe(1);
    expect(a.basePpm).toBe(20_500);
    expect(row(rows, "A-D1-02", 20)).toMatchObject({ n: 40, excludedNews: 0 });
  });

  it("an angle-night with too few shares has no result, only its count", () => {
    const { rows } = scorecardNight(input({ liquidCodes: codes(9) }));
    expect(row(rows, "A-D1-02", 1)).toMatchObject({
      n: 9,
      ic: null,
      topExcessPpm: null,
      bottomExcessPpm: null,
    });
  });

  it("flags, buckets and missing values are not numbers; a share without both closes is left out", () => {
    const night = featureNight(PREV, 40, (k, a) =>
      a !== "A-D1-02" ? null : k <= 5 ? { flag: "stale" } : k <= 8 ? null : rankVal(k),
    );
    const b = bars();
    b.delete("ZZ040");
    const { rows } = scorecardNight(input({ featuresPrev: night, bars: b, featuresBack20: null }));
    expect(rows.map((r) => r.angleId)).toEqual(["A-D1-02", "A-D1-06", "A-D2-01"]);
    expect(row(rows, "A-D1-02", 1).n).toBe(31); // 40 - 5 flags - 3 nulls - 1 without bars
    expect(row(rows, "A-D2-01", 1)).toMatchObject({ n: 0, ic: null });
  });

  it("writes no 20-session row when the window does not end before D, and nothing without features", () => {
    expect(scorecardNight(input({ end20: D })).rows.every((r) => r.horizon === 1)).toBe(true);
    expect(
      scorecardNight(input({ featuresBack20: featureNight(PREV), end20: PREV })).rows.some(
        (r) => r.horizon === 20,
      ),
    ).toBe(false);
    expect(scorecardNight(input({ featuresPrev: null, featuresBack20: null }))).toEqual({
      rows: [],
      histograms: {},
    });
    expect(
      scorecardNight(input({ featuresPrev: { d: PREV, rows: [] }, featuresBack20: null })).rows,
    ).toEqual([]);
    expect(
      scorecardNight(input({ featuresPrev: featureNight(D) })).rows.some((r) => r.horizon === 1),
    ).toBe(false);
  });

  it("marks the results season and an empty base", () => {
    const { rows } = scorecardNight(input({ resultsSeason: (fd) => fd === PREV }));
    expect(row(rows, "A-D1-02", 1).resultsSeason).toBe(1);
    expect(row(rows, "A-D1-02", 20).resultsSeason).toBe(0);
    const none = scorecardNight(input({ bars: new Map() }));
    expect(row(none.rows, "A-D1-02", 1)).toMatchObject({ n: 0, basePpm: null, ic: null });
  });

  it("population check: against the prior-60 reference, else the D-21 night; histograms kept", () => {
    const cold = scorecardNight(input());
    expect(row(cold.rows, "A-D1-02", 1).psiPpm).toBe(0); // the same distribution 20 sessions back
    expect(cold.histograms["A-D1-02"]).toHaveLength(HIST_BINS + 1);
    expect(cold.histograms["A-D1-02"]!.reduce((a, x) => a + x, 0)).toBe(40);
    expect(cold.histograms["A-D1-09"]).toBeUndefined(); // a gate is never scored
    const skewed = new Map([["A-D1-02", [400, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]]);
    const shifted = scorecardNight(input({ prior60: skewed }));
    expect(row(shifted.rows, "A-D1-02", 1).psiPpm).toBeGreaterThan(250_000);
    expect(row(shifted.rows, "A-D2-01", 1).psiPpm).toBeNull(); // no reference for that angle
    const noRef = scorecardNight(input({ featuresBack20: null }));
    expect(row(noRef.rows, "A-D1-02", 1).psiPpm).toBeNull();
  });

  it("LRN-AT-2: no look-ahead — a later bar changes nothing, a world cut at D gives the same rows", () => {
    const base = scorecardNight(input());
    const moved = scorecardNight(input({ bars: bars(40, { ZZ001: 99, ZZ040: 0.01 }) }));
    expect(moved).toEqual(base);
    const cut = new Map([...bars()].map(([c, l]) => [c, l.filter((b) => b.d <= D)]));
    expect(scorecardNight(input({ bars: cut }))).toEqual(base);
    expect(base.rows.every((r) => r.featureD < D)).toBe(true);
    expect(AFTER > D).toBe(true);
  });

  it("LRN-AT-11: the scorecard has no picks input; the same liquid shares give the same rows in any order", () => {
    const a = scorecardNight(input());
    const b = scorecardNight(input({ liquidCodes: [...codes()].reverse().concat("ZZ001") }));
    expect(b).toEqual(a);
  });
});

describe("helpers", () => {
  it("histogramOf bins [-1, 1] and counts missing values last", () => {
    const night = featureNight(PREV, 4, (k, a) =>
      a !== "A-D1-02" ? 0 : k === 4 ? null : [-1, 0, 1][k - 1],
    );
    const h = histogramOf(night, "A-D1-02", new Set(codes(4)));
    expect(h).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1]);
    expect(histogramOf(night, "A-D1-02", new Set(["ZZ001"]))).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("psi is zero for equal shapes and null for an empty side or a size mismatch", () => {
    expect(psi([1, 2, 3], [2, 4, 6])).toBeCloseTo(0, 12);
    expect(psi([0, 0], [1, 1])).toBeNull();
    expect(psi([1, 1], [0, 0])).toBeNull();
    expect(psi([1, 1], [1, 1, 1])).toBeNull();
    expect(psi([10, 0], [0, 10])!).toBeGreaterThan(1);
  });

  it("scoredAngles keeps registry score angles only", () => {
    expect(scoredAngles(null)).toEqual([]);
    const night = featureNight(PREV, 2);
    expect(
      scoredAngles({
        ...night,
        rows: night.rows.map((r) => ({ ...r, features: { ...r.features, "A-D9-99": 1 } })),
      }),
    ).toEqual(["A-D1-02", "A-D1-06", "A-D2-01"]);
  });
});

describe("mover coverage", () => {
  it("counts the movers in the top tenth of the evening score, news-before-open apart", () => {
    // equal clusters: momentum (A-D1-02), liquidity (A-D2-01), low_volatility (A-D1-06)
    const night = featureNight(PREV, 40, (k, a) =>
      a === "A-D1-02"
        ? rankVal(k)
        : a === "A-D2-01"
          ? rankVal(k)
          : a === "A-D1-06"
            ? { bucket: "mid" }
            : 1,
    );
    const s = eveningScores(night);
    expect(s.size).toBe(40);
    expect(s.get("ZZ040")).toBeCloseTo(2 / 3, 10);
    const c = moverCoverage(night, [
      { code: "ZZ040", side: "gainer", cause: "stock_specific" },
      { code: "ZZ039", side: "loser", cause: "market_move" },
      { code: "ZZ038", side: "gainer", cause: "news_before_open" },
      { code: "ZZ001", side: "gainer", cause: "sector_move" },
      { code: "ZZ999", side: "loser", cause: "news_before_open" },
    ]);
    expect(c).toEqual({
      gainers: 3,
      gainersInTop: 1,
      losers: 2,
      losersInTop: 1,
      newsBeforeOpen: 2,
      newsInTop: 1,
      scored: 40,
    });
  });

  it("a code with an undefined scored angle is not eligible; no night or no score gives null", () => {
    const night = featureNight(PREV, 20, (k, a) =>
      a === "A-D1-02" && k === 20 ? null : rankVal(k, 20),
    );
    expect(eveningScores(night).has("ZZ020")).toBe(false);
    expect(moverCoverage(null, [])).toBeNull();
    expect(moverCoverage({ d: PREV, rows: [] }, [])).toBeNull();
    const gatesOnly = {
      d: PREV,
      rows: [{ code: "ZZ001", features: { "A-D1-09": 1 }, activeSetHash: "h", manifestId: "m" }],
    };
    expect(eveningScores(gatesOnly).size).toBe(0);
    expect(moverCoverage(gatesOnly, [])).toBeNull();
    const allUndefined = featureNight(PREV, 3, () => null);
    expect(moverCoverage(allUndefined, [])).toBeNull();
  });
});
