// @vitest-environment node
// VAL-112 wired into VAL-110 (M14 WP4, D-226, D-228): the level of (i)/(ii) follows the error budget
// when the caller passes k; without k it is the v1 fixed level; the leverage test is descriptive.
import { describe, expect, it } from "vitest";
import {
  evaluateLeverage,
  evaluateVal110,
  replicationsFor,
  type Val110Input,
} from "../../src/lib/stats/val110";
import { createLineageSplit } from "../../src/lib/stats/splits";
import { validationLevel } from "../../src/lib/stats/gates";
import {
  LINEAGE,
  PARAMS,
  accessRow,
  dailyReturns,
  makeRows,
  weekdayCalendar,
} from "../fixtures/stats/t13";

const split = createLineageSplit({
  market: "ASX",
  family: "F1",
  calendar: weekdayCalendar(2000),
  maxHoldingUpper: 120,
  primaryRows: [],
  params: PARAMS,
});
const FAST = { ...PARAMS, bootstrapReplicationsFactor: 2 };
const S = 504;

function input(over: Partial<Val110Input> = {}): Val110Input {
  return {
    runId: "run-1",
    lineageId: LINEAGE,
    ruleVersion: "1",
    variant: "primary",
    split,
    access: accessRow("validation_access", split),
    params: { ...FAST, valErrorBudgetMode: "alpha_spending", valFwerPerLineage: 0.05 },
    activeLineages: 6,
    rows: makeRows({ n: 400, S, edge: 0.02 }),
    sessionCount: S,
    block: 5,
    windowEndD: split.validation_end_d!,
    trialsOnSplit: 1,
    costInfeasible: false,
    safety: { effectiveN: 10, delta: 0.01, firstBlockD: null },
    pboWeekly: null,
    dsr: { daily: dailyReturns(500, 0.002, 0.01), variantDailySr: [], defaultSrVariance: 0.0001 },
    ...over,
  };
}

describe("VAL-110 level from the error budget", () => {
  it("k = 0 tests spent: 0.05 / 2.05; k = 3: 0.00625 / 2.00625; B follows the level", () => {
    const r0 = evaluateVal110(input({ priorTests: 0 }));
    expect(r0.level).toBeCloseTo(0.05 / 2.05, 12);
    expect(r0.B).toBe(replicationsFor(r0.level, FAST));
    const r3 = evaluateVal110(input({ priorTests: 3 }));
    expect(r3.level).toBeCloseTo(0.00625 / 2.00625, 12);
    expect(r3.B).toBeGreaterThanOrEqual(r0.B);
    for (const x of r3.results.filter((y) => y.test === "i")) {
      expect(x.level).toBeCloseTo(r3.level, 12);
    }
  });

  it("without k the level is the v1 fixed level alpha / (m L), whatever the mode", () => {
    const r = evaluateVal110(input());
    expect(r.level).toBeCloseTo(validationLevel(0.05, 20, 6), 12);
  });

  it("fixed mode ignores k", () => {
    const r = evaluateVal110(
      input({ priorTests: 5, params: { ...FAST, valErrorBudgetMode: "fixed" } }),
    );
    expect(r.level).toBeCloseTo(validationLevel(0.05, 20, 6), 12);
  });
});

describe("O-45: the leverage test is descriptive", () => {
  it("runs without an access row and keeps the level alpha / (m L)", () => {
    const r = evaluateLeverage({
      runId: "run-1",
      lineageId: LINEAGE,
      ruleVersion: "1",
      variant: "primary",
      split,
      params: FAST,
      activeLineages: 6,
      rows: makeRows({ n: 400, S: 504, edge: 0.0, netShift: 0.02 }),
      sessionCount: 504,
      block: 5,
      windowEndD: split.validation_end_d!,
    });
    expect(r.level).toBeCloseTo(0.05 / 120, 12);
    expect(r.result.test).toBe("leverage");
  });
});
