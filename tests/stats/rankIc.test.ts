// @vitest-environment node
// VAL-114 Spearman IC and the 21-session block bootstrap (M14 WP4, D-232).
import { describe, expect, it } from "vitest";
import {
  averageRanks,
  dailyRankIc,
  median,
  RANK_IC_BLOCK_SESSIONS,
  spearman,
  summariseRankIc,
} from "@/lib/stats/rankIc";

describe("Spearman IC", () => {
  it("average ranks share the mean rank of a tie", () => {
    expect(averageRanks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
    expect(averageRanks([5, 5, 5])).toEqual([2, 2, 2]);
  });

  it("known answer with ties: x = 1..5, y = (2, 1, 3, 3, 5) gives 8.5 / sqrt(95)", () => {
    // ranks of y: 2, 1, 3.5, 3.5, 5; both rank means are 3; sum dx dy = 2 + 2 + 0 + 0.5 + 4 = 8.5,
    // sum dx^2 = 10, sum dy^2 = 1 + 4 + 0.25 + 0.25 + 4 = 9.5
    const rho = spearman([1, 2, 3, 4, 5], [2, 1, 3, 3, 5])!;
    expect(rho).toBeCloseTo(8.5 / Math.sqrt(95), 12);
    expect(rho).toBeCloseTo(0.872082, 5);
  });

  it("is 1 for a monotone relation, -1 for a reversed one, and null for a constant side", () => {
    expect(spearman([1, 2, 3, 4], [10, 100, 1000, 10000])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 12);
    expect(spearman([1, 2, 3], [7, 7, 7])).toBeNull();
    expect(spearman([1], [1])).toBeNull();
    expect(() => spearman([1, 2], [1])).toThrow(RangeError);
  });

  it("median handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("dailyRankIc", () => {
  const codes = Array.from({ length: 12 }, (_, i) => `C${String(i).padStart(2, "0")}`);
  const scores = codes.map((code, i) => ({ code, score: i }));
  const forward = new Map(codes.map((code, i) => [code, 0.001 * i - 0.004]));

  it("a score that orders the excess return perfectly gives IC 1 (the U1 median only shifts)", () => {
    const r = dailyRankIc(scores, forward, codes.slice(0, 6));
    expect(r.n).toBe(12);
    expect(r.ic).toBeCloseTo(1, 12);
    const reversed = dailyRankIc(
      scores.map((s) => ({ ...s, score: -s.score })),
      forward,
      codes.slice(0, 6),
    );
    expect(reversed.ic).toBeCloseTo(-1, 12);
  });

  it("skips a day with fewer than 10 scored codes", () => {
    const r = dailyRankIc(scores.slice(0, 9), forward, codes);
    expect(r).toEqual({ n: 9, ic: null });
    expect(dailyRankIc(scores.slice(0, 10), forward, codes).ic).not.toBeNull();
  });

  it("codes without a forward return are not counted; no U1 return means no IC", () => {
    const partial = new Map([...forward].filter(([c]) => c !== "C03"));
    expect(dailyRankIc(scores, partial, codes).n).toBe(11);
    expect(dailyRankIc(scores, new Map(), codes)).toEqual({ n: 0, ic: null });
  });
});

describe("21-session block bootstrap of the daily IC", () => {
  const series = Array.from({ length: 120 }, (_, i) => 0.03 + 0.1 * Math.sin(i / 3));

  it("uses 21-session blocks for monthly and 5 for weekly", () => {
    expect(RANK_IC_BLOCK_SESSIONS).toEqual({ monthly: 21, weekly: 5 });
  });

  it("is deterministic for a seed scope and differs between scopes", () => {
    const a = summariseRankIc(series, { scope: "rank_ic:AU:F1", replicates: 500 });
    const b = summariseRankIc(series, { scope: "rank_ic:AU:F1", replicates: 500 });
    expect(b).toEqual(a);
    const c = summariseRankIc(series, { scope: "rank_ic:AU:F2", replicates: 500 });
    expect(c.medianIc).toBe(a.medianIc);
    expect(c.lower90 === a.lower90 && c.upper90 === a.upper90).toBe(false);
    expect(a.nDays).toBe(120);
    expect(a.lower90!).toBeLessThanOrEqual(a.upper90!);
    expect(a.lower90!).toBeLessThanOrEqual(a.medianIc!);
    expect(a.upper90!).toBeGreaterThanOrEqual(a.medianIc!);
  });

  it("a series of exactly one block: every replicate is a rotation, so the interval is the median", () => {
    const one = Array.from({ length: 21 }, (_, i) => (i % 7) - 3 + i * 0.01);
    const s = summariseRankIc(one, { scope: "rank_ic:AU:F1", replicates: 200 });
    expect(s.lower90).toBe(s.medianIc);
    expect(s.upper90).toBe(s.medianIc);
    expect(s.meanIc).toBeCloseTo(one.reduce((x, y) => x + y, 0) / 21, 12);
  });

  it("a constant series gives a degenerate interval; an empty one gives nulls", () => {
    const s = summariseRankIc(Array<number>(50).fill(0.07), { scope: "x", replicates: 100 });
    expect([s.medianIc, s.lower90, s.upper90]).toEqual([0.07, 0.07, 0.07]);
    expect(summariseRankIc([], { scope: "x" })).toEqual({
      nDays: 0,
      medianIc: null,
      meanIc: null,
      lower90: null,
      upper90: null,
    });
  });
});
