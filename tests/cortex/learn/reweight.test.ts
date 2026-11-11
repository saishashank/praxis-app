// @vitest-environment node
// Weekly re-weighting (cortex_learning_architecture B.2, C.7; LRN-AT-3, LRN-AT-4 and the weekly half of
// LRN-AT-5). Synthetic scorecards only.
import { describe, expect, it } from "vitest";
import { checkpoint } from "@/lib/cortex/learn/checkpoint";
import { learnConfig } from "@/lib/cortex/learn/config";
import {
  placebo,
  placeboScope,
  reweight,
  reweightScope,
  weeklyWords,
  weightsHash,
  withinChance,
  type DevPrior,
} from "@/lib/cortex/learn/reweight";
import type { LearnerWeights } from "@/lib/cortex/learn/types";
import { scopedPrng } from "@/lib/stats/rng";
import { icPaths, row, rowsOf, weekdays } from "./fixtures";

const ANGLES = ["A-D1-01", "A-D1-02", "A-D2-01", "A-D2-02", "A-D3-01", "A-D3-02"];
const CLUSTER: Record<string, string> = {
  "A-D1-01": "momentum",
  "A-D1-02": "momentum",
  "A-D2-01": "liquidity",
  "A-D2-02": "liquidity",
  "A-D3-01": "quality",
  "A-D3-02": "quality",
};
const prior = (devIc = 0.03): DevPrior =>
  Object.fromEntries(
    ANGLES.map((a, i) => [a, { devIc, cluster: CLUSTER[a]!, name: `angle ${i + 1}` }]),
  );
const EQUAL: LearnerWeights = {
  angle: Object.fromEntries(ANGLES.map((a) => [a, 1])),
  cluster: { momentum: 1, liquidity: 1, quality: 1 },
};
const DATES = weekdays(300);

