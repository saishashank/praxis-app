// @vitest-environment node
// Distinctness on synthetic correlated features (M15 C2; CTX-033, AT-53 "residualised distinctness").
import { describe, expect, it } from "vitest";
import {
  clusterMeanCorrelation,
  distinctnessReport,
  effectiveNumber,
  factorMatrix,
  MAX_RANK_CORRELATION,
  MAX_VIF,
  MIN_PARTIAL_IC_RATIO,
  ols,
  partialIc,
  rankCorrelationMatrix,
  residualiseFeatures,
  symmetricEigenvalues,
  vif,
} from "@/lib/stats/distinctness";
import { normal, prngFor } from "./helpers";

const N = 400;

function draw(scope: string): number[] {
  const prng = prngFor(scope);
  return Array.from({ length: N }, () => normal(prng));
}

describe("OLS and factors", () => {
  it("known answer: y = 1 + 2x exactly → coef (1, 2), residuals 0, R² 1", () => {
    const x = [0, 1, 2, 3, 4];
    const fit = ols(
      x.map((v) => 1 + 2 * v),
      x.map((v) => [v]),
    )!;
    expect(fit.coef[0]).toBeCloseTo(1, 10);
    expect(fit.coef[1]).toBeCloseTo(2, 10);
    expect(fit.residuals.every((r) => Math.abs(r) < 1e-9)).toBe(true);
    expect(fit.r2).toBeCloseTo(1, 10);
    expect(ols([1, 2, 3], [[1], [1], [1]])).toBeNull(); // constant column duplicates the intercept
  });

  it("factor matrix: sector dummies (first level dropped), beta, size", () => {
    const X = factorMatrix({
      sector: ["mining", "banks", "mining"],
      beta: [1.1, 0.9, 1.3],
      size: [20, 22, 19],
    });
    expect(X).toEqual([
      [1, 1.1, 20],
      [0, 0.9, 22],
      [1, 1.3, 19],
    ]);
  });

  it("recovers planted beta and size loadings and removes them from the residual", () => {
    const beta = draw("beta").map((v) => 1 + 0.3 * v);
    const size = draw("size").map((v) => 21 + 1.5 * v);
    const sector = Array.from({ length: N }, (_, i) => ["a", "b", "c"][i % 3]!);
    const noise = draw("noise");
    const feature = beta.map(
      (b, i) => 2 * b + 3 * size[i]! + (sector[i] === "b" ? 5 : 0) + noise[i]!,
    );
    const r = residualiseFeatures([feature], { sector, beta, size });
    expect(r.loadings[0]!.beta).toBeCloseTo(2, 0);
    expect(r.loadings[0]!.size).toBeCloseTo(3, 1);
    const rho = rankCorrelationMatrix([r.residuals[0]!, size])[0]![1]!;
    expect(Math.abs(rho)).toBeLessThan(0.1);
  });
});

describe("correlation, VIF, effective number", () => {
  it("VIF known answer: two features with correlation r give 1 / (1 − r²)", () => {
    const x = draw("vif-x");
    const e = draw("vif-e");
    const y = x.map((v, i) => v + e[i]!);
    const v = vif([x, y]);
    // Pearson r of x and x + e with unit variances is 1/√2 → VIF = 2 (sampling noise allowed).
    const fit = ols(
      y,
      x.map((v) => [v]),
    )!;
    const expected = 1 / (1 - fit.r2);
    expect(v[0]).toBeCloseTo(expected, 8);
    expect(v[1]).toBeCloseTo(expected, 8);
    expect(expected).toBeGreaterThan(1.6);
    expect(expected).toBeLessThan(2.5);
    expect(vif([x])).toEqual([1]);
    expect(vif([x, x.map((t) => 2 * t)])[0]).toBe(Infinity);
  });

  it("eigenvalues known answer: [[2, 1], [1, 2]] → 3, 1; effective number of I_3 is 3, of a rank-1 pair ≈ 1", () => {
    const ev = symmetricEigenvalues([
      [2, 1],
      [1, 2],
    ]);
    expect(ev[0]).toBeCloseTo(3, 10);
    expect(ev[1]).toBeCloseTo(1, 10);
    expect(
      effectiveNumber([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]),
    ).toBeCloseTo(3, 10);
    expect(
      effectiveNumber([
        [1, 1],
        [1, 1],
      ]),
    ).toBeCloseTo(1, 10);
    // (Σλ)²/Σλ² with λ = 1.5, 0.5 → 4 / 2.5 = 1.6
    expect(
      effectiveNumber([
        [1, 0.5],
        [0.5, 1],
      ]),
    ).toBeCloseTo(1.6, 10);
  });

  it("cluster-mean correlation on raw features", () => {
    const x = draw("cm-x");
    const z = draw("cm-z");
    const r = clusterMeanCorrelation(
      [x, x.map((v) => v + 0.1), z],
      ["momentum", "momentum", "quality"],
    );
    expect(r.clusters).toEqual(["momentum", "quality"]);
    expect(r.max).toBeLessThan(0.2);
    const same = clusterMeanCorrelation([x, x.map((v) => 0.9 * v)], ["a", "b"]);
    expect(same.max).toBeCloseTo(1, 10);
  });
});

