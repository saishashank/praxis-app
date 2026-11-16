// @vitest-environment node
// FAM-010 real target exit (M21 E1, D-1224). HIGH-RISK money maths: every expected value is hand-computed in
// micro-AUD and written as a literal. Synthetic ZZ data only.
// Setup: entry fill A$10.00 = 10_000_000; the initial stop is A$9.00 (level 9_000_000), so 1R = 1_000_000.
import { describe, expect, it } from "vitest";
import { COST_PROFILES } from "@/lib/arena/costs";
import { csExitSlippedPrice, fillCloseSignalExit, type FillEnv } from "@/lib/arena/fills";
import { evaluateExit, f1Plan, f4Plan } from "@/lib/agents/families/exits";
import {
  targetFromParams,
  targetLevel,
  targetOf,
  withTarget,
} from "@/lib/agents/families/targetOf";
import type { CsRule, ExitPlan } from "@/lib/agents/families/types";
import { agentParamsSha, defaultAgentParams, paramsWithVersion } from "@/lib/agents/params";
import { makeRational } from "@/lib/money/rational";
import { DOLLAR, position } from "../../fixtures/agents/families/builders";

const ENTRY = 10n * DOLLAR;
const STOP = 9n * DOLLAR;
const base: ExitPlan = {
  initialStops: [
    { id: "initial", via: null, spec: { atr_micro: null, k: null, cap: null, level_micro: STOP } },
  ],
  trails: [],
  cs: [],
};
const tgt = (r: [bigint, bigint] | null, pct: [bigint, bigint] | null): ExitPlan =>
  withTarget(base, {
    r: r === null ? null : makeRational(r[0], r[1]),
    pct: pct === null ? null : makeRational(pct[0], pct[1]),
  });
const at = (plan: ExitPlan, close: bigint) =>
  evaluateExit(position(plan, { fillMicro: ENTRY, closeMicro: close, sessionsHeld: 3 }));

describe("target price (hand-computed)", () => {
  it("2R: 10_000_000 + 2 x (10_000_000 - 9_000_000) = 12_000_000", () => {
    expect(targetLevel({ r: makeRational(2n), pct: null }, ENTRY, STOP)).toBe(12_000_000n);
  });
  it("10 %: 10_000_000 x 1.10 = 11_000_000", () => {
    expect(targetLevel({ r: null, pct: makeRational(1n, 10n) }, ENTRY, STOP)).toBe(11_000_000n);
  });
  it("a non-whole micro target rounds up to the smallest triggering close", () => {
    // R = 3/2, entry 10_000_001, stop 9_000_000: risk 1_000_001, x 3/2 = 1_500_001.5 -> 1_500_002
    expect(targetLevel({ r: makeRational(3n, 2n), pct: null }, 10_000_001n, STOP)).toBe(
      11_500_003n,
    );
    // 5 %: 10_000_001 x 21/20 = 10_500_001.05 -> 10_500_002
    expect(targetLevel({ r: null, pct: makeRational(1n, 20n) }, 10_000_001n, STOP)).toBe(
      10_500_002n,
    );
  });
  it("no positive risk gives no R target", () => {
    expect(targetLevel({ r: makeRational(2n), pct: null }, STOP, ENTRY)).toBeNull();
  });
  it("targetOf reads the key from a version params_json; none for a v1 version", () => {
    expect(targetOf({ f1_target_r: 2 }, ENTRY, STOP)).toBe(12_000_000n);
    expect(targetOf({ f4_target_pct: 10 }, ENTRY, STOP)).toBe(11_000_000n);
    expect(targetOf({ f1_trail_atr: 3 }, ENTRY, STOP)).toBeNull();
    expect(targetOf({ f1_target_r: 9 }, ENTRY, STOP)).toBeNull(); // out of bounds: no target
  });
});

describe("trigger at the close", () => {
  it("2R fires at the target close and not one tick below", () => {
    const plan = tgt([2n, 1n], null);
    expect(at(plan, 12_000_000n).cs?.rule).toBe("target");
    expect(at(plan, 11_990_000n).cs).toBeNull();
    expect(at(plan, 11_999_999n).cs).toBeNull();
  });
  it("10 % fires at 11_000_000 and not at 10_990_000", () => {
    const plan = tgt(null, [1n, 10n]);
    expect(at(plan, 11_000_000n).cs?.rule).toBe("target");
    expect(at(plan, 10_990_000n).cs).toBeNull();
  });
  it("a plan with a target and an earlier SMA rule exits on the SMA rule when both fire", () => {
    const sma: CsRule = { id: "close_above_sma", via: null, kind: "close_above_sma", period: 5 };
    const plan = withTarget({ ...base, cs: [sma] }, { r: makeRational(2n), pct: null });
    const ev = evaluateExit(
      position(plan, {
        fillMicro: ENTRY,
        closeMicro: 12_500_000n,
        closeAboveExitSma: true,
        sessionsHeld: 3,
      }),
    );
    expect(ev.cs?.rule).toBe("close_above_sma");
    expect(ev.triggered.map((t) => t.rule)).toEqual(["close_above_sma", "target"]);
  });
  it("the target is appended last in every family plan and absent without a key", () => {
    const p = defaultAgentParams();
    expect(f1Plan(p, 500_000n).cs.map((c) => c.id)).toEqual(["time_stop", "max_hold"]);
    const v = paramsWithVersion(p, "F1", { f1_target_r: 2 });
    expect(f1Plan(v, 500_000n).cs.map((c) => c.id)).toEqual(["time_stop", "max_hold", "target"]);
    const v4 = paramsWithVersion(p, "F4", { f4_target_pct: 10 });
    expect(f4Plan(v4, 500_000n).cs.map((c) => c.id)).toEqual([
      "close_above_sma",
      "time_stop",
      "target",
    ]);
  });
  it("a version without a target keeps the exact v1 parameters hash; both keys give none", () => {
    const p = defaultAgentParams();
    expect(agentParamsSha(paramsWithVersion(p, "F1", {}))).toBe(agentParamsSha(p));
    expect(targetFromParams("F1", { f1_target_r: 2, f1_target_pct: 10 })).toBeUndefined();
  });
});

describe("fill at the target and the slippage (known answers)", () => {
  const ADV = 5_000_000_000_000n; // A$5M: the 10 bps bucket
  const env: FillEnv = {
    bar: {
      openMicro: 12_100_000n,
      highMicro: 12_200_000n,
      lowMicro: 12_000_000n,
      closeMicro: 12_100_000n,
    },
    advMicro: ADV,
    profile: COST_PROFILES.P5,
  };
  it("the next open (gapped above the target) less 10 bps on the 0.01 grid", () => {
    // 10 bps of 12_100_000 = 12_100; raw 12_087_900; sell rounds down to the 10_000 grid = 12_080_000
    const f = fillCloseSignalExit(env, 100n);
    expect(f.rule).toBe("close_signal");
    expect(f.refPriceMicro).toBe(12_100_000n);
    expect(f.fillPriceMicro).toBe(12_080_000n);
    expect(f.slipMicro).toBe(20_000n);
    expect(f.valueMicro).toBe(1_208_000_000n);
    // the one function every CS exit pays, exported for the short scorer (R1)
    expect(csExitSlippedPrice(env, 12_100_000n)).toBe(12_080_000n);
  });
});
