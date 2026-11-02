// @vitest-environment node
// S over fixed K clusters and the disagreement d (M15 C3a; CTX-012 "Score", CTX-023).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISAGREEMENT_MAX,
  DISAGREEMENT_LABEL,
  disagreement,
  disagreementTest,
} from "@/lib/cortex/score/disagreement";
import { clusterMeans, contributionOf, scoreOf } from "@/lib/cortex/score/score";
import type { AngleCluster, AngleValue, ScoredAngle } from "@/lib/cortex/score/types";

const scored: readonly ScoredAngle[] = [
  { id: "A-D1-01", version: 1, cluster: "momentum" },
  { id: "A-D1-02", version: 1, cluster: "momentum" },
  { id: "A-D1-03", version: 2, cluster: "low_volatility" },
  { id: "A-D2-01", version: 1, cluster: "liquidity" },
];
const K4: readonly AngleCluster[] = ["momentum", "low_volatility", "liquidity", "event"];
const feats = (entries: [string, AngleValue][]) => new Map<string, AngleValue>(entries);
const base = feats([
  ["A-D1-01", 0.8],
  ["A-D1-02", 0.2],
  ["A-D1-03", -0.2],
  ["A-D2-01", { flag: "stale" }],
]);

describe("scoreOf", () => {
  it("S = (1/K) Σ cluster means; a flag is 0; an empty cluster is 0 and K stays fixed", () => {
    const sc = scoreOf(base, scored, K4);
    expect(sc.K).toBe(4);
    expect(sc.clusters.map((c) => [c.cluster, c.n, c.mean])).toEqual([
      ["momentum", 2, 0.5],
      ["low_volatility", 1, -0.2],
      ["liquidity", 1, 0],
      ["event", 0, 0],
    ]);
    // (0.5 − 0.2 + 0 + 0) / 4 = 0.075
    expect(sc.s).toBeCloseTo(0.075, 12);
  });

  it("K is the declared cluster count, not the populated one: dropping `event` changes S", () => {
    const s3 = scoreOf(base, scored, ["momentum", "low_volatility", "liquidity"]).s;
    expect(s3).toBeCloseTo(0.3 / 3, 12);
  });

  it("contributions: numbers as is, flags and buckets 0", () => {
    expect(contributionOf(-0.4)).toBe(-0.4);
    expect(contributionOf({ flag: "x" })).toBe(0);
    expect(contributionOf({ bucket: "b" })).toBe(0);
  });

  it("an undefined angle is a programming error here (eligibility runs first)", () => {
    const f = feats([["A-D1-01", undefined]]);
    expect(() => clusterMeans(f, scored, K4)).toThrow(/eligibility/);
  });

  it("rejects K outside 1..6, a cluster list that is not K long, and duplicate clusters", () => {
    expect(() => scoreOf(base, scored, K4, 3)).toThrow(RangeError);
    expect(() => scoreOf(base, scored, [], 0)).toThrow(RangeError);
    expect(() =>
      scoreOf(base, scored, ["momentum", "momentum", "event", "quality", "liquidity", "sentiment"]),
    ).toThrow(RangeError);
    expect(() =>
      scoreOf(base, scored, [
        "momentum",
        "low_volatility",
        "liquidity",
        "event",
        "quality",
        "sentiment",
        "momentum",
      ] as AngleCluster[]),
    ).toThrow(RangeError);
  });

  it("never yields −0", () => {
    const f = feats([
      ["A-D1-01", -0.0],
      ["A-D1-02", 0],
      ["A-D1-03", 0],
      ["A-D2-01", 0],
    ]);
    expect(Object.is(scoreOf(f, scored, K4).s, 0)).toBe(true);
  });
});

describe("disagreement (CTX-023)", () => {
  it("d = opposing clusters ÷ K; zero-mean, flag-zeroed and empty clusters do not oppose", () => {
    const d = disagreement(scoreOf(base, scored, K4));
    // S > 0; only low_volatility (−0.2) opposes; liquidity (flag → 0) and event (empty) do not.
    expect(d.opposing).toBe(1);
    expect(d.K).toBe(4);
    expect(d.d).toBe(0.25);
    expect(d.opposingClusters).toEqual(["low_volatility"]);
  });

  it("S = 0 → nothing opposes (d = 0) even with non-zero clusters", () => {
    const f = feats([
      ["A-D1-01", 0.4],
      ["A-D1-02", 0.4],
      ["A-D1-03", -0.4],
      ["A-D2-01", 0],
    ]);
    const sc = scoreOf(f, scored, ["momentum", "low_volatility"]);
    expect(sc.s).toBe(0);
    expect(disagreement(sc).d).toBe(0);
  });

  it("S < 0: a positive cluster opposes", () => {
    const f = feats([
      ["A-D1-01", -0.9],
      ["A-D1-02", -0.9],
      ["A-D1-03", 0.1],
      ["A-D2-01", 0.1],
    ]);
    const d = disagreement(scoreOf(f, scored, K4));
    expect(d.opposingClusters).toEqual(["low_volatility", "liquidity"]);
    expect(d.d).toBe(0.5);
  });

  it("abstains strictly above cortex_disagreement_max (0.4): 0.25 passes, 0.5 fails with the label", () => {
    expect(DEFAULT_DISAGREEMENT_MAX).toBe(0.4);
    const pass = disagreementTest(scoreOf(base, scored, K4));
    expect(pass).toEqual({ pass: true, d: 0.25 });
    const f = feats([
      ["A-D1-01", 0.9],
      ["A-D1-02", 0.9],
      ["A-D1-03", -0.1],
      ["A-D2-01", 0],
    ]);
    const fail = disagreementTest(scoreOf(f, scored, ["momentum", "low_volatility"]));
    expect(fail.pass).toBe(false);
    if (fail.pass) return;
    expect(fail.d).toBe(0.5);
    expect(fail.max).toBe(0.4);
    expect(fail.label).toBe(DISAGREEMENT_LABEL);
    // d equal to the key passes (strict test)
    expect(disagreementTest(scoreOf(f, scored, ["momentum", "low_volatility"]), 0.5).pass).toBe(
      true,
    );
    expect(() => disagreementTest(scoreOf(base, scored, K4), 1.5)).toThrow(RangeError);
  });
});

describe("order independence (AT-50 bytes, review S2)", () => {
  it("the scored set in any order gives the identical S bytes", () => {
    const f = feats([
      ["A-D1-01", 0.1],
      ["A-D1-02", 0.2],
      ["A-D1-03", 0.3],
      ["A-D2-01", 0.7],
    ]);
    // Three float additions in different orders can differ in the last bit; sorting by id fixes one order.
    const many: ScoredAngle[] = [
      ...scored,
      { id: "A-D1-04", version: 1, cluster: "momentum" },
      { id: "A-D1-05", version: 1, cluster: "momentum" },
    ];
    const f2 = new Map([...f, ["A-D1-04", 0.123456789], ["A-D1-05", 0.987654321]] as [
      string,
      AngleValue,
    ][]);
    const a = scoreOf(f2, many, K4);
    const b = scoreOf(f2, [...many].reverse(), K4);
    const c = scoreOf(f2, [many[4]!, many[1]!, many[5]!, many[0]!, many[3]!, many[2]!], K4);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
    expect(Object.is(b.s, a.s)).toBe(true);
  });
});
