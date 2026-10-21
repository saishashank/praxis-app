// @vitest-environment node
// VAL-110 / ARN-087 evaluator, criteria (i)-(vi) one by one (M4 T13; design 4.8; decisions 24, 25, 27).
import { describe, expect, it } from "vitest";
import {
  evaluateHoldout,
  evaluateLeverage,
  evaluateVal110,
  replicationsFor,
  signalRowFromEntry,
  type Val110Input,
} from "../../src/lib/stats/val110";
import { createLineageSplit } from "../../src/lib/stats/splits";
import { bootstrapReplications, validationLevel } from "../../src/lib/stats/gates";
import {
  LINEAGE,
  PARAMS,
  accessRow,
  dailyReturns,
  makeRows,
  weekdayCalendar,
  weeklyMatrix,
} from "../fixtures/stats/t13";

const calendar = weekdayCalendar(2000);
const split = createLineageSplit({
  market: "ASX",
  family: "F1",
  calendar,
  maxHoldingUpper: 120,
  primaryRows: [],
  params: PARAMS,
});
// FAST keeps the test suite quick: m = 2 gives level 0.05 / 12 and B = 1,000. The default parameters
// (level 0.000417, B = 48,000) are exercised explicitly in the first block and in the leverage test.
const FAST = { ...PARAMS, trialBudgetPerLineage: 2, bootstrapReplicationsFactor: 2 };
const S = 504;
const BLOCK = 5;

function base(over: Partial<Val110Input> = {}): Val110Input {
  return {
    runId: "run-1",
    lineageId: LINEAGE,
    ruleVersion: "1",
    variant: "primary",
    split,
    access: accessRow("validation_access", split),
    params: FAST,
    activeLineages: 6,
    rows: makeRows({ n: 400, S, edge: 0.02 }),
    sessionCount: S,
    block: BLOCK,
    windowEndD: split.validation_end_d!,
    trialsOnSplit: 1,
    costInfeasible: false,
    safety: { effectiveN: 10, delta: 0.01, firstBlockD: null },
    pboWeekly: null,
    dsr: { daily: dailyReturns(500, 0.002, 0.01), variantDailySr: [], defaultSrVariance: 0.0001 },
    ...over,
  };
}

describe("levels and replications (decision 24)", () => {
  it("level = 0.05 / (20 x 6) and B = 48,000 at the default", () => {
    const r = evaluateVal110(base({ params: PARAMS }));
    expect(r.level).toBeCloseTo(0.05 / 120, 12);
    expect(r.B).toBe(48000);
    expect(r.L).toBe(6);
    expect(r.m).toBe(20);
    expect(replicationsFor(r.level, PARAMS)).toBe(bootstrapReplications(r.level));
  });
  it("L follows the active lineages above the floor; every result stores level, B, n, blocks, L, m", () => {
    const r = evaluateVal110(
      base({ params: PARAMS, activeLineages: 8, rows: makeRows({ n: 120, S, edge: 0.02 }) }),
    );
    expect(r.L).toBe(8);
    expect(r.level).toBeCloseTo(validationLevel(0.05, 20, 8), 12);
    for (const x of r.results.filter((y) => y.test === "i")) {
      expect(x.L_used).toBe(8);
      expect(x.m_used).toBe(20);
      expect(x.level).toBeCloseTo(r.level, 12);
      expect(x.B).toBe(r.B);
      expect(x.blocks).toBe(Math.floor(S / BLOCK));
    }
  });
});

describe("the access row is written before the test reads the rows", () => {
  it("refuses a missing, wrong-kind, wrong-lineage or wrong-split access row", () => {
    expect(() => evaluateVal110(base({ access: accessRow("holdout_access", split) }))).toThrow(
      /trial_ledger/,
    );
    expect(() =>
      evaluateVal110(
        base({ access: accessRow("validation_access", split, { lineage_id: "ASX:F2" }) }),
      ),
    ).toThrow(/trial_ledger/);
    expect(() =>
      evaluateVal110(base({ access: accessRow("validation_access", { version: 9 }) })),
    ).toThrow(/trial_ledger/);
  });
});

