// @vitest-environment node
// Known-answer tests for the competing-risk cumulative incidence (M4 T14; ARN-071, ARN-053): the
// Aalen-Johansen estimator on small hand-computed cohorts (ties, censoring), its delta-method
// variance, the Wilson proportions on non-overlapping cohorts and the seeded block bootstrap.
import { describe, expect, it } from "vitest";
import {
  aalenJohansen,
  cifBootstrap,
  cifProportions,
  nonOverlapping,
  type Cause,
  type CifObservation,
  type ResolvedCohort,
} from "@/lib/replay/cif";
import { effectiveN } from "@/lib/arena/cohort";

const obs = (time: number, cause: Cause | null): CifObservation => ({ time, cause });
const near = (a: number, b: number, tol = 1e-12): void => {
  expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(tol);
};

describe("Aalen-Johansen: hand-computed cases", () => {
  // n = 6: t=1 target + bust (a tie of two causes), t=2 censored, t=3 target twice, t=4 stalled.
  //   t=1: n=6 d=2 -> F_target = F_bust = 1/6, S = 2/3
  //   t=3: n=3 d=2 -> F_target += 2/3 * 2/3 = 4/9 (= 11/18), S = 2/9
  //   t=4: n=1 d=1 -> F_stalled = 2/9, S = 0
  const sample = [
    obs(1, "target"),
    obs(1, "bust"),
    obs(2, null),
    obs(3, "target"),
    obs(3, "target"),
    obs(4, "stalled"),
  ];
  const est = aalenJohansen(sample, [1, 2, 3, 4]);

  it("point estimates with a tie of causes, a censoring and the sum of CIFs + survival = 1", () => {
    near(est[0]!.cif.target, 1 / 6);
    near(est[0]!.cif.bust, 1 / 6);
    near(est[1]!.cif.target, 1 / 6); // a censoring is not an event
    near(est[2]!.cif.target, 11 / 18);
    near(est[2]!.cif.bust, 1 / 6);
    near(est[3]!.cif.stalled, 2 / 9);
    near(est[3]!.cif.timeout, 0);
    for (const e of est) {
      const total = e.cif.target + e.cif.bust + e.cif.stalled + e.cif.timeout + e.survival;
      near(total, 1);
    }
    expect(est[3]!.censored).toBe(1);
    expect(est[2]!.events).toEqual({ target: 3, bust: 1, stalled: 0, timeout: 0 });
  });

  it("delta-method variance: CIF_target(1) = 5/216 and CIF_target(3) = 1/24 (hand derivation)", () => {
    near(est[0]!.se.target, Math.sqrt(5 / 216));
    near(est[2]!.se.target, Math.sqrt(1 / 24));
  });

  it("without censoring the CIF is a binomial proportion with variance p (1 - p) / n", () => {
    // A at 1, B at 2, A at 3: F_A(3) = 2/3, variance (2/3)(1/3)/3 = 2/27
    const e = aalenJohansen([obs(1, "target"), obs(2, "bust"), obs(3, "target")], [3])[0]!;
    near(e.cif.target, 2 / 3);
    near(e.se.target * e.se.target, 2 / 27);
    near(e.cif.bust, 1 / 3);
    near(e.se.bust * e.se.bust, 2 / 27);
  });

  it("a censoring at the same time as an event is still at risk for that event", () => {
    // (2 target), (2 censored), (3 bust): t=2 n=3 -> F_target = 1/3; t=3 n=1 -> F_bust = 2/3 * 1
    const e = aalenJohansen([obs(2, "target"), obs(2, null), obs(3, "bust")], [3])[0]!;
    near(e.cif.target, 1 / 3);
    near(e.cif.bust, 2 / 3);
  });

  it("only censored cohorts: every CIF is 0 and survival 1", () => {
    const e = aalenJohansen([obs(5, null), obs(9, null)], [63, 252])[1]!;
    expect(e.cif).toEqual({ target: 0, bust: 0, stalled: 0, timeout: 0 });
    expect(e.survival).toBe(1);
    expect(e.se.target).toBe(0);
  });

  it("events after the horizon are not counted; the horizon list is free", () => {
    const e = aalenJohansen([obs(10, "target"), obs(100, "timeout"), obs(300, "bust")], [63, 252]);
    near(e[0]!.cif.target, 1 / 3);
    near(e[0]!.cif.timeout, 0);
    near(e[1]!.cif.timeout, 1 / 3);
    near(e[1]!.cif.bust, 0);
  });
});

