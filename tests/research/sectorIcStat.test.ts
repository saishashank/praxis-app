// @vitest-environment node
// M23 R1 (D-1605, D-1634, D-1656): the sector rank-IC statistic. R3 owns the panel builder and its own test
// (`sectorIc.test.ts`); this file proves the pure statistic: floor before any outcome is read, a planted IC passes,
// a null does not, degenerate months are left out.
import { describe, expect, it } from "vitest";
import {
  sectorIcLook,
  qualifyingMonths,
  type MonthEntry,
  type ReadGroup,
} from "@/lib/research/sectorIc";
import { belowInt, scopedPrng, uniform01 } from "@/lib/stats/rng";

const GROUPS = 8;
const params = {
  lineage: "zz_sector_ic",
  minMembers: 3,
  minGroupsPerMonth: 4,
  minMonths: 95,
  expectedBlockMonths: 3,
  replicates: 400,
};

function panel(months: number, members = 5): MonthEntry[] {
  return Array.from({ length: months }, (_, m) => ({
    month: m,
    groups: Array.from({ length: GROUPS }, (_, g) => ({ group: `G${g}`, members })),
  }));
}

/** signal = group rank noise; outcome = signal * edge + noise (uniform). */
function reader(edge: number, seed: string): ReadGroup {
  return (month, group) => {
    const rng = scopedPrng(`${seed}:${month}:${group}`);
    const signal = uniform01(rng);
    const noise = uniform01(rng) - 0.5;
    return { signal, outcome: signal * edge + noise };
  };
}

describe("sector rank IC look", () => {
  it("a planted edge over 120 months passes, a null over 120 months does not", () => {
    const planted = sectorIcLook(panel(120), reader(1.2, "plant"), params);
    if (planted.status !== "looked") throw new Error("expected a look");
    expect(planted.months).toBe(120);
    expect(planted.usedMonths).toBe(120);
    expect(planted.meanIc!).toBeGreaterThan(0.1);
    expect(planted.lowerIc!).toBeGreaterThan(0);
    expect(planted.verdict).toBe("PASS");

    const nul = sectorIcLook(panel(120), reader(0, "null"), params);
    if (nul.status !== "looked") throw new Error("expected a look");
    expect(nul.lowerIc!).toBeLessThan(0.05);
    expect(nul.verdict).toBe("NULL");
  });

  it("94 months is below sample and no group is ever read", () => {
    let reads = 0;
    const counting: ReadGroup = () => {
      reads += 1;
      throw new Error("an outcome was read");
    };
    const r = sectorIcLook(panel(94), counting, params);
    expect(r).toMatchObject({ status: "below_sample", months: 94, floor: 95 });
    expect(reads).toBe(0);
    // 95 reads outcomes
    expect(() => sectorIcLook(panel(95), counting, params)).toThrow("an outcome was read");
  });

  it("groups under the member floor are left out of the count: months with too few qualifying groups do not count", () => {
    const entries: MonthEntry[] = [
      ...panel(3),
      {
        month: 3,
        groups: [
          { group: "A", members: 2 },
          { group: "B", members: 9 },
          { group: "C", members: 9 },
          { group: "D", members: 9 },
          { group: "E", members: 9 },
        ],
      },
      {
        month: 4,
        groups: [
          { group: "A", members: 2 },
          { group: "B", members: 2 },
          { group: "C", members: 9 },
          { group: "D", members: 9 },
          { group: "E", members: 9 },
        ],
      },
    ];
    const q = qualifyingMonths(entries, 3, 4);
    expect(q.map((x) => x.month)).toEqual([0, 1, 2, 3]); // month 4 has only 3 qualifying groups
    expect(q[3]!.groups).toEqual(["B", "C", "D", "E"]);
  });

  it("months with a constant signal have no correlation: left out, counted, and too few left is INCONCLUSIVE (spent)", () => {
    const constant: ReadGroup = (month, group) => ({
      signal: 1,
      outcome: belowInt(scopedPrng(`c:${month}:${group}`), 100),
    });
    const r = sectorIcLook(panel(100), constant, params);
    if (r.status !== "looked") throw new Error("expected a look");
    expect(r.degenerateMonths).toBe(100);
    expect(r.usedMonths).toBe(0);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.lowerIc).toBeNull();
  });

  it("the holdout-only mean is reported, never the gate", () => {
    const r = sectorIcLook(panel(120), reader(1.2, "plant"), { ...params, holdoutFromMonth: 90 });
    if (r.status !== "looked") throw new Error("expected a look");
    expect(r.holdoutMonths).toBe(30);
    expect(r.holdoutMeanIc).not.toBeNull();
    expect(r.meanGroupsPerMonth).toBe(GROUPS);
  });

  it("deterministic for a seed", () => {
    const a = sectorIcLook(panel(100), reader(0.5, "d"), params);
    const b = sectorIcLook(panel(100), reader(0.5, "d"), params);
    expect(a).toEqual(b);
  });
});
