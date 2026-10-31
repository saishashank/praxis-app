// @vitest-environment node
// AT-51 (M15 P6; CTX-035, CTX-053): the Brier-skill bound and the slope upper bound per allowed family,
// ECE reported but not gated (static check), the placebo rule (mean <= 0.35 + 1.35 SE) and the
// random-angle null on synthetic pipelines, MDE rows at n_eff 100/150/300, and the plain-JS rules
// pinned to the C2 economic gate. Synthetic ZZ data only (SEC-110).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateFamily, pooledCellOf } from "@/lib/cortex/status";
import { cellGate, decideFamily, regimeStable } from "@/lib/cortex/statusRules.mjs";
import { ece } from "@/lib/stats/calibration";
import { economicGate, type CellStatistic } from "@/lib/stats/cells";
import {
  mdeRows,
  PLACEBO_MAX_MEAN_ALLOWED,
  PLACEBO_SE_MULTIPLIER,
  placeboRuns,
  placeboTest,
  randomAngleNullRun,
} from "@/lib/stats/nulls";
import { bernoulli, layoutOf, normal, plantedOutcomes, prngFor } from "../../stats/m15/helpers";
import { cellStat } from "../../cortex/night/zzNight";

const BOOT = { expectedBlock: 20, replicates: 150 };
const goodCell = (): CellStatistic => cellStat("F1|top3|v2|U1");

function sample(scope: string, n: number, predictorSlope: number, trueSlope: number) {
  const prng = prngFor(`at51:${scope}`);
  const planted = plantedOutcomes(n, trueSlope, prng);
  // The predictor reports logistic(predictorSlope * z); the truth is logistic(trueSlope * z).
  const p = planted.z.map((z) => 1 / (1 + Math.exp(-predictorSlope * z)));
  return { p, y: planted.y, layout: layoutOf(n, 300), prng };
}

describe("AT-51 Brier-skill bound and slope upper bound per allowed family", () => {
  it("a calibrated informative predictor is allowed: lower bound > 0, slope upper bound >= 1 so p is shown", () => {
    for (const family of ["F1", "F4"] as const) {
      const s = sample(family, 1500, 1.4, 1.4);
      const d = evaluateFamily({ family, ...s, cell: goodCell(), bootstrap: BOOT });
      expect(d.evidence.brier_skill_lo90).toBeGreaterThan(0);
      expect(d.evidence.n_eff).toBeGreaterThanOrEqual(200);
      expect(d.failed).toEqual([]);
      expect(d.status).toBe("allowed");
      expect(d.evidence.slope_ub90).toBeGreaterThanOrEqual(1);
      expect(d.pHidden).toBe(false);
      expect(d.evidence.mde).toBeGreaterThan(0);
    }
  });

  it("an over-confident predictor (slope 0.4) has its p hidden but is not refused for it (the slope is a diagnostic)", () => {
    const s = sample("over", 1500, 3.5, 1.4);
    const d = evaluateFamily({ family: "F1", ...s, cell: goodCell(), bootstrap: BOOT });
    expect(d.evidence.slope_ub90 as number).toBeLessThan(1);
    expect(d.pHidden).toBe(true);
    expect(d.failed).not.toContain("slope");
  });

  it("a predictor with no skill has a lower bound at or below 0 and stays in shadow", () => {
    const prng = prngFor("at51:noskill");
    const n = 1500;
    const p = Array.from({ length: n }, () => 0.5);
    const y = Array.from({ length: n }, () => bernoulli(prng, 0.5));
    const d = evaluateFamily({
      family: "F1",
      p,
      y,
      layout: layoutOf(n, 300),
      cell: goodCell(),
      prng,
      bootstrap: BOOT,
    });
    expect(d.status).toBe("shadow");
    expect(d.failed).toContain("brier_skill_not_positive");
  });

  it("below the n_eff floor the family reports calibration untestable; F7 is never allowed", () => {
    const small = sample("small", 120, 1.4, 1.4);
    const d = evaluateFamily({ family: "F1", ...small, cell: goodCell(), bootstrap: BOOT });
    expect(d.failed).toContain("calibration_untestable");
    const big = sample("f7", 1500, 1.4, 1.4);
    const f7 = evaluateFamily({ family: "F7", ...big, cell: goodCell(), bootstrap: BOOT });
    expect(f7.failed).toEqual(["f7_never_allowed"]);
    expect(f7.status).toBe("shadow");
  });

  it("an undefined slope hides p (D-300) and the minimum n_eff bound is a parameter", () => {
    const d = decideFamily({
      family: "F1",
      nEff: 180,
      minNEff: 150,
      brierLo90: 0.01,
      slopeUb90: null,
      cell: pooledCellOf(goodCell()),
    });
    expect(d.pHidden).toBe(true);
    expect(d.allowed).toBe(true);
    expect(
      decideFamily({
        family: "F1",
        nEff: 180,
        brierLo90: 0.01,
        slopeUb90: 1.2,
        cell: pooledCellOf(goodCell()),
      }).failed,
    ).toContain("calibration_untestable");
  });
});