describe("reweight", () => {
  it("LRN-AT-3: the same rows give the same weights_hash bytes, twice", () => {
    const paths = icPaths({
      angles: ANGLES,
      sessions: 80,
      sd: 0.02,
      seed: "at3",
      meanAt: (a) => (a === "A-D1-01" ? 0.05 : 0.0),
    });
    const rows = rowsOf(paths, DATES, 20, 80, [20]);
    const config = learnConfig({ replicates: 300 }, { relaxed: true });
    const run = () =>
      reweight({
        angleDays60: rows,
        devPrior: prior(),
        current: EQUAL,
        config,
        prng: scopedPrng(reweightScope("ASX", "2026-W10")),
      });
    const a = run();
    const b = run();
    expect(a.weightsHash).toBe(b.weightsHash);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.weightsHash).toBe(weightsHash(a.weights));
    expect(a.weightsHash).toMatch(/^[0-9a-f]{64}$/);
    // Rows in another order give the same bytes (the core sorts).
    const c = reweight({
      angleDays60: [...rows].reverse(),
      devPrior: prior(),
      current: EQUAL,
      config,
      prng: scopedPrng(reweightScope("ASX", "2026-W10")),
    });
    expect(c.weightsHash).toBe(a.weightsHash);
  });

  it("a strong angle gains weight (a quarter of the way), mean weight 1, floor and cluster cap hold", () => {
    const paths = icPaths({
      angles: ANGLES,
      sessions: 80,
      sd: 0.01,
      seed: "strong",
      meanAt: (a) => (a === "A-D1-01" ? 0.08 : a === "A-D3-02" ? -0.04 : 0.02),
    });
    const rows = rowsOf(paths, DATES, 0, 80, [1, 20]);
    const config = learnConfig({ replicates: 300 }, { relaxed: true });
    const r = reweight({
      angleDays60: rows,
      devPrior: prior(),
      current: EQUAL,
      config,
      prng: scopedPrng("s"),
    });
    expect(r.changed).toBe(true);
    expect(r.evidence["A-D1-01"]!.finding).toBe("up");
    expect(r.evidence["A-D3-02"]!.finding).toBe("down");
    expect(r.raisedMost).toBe("A-D1-01");
    expect(r.loweredMost).toBe("A-D3-02");
    const w = Object.values(r.weights.angle);
    expect(w.reduce((s, x) => s + x, 0) / w.length).toBeCloseTo(1, 5);
    for (const x of w) expect(x).toBeGreaterThanOrEqual(config.weightFloor - 1e-6);
    const cw = Object.values(r.weights.cluster);
    const total = cw.reduce((s, x) => s + x, 0);
    for (const x of cw) expect(x / total).toBeLessThanOrEqual(config.clusterWeightMax + 1e-6);
    // trust region: before the mean-1 rescale the raise is at most maxStep of the way to the target.
    expect(r.weights.angle["A-D1-01"]!).toBeLessThan(2);
    expect(r.words[0]).toContain("more weight to 'angle 1'");
    expect(r.words[0]).toMatch(/less to .*'angle 6'/);
    expect(r.maxMove).toBeGreaterThan(0);
  });

  it("thin angles (too few nights, or results season only) keep their weight; band → no change", () => {
    const config = learnConfig({ replicates: 200 }, { relaxed: true });
    const fewRows = ANGLES.flatMap((a) => DATES.slice(0, 10).map((d) => row(d, a, 20, 0.2)));
    const few = reweight({
      angleDays60: fewRows,
      devPrior: prior(),
      current: EQUAL,
      config,
      prng: scopedPrng("t"),
    });
    expect(Object.values(few.evidence).every((e) => e.thin)).toBe(true);
    expect(few.changed).toBe(false);
    expect(few.weights).toEqual(EQUAL);
    expect(few.words[0]).toContain("no weight moved");
    const season = ANGLES.flatMap((a) =>
      DATES.slice(0, 60).map((d) => row(d, a, 20, 0.2, { resultsSeason: 1 })),
    );
    const s = reweight({
      angleDays60: season,
      devPrior: prior(),
      current: EQUAL,
      config,
      prng: scopedPrng("t"),
    });
    expect(Object.values(s.evidence).every((e) => e.thin)).toBe(true);
    expect(s.changed).toBe(false);
  });

  it("missing or bad current weights default to 1; an infeasible cluster cap keeps clusters equal", () => {
    const two: DevPrior = {
      "A-D1-01": { devIc: 0.03, cluster: "momentum", name: "a" },
      "A-D2-01": { devIc: 0.03, cluster: "liquidity", name: "b" },
    };
    const config = learnConfig({ replicates: 200 }, { relaxed: true });
    const rows = [
      ...DATES.slice(0, 60).map((d, i) => row(d, "A-D1-01", 20, 0.1 + (i % 3) * 0.01)),
      ...DATES.slice(0, 60).map((d, i) => row(d, "A-D2-01", 20, -0.05 + (i % 3) * 0.01)),
    ];
    const r = reweight({
      angleDays60: rows,
      devPrior: two,
      current: { angle: { "A-D1-01": Number.NaN }, cluster: {} },
      config,
      prng: scopedPrng("two"),
    });
    expect(r.clusterCapInfeasible).toBe(true);
    expect(r.weights.cluster).toEqual({ liquidity: 1, momentum: 1 });
    expect(r.evidence["A-D1-01"]!.from).toBe(1);
    expect(r.changed).toBe(true);
  });

  it("every angle non-positive: the targets carry no information and the weights hold", () => {
    const config = learnConfig({ replicates: 200 }, { relaxed: true });
    const rows = ANGLES.flatMap((a) =>
      DATES.slice(0, 60).map((d, i) => row(d, a, 20, -0.2 + (i % 2) * 0.001)),
    );
    const r = reweight({
      angleDays60: rows,
      devPrior: prior(0),
      current: EQUAL,
      config,
      prng: scopedPrng("neg"),
    });
    expect(r.changed).toBe(false);
  });

  it("placebo: deterministic per week scope, flips signs, words carry the chance line", () => {
    const paths = icPaths({
      angles: ANGLES,
      sessions: 80,
      sd: 0.01,
      seed: "pl",
      meanAt: (a) => (a === "A-D1-01" ? 0.06 : 0.01),
    });
    const rows = rowsOf(paths, DATES, 0, 80, [20]);
    const config = learnConfig({ replicates: 200 }, { relaxed: true });
    const real = reweight({
      angleDays60: rows,
      devPrior: prior(),
      current: EQUAL,
      config,
      prng: scopedPrng("r"),
    });
    const twin = () =>
      placebo({
        angleDays60: rows,
        devPrior: prior(),
        current: EQUAL,
        config,
        prng: scopedPrng(placeboScope("ASX", "2026-W10")),
      });
    expect(twin().weightsHash).toBe(twin().weightsHash);
    expect(typeof withinChance(real, twin())).toBe("boolean");
    const words = weeklyWords(real, twin(), prior(), config);
    expect(words).toContain("coin flips");
    expect(words).toContain("Weekly re-weighting");
    const nullRows = rows.map((r) => ({ ...r, ic: r.ic === null ? null : 0 }));
    const z = placebo({
      angleDays60: [...nullRows, row(DATES[0]!, "A-D1-01", 20, null)],
      devPrior: prior(),
      current: EQUAL,
      config,
      prng: scopedPrng("z"),
    });
    expect(z.changed).toBe(false);
  });

  // LRN-AT-4. 250 sessions (≈ one trading year) of pure-noise scorecards (daily IC sd 0.08, the realistic
  // level of B.1; 20-session IC = overlapping means), a weekly reweight from session 79 on a 60-session
  // window, 35 weeks a seed. Seeds: 200 as the design asks. The bootstrap only confirms the sign of a BH
  // rejection (the p is the analytic overlap t-test), so 199 replicates (production: 2,000) do not
  // touch the rate being measured and keep the test fast.
  // "Per angle" counts the generations in which that angle's own weight moved on a finding about it
  // (a mean-1 rescale moving the others is a common factor that leaves every score unchanged).
  it("LRN-AT-4: pure noise → at most 2 generations a year per angle in expectation (200 seeds)", () => {
    const config = learnConfig({ replicates: 199 }, { relaxed: true });
    const SEEDS = 200;
    const SESSIONS = 250;
    const band = config.bandPp / 100;
    let angleMoves = 0;
    let generations = 0;
    let weeks = 0;
    let within = 0;
    for (let s = 0; s < SEEDS; s += 1) {
      const paths = icPaths({
        angles: ANGLES,
        sessions: SESSIONS,
        sd: 0.08,
        seed: `at4:${s}`,
        meanAt: () => 0,
      });
      const all = rowsOf(paths, DATES, 0, SESSIONS, [20]);
      let current = EQUAL;
      for (let t = 79; t < SESSIONS; t += 5) {
        const win = all.filter((r) => r.d >= DATES[t - 59]! && r.d <= DATES[t]!);
        const r = reweight({
          angleDays60: win,
          devPrior: prior(),
          current,
          config,
          prng: scopedPrng(`at4:${s}:${t}`),
        });
        weeks += 1;
        if (!r.changed) {
          within += 1; // no move is inside any placebo band
          continue;
        }
        generations += 1;
        for (const a of ANGLES) {
          const e = r.evidence[a]!;
          if (e.finding !== null && Math.abs(e.to - e.from) > band) angleMoves += 1;
        }
        const twin = placebo({
          angleDays60: win,
          devPrior: prior(),
          current,
          config,
          prng: scopedPrng(placeboScope("ASX", `${s}:${t}`)),
        });
        if (withinChance(r, twin)) within += 1;
        current = r.weights;
      }
    }
    expect(weeks).toBe(SEEDS * 35);
    const perAngleYear = angleMoves / (SEEDS * ANGLES.length);
    const generationsPerYear = generations / SEEDS;
    expect(perAngleYear).toBeLessThanOrEqual(2);
    // The learner as a whole stays far from weekly churn (35 weekly runs a year) ...
    expect(generationsPerYear).toBeLessThanOrEqual(2);
    // ... and the placebo band contains the real change in ≥ 90 % of the weeks (C.12 AT-4).
    expect(within / weeks).toBeGreaterThanOrEqual(0.9);
  });

  // LRN-AT-5, weekly half: an IC drop from 0.03 to −0.01 at session 100 halves the angle's weight within
  // 60 sessions; a rising angle gains weight only here.
  // The nightly pipeline in miniature: checkpoints every second session on the daily rows; the weekly
  // run (every fifth session) gets the angles with a fall alarm since the last run; the weekly weights
  // (not the temporary caps) are the next week's `current`.
  it("LRN-AT-5 (weekly): a drop at session 100 halves the weight within 60 sessions; a rise is raised only weekly", () => {
    const config = learnConfig({ replicates: 150 }, { relaxed: true });
    const paths = icPaths({
      angles: ANGLES,
      sessions: 200,
      sd: 0.015,
      seed: "at5w",
      meanAt: (a, t) =>
        a === "A-D2-01" && t >= 100 ? -0.01 : a === "A-D1-02" && t >= 100 ? 0.06 : 0.03,
    });
    const all = rowsOf(paths, DATES, 0, 200, [1, 20]);
    const names = Object.fromEntries(ANGLES.map((a) => [a, { name: a.toLowerCase() }]));
    let current = EQUAL;
    let alarms = new Set<string>();
    let halvedAt: number | null = null;
    let raisedAt: number | null = null;
    for (let t = 60; t < 200; t += 1) {
      if (t % 2 === 0) {
        const out = checkpoint({
          market: "ASX",
          d: DATES[t]!,
          calendar: DATES,
          angleDays120: all.filter(
            (r) => r.d >= DATES[t - 119 < 0 ? 0 : t - 119]! && r.d <= DATES[t]!,
          ),
          angles: names,
          weights: current,
          events10: [],
          compareRows: [],
          leaders: [],
          config,
        });
        for (const x of out) if (x.reason === "fall_alarm" && x.angleId) alarms.add(x.angleId);
      }
      if (t % 5 !== 4) continue;
      const win = all.filter((r) => r.d >= DATES[t - 59]! && r.d <= DATES[t]!);
      const r = reweight({
        angleDays60: win,
        devPrior: prior(),
        current,
        config,
        prng: scopedPrng(`at5w:${t}`),
        fallAlarms: [...alarms],
      });
      for (const a of alarms)
        expect(r.weights.angle[a]!).toBeLessThanOrEqual(current.angle[a]! + 0.05); // only the rescale may lift it
      alarms = new Set();
      current = r.weights;
      if (t >= 100 && halvedAt === null && current.angle["A-D2-01"]! <= 0.5) halvedAt = t;
      if (t >= 100 && raisedAt === null && current.angle["A-D1-02"]! > 1.1) raisedAt = t;
      if (t < 100) expect(current.angle["A-D2-01"]!).toBeGreaterThan(0.8);
    }
    expect(halvedAt).not.toBeNull();
    expect(halvedAt! - 100).toBeLessThanOrEqual(60);
    expect(raisedAt).not.toBeNull();
  });
});
