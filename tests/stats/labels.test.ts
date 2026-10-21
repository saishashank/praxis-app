// @vitest-environment node
// Labels and their transitions (M4 T13; ARN-086, ARN-082, DAT-127; decision 29).
import { describe, expect, it } from "vitest";
import { makeRational } from "../../src/lib/money/rational";
import {
  NOTE_C2_BIAS,
  NOTE_EDGE,
  NOTE_F5,
  NOTE_LIVE_DIFFERS,
  NOTE_V1_KNOWLEDGE,
  assignLabel,
  coverageShortfall,
  type LabelInput,
} from "../../src/lib/stats/labels";
import { forwardLookLevel } from "../../src/lib/stats/gates";
import type { SingleTestResult, Val110Result } from "../../src/lib/stats/val110";
import { PARAMS } from "../fixtures/stats/t13";

function val(over: Partial<Val110Result> = {}, n = 400): Val110Result {
  return {
    results: [
      { id: "vr:a:i:excess", n, test: "i" },
      { id: "vr:a:iv", n, test: "iv" },
    ] as never,
    checks: { i: "pass", ii: "n/a", iii: "pass", iv: "pass", ivb: "pass", v: "n/a", vi: "pass" },
    absoluteGate: true,
    insufficient: false,
    passes: true,
    level: 0.000417,
    B: 48000,
    L: 6,
    m: 20,
    mde: 0.011,
    excessInterval: { lower: 0.01, upper: 0.03 },
    reachableD: null,
    ...over,
  };
}

function hold(pass: boolean, insufficient = false): SingleTestResult {
  return {
    result: { id: "vr:a:holdout", reachable_d: insufficient ? "2027-01-04" : null } as never,
    pass,
    insufficient,
    level: 0.05 / 6,
    B: 2400,
    mde: 0.02,
  };
}

function input(over: Partial<LabelInput> = {}): LabelInput {
  return {
    executionId: "E01",
    ruleVersion: "1",
    variant: "primary",
    d: "2026-10-19",
    params: PARAMS,
    activeLineages: 6,
    eventFamily: false,
    coverage: null,
    f5DescriptiveOnly: false,
    validation: null,
    holdout: null,
    forward: null,
    doubledWithoutPass: false,
    costInfeasible: false,
    survivorshipExposedShare: null,
    liveRuleDiffersFromVariant: false,
    ...over,
  };
}

const quals = (r: { qualifiers_json: string }): string[] => JSON.parse(r.qualifiers_json);

