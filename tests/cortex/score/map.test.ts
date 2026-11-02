// @vitest-environment node
// Platt apply with the refit guard and the per-code wrapper (M15 C3a; CTX-012 "Map", CTX-060, D-281).
import { describe, expect, it } from "vitest";
import { activeSetHash, mapGuard, pOf } from "@/lib/cortex/score/map";
import { scoreCode } from "@/lib/cortex/score";
import type { AngleValue, CortexMap, ScoredAngle } from "@/lib/cortex/score/types";
import { logistic, plattApply } from "@/lib/stats/calibration";

const scored: readonly ScoredAngle[] = [
  { id: "A-D1-01", version: 1, cluster: "momentum" },
  { id: "A-D1-03", version: 2, cluster: "low_volatility" },
];
const HASH = activeSetHash(scored);
const map: CortexMap = {
  family: "F1",
  ruleVersion: "F1.cortex.1",
  fittedAt: "2026-10-01T00:00:00Z",
  a: 1.5,
  b: -0.25,
  sMean: 0.1,
  sSd: 0.2,
  K: 2,
  clusters: ["momentum", "low_volatility"],
  activeSetHash: HASH,
  nEff: 250,
};
const feats = (entries: [string, AngleValue][]) => new Map<string, AngleValue>(entries);

describe("activeSetHash", () => {
  it("is order-independent, 64 hex chars, and changes with a version or an id", () => {
    expect(HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(activeSetHash([scored[1]!, scored[0]!])).toBe(HASH);
    expect(activeSetHash([scored[0]!, { ...scored[1]!, version: 3 }])).not.toBe(HASH);
    expect(activeSetHash([scored[0]!])).not.toBe(HASH);
    expect(() => activeSetHash([scored[0]!, scored[0]!])).toThrow(RangeError);
  });
});

describe("mapGuard (refit guard)", () => {
  it("passes a map fitted on tonight's scored set with the declared clusters", () => {
    expect(mapGuard(map, HASH, ["low_volatility", "momentum"])).toEqual({ ok: true, map });
  });

  it("no map → map_missing (D-281)", () => {
    const g = mapGuard(undefined, HASH);
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.reason).toBe("map_missing");
  });

  it("a changed active set → map_stale until the charged-trial refit", () => {
    const other = activeSetHash([...scored, { id: "A-D2-01", version: 1, cluster: "liquidity" }]);
    const g = mapGuard(map, other);
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.reason).toBe("map_stale");
    expect(g.detail).toContain(map.activeSetHash.slice(0, 12));
  });

  it("declared clusters that differ from the map's → map_stale", () => {
    const g = mapGuard(map, HASH, ["momentum", "event"]);
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.reason).toBe("map_stale");
  });

  it("K / clusters mismatch, non-finite parameters or s_sd ≤ 0 → map_invalid", () => {
    for (const bad of [
      { ...map, K: 3 },
      { ...map, a: NaN },
      { ...map, sSd: 0 },
      { ...map, K: 0, clusters: [] as CortexMap["clusters"] },
    ]) {
      const g = mapGuard(bad, HASH);
      expect(g.ok).toBe(false);
      if (!g.ok) expect(g.reason).toBe("map_invalid");
    }
  });
});

describe("pOf", () => {
  it("is C2 plattApply: logistic(a · (S − mean)/sd + b)", () => {
    const s = 0.3;
    expect(pOf(map, s)).toBe(plattApply(map, s));
    expect(pOf(map, s)).toBeCloseTo(logistic(1.5 * ((0.3 - 0.1) / 0.2) - 0.25), 12);
    expect(pOf(map, 0.1)).toBeCloseTo(logistic(-0.25), 12);
    expect(() => pOf(map, NaN)).toThrow(RangeError);
  });
});

describe("scoreCode", () => {
  it("ineligible on an undefined angle", () => {
    const r = scoreCode(feats([["A-D1-01", 0.5]]), scored, map, HASH, map.clusters);
    expect(r.status).toBe("ineligible");
    if (r.status !== "ineligible") return;
    expect(r.eligibility.missing).toEqual(["A-D1-03"]);
  });

  it("scored with p under a current map", () => {
    const f = feats([
      ["A-D1-01", 0.6],
      ["A-D1-03", -0.2],
    ]);
    const r = scoreCode(f, scored, map, HASH, map.clusters);
    expect(r.status).toBe("scored");
    if (r.status !== "scored") return;
    expect(r.score.s).toBeCloseTo(0.2, 12);
    expect(r.disagreement.d).toBe(0.5);
    expect(r.p).toBeCloseTo(plattApply(map, 0.2), 12);
    expect(r.guard.ok).toBe(true);
  });

  it("scored with NO p when the map is missing or stale (shadow), S still over the declared clusters", () => {
    const f = feats([
      ["A-D1-01", 0.6],
      ["A-D1-03", -0.2],
    ]);
    const missing = scoreCode(f, scored, undefined, HASH, map.clusters);
    expect(missing.status).toBe("scored");
    if (missing.status !== "scored") return;
    expect(missing.p).toBeNull();
    expect(missing.guard.ok).toBe(false);
    expect(missing.score.s).toBeCloseTo(0.2, 12);
    const stale = scoreCode(f, scored, map, "0".repeat(64), map.clusters);
    expect(stale.status === "scored" && stale.p).toBeNull();
  });

  it("is deterministic: the same inputs give equal output objects", () => {
    const f = feats([
      ["A-D1-01", 0.6],
      ["A-D1-03", -0.2],
    ]);
    expect(scoreCode(f, scored, map, HASH, map.clusters)).toEqual(
      scoreCode(f, scored, map, HASH, map.clusters),
    );
  });
});
