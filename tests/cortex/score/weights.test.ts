// @vitest-environment node
// Learner weights in the score (design C.3; D-923, D-926) and the weights check of the refit guard
// (LRN-AT-6). Synthetic angle ids, no data.
import { describe, expect, it } from "vitest";
import { scoreCode } from "@/lib/cortex/score";
import { activeSetHash, mapGuard, pOf, weightsHash } from "@/lib/cortex/score/map";
import { clusterMeans, scoreOf, weightsProblem } from "@/lib/cortex/score/score";
import type {
  AngleCluster,
  AngleValue,
  CortexMap,
  ScoredAngle,
  ScoreWeights,
} from "@/lib/cortex/score/types";

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

describe("scoreOf with weights (C.3)", () => {
  it("no weights and all-one weights give the very same bytes", () => {
    const none = JSON.stringify(scoreOf(base, scored, K4));
    const ones: ScoreWeights = {
      angle: { "A-D1-01": 1, "A-D1-02": 1, "A-D1-03": 1, "A-D2-01": 1 },
      cluster: { momentum: 1, low_volatility: 1, liquidity: 1, event: 1 },
    };
    expect(JSON.stringify(scoreOf(base, scored, K4, 4, ones))).toBe(none);
    expect(JSON.stringify(scoreOf(base, scored, K4, 4, {}))).toBe(none);
  });

  it("angle weights weigh the cluster mean; cluster weights weigh S over the fixed K", () => {
    const sc = scoreOf(base, scored, K4, 4, {
      angle: { "A-D1-01": 3, "A-D1-02": 1 },
      cluster: { momentum: 2 },
    });
    // momentum (3·0.8 + 1·0.2) / 4 = 0.65; S = (2·0.65 − 0.2 + 0 + 0) / (2 + 1 + 1 + 1) = 0.22
    expect(sc.clusters[0]!.mean).toBeCloseTo(0.65, 12);
    expect(sc.clusters[0]!.n).toBe(2);
    expect(sc.s).toBeCloseTo(0.22, 12);
    expect(sc.K).toBe(4);
  });

  it("D-926: a benched angle (weight 0) drops out of the mean but stays in the count", () => {
    const sc = scoreOf(base, scored, K4, 4, { angle: { "A-D1-01": 0 } });
    expect(sc.clusters[0]).toEqual({ cluster: "momentum", n: 2, mean: 0.2 });
    // a cluster whose every angle is benched contributes 0 and K stays fixed
    const low = scoreOf(base, scored, K4, 4, { angle: { "A-D1-03": 0 } });
    expect(low.clusters[1]).toEqual({ cluster: "low_volatility", n: 1, mean: 0 });
    expect(low.s).toBeCloseTo(0.5 / 4, 12);
  });

  it("D-926: a benched angle is still required — undefined makes the code ineligible", () => {
    const set = scored.map((a) => ({ ...a, weight: a.id === "A-D1-01" ? 0 : undefined }));
    const missing = feats([...base].filter(([id]) => id !== "A-D1-01"));
    const map = mapOf();
    const r = scoreCode(missing, set, map, activeSetHash(scored), [...K4], {
      weights: { angle: { "A-D1-01": 0 } },
    });
    expect(r.status).toBe("ineligible");
    expect(() => clusterMeans(missing, set, K4)).toThrow(RangeError);
  });

  it("ScoredAngle.weight is read by clusterMeans; a bad one is a programming error", () => {
    const set = scored.map((a) => (a.id === "A-D1-02" ? { ...a, weight: 3 } : a));
    expect(clusterMeans(base, set, K4)[0]!.mean).toBeCloseTo((0.8 + 0.6) / 4, 12);
    const bad = scored.map((a) => (a.id === "A-D1-02" ? { ...a, weight: -1 } : a));
    expect(() => clusterMeans(base, bad, K4)).toThrow(/weight/);
  });

  it("invalid weights throw map_invalid (the guard catches them first on the night path)", () => {
    expect(() => scoreOf(base, scored, K4, 4, { cluster: { momentum: 2 } }, 0.35)).toThrow(
      /map_invalid/,
    );
    expect(() => scoreOf(base, scored, K4, 4, { angle: { "A-D1-01": -1 } })).toThrow(/map_invalid/);
  });
});

describe("weightsProblem", () => {
  it("accepts finite non-negative weights within the cap", () => {
    expect(weightsProblem({}, K4, 0.35)).toBeNull();
    expect(weightsProblem({ cluster: { momentum: 1.5 } }, K4, 0.35)).toBeNull(); // 1.5 / 4.5
    expect(weightsProblem({ cluster: { momentum: 2 } }, K4)).toBeNull(); // no cap given
  });

  it("refuses negative, non-finite or non-number weights, unknown clusters and a zero total", () => {
    expect(weightsProblem({ angle: { x: -0.1 } }, K4)).toMatch(/angle weight x/);
    expect(weightsProblem({ angle: { x: Number.NaN } }, K4)).toMatch(/angle weight x/);
    expect(weightsProblem({ angle: { x: "1" as unknown as number } }, K4)).toMatch(/angle/);
    expect(weightsProblem({ cluster: { momentum: Infinity } }, K4)).toMatch(/cluster weight/);
    expect(weightsProblem({ cluster: { quality: 1 } }, K4)).toMatch(/undeclared quality/);
    expect(
      weightsProblem({ cluster: { momentum: 0, low_volatility: 0, liquidity: 0, event: 0 } }, K4),
    ).toMatch(/no cluster/);
  });

  it("the cap is max(cluster_weight_max, 1/K): equal weights never violate it", () => {
    expect(weightsProblem({ cluster: { momentum: 2 } }, K4, 0.35)).toMatch(/above the cap/);
    const k2: AngleCluster[] = ["momentum", "liquidity"];
    expect(weightsProblem({}, k2, 0.35)).toBeNull(); // 0.5 each, cap 0.5
    expect(weightsProblem({ cluster: { momentum: 1.1 } }, k2, 0.35)).toMatch(/momentum/);
    expect(weightsProblem({}, [], 0.35)).toMatch(/no cluster/);
  });
});

