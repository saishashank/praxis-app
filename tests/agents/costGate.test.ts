// @vitest-environment node
// FAM-005 cost gate (M14, D-214, D-215): table, round-trip cost, exact comparison.
import { describe, expect, it } from "vitest";
import {
  costGateKey,
  costGateTable,
  costGateVerdict,
  passesCostGate,
  roundTripCost,
  type CostGateRow,
} from "@/lib/agents/costGate";
import { COST_PROFILES } from "@/lib/arena/costs";
import { cmpRat, makeRational } from "@/lib/money/rational";

const row = (n: bigint, d = 100n, v = "F1"): CostGateRow => ({
  family: "F1",
  ruleVersion: "F1.v1",
  variant: v,
  grossNum: n,
  grossDen: d,
});
const KEY = costGateKey("F1", "F1.v1", "F1");

describe("costGateTable", () => {
  it("is unmeasured below 30 rows and the exact median from 30", () => {
    const few = costGateTable(Array.from({ length: 29 }, (_, i) => row(BigInt(i))));
    expect(few.get(KEY)).toEqual({ rows: 29, median: null });
    const rows = Array.from({ length: 30 }, (_, i) => row(BigInt(i))); // 0..29 -> median 14.5/100
    const t = costGateTable(rows);
    expect(cmpRat(t.get(KEY)!.median!, makeRational(29n, 200n))).toBe(0);
  });

  it("does not depend on row order and groups by variant", () => {
    const rows = [...Array.from({ length: 30 }, (_, i) => row(BigInt(i))), row(1n, 1n, "X")];
    const a = costGateTable(rows);
    const b = costGateTable([...rows].reverse());
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect(a.get(costGateKey("F1", "F1.v1", "X"))!.median).toBeNull();
  });
});

describe("roundTripCost and the gate", () => {
  it("P5 fees alone are about 1.67 % of A$600 (spec reference)", () => {
    const c = roundTripCost(COST_PROFILES.P5, 1_000_000_000_000n);
    const pct = Number(c.num * 10_000n) / Number(c.den) / 100; // money-float-ok: test display
    expect(pct).toBeGreaterThan(1.6);
    expect(pct).toBeLessThan(4.2);
  });

  it("spec example: gross 3 %, cost 2 %, k = 2 is skipped; 4 % passes", () => {
    const cost = makeRational(2n, 100n);
    const k = makeRational(2n);
    expect(passesCostGate(makeRational(3n, 100n), cost, k)).toBe(false);
    expect(passesCostGate(makeRational(4n, 100n), cost, k)).toBe(true);
  });

  it("verdicts: missing or unmeasured passes as unmeasured", () => {
    const cost = makeRational(2n, 100n);
    const k = makeRational(2n);
    expect(costGateVerdict(undefined, "F1", "F1.v1", "F1", cost, k)).toBe("unmeasured");
    const t = costGateTable(Array.from({ length: 30 }, () => row(3n)));
    expect(costGateVerdict(t, "F1", "F1.v1", "F1", cost, k)).toBe("skip");
    expect(costGateVerdict(t, "F2", "F2.v1", "F2", cost, k)).toBe("unmeasured");
  });
});