describe("(i) excess over matched controls and the absolute gate", () => {
  it("passes with a real edge: p <= level, absolute lower bound > 0, MDE reported", () => {
    const r = evaluateVal110(base());
    expect(r.checks.i).toBe("pass");
    expect(r.absoluteGate).toBe(true);
    expect(r.mde).toBeGreaterThan(0);
    const ex = r.results.find((x) => x.id.endsWith(":i:excess"))!;
    expect(ex.p!).toBeLessThanOrEqual(r.level);
    expect(ex.test).toBe("i");
    expect(ex.mde).toBe(r.mde);
    const abs = r.results.find((x) => x.id.endsWith(":i:absolute"))!;
    expect(abs.lower!).toBeGreaterThan(0);
    expect(r.excessInterval!.lower).toBeGreaterThan(0);
  });

  it("fails with no edge (null excess): p above the level", () => {
    const r = evaluateVal110(base({ rows: makeRows({ n: 400, S, edge: 0 }) }));
    expect(r.checks.i).toBe("fail");
    expect(r.results.find((x) => x.id.endsWith(":i:excess"))!.p!).toBeGreaterThan(r.level);
  });

  it("fails the absolute gate when the controls lose more than the rows (excess > 0, net lower bound <= 0)", () => {
    const r = evaluateVal110(
      base({ rows: makeRows({ n: 400, S, edge: 0.02, netShift: -0.05, stressCost: 0.005 }) }),
    );
    const ex = r.results.find((x) => x.id.endsWith(":i:excess"))!;
    expect(ex.p!).toBeLessThanOrEqual(r.level);
    expect(r.absoluteGate).toBe(false);
    expect(r.checks.i).toBe("fail");
    expect(r.passes).toBe(false);
  });

  it("80 trades -> insufficient evidence with a reachable date, and no bootstrap is run", () => {
    const r = evaluateVal110(base({ rows: makeRows({ n: 80, S, edge: 0.05 }) }));
    expect(r.insufficient).toBe(true);
    expect(r.checks.i).toBe("insufficient");
    expect(r.passes).toBe(false);
    const x = r.results.find((y) => y.test === "i")!;
    expect(x.outcome).toBe("insufficient evidence");
    expect(x.p).toBeNull();
    expect(x.B).toBe(0);
    expect(x.reachable_d!).toBeTruthy();
    expect(x.reachable_d! > split.validation_end_d!).toBe(true);
  });

  it("a window under 15 blocks -> insufficient independent blocks with a reachable date", () => {
    const r = evaluateVal110(
      base({ rows: makeRows({ n: 200, S: 60, edge: 0.05 }), sessionCount: 60, block: BLOCK }),
    );
    expect(r.checks.i).toBe("insufficient");
    const x = r.results.find((y) => y.test === "i")!;
    expect(x.outcome).toBe("insufficient independent blocks");
    expect(x.blocks).toBe(12);
    expect(x.reachable_d).not.toBeNull();
  });

  it("rows without controls are left out of the excess test", () => {
    const rows = [...makeRows({ n: 400, S, edge: 0.02 })];
    const withNull = rows.map((r, i) => (i % 2 === 0 ? { ...r, excess: null } : r));
    const r = evaluateVal110(base({ rows: withNull }));
    expect(r.results.find((x) => x.id.endsWith(":i:excess"))!.n).toBe(200);
  });
});

describe("(ii) challenger against the incumbent", () => {
  const mk = (prefix: string, edge: number, n = 300) =>
    makeRows({ n, S, edge, seed: prefix }).map((r, i) => ({
      key: `k${i}`,
      entrySession: r.entrySession,
      excess: r.excess as number,
    }));
  it("not applicable without a challenger", () => {
    expect(evaluateVal110(base()).checks.ii).toBe("n/a");
  });
  it("passes when the challenger's per-row excess beats the incumbent's", () => {
    const r = evaluateVal110(
      base({ challenger: { challengerRows: mk("c", 0.06), incumbentRows: mk("c", 0.0) } }),
    );
    expect(r.checks.ii).toBe("pass");
    expect(r.results.some((x) => x.test === "ii")).toBe(true);
  });
  it("fails when they are alike", () => {
    const r = evaluateVal110(
      base({ challenger: { challengerRows: mk("c", 0.02), incumbentRows: mk("c", 0.02) } }),
    );
    expect(r.checks.ii).toBe("fail");
    expect(r.passes).toBe(false);
  });
  it("counts rows present in only one version", () => {
    const only = mk("c", 0.03, 300);
    const r = evaluateVal110(base({ challenger: { challengerRows: only, incumbentRows: [] } }));
    expect(r.results.find((x) => x.test === "ii")!.n).toBe(300);
  });
});

describe("(iii) safety check", () => {
  const safety = (effectiveN: number, delta: number | null) => ({
    effectiveN,
    delta,
    firstBlockD: "2027-03-01",
  });
  it("blocks only when effective N >= 8 and delta > tolerance", () => {
    const r = evaluateVal110(base({ safety: safety(8, 0.06) }));
    expect(r.checks.iii).toBe("blocks");
    expect(r.passes).toBe(false);
  });
  it("is descriptive below effective N 8 (with the first-block date)", () => {
    const r = evaluateVal110(base({ safety: safety(7, 0.3) }));
    expect(r.checks.iii).toBe("descriptive");
    expect(r.passes).toBe(true);
    expect(r.results.find((x) => x.test === "iii")!.reachable_d).toBe("2027-03-01");
  });
  it("does not block at exactly the tolerance (point estimate must exceed +5 pp)", () => {
    expect(evaluateVal110(base({ safety: safety(12, 0.05) })).checks.iii).toBe("pass");
  });
  it("is descriptive when not estimable or absent", () => {
    expect(evaluateVal110(base({ safety: safety(12, null) })).checks.iii).toBe("descriptive");
    expect(evaluateVal110(base({ safety: null })).checks.iii).toBe("descriptive");
  });
});