describe("transitions UNVALIDATED -> PASSED-BACKTEST -> CONSISTENT-FORWARD", () => {
  it("starts UNVALIDATED", () => {
    const r = assignLabel(input());
    expect(r.label).toBe("UNVALIDATED");
    expect(r.n).toBe(0);
    expect(r.cost_infeasible).toBe(0);
  });

  it("validation passed but no holdout confirmation yet stays UNVALIDATED", () => {
    const r = assignLabel(input({ validation: val() }));
    expect(r.label).toBe("UNVALIDATED");
    expect(quals(r)).toContain("validation passed; holdout confirmation pending");
  });

  it("VAL-110 + one holdout confirmation -> PASSED-BACKTEST with the edge sentence and the v1 note", () => {
    const r = assignLabel(input({ validation: val(), holdout: hold(true) }));
    expect(r.label).toBe("PASSED-BACKTEST");
    expect(quals(r)).toEqual(expect.arrayContaining([NOTE_EDGE, NOTE_V1_KNOWLEDGE]));
    expect(r.n).toBe(400);
    expect(r.mde).toBe(0.011);
    expect(JSON.parse(r.result_ids)).toEqual(["vr:a:holdout", "vr:a:i:excess", "vr:a:iv"]);
  });

  const forward = (over = {}) => ({
    trades: 100,
    months: 6,
    p: 0.001,
    mean: 0.01,
    cifInside: true as boolean | null,
    ...over,
  });
  const passed = { validation: val(), holdout: hold(true) };

  it("100 forward trades, 6 months, p within (0.10/L)/2 and CIF inside -> CONSISTENT-FORWARD", () => {
    expect(forwardLookLevel(1, 6)).toBeCloseTo(0.1 / 6 / 2, 12);
    const r = assignLabel(input({ ...passed, forward: forward() }));
    expect(r.label).toBe("CONSISTENT-FORWARD");
    expect(quals(r)).toContain(NOTE_V1_KNOWLEDGE);
  });

  it("each look spends less alpha: look 2 needs p <= (0.10/L)/4", () => {
    const level2 = forwardLookLevel(2, 6);
    const ok = assignLabel(
      input({ ...passed, forward: forward({ trades: 200, p: level2 * 0.9 }) }),
    );
    expect(ok.label).toBe("CONSISTENT-FORWARD");
    const no = assignLabel(
      input({ ...passed, forward: forward({ trades: 200, p: level2 * 1.1 }) }),
    );
    expect(no.label).toBe("PASSED-BACKTEST");
  });

  it("stays PASSED-BACKTEST under 100 trades, under 6 months, with a non-positive mean or CIF outside", () => {
    for (const f of [
      forward({ trades: 99 }),
      forward({ months: 5 }),
      forward({ mean: -0.001 }),
      forward({ cifInside: false }),
    ]) {
      expect(assignLabel(input({ ...passed, forward: f })).label).toBe("PASSED-BACKTEST");
    }
    const r = assignLabel(input({ ...passed, forward: forward({ cifInside: null }) }));
    expect(r.label).toBe("PASSED-BACKTEST");
    expect(quals(r)).toContain("forward CIF not yet estimable");
  });

  it("forward evidence without a backtest pass does not label anything CONSISTENT-FORWARD", () => {
    const r = assignLabel(input({ forward: forward() }));
    expect(r.label).toBe("UNVALIDATED");
  });
});

describe("negative outcomes", () => {
  const failing = (upper: number) =>
    val({
      passes: false,
      checks: { ...val().checks, i: "fail" },
      excessInterval: { lower: -0.02, upper },
    });

  it("FAILED when the 90 % interval upper end is below the useful edge (+0.5 %)", () => {
    expect(assignLabel(input({ validation: failing(0.004) })).label).toBe("FAILED");
  });
  it("NOT-DEMONSTRATED when the interval still reaches the useful edge", () => {
    expect(assignLabel(input({ validation: failing(0.02) })).label).toBe("NOT-DEMONSTRATED");
    expect(assignLabel(input({ validation: failing(0.005) })).label).toBe("NOT-DEMONSTRATED");
  });
  it("a failed holdout confirmation is a negative outcome too", () => {
    const r = assignLabel(input({ validation: val(), holdout: hold(false) }));
    expect(r.label).toBe("NOT-DEMONSTRATED");
  });
  it("a criterion failing other than (i) is NOT-DEMONSTRATED", () => {
    const v = val({ passes: false, checks: { ...val().checks, vi: "fail" } });
    expect(assignLabel(input({ validation: v })).label).toBe("NOT-DEMONSTRATED");
  });
});

