// @vitest-environment node
// VAL-114 daily rank scores and the KB-081 rank variants (M14 WP4, D-232): entry thresholds are not
// applied, event families score only codes with an eligible group, the output is sorted and pure.
import { describe, expect, it } from "vitest";
import { rankScores } from "@/lib/agents/families/rankScore";
import { defaultAgentParams } from "@/lib/agents/params";
import {
  CENT,
  dayAgo,
  D,
  ev,
  factsOf,
  inputsOf,
  makeBars,
  override,
  peers,
  rising,
  wobble,
} from "../fixtures/agents/families/builders";

const p = defaultAgentParams();
const num = (r: { num: bigint; den: bigint }): number => Number(r.num) / Number(r.den);

describe("F1 scores", () => {
  const world = [
    factsOf("ZZA", "U1", makeBars({ close: rising(CENT) }), p),
    factsOf("ZZB", "U1", makeBars({ close: rising(CENT / 2n) }), p),
    ...peers("ZZP", "U1", 8, p),
  ];

  it("scores every U1 code with a computable percentile, with no entry threshold, sorted by code", () => {
    const s = rankScores("F1", inputsOf(world), p);
    expect(s.map((x) => x.code)).toEqual([...s.map((x) => x.code)].sort());
    expect(s).toHaveLength(10);
    const by = new Map(s.map((x) => [x.code, x.score]));
    expect(by.get("ZZA")!).toBeGreaterThan(by.get("ZZB")!);
    expect(by.get("ZZB")!).toBeGreaterThan(by.get("ZZP0")!);
    // the v1 key is the tier percentile of the 6-month return, in [0, 1]
    for (const x of s) {
      expect(x.score).toBeGreaterThanOrEqual(0);
      expect(x.score).toBeLessThanOrEqual(1);
    }
  });

  it("is pure: the same facts give the same scores, and U2 codes are not scored", () => {
    const a = rankScores("F1", inputsOf(world), p);
    expect(rankScores("F1", inputsOf(world), p)).toEqual(a);
    const withU2 = [...world, factsOf("ZZU", "U2", makeBars({ close: rising(CENT) }), p)];
    expect(rankScores("F1", inputsOf(withU2), p).map((x) => x.code)).not.toContain("ZZU");
  });

  it("vol_scaled divides the v1 score by the 20-session volatility of log returns", () => {
    const v1 = new Map(rankScores("F1", inputsOf(world), p).map((x) => [x.code, x.score]));
    const scaled = rankScores("F1", inputsOf(world), p, "vol_scaled");
    const peer = world.find((c) => c.code === "ZZP0")!;
    const closes = peer.closesAdj.slice(-21).map((c) => Number(c) / 1e6);
    const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]!));
    const m = rets.reduce((s, x) => s + x, 0) / 20;
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / 19);
    const got = scaled.find((x) => x.code === "ZZP0")!.score;
    expect(got).toBeCloseTo(v1.get("ZZP0")! / sd, 9);
  });

  it("composite3 sums three z-scores, so the scores of a day sum to zero", () => {
    const c3 = rankScores("F1", inputsOf(world), p, "composite3");
    expect(c3.length).toBeGreaterThan(0);
    expect(c3.reduce((s, x) => s + x.score, 0)).toBeCloseTo(0, 9);
    expect(c3.map((x) => x.code)).toEqual([...c3.map((x) => x.code)].sort());
  });
});

describe("event families score only codes with an eligible group", () => {
  const quiet = factsOf("ZZQ", "U1", makeBars({ close: wobble(2_000_000n) }), p);
  const mk = (code: string) => factsOf(code, "U1", makeBars({ close: wobble(2_000_000n) }), p);

  it("F2: AR below the entry threshold is still scored; a negative member or no event is not", () => {
    const events = [
      ev({ code: "ZZE", category: "results", polarity: 1, ar: "0.01", day0: dayAgo(2) }),
      ev({ code: "ZZG", category: "results", polarity: 1, ar: "0.05", day0: dayAgo(2) }),
      ev({ code: "ZZN", category: "results", polarity: 1, ar: "0.05", day0: dayAgo(2), seq: 1 }),
      ev({ code: "ZZN", category: "other", polarity: -1, ar: "0.05", day0: dayAgo(2), seq: 2 }),
      ev({ code: "ZZL", category: "results", polarity: 1, ar: "0.05", day0: dayAgo(5) }),
    ];
    const s = rankScores(
      "F2",
      inputsOf([quiet, mk("ZZE"), mk("ZZG"), mk("ZZN"), mk("ZZL")], { events }),
      p,
    );
    expect(s.map((x) => x.code)).toEqual(["ZZE", "ZZG"]);
    expect(s[0]!.score).toBeCloseTo(0.01, 12);
    expect(s[1]!.score).toBeCloseTo(0.05, 12);
  });

  it("F3: score is AR x day-0 volume ratio, day 0 must be D", () => {
    const events = [
      ev({ code: "ZZE", category: "results", polarity: 1, ar: "0.04", vol: "3", day0: D }),
      ev({ code: "ZZG", category: "results", polarity: 1, ar: "0.04", vol: "3", day0: dayAgo(1) }),
    ];
    const s = rankScores("F3", inputsOf([quiet, mk("ZZE"), mk("ZZG")], { events }), p);
    expect(s).toHaveLength(1);
    expect(s[0]!.code).toBe("ZZE");
    expect(s[0]!.score).toBeCloseTo(0.12, 12);
  });
});

describe("F4, F5 and F6 keys", () => {
  it("F4 is minus RSI(2) over U1 codes whose RSI(2) is usable (v1)", () => {
    const base = factsOf("ZZD", "U1", makeBars({ close: wobble(2_000_000n) }), p);
    const a = override(base, { code: "ZZA", ind: { rsiShort: 5, rsiShortWarm: true } });
    const b = override(base, { code: "ZZB", ind: { rsiShort: 40, rsiShortWarm: true } });
    const cold = override(base, { code: "ZZC", ind: { rsiShort: 3, rsiShortWarm: false } });
    const s = rankScores("F4", inputsOf([a, b, cold]), p);
    expect(s).toEqual([
      { code: "ZZA", score: -5 },
      { code: "ZZB", score: -40 },
    ]);
  });

  it("F5 scores the volume ratio of U2 codes with a price-sensitive positive event on D", () => {
    const base = factsOf("ZZF", "U2", makeBars({ close: wobble(2_000_000n) }), p);
    const hit = override(base, { code: "ZZH" });
    const none = override(base, { code: "ZZI" });
    const events = [ev({ code: "ZZH", category: "results", polarity: 1, ar: "0.01", day0: D })];
    const s = rankScores("F5", inputsOf([hit, none], { events }), p);
    expect(s.map((x) => x.code)).toEqual(["ZZH"]);
    expect(s[0]!.score).toBeCloseTo(num(base.ind.volumeRatio!), 12);
  });

  it("F6 is the number of agreeing evidence classes for every U1/U2 code", () => {
    const leader = factsOf("ZZA", "U1", makeBars({ close: rising(CENT) }), p);
    const s = rankScores("F6", inputsOf([leader, ...peers("ZZP", "U1", 4, p)]), p);
    expect(s).toHaveLength(5);
    for (const x of s) expect(Number.isInteger(x.score)).toBe(true);
    expect(s.every((x) => x.score >= 0 && x.score <= 4)).toBe(true);
  });
});
