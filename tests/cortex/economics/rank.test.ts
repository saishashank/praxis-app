// @vitest-environment node
// Ranking (M15 C3a; CTX-022; AT-52 "the ATR 4 %/6 % pair with equal p ranks the lower-ATR name").
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RANK_SHRINK_N0,
  type RankCandidate,
  rankCandidates,
  rankKeyOf,
  shrinkWeight,
} from "@/lib/cortex/economics/rank";

const cand = (over: Partial<RankCandidate> & { code: string }): RankCandidate => ({
  volBucket: "mid",
  meanNet: 0.03,
  nEff: 120,
  lReal: 0.05,
  disagreement: 0,
  advMicro: 1_000_000_000_000n,
  ...over,
});

describe("shrinkage", () => {
  it("w = n_eff / (n_eff + n0), n0 = 60 by default; undefined n_eff → 0", () => {
    expect(DEFAULT_RANK_SHRINK_N0).toBe(60);
    expect(shrinkWeight(60)).toBeCloseTo(0.5, 12);
    expect(shrinkWeight(180)).toBeCloseTo(0.75, 12);
    expect(shrinkWeight(120, 120)).toBeCloseTo(0.5, 12);
    expect(shrinkWeight(undefined)).toBe(0);
    expect(shrinkWeight(0)).toBe(0);
    expect(() => shrinkWeight(10, 0)).toThrow(RangeError);
  });

  it("the key is shrunk mean ÷ L_real; no realised loss ranks by the sign of the mean", () => {
    expect(rankKeyOf(0.03, 0.06)).toBeCloseTo(0.5, 12);
    expect(rankKeyOf(0.03, 0)).toBe(Infinity);
    expect(rankKeyOf(-0.03, 0)).toBe(-Infinity);
    expect(rankKeyOf(0, 0)).toBe(0);
    expect(() => rankKeyOf(0.03, -1)).toThrow(RangeError);
  });
});

describe("rankCandidates", () => {
  it("AT-52: equal p (equal mean net), ATR 4 % vs 6 % → the lower-ATR name ranks first", () => {
    // Realised losses scale with ATR: L_real 0.04 vs 0.06 at the same shrunk mean 0.03.
    const atr6 = cand({ code: "ZZ06", lReal: 0.06, volBucket: "high" });
    const atr4 = cand({ code: "ZZ04", lReal: 0.04, volBucket: "mid" });
    const ranked = rankCandidates([atr6, atr4], 0.03);
    expect(ranked.map((r) => r.candidate.code)).toEqual(["ZZ04", "ZZ06"]);
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[0]!.rankKey[0]).toBeCloseTo(0.75, 12);
    expect(ranked[1]!.rankKey[0]).toBeCloseTo(0.5, 12);
  });

  it("shrinks towards the family mean with w = n_eff/(n_eff + n0)", () => {
    // cell mean 0.05 at n_eff 60 (w 0.5), family mean 0.01 → shrunk 0.03; ÷ L_real 0.05 = 0.6
    const [r] = rankCandidates([cand({ code: "ZZ01", meanNet: 0.05, nEff: 60 })], 0.01);
    expect(r!.shrinkWeight).toBeCloseTo(0.5, 12);
    expect(r!.shrunkMeanNet).toBeCloseTo(0.03, 12);
    expect(r!.rankKey[0]).toBeCloseTo(0.6, 12);
    // a higher-n_eff cell with the same raw mean is shrunk less and ranks above it
    const two = rankCandidates(
      [
        cand({ code: "ZZ01", meanNet: 0.05, nEff: 60 }),
        cand({ code: "ZZ02", meanNet: 0.05, nEff: 600 }),
      ],
      0.01,
    );
    expect(two.map((r) => r.candidate.code)).toEqual(["ZZ02", "ZZ01"]);
  });

  it("ties: smaller L_real, then lower disagreement, then higher ADV, then code", () => {
    const base = { meanNet: 0.04, nEff: 120 };
    // Same key 0.8 for all four (shrunk 0.04 at family mean 0.04): lReal 0.05.
    const a = cand({ code: "ZZ0A", ...base, lReal: 0.05, disagreement: 0.25, advMicro: 5n });
    const b = cand({ code: "ZZ0B", ...base, lReal: 0.05, disagreement: 0, advMicro: 5n });
    const c = cand({ code: "ZZ0C", ...base, lReal: 0.05, disagreement: 0, advMicro: 9n });
    const d = cand({ code: "ZZ0D", ...base, lReal: 0.05, disagreement: 0, advMicro: 9n });
    const ranked = rankCandidates([a, b, c, d], 0.04);
    const keys = ranked.map((r) => r.rankKey[0]);
    expect(new Set(keys).size).toBe(1); // exact float equality: the tie-breakers decide
    expect(keys[0]).toBeCloseTo(0.8, 12);
    expect(ranked.map((r) => r.candidate.code)).toEqual(["ZZ0C", "ZZ0D", "ZZ0B", "ZZ0A"]);
  });

  it("cross-bucket order is by the same quantity; a negative shrunk mean ranks last", () => {
    const ranked = rankCandidates(
      [
        cand({ code: "ZZ01", volBucket: "low", meanNet: 0.02, lReal: 0.02 }), // 1.0 ÷ ... = key 1.0 at w=... see below
        cand({ code: "ZZ02", volBucket: "high", meanNet: 0.06, lReal: 0.08 }),
        cand({ code: "ZZ03", volBucket: "mid", meanNet: -0.02, lReal: 0.03 }),
      ],
      0,
    );
    // w = 120/180 = 2/3: shrunk 0.01333/0.02 = 0.667; 0.04/0.08 = 0.5; −0.01333/0.03 < 0
    expect(ranked.map((r) => r.candidate.code)).toEqual(["ZZ01", "ZZ02", "ZZ03"]);
    expect(ranked[2]!.rankKey[0]).toBeLessThan(0);
  });

  it("is order-independent and deterministic", () => {
    const list = [cand({ code: "ZZ02", lReal: 0.06 }), cand({ code: "ZZ01", lReal: 0.04 })];
    expect(rankCandidates(list, 0.03)).toEqual(rankCandidates([...list].reverse(), 0.03));
    expect(rankCandidates([], 0.03)).toEqual([]);
  });

  it("rejects non-finite inputs", () => {
    expect(() => rankCandidates([cand({ code: "ZZ01", meanNet: NaN })], 0)).toThrow(RangeError);
    expect(() => rankCandidates([cand({ code: "ZZ01" })], NaN)).toThrow(RangeError);
    expect(() => rankCandidates([cand({ code: "ZZ01", disagreement: -1 })], 0)).toThrow(RangeError);
  });
});