describe("(iv) stress and (iv-b) cost-feasibility", () => {
  it("(iv) fails when the stress mean is not positive", () => {
    const rows = makeRows({ n: 400, S, edge: 0.02, netShift: 0.01, stressCost: 0.05 });
    const r = evaluateVal110(base({ rows }));
    expect(r.checks.iv).toBe("fail");
    expect(r.passes).toBe(false);
  });
  it("(iv) passes on a positive stress point estimate", () => {
    expect(evaluateVal110(base()).checks.iv).toBe("pass");
  });
  it("(iv-b) blocks when the row is cost-infeasible", () => {
    const r = evaluateVal110(base({ costInfeasible: true }));
    expect(r.checks.ivb).toBe("fail");
    expect(r.checks.i).toBe("pass");
    expect(r.passes).toBe(false);
    expect(r.results.find((x) => x.test === "iv-b")!.outcome).toBe("cost-infeasible");
  });
});

describe("(v) PBO", () => {
  it("is n/a below 5 tested variants and does not block", () => {
    const r = evaluateVal110(base({ pboWeekly: weeklyMatrix(100, 4, 0.01) }));
    expect(r.checks.v).toBe("n/a");
    expect(r.passes).toBe(true);
    expect(r.results.find((x) => x.test === "v")!.outcome).toMatch(/^n\/a/);
  });
  it("passes when the in-sample best stays best out of sample (PBO <= 0.2)", () => {
    const r = evaluateVal110(base({ pboWeekly: weeklyMatrix(100, 6, 0.02) }));
    expect(r.checks.v).toBe("pass");
    expect(r.results.find((x) => x.test === "v")!.stat!).toBeLessThanOrEqual(0.2);
  });
  it("fails for equal variants (PBO well above 0.2)", () => {
    const r = evaluateVal110(base({ pboWeekly: weeklyMatrix(100, 6, 0) }));
    expect(r.checks.v).toBe("fail");
    expect(r.passes).toBe(false);
  });
});

describe("(vi) Deflated Sharpe Ratio", () => {
  it("passes for a strong series with a single trial (SR0 = 0)", () => {
    const r = evaluateVal110(base());
    expect(r.checks.vi).toBe("pass");
    const x = r.results.find((y) => y.test === "vi")!;
    expect(x.lower).toBe(0); // SR0
    expect(x.stat!).toBeGreaterThanOrEqual(0.95);
  });
  it("is deflated by many trials: fails when SR does not clear the expected maximum", () => {
    const r = evaluateVal110(
      base({
        trialsOnSplit: 20,
        dsr: {
          daily: dailyReturns(500, 0.0004, 0.01),
          variantDailySr: [0.0, 0.05, 0.1, 0.15, 0.2, 0.25],
          defaultSrVariance: 0.0001,
        },
      }),
    );
    expect(r.checks.vi).toBe("fail");
    expect(r.results.find((y) => y.test === "vi")!.lower!).toBeGreaterThan(0);
  });
  it("uses the frozen default variance below 5 variants and the variants' variance from 5", () => {
    const few = evaluateVal110(
      base({
        trialsOnSplit: 20,
        dsr: {
          daily: dailyReturns(500, 0.002, 0.01),
          variantDailySr: [0.1, 0.2],
          defaultSrVariance: 0.04,
        },
      }),
    );
    const many = evaluateVal110(
      base({
        trialsOnSplit: 20,
        dsr: {
          daily: dailyReturns(500, 0.002, 0.01),
          variantDailySr: [0.1, 0.1, 0.1, 0.1, 0.1],
          defaultSrVariance: 0.04,
        },
      }),
    );
    const sr0 = (r: typeof few) => r.results.find((y) => y.test === "vi")!.lower!;
    expect(sr0(few)).toBeGreaterThan(sr0(many));
    expect(sr0(many)).toBe(0);
  });
  it("is insufficient without daily returns", () => {
    const r = evaluateVal110(base({ dsr: null }));
    expect(r.checks.vi).toBe("insufficient");
    expect(r.passes).toBe(false);
  });
});