describe("insufficient evidence, possible luck, UNVALIDATABLE", () => {
  it("under 100 rows or 15 blocks -> insufficient evidence with its date", () => {
    const v = val({
      passes: false,
      insufficient: true,
      reachableD: "2027-02-01",
      excessInterval: null,
    });
    const r = assignLabel(input({ validation: v }));
    expect(r.label).toBe("insufficient evidence");
    expect(quals(r)).toContain("reachable 2027-02-01");
  });
  it("an insufficient holdout window is insufficient evidence", () => {
    const r = assignLabel(input({ validation: val(), holdout: hold(false, true) }));
    expect(r.label).toBe("insufficient evidence");
    expect(quals(r)).toContain("reachable 2027-01-04");
  });
  it("doubled without PASSED-BACKTEST -> possible luck", () => {
    expect(assignLabel(input({ doubledWithoutPass: true })).label).toBe("possible luck");
    const nd = val({ passes: false, excessInterval: { lower: 0, upper: 0.03 } });
    expect(assignLabel(input({ validation: nd, doubledWithoutPass: true })).label).toBe(
      "possible luck",
    );
  });
  it("doubled with PASSED-BACKTEST, FAILED or UNVALIDATABLE keeps that label", () => {
    expect(
      assignLabel(input({ validation: val(), holdout: hold(true), doubledWithoutPass: true }))
        .label,
    ).toBe("PASSED-BACKTEST");
    const failed = val({ passes: false, excessInterval: { lower: -0.05, upper: 0.001 } });
    expect(assignLabel(input({ validation: failed, doubledWithoutPass: true })).label).toBe(
      "FAILED",
    );
  });
  it("event coverage below 90 % -> UNVALIDATABLE, whatever the numbers say", () => {
    const r = assignLabel(
      input({
        eventFamily: true,
        coverage: { covered: 89, total: 100 },
        validation: val(),
        holdout: hold(true),
      }),
    );
    expect(r.label).toBe("UNVALIDATABLE");
  });
  it("coverage at exactly 90 % is enough; unknown coverage of an event family is not", () => {
    const min = PARAMS.eventCoverageMin;
    expect(coverageShortfall({ covered: 90, total: 100 }, min)).toBe(false);
    expect(coverageShortfall({ covered: 899, total: 1000 }, min)).toBe(true);
    expect(coverageShortfall(null, min)).toBe(true);
    expect(assignLabel(input({ eventFamily: true, coverage: null, validation: val() })).label).toBe(
      "UNVALIDATABLE",
    );
  });
  it("price-only families (F1, F4) need no event coverage", () => {
    const r = assignLabel(
      input({ eventFamily: false, coverage: null, validation: val(), holdout: hold(true) }),
    );
    expect(r.label).toBe("PASSED-BACKTEST");
  });
  it("F5 is descriptive-only: UNVALIDATED with the qualifier even if the numbers pass", () => {
    const r = assignLabel(
      input({ f5DescriptiveOnly: true, validation: val(), holdout: hold(true) }),
    );
    expect(r.label).toBe("UNVALIDATED");
    expect(quals(r)).toContain(NOTE_F5);
  });
});

describe("qualifiers and the cost-infeasible flag", () => {
  it("cost_infeasible is a flag beside the label, not a label", () => {
    const r = assignLabel(input({ costInfeasible: true }));
    expect(r.label).toBe("UNVALIDATED");
    expect(r.cost_infeasible).toBe(1);
  });
  it("event families carry the C2 exit-mapping note; others do not", () => {
    expect(
      quals(assignLabel(input({ eventFamily: true, coverage: { covered: 95, total: 100 } }))),
    ).toContain(NOTE_C2_BIAS);
    expect(quals(assignLabel(input()))).not.toContain(NOTE_C2_BIAS);
  });
  it("survivorship-exposed share and live-rule mismatch are listed", () => {
    const r = assignLabel(
      input({
        survivorshipExposedShare: makeRational(1n, 8n),
        liveRuleDiffersFromVariant: true,
      }),
    );
    expect(quals(r)).toEqual(
      expect.arrayContaining(["survivorship-exposed (12.5%)", NOTE_LIVE_DIFFERS]),
    );
    expect(
      quals(assignLabel(input({ survivorshipExposedShare: makeRational(0n, 5n) }))).some((q) =>
        q.startsWith("survivorship"),
      ),
    ).toBe(false);
  });
  it("record shape matches the label table and the output is deterministic", () => {
    const i = input({ validation: val(), holdout: hold(true) });
    const a = assignLabel(i);
    expect(a.id).toBe("label:E01:1:primary:2026-10-19");
    expect(() => JSON.parse(a.qualifiers_json)).not.toThrow();
    expect(() => JSON.parse(a.result_ids)).not.toThrow();
    expect(JSON.stringify(a)).toBe(JSON.stringify(assignLabel(i)));
  });
});