describe("weightsHash", () => {
  it("is the same for the same weights in any key order and changes with a value", () => {
    const a: ScoreWeights = { angle: { x: 1, y: 0.5 }, cluster: { momentum: 1 } };
    const b: ScoreWeights = { cluster: { momentum: 1 }, angle: { y: 0.5, x: 1 } };
    expect(weightsHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(weightsHash(b)).toBe(weightsHash(a));
    expect(weightsHash({ ...a, angle: { x: 1, y: 0.6 } })).not.toBe(weightsHash(a));
  });
});

// ---- LRN-AT-6: the refit guard on learner weights ---------------------------------------------------

const HASH = activeSetHash(scored);
const W: ScoreWeights = { angle: { "A-D1-01": 1.4, "A-D1-02": 0.6 }, cluster: { momentum: 1.2 } };
function mapOf(over: Partial<CortexMap> = {}): CortexMap {
  return {
    family: "F1",
    ruleVersion: "F1.learn",
    fittedAt: "2026-10-01T00:00:00Z",
    a: 1.5,
    b: -0.25,
    sMean: 0.1,
    sSd: 0.2,
    K: 4,
    clusters: [...K4],
    activeSetHash: HASH,
    nEff: 250,
    ...over,
  };
}
const learnerMap = (over: Partial<CortexMap> = {}): CortexMap =>
  mapOf({ weights: W, weightsHash: weightsHash(W), learner: true, generation: 3, ...over });

describe("LRN-AT-6: mapGuard weights check", () => {
  const reason = (g: ReturnType<typeof mapGuard>) => (g.ok ? "ok" : g.reason);
  const detail = (g: ReturnType<typeof mapGuard>) => (g.ok ? "" : g.detail);

  it("passes a learner map whose stored hash matches its weights and the rule's", () => {
    const m = learnerMap();
    expect(mapGuard(m, HASH, K4, { weights: W, clusterWeightMax: 0.35 })).toEqual({
      ok: true,
      map: m,
    });
    expect(mapGuard(m, HASH, K4).ok).toBe(true); // a caller that does not score skips the rule check
  });

  it("a stored hash that does not match the weights → map_invalid", () => {
    const g = mapGuard(learnerMap({ weightsHash: "0".repeat(64) }), HASH, K4, { weights: W });
    expect(reason(g)).toBe("map_invalid");
    expect(detail(g)).toMatch(/does not match/);
  });

  it("weights without a hash, or a hash without weights → map_invalid", () => {
    expect(reason(mapGuard(learnerMap({ weightsHash: undefined }), HASH, K4))).toBe("map_invalid");
    const hashOnly = mapOf({ weightsHash: weightsHash(W) });
    expect(detail(mapGuard(hashOnly, HASH, K4))).toMatch(/come together/);
  });

  it("a rule scoring with other weights than its map → map_invalid", () => {
    const other = { ...W, cluster: { momentum: 1.3 } };
    expect(reason(mapGuard(learnerMap(), HASH, K4, { weights: other }))).toBe("map_invalid");
    expect(reason(mapGuard(learnerMap(), HASH, K4, {}))).toBe("map_invalid");
    expect(reason(mapGuard(mapOf(), HASH, K4, { weights: W }))).toBe("map_invalid");
  });

  it("a fixed map and a rule without weights pass as before", () => {
    expect(mapGuard(mapOf(), HASH, K4, { clusterWeightMax: 0.35 }).ok).toBe(true);
  });

  it("weights above the cluster cap → map_invalid, never silently fixed", () => {
    const big: ScoreWeights = { cluster: { momentum: 3 } };
    const g = mapGuard(mapOf({ weights: big, weightsHash: weightsHash(big) }), HASH, K4, {
      weights: big,
      clusterWeightMax: 0.35,
    });
    expect(reason(g)).toBe("map_invalid");
    expect(detail(g)).toMatch(/above the cap/);
  });

  it("a learner fitted on another scored set → map_stale before any weights check", () => {
    const g = mapGuard(learnerMap({ weightsHash: "x" }), activeSetHash(scored.slice(1)), K4, {
      weights: W,
    });
    expect(reason(g)).toBe("map_stale");
  });
});

describe("scoreCode with a learner rule", () => {
  it("scores the weighted S and its p under a valid learner map", () => {
    const m = learnerMap();
    const r = scoreCode(base, scored, m, HASH, [...K4], { weights: W, clusterWeightMax: 0.35 });
    expect(r.status).toBe("scored");
    if (r.status !== "scored") return;
    const s = scoreOf(base, scored, K4, 4, W).s;
    expect(r.score.s).toBe(s);
    expect(r.p).toBe(pOf(m, s));
    expect(r.score.s).not.toBe(scoreOf(base, scored, K4).s);
  });

  it("invalid weights: equal-weight S, no p, map_invalid (the night never throws)", () => {
    const bad: ScoreWeights = { angle: { "A-D1-01": -2 } };
    const m = mapOf({ weights: bad, weightsHash: weightsHash(bad) });
    const r = scoreCode(base, scored, m, HASH, [...K4], { weights: bad });
    expect(r.status).toBe("scored");
    if (r.status !== "scored") return;
    expect(r.p).toBeNull();
    expect(r.guard.ok ? "ok" : r.guard.reason).toBe("map_invalid");
    expect(r.score.s).toBe(scoreOf(base, scored, K4).s);
  });
});
