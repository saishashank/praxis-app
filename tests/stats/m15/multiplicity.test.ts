// @vitest-environment node
// BH under PRDS and the split-half sign test for the trial ledger (M15 C2; CTX-031, AT-53, D-258).
import { describe, expect, it } from "vitest";
import {
  benjaminiHochberg,
  DEFAULT_FDR_Q,
  measuredCells,
  splitHalfSign,
} from "@/lib/stats/multiplicity";

// Benjamini & Hochberg (1995), Table 1: the 15 p-values of the Neuhaus et al. (1992) study.
const BH_1995 = [
  0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.324, 0.4262, 0.5719,
  0.6528, 0.759, 1.0,
];

describe("benjaminiHochberg", () => {
  it("textbook: BH at q = 0.05 rejects the four smallest of the BH (1995) list", () => {
    const r = benjaminiHochberg(BH_1995, 0.05);
    expect(r.k).toBe(4);
    expect(r.threshold).toBe(0.0095);
    expect(r.rejected.slice(0, 4)).toEqual([true, true, true, true]);
    expect(r.rejected.slice(4).every((x) => !x)).toBe(true);
    expect(r.dependence).toBe("prds");
    // adjusted p_(4) = min over j >= 4 of 15 p_(j) / j; 15 × 0.0095 / 4 = 0.035625 is the minimum.
    expect(r.adjusted[3]).toBeCloseTo(0.035625, 10);
    // adjusted values are monotone in the sorted order and capped at 1
    for (let i = 1; i < r.adjusted.length; i += 1)
      expect(r.adjusted[i]!).toBeGreaterThanOrEqual(r.adjusted[i - 1]!);
    expect(r.adjusted[14]).toBe(1);
  });

  it("textbook: BY (arbitrary dependence) at q = 0.05 rejects three", () => {
    // c = H_15 = 3.3182; p_(4) = 0.0095 > 4 × 0.05 / (15 × 3.3182) = 0.00402.
    const r = benjaminiHochberg(BH_1995, 0.05, "arbitrary");
    expect(r.k).toBe(3);
    expect(r.dependence).toBe("arbitrary");
  });

  it("the ledger default is q = 0.10 under PRDS and keeps input order", () => {
    expect(DEFAULT_FDR_Q).toBe(0.1);
    const shuffled = [0.5, 0.0001, 0.03, 0.0004];
    const r = benjaminiHochberg(shuffled);
    expect(r.rejected).toEqual([false, true, true, true]);
    expect(r.k).toBe(3);
  });

  it("rejects nothing when every p is large and validates inputs", () => {
    const r = benjaminiHochberg([0.5, 0.6, 0.7]);
    expect(r.k).toBe(0);
    expect(r.threshold).toBe(0);
    expect(() => benjaminiHochberg([1.5])).toThrow(RangeError);
    expect(() => benjaminiHochberg([0.5], 0)).toThrow(RangeError);
    expect(benjaminiHochberg([]).k).toBe(0);
  });
});

describe("split-half sign agreement", () => {
  it("needs both halves to carry the expected sign", () => {
    expect(splitHalfSign(0.03, 0.01)).toBe(true);
    expect(splitHalfSign(0.03, -0.01)).toBe(false);
    expect(splitHalfSign(-0.03, -0.01, -1)).toBe(true);
    expect(splitHalfSign(-0.03, -0.01, 1)).toBe(false);
    expect(splitHalfSign(0, 0.01)).toBe(false);
    expect(splitHalfSign(NaN, 0.01)).toBe(false);
  });

  it("measured = BH-rejected and sign-agreeing", () => {
    const r = measuredCells(
      [
        { id: "a", p: 0.001, firstHalf: 0.05, secondHalf: 0.04 },
        { id: "b", p: 0.002, firstHalf: 0.05, secondHalf: -0.04 },
        { id: "c", p: 0.9, firstHalf: 0.05, secondHalf: 0.04 },
        { id: "d", p: 0.001, firstHalf: -0.05, secondHalf: -0.04, orientation: -1 },
      ],
      0.1,
    );
    expect(r.cells.map((c) => c.measured)).toEqual([true, false, false, true]);
    expect(r.cells[1]!.bhRejected).toBe(true);
    expect(r.cells[1]!.signAgrees).toBe(false);
    expect(r.cells[2]!.bhRejected).toBe(false);
    expect(r.bh.k).toBe(3);
  });
});