describe("overall result", () => {
  it("passes only when every criterion passes", () => {
    const r = evaluateVal110(base({ pboWeekly: weeklyMatrix(100, 6, 0.02) }));
    expect(r.checks).toEqual({
      i: "pass",
      ii: "n/a",
      iii: "pass",
      iv: "pass",
      ivb: "pass",
      v: "pass",
      vi: "pass",
    });
    expect(r.passes).toBe(true);
    expect(new Set(r.results.map((x) => x.id)).size).toBe(r.results.length);
  });
  it("every record satisfies the validation_result column constraints", () => {
    const r = evaluateVal110(base({ pboWeekly: weeklyMatrix(100, 6, 0.02) }));
    for (const x of r.results) {
      expect(x.level).toBeGreaterThan(0);
      expect(x.level).toBeLessThanOrEqual(1);
      expect(Number.isInteger(x.B) && x.B >= 0).toBe(true);
      expect(Number.isInteger(x.n) && x.n >= 0).toBe(true);
      expect(Number.isInteger(x.blocks) && x.blocks >= 0).toBe(true);
      expect(x.L_used).toBeGreaterThanOrEqual(1);
      expect(x.m_used).toBeGreaterThanOrEqual(1);
      expect(x.outcome.length).toBeGreaterThan(0);
      if (x.p !== null) expect(x.p >= 0 && x.p <= 1).toBe(true);
    }
  });
  it("is deterministic: the same input gives byte-identical output", () => {
    const a = JSON.stringify(evaluateVal110(base({ pboWeekly: weeklyMatrix(100, 6, 0.02) })));
    const b = JSON.stringify(evaluateVal110(base({ pboWeekly: weeklyMatrix(100, 6, 0.02) })));
    expect(a).toBe(b);
  });
  it("a different master seed gives a different bootstrap standard error", () => {
    const rows = makeRows({ n: 400, S, edge: 0.005 });
    const a = evaluateVal110(base({ rows }));
    const b = evaluateVal110(base({ rows, masterSeed: 7n }));
    expect(a.results[0]!.stat).not.toBe(b.results[0]!.stat);
  });
});

describe("holdout confirmation and leverage", () => {
  const single = (rows: ReturnType<typeof makeRows>) => ({
    runId: "run-1",
    lineageId: LINEAGE,
    ruleVersion: "1",
    variant: "primary",
    split,
    params: PARAMS,
    activeLineages: 6,
    rows,
    sessionCount: 378,
    block: BLOCK,
    windowEndD: split.holdout_end_d!,
  });
  it("confirms (i) at alpha / L with the absolute gate", () => {
    const r = evaluateHoldout({
      ...single(makeRows({ n: 300, S: 378, edge: 0.02 })),
      access: accessRow("holdout_access", split),
    });
    expect(r.level).toBeCloseTo(0.05 / 6, 12);
    expect(r.B).toBe(2400);
    expect(r.pass).toBe(true);
    expect(r.result.test).toBe("holdout");
    expect(r.mde).toBeGreaterThan(0);
  });
  it("does not confirm a null edge", () => {
    const r = evaluateHoldout({
      ...single(makeRows({ n: 300, S: 378, edge: 0 })),
      access: accessRow("holdout_access", split),
    });
    expect(r.pass).toBe(false);
  });
  it("is insufficient under 100 rows", () => {
    const r = evaluateHoldout({
      ...single(makeRows({ n: 60, S: 378, edge: 0.05 })),
      access: accessRow("holdout_access", split),
    });
    expect(r.insufficient).toBe(true);
    expect(r.pass).toBe(false);
  });
  it("needs a holdout_access row", () => {
    expect(() =>
      evaluateHoldout({
        ...single(makeRows({ n: 300, S: 378, edge: 0.02 })),
        access: accessRow("validation_access", split),
      }),
    ).toThrow(/trial_ledger/);
  });
  it("leverage tests the sleeve's net expectancy at alpha / (m L)", () => {
    const r = evaluateLeverage({
      ...single(makeRows({ n: 400, S: 504, edge: 0.0, netShift: 0.02 })),
      sessionCount: 504,
      access: accessRow("validation_access", split),
    });
    expect(r.level).toBeCloseTo(0.05 / 120, 12);
    expect(r.result.test).toBe("leverage");
    expect(r.pass).toBe(true);
  });
});

describe("signalRowFromEntry", () => {
  it("reduces exact fractions to floats and skips open rows", () => {
    const entry = (net: unknown) =>
      ({
        row: { id: "lr:1" },
        net,
        stress: { num: 1n, den: 100n },
        excess: { num: 1n, den: 50n },
      }) as never;
    const r = signalRowFromEntry(entry({ num: 3n, den: 100n }), 7)!;
    expect(r).toEqual({ id: "lr:1", entrySession: 7, net: 0.03, stress: 0.01, excess: 0.02 });
    expect(signalRowFromEntry(entry(null), 7)).toBeNull();
  });
});