describe("partial IC", () => {
  it("a distinct feature keeps its IC; a redundant one loses it", () => {
    const x = draw("pic-x");
    const z = draw("pic-z");
    const e = draw("pic-e");
    const forward = x.map((v, i) => 0.5 * v + e[i]!);
    const distinct = partialIc(x, [z], forward);
    expect(distinct.raw).toBeGreaterThan(0.3);
    expect(distinct.ratio).toBeGreaterThan(0.9);
    expect(distinct.pass).toBe(true);
    // Redundant: x against a near copy of itself as the other feature.
    const copy = x.map((v, i) => v + 0.05 * z[i]!);
    const redundant = partialIc(x, [copy], forward);
    expect(redundant.ratio).toBeLessThan(MIN_PARTIAL_IC_RATIO);
    expect(redundant.pass).toBe(false);
    expect(partialIc([1, 1, 1], [], [1, 2, 3]).raw).toBeNull();
  });
});

describe("distinctnessReport", () => {
  const beta = draw("rep-beta").map((v) => 1 + 0.3 * v);
  const size = draw("rep-size").map((v) => 21 + 1.5 * v);
  const sector = Array.from({ length: N }, (_, i) => ["a", "b"][i % 2]!);
  const factors = { sector, beta, size };
  const a = draw("rep-a");
  const b = draw("rep-b");
  const c = draw("rep-c");
  const forward = a.map((v, i) => 0.3 * v + 0.3 * b[i]! + 0.3 * c[i]! + draw("rep-f")[i]!);

  it("independent features pass every check with an effective number near the count", () => {
    const r = distinctnessReport({
      angleIds: ["A-D1-01", "A-D1-02", "A-D5-01"],
      clusters: ["momentum", "momentum", "quality"],
      features: [a, b, c],
      factors,
      forward,
    });
    expect(r.pass).toBe(true);
    expect(r.maxRankCorrelation).toBeLessThan(0.2);
    expect(r.vif.every((v) => v < 1.2)).toBe(true);
    expect(r.effectiveNumber).toBeGreaterThan(2.9);
    expect(r.loadings).toHaveLength(3);
    expect(r.partialIc.every((p) => p.pass)).toBe(true);
  });

  it("a near-duplicate feature fails rank correlation, VIF and partial IC; the effective number drops", () => {
    const dup = a.map((v, i) => v + 0.1 * c[i]!);
    const r = distinctnessReport({
      angleIds: ["A-D1-01", "A-D1-01b", "A-D5-01"],
      clusters: ["momentum", "momentum", "quality"],
      features: [a, dup, c],
      factors,
      forward,
    });
    expect(r.pass).toBe(false);
    expect(r.maxRankCorrelation).toBeGreaterThan(MAX_RANK_CORRELATION);
    expect(Math.max(...r.vif)).toBeGreaterThan(MAX_VIF);
    expect(r.checks.rankCorrelation).toBe(false);
    expect(r.checks.vif).toBe(false);
    expect(r.checks.partialIc).toBe(false);
    expect(r.effectiveNumber).toBeLessThan(2.3);
  });

  it("a feature that is only sector/beta/size exposure is residualised away", () => {
    const exposure = beta.map((v, i) => 3 * v - 0.5 * size[i]! + (sector[i] === "a" ? 1 : 0));
    const r = distinctnessReport({
      angleIds: ["x", "y"],
      clusters: ["momentum", "quality"],
      features: [a, exposure],
      factors,
      forward,
    });
    // After residualisation the exposure feature is numerically zero: constant → NaN correlations are
    // ignored by the max, and its loadings read back the planted coefficients.
    expect(r.loadings[1]!.beta).toBeCloseTo(3, 8);
    expect(r.loadings[1]!.size).toBeCloseTo(-0.5, 8);
    expect(r.maxRankCorrelation).toBeLessThan(0.2);
    expect(() =>
      distinctnessReport({
        angleIds: ["x"],
        clusters: ["m", "q"],
        features: [a],
        factors,
        forward,
      }),
    ).toThrow(RangeError);
  });
});