describe("AT-51 the plain-JS gate mirror equals the C2 economic gate", () => {
  const variants: Partial<CellStatistic>[] = [
    {},
    { n: 40 },
    { blocks: 10 },
    { nEff: undefined },
    { lower90: -0.001 },
    { lower90: Number.NaN, bound: { undefined: "too few blocks" } },
    { byRegime: { NEUTRAL: { n: 40, meanNet: -0.01 } } },
    { byRegime: { NEUTRAL: { n: 5, meanNet: 0.02 } } },
  ];
  it("agrees on every variant and regime", () => {
    for (const v of variants) {
      const cell = { ...goodCell(), ...v } as CellStatistic;
      for (const regime of ["NEUTRAL", "RISK-ON", "SHOCK", "OTHER"]) {
        const c2 = economicGate(cell, regime);
        const mirror = cellGate(pooledCellOf(cell)!, regime);
        expect(mirror.pass).toBe(c2.pass);
        if (!c2.pass && !mirror.pass) expect(mirror.reason).toBe(c2.reason);
      }
    }
  });

  it("regime stability needs a regime with enough setups and a non-negative mean in each", () => {
    expect(regimeStable(pooledCellOf(goodCell())!).stable).toBe(true);
    const bad = {
      ...goodCell(),
      byRegime: { A: { n: 40, meanNet: 0.02 }, B: { n: 40, meanNet: -0.01 } },
    };
    expect(regimeStable(pooledCellOf(bad)!).stable).toBe(false);
    const none = { ...goodCell(), byRegime: { A: { n: 10, meanNet: 0.02 } } };
    expect(regimeStable(pooledCellOf(none)!).stable).toBe(false);
  });
});

describe("AT-51 ECE is reported, never gated (static check)", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
  const walk = (dir: string): string[] =>
    readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );

  it("no gate and no permission rule reads ECE", () => {
    for (const f of walk("src/lib/cortex/gates")) expect(read(f), f).not.toMatch(/\bece(Ci)?\b/i);
    expect(read("src/lib/cortex/status.ts")).not.toMatch(/\bece(Ci)?\b/i);
    const rules = read("src/lib/cortex/statusRules.mjs");
    const start = rules.indexOf("export function decideFamily");
    const end = rules.indexOf("const RANK");
    expect(rules.slice(start, end)).not.toMatch(/\bece\b/i);
  });

  it("ECE is still computed and reported (it is a statement field, not a criterion)", () => {
    const s = sample("ece", 800, 1.4, 1.4);
    const r = ece(s.p, s.y);
    expect(r.ece).toBeGreaterThanOrEqual(0);
    expect(r.ece).toBeLessThan(0.1);
    expect(r.bins.length).toBe(10);
  });
});