const cohort = (
  id: string,
  startD: string,
  ttd: number,
  kind: Cause | null,
  terminalD: string | null,
): ResolvedCohort => ({
  id,
  executionId: "E01",
  startD,
  terminalD,
  terminalKind: kind,
  ttdSessions: kind === null ? null : ttd,
});

describe("proportions on resolved non-overlapping cohorts", () => {
  const cohorts = [
    cohort("a", "2030-01-02", 40, "target", "2030-02-27"),
    cohort("b", "2030-01-09", 30, "bust", "2030-02-20"), // overlaps a: not counted
    cohort("c", "2030-03-01", 100, "timeout", "2030-07-19"),
    cohort("d", "2030-08-01", 10, "stalled", "2030-08-14"),
    cohort("e", "2030-09-02", 0, null, null), // unresolved: never counted
  ];

  it("uses the M3 effective-N selection (greedy by start, actual outcome intervals)", () => {
    const counted = nonOverlapping(cohorts).map((c) => c.id);
    expect(counted).toEqual(["a", "c", "d"]);
    expect(counted).toEqual([...effectiveN(cohorts).counted]);
  });

  it("CIF = share of the effective cohorts that ended in a cause by the horizon, Wilson 90 %", () => {
    const [h63, h126] = cifProportions(cohorts, [63, 126]);
    expect(h63!.n).toBe(3);
    expect(h63!.counts).toEqual({ target: 1, bust: 0, stalled: 1, timeout: 0 });
    expect(h126!.counts).toEqual({ target: 1, bust: 0, stalled: 1, timeout: 1 });
    near(h126!.cif.timeout, 1 / 3);
    // Wilson interval for 1 of 3 at 90 %: z = 1.6448536269514722
    const z = 1.6448536269514722;
    const n = 3;
    const p = 1 / 3;
    const denom = 1 + (z * z) / n;
    const centre = (p + (z * z) / (2 * n)) / denom;
    const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
    near(h126!.interval.timeout.lower, centre - half, 1e-9);
    near(h126!.interval.timeout.upper, centre + half, 1e-9);
  });

  it("no resolved cohort: n = 0 and a vacuous interval", () => {
    const [h] = cifProportions([cohort("e", "2030-09-02", 0, null, null)], [63]);
    expect(h!.n).toBe(0);
    expect(h!.interval.target).toEqual({ lower: 0, upper: 1 });
  });
});

describe("bootstrap intervals", () => {
  const sample: CifObservation[] = [];
  for (let i = 0; i < 40; i += 1) {
    const cause: Cause =
      i % 4 === 0 ? "target" : i % 4 === 1 ? "bust" : i % 4 === 2 ? "stalled" : "timeout";
    sample.push(obs(20 + i, i % 7 === 6 ? null : cause));
  }

  it("is a seeded stream: the same scope gives the same intervals, another scope other ones", () => {
    const a = cifBootstrap(sample, [63], 5, 300, "cifboot:E01");
    const b = cifBootstrap(sample, [63], 5, 300, "cifboot:E01");
    const c = cifBootstrap(sample, [63], 5, 300, "cifboot:E02");
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("brackets the point estimate and stays inside [0, 1]", () => {
    const [h] = cifBootstrap(sample, [63], 5, 600, "cifboot:x");
    const point = aalenJohansen(sample, [63])[0]!;
    for (const cause of ["target", "bust", "stalled", "timeout"] as const) {
      const i = h!.interval[cause];
      expect(i.lower).toBeLessThanOrEqual(point.cif[cause] + 1e-9);
      expect(i.upper).toBeGreaterThanOrEqual(point.cif[cause] - 1e-9);
      expect(i.lower).toBeGreaterThanOrEqual(0);
      expect(i.upper).toBeLessThanOrEqual(1);
    }
  });

  it("refuses an empty sample and bad block or replicate counts", () => {
    expect(() => cifBootstrap([], [63], 5, 10, "s")).toThrow(RangeError);
    expect(() => cifBootstrap(sample, [63], 0, 10, "s")).toThrow(RangeError);
    expect(() => cifBootstrap(sample, [63], 5, 0, "s")).toThrow(RangeError);
  });
});
