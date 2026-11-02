// @vitest-environment node
// Placebo, random-angle null and MDE rows (M15 C2; CTX-035, AT-51).
import { describe, expect, it } from "vitest";
import {
  MDE_NEFF_LEVELS,
  mdeRows,
  permutation,
  PLACEBO_MAX_MEAN_ALLOWED,
  PLACEBO_MIN_RUNS,
  PLACEBO_SE_MULTIPLIER,
  placeboRuns,
  placeboTest,
  RANDOM_ANGLE_MIN_SETS,
  randomAngleNull,
  randomAngleNullRun,
  randomAngleSets,
  shuffle,
} from "@/lib/stats/nulls";
import { normalQuantile } from "@/lib/stats/normal";
import { prngFor } from "./helpers";

describe("permutation and shuffle", () => {
  it("is a permutation, deterministic for a seed, different for another", () => {
    const a = Array.from(permutation(20, prngFor("perm")));
    const b = Array.from(permutation(20, prngFor("perm")));
    const c = Array.from(permutation(20, prngFor("perm-2")));
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(shuffle(["x", "y", "z"], prngFor("s")).sort()).toEqual(["x", "y", "z"]);
  });
});

describe("placebo", () => {
  it("rule constants: ≥ 50 runs, mean ≤ 0.35 + 1.35 SE", () => {
    expect(PLACEBO_MIN_RUNS).toBe(50);
    expect(PLACEBO_MAX_MEAN_ALLOWED).toBe(0.35);
    expect(PLACEBO_SE_MULTIPLIER).toBe(1.35);
  });

  it("known answer: 50 runs with 10 ones → mean 0.2, se = sd/√50, pass", () => {
    const runs = [...new Array<number>(40).fill(0), ...new Array<number>(10).fill(1)];
    const r = placeboTest(runs);
    expect(r.meanAllowed).toBeCloseTo(0.2, 12);
    // sample variance = (10 × 0.64 + 40 × 0.04) / 49 = 8 / 49
    expect(r.se).toBeCloseTo(Math.sqrt(8 / 49) / Math.sqrt(50), 12);
    expect(r.bound).toBeCloseTo(0.35 + 1.35 * r.se, 12);
    expect(r.pass).toBe(true);
    expect(r.enoughRuns).toBe(true);
  });

  it("fails when the shuffled pipeline allows too many families", () => {
    const runs = new Array<number>(50).fill(1);
    const r = placeboTest(runs);
    expect(r.se).toBe(0);
    expect(r.pass).toBe(false);
    expect(placeboTest([0, 0, 0]).enoughRuns).toBe(false);
  });

  it("synthetic pipeline: a null pipeline on shuffled outcomes passes, a leaky one fails", () => {
    // Outcomes: 300 wins among 600. A pipeline that "allows" a family when the first 60 shuffled
    // outcomes hold ≥ 45 wins (p ≈ 1e-4 per family, 6 families) allows about 0 per run.
    const outcomes = Array.from({ length: 600 }, (_, i) => (i < 300 ? 1 : 0));
    const strict = placeboRuns(
      outcomes,
      (sh) => {
        let allowed = 0;
        for (let f = 0; f < 6; f += 1) {
          let wins = 0;
          for (let i = 0; i < 60; i += 1) wins += sh[(f * 60 + i) % 600]!;
          if (wins >= 45) allowed += 1;
        }
        return allowed;
      },
      50,
      prngFor("placebo-strict"),
    );
    expect(placeboTest(strict).pass).toBe(true);
    // A leaky pipeline allows a family whenever its first 60 hold ≥ 28 wins (about 2/3 of the time).
    const leaky = placeboRuns(
      outcomes,
      (sh) => {
        let allowed = 0;
        for (let f = 0; f < 6; f += 1) {
          let wins = 0;
          for (let i = 0; i < 60; i += 1) wins += sh[(f * 60 + i) % 600]!;
          if (wins >= 28) allowed += 1;
        }
        return allowed;
      },
      50,
      prngFor("placebo-leaky"),
    );
    expect(placeboTest(leaky).pass).toBe(false);
    expect(() => placeboRuns(outcomes, () => 0, 0, prngFor("x"))).toThrow(RangeError);
  });
});

describe("random-angle null", () => {
  it("draws K-subsets of the pool, in pool order, deterministically", () => {
    const pool = ["a", "b", "c", "d", "e", "f"];
    const sets = randomAngleSets(pool, 3, 5, prngFor("sets"));
    expect(sets).toHaveLength(5);
    for (const s of sets) {
      expect(s).toHaveLength(3);
      expect(new Set(s).size).toBe(3);
      expect([...s].sort()).toEqual(s);
    }
    expect(randomAngleSets(pool, 3, 5, prngFor("sets"))).toEqual(sets);
    expect(() => randomAngleSets(pool, 7, 1, prngFor("x"))).toThrow(RangeError);
  });

  it("known answer: live 0.9 against 100 random scores 0.00…0.99 → nearest-rank q95 0.94, fail; 0.95 passes", () => {
    const random = Array.from({ length: 100 }, (_, i) => i / 100);
    const fail = randomAngleNull(0.9, random);
    // `percentile` is nearest-rank: sorted[ceil(0.95 × 100) − 1] = sorted[94] = 0.94.
    expect(fail.q95).toBeCloseTo(0.94, 12);
    expect(fail.pass).toBe(false);
    expect(fail.liveRank).toBeCloseTo(0.9, 12);
    expect(fail.enoughSets).toBe(false);
    expect(RANDOM_ANGLE_MIN_SETS).toBe(1000);
    expect(randomAngleNull(0.94, random).pass).toBe(false);
    expect(randomAngleNull(0.95, random).pass).toBe(true);
  });

  it("planted score above the random sets passes, a null score does not", () => {
    // Pool of 30 angles; the "score" of a set is the number of planted angles in it (3 planted).
    const pool = Array.from({ length: 30 }, (_, i) => i);
    const planted = new Set([0, 1, 2]);
    const scoreOf = (set: readonly number[]) => set.filter((a) => planted.has(a)).length;
    const live = randomAngleNullRun(3, pool, 5, 1000, scoreOf, prngFor("ran-live"));
    expect(live.pass).toBe(true);
    expect(live.enoughSets).toBe(true);
    const nul = randomAngleNullRun(0, pool, 5, 1000, scoreOf, prngFor("ran-null"));
    expect(nul.pass).toBe(false);
  });
});

describe("MDE rows", () => {
  it("known answer: sd 1 at n_eff 100, level 0.10, power 0.80 → (z0.9 + z0.8) / 10", () => {
    expect(MDE_NEFF_LEVELS).toEqual([100, 150, 300]);
    const rows = mdeRows(1);
    expect(rows.map((r) => r.nEff)).toEqual([100, 150, 300]);
    const z = normalQuantile(0.9) + normalQuantile(0.8);
    expect(rows[0]!.mde).toBeCloseTo(z / 10, 10);
    expect(rows[0]!.mde).toBeCloseTo(0.2123, 3);
    expect(rows[2]!.mde).toBeCloseTo(z / Math.sqrt(300), 10);
    expect(rows[1]!.mde).toBeLessThan(rows[0]!.mde);
    expect(() => mdeRows(-1)).toThrow(RangeError);
  });
});