describe("AT-51 placebo: shuffled outcomes allow no more than 0.35 + 1.35 SE families", () => {
  const n = 500;
  const base = sample("placebo", n, 1.4, 1.4);

  it("the real outcomes pass the pipeline; the shuffled ones almost never do", () => {
    const pipeline = (y: readonly (0 | 1)[], run: number): number =>
      evaluateFamily({
        family: "F1",
        p: base.p,
        y,
        layout: base.layout,
        cell: goodCell(),
        prng: prngFor(`at51:placebo-boot:${run}`),
        minNEff: 150,
        bootstrap: { expectedBlock: 20, replicates: 80 },
      }).allowed
        ? 1
        : 0;
    expect(pipeline(base.y, 999)).toBe(1);
    const runs = placeboRuns(base.y, pipeline, 60, prngFor("at51:placebo-shuffle"));
    const res = placeboTest(runs);
    expect(res.enoughRuns).toBe(true);
    expect(res.pass).toBe(true);
    expect(res.bound).toBeCloseTo(PLACEBO_MAX_MEAN_ALLOWED + PLACEBO_SE_MULTIPLIER * res.se, 12);
    expect(res.meanAllowed).toBeLessThanOrEqual(res.bound);
  }, 120_000);

  it("a pipeline that allows a family in every run fails the rule", () => {
    const res = placeboTest(new Array<number>(60).fill(1).map((v, i) => (i % 7 === 0 ? 0 : v)));
    expect(res.pass).toBe(false);
  });
});

describe("AT-51 random-angle null: the live set must beat the 95th percentile of random sets", () => {
  const rows = 400;
  const prng = prngFor("at51:angles");
  const forward = Array.from({ length: rows }, () => normal(prng));
  const noise = Array.from({ length: 30 }, () => Array.from({ length: rows }, () => normal(prng)));
  const planted = forward.map((f) => 0.35 * f + normal(prng)); // an informative angle
  const corr = (a: readonly number[], b: readonly number[]) => {
    const n = a.length;
    const ma = a.reduce((s, v) => s + v, 0) / n;
    const mb = b.reduce((s, v) => s + v, 0) / n;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < n; i += 1) {
      sab += (a[i]! - ma) * (b[i]! - mb);
      saa += (a[i]! - ma) ** 2;
      sbb += (b[i]! - mb) ** 2;
    }
    return sab / Math.sqrt(saa * sbb);
  };
  const scoreOf = (set: readonly (readonly number[])[]): number => {
    const mean = Array.from(
      { length: rows },
      (_, i) => set.reduce((s, c) => s + c[i]!, 0) / set.length,
    );
    return corr(mean, forward);
  };

  it("planted: a live set holding the informative angle is above the 95th percentile; null: a noise set is not", () => {
    const k = 3;
    const livePlanted = scoreOf([planted, noise[0]!, noise[1]!]);
    const liveNull = scoreOf([noise[2]!, noise[3]!, noise[4]!]);
    const a = randomAngleNullRun(
      livePlanted,
      noise,
      k,
      1000,
      (s) => scoreOf(s),
      prngFor("at51:sets-a"),
    );
    const b = randomAngleNullRun(
      liveNull,
      noise,
      k,
      1000,
      (s) => scoreOf(s),
      prngFor("at51:sets-b"),
    );
    expect(a.enoughSets).toBe(true);
    expect(a.pass).toBe(true);
    expect(a.liveScore).toBeGreaterThan(a.q95);
    expect(a.liveRank).toBeGreaterThan(0.95);
    expect(b.pass).toBe(false);
    expect(b.liveScore).toBeLessThanOrEqual(b.q95);
  });
});

describe("AT-51 MDE rows at n_eff 100, 150 and 300", () => {
  it("the minimum detectable effect falls as 1/sqrt(n_eff)", () => {
    const rows = mdeRows(0.5);
    expect(rows.map((r) => r.nEff)).toEqual([100, 150, 300]);
    expect(rows[0]!.mde).toBeGreaterThan(rows[1]!.mde);
    expect(rows[1]!.mde).toBeGreaterThan(rows[2]!.mde);
    expect(rows[0]!.mde / rows[2]!.mde).toBeCloseTo(Math.sqrt(3), 10);
    expect(mdeRows(0).every((r) => r.mde === 0)).toBe(true);
  });

  it("the evaluator's evidence carries the three rows and the family's own MDE", () => {
    const s = sample("mde", 1000, 1.4, 1.4);
    const d = evaluateFamily({ family: "F1", ...s, cell: goodCell(), bootstrap: BOOT });
    expect((d.evidence.mde_rows as { nEff: number }[]).map((r) => r.nEff)).toEqual([100, 150, 300]);
    expect(d.evidence.mde).toBeGreaterThan(0);
  });
});
