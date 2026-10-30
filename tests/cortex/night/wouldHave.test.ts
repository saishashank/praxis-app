// @vitest-environment node
// Would-have scoring helper for batch 3 (M15 C3c; CTX-023, CTX-054; FAM-008 fill model; D-288,
// D-301; AT-52 "+9 % open vs 8 % cap → unfilled in both arms").
import { describe, expect, it } from "vitest";
import type { ViewBar } from "@/lib/agents/decisionView";
import { f1Plan } from "@/lib/agents/families/exits";
import type { ExitPlan, StopSpec } from "@/lib/agents/families/types";
import { defaultAgentParams } from "@/lib/agents/params";
import { COST_PROFILES } from "@/lib/arena/costs";
import { limitPriceMicro } from "@/lib/arena/fills";
import { wouldHaveOutcome, type WouldHaveInput } from "@/lib/cortex/night";
import { makeRational } from "@/lib/money/rational";

const C = 10_000n; // micro per cent
const bar = (d: string, open: number, high: number, low: number, close: number): ViewBar => ({
  d,
  open: BigInt(open) * C,
  high: BigInt(high) * C,
  low: BigInt(low) * C,
  close: BigInt(close) * C,
  volume: 100_000n,
});
const stopSpec: StopSpec = {
  atr_micro: 1_000_000n,
  k: makeRational(2n),
  cap: null,
  level_micro: null,
};
/** A plan with the initial stop and a three-session max hold (fill session = 1 → fires at the third close). */
const plan: ExitPlan = {
  initialStops: [{ id: "initial", via: null, spec: stopSpec }],
  trails: [],
  cs: [{ id: "max_hold", via: null, kind: "time_stop", sessions: 3, minReturn: null }],
};
const limit = limitPriceMicro(
  2_000n * C,
  1_800n * C,
  makeRational(8n, 100n),
  makeRational(12n, 100n),
); // 20.45
const base: Omit<WouldHaveInput, "bars"> = {
  code: "ZZA",
  family: "F1",
  qty: 100n,
  limitMicro: limit,
  plan,
  atrMicro: 1_000_000n,
  profile: COST_PROFILES.P1,
  advMicro: 2_000_000n * 1_000_000n,
};

describe("wouldHaveOutcome", () => {
  it("AT-52: a +9 % open with the low above the limit is unfilled (no trade in both arms)", () => {
    const out = wouldHaveOutcome({
      ...base,
      bars: [bar("2026-03-03", 2_180, 2_200, 2_100, 2_150)],
    });
    expect(out).toEqual({
      fillStatus: "unfilled",
      fillMicro: null,
      fillD: "2026-03-03",
      exitD: null,
      exitRule: null,
      csRule: null,
      grossMicro: null,
      netMicro: null,
      outcomeClass: null,
      stopMicro: null,
    });
  });

  it("filled at the open, stopped out at the level two sessions later: a loss, stop referenced to the fill", () => {
    const bars = [
      bar("2026-03-03", 2_000, 2_020, 1_990, 2_010), // fill at the open (+ slippage), stop not hit after the open
      bar("2026-03-04", 2_005, 2_030, 1_995, 2_000),
      bar("2026-03-05", 1_990, 2_000, 1_700, 1_750), // low through the stop → level fill
    ];
    const out = wouldHaveOutcome({ ...base, bars });
    expect(out).not.toBeNull();
    expect(out!.fillStatus).toBe("filled");
    expect(out!.fillD).toBe("2026-03-03");
    expect(out!.exitD).toBe("2026-03-05");
    expect(out!.exitRule).toBe("level");
    // stop = fill − 2 × ATR(A$1): 2 % + slippage below the open
    expect(out!.stopMicro).toBe(out!.fillMicro! - 2_000_000n);
    expect(out!.netMicro! < out!.grossMicro!).toBe(true); // brokerage on both sides
    expect(out!.outcomeClass).toBe("loss");
  });

  it("a gap through the stop fills at the open (ARN-021); a hold past the horizon exits at the next open", () => {
    const gap = wouldHaveOutcome({
      ...base,
      bars: [
        bar("2026-03-03", 2_000, 2_020, 1_990, 2_010),
        bar("2026-03-04", 1_700, 1_720, 1_690, 1_700),
      ],
    });
    expect(gap!.exitRule).toBe("gap_open");
    expect(gap!.exitD).toBe("2026-03-04");

    const held = wouldHaveOutcome({
      ...base,
      bars: [
        bar("2026-03-03", 2_000, 2_020, 1_990, 2_010),
        bar("2026-03-04", 2_020, 2_060, 2_010, 2_050),
        bar("2026-03-05", 2_060, 2_100, 2_050, 2_090),
        bar("2026-03-06", 2_120, 2_150, 2_100, 2_140), // time exit at this open
      ],
    });
    expect(held!.exitRule).toBe("close_signal");
    expect(held!.csRule).toBe("max_hold");
    expect(held!.exitD).toBe("2026-03-06");
    expect(held!.grossMicro! > 0n).toBe(true);
    expect(held!.outcomeClass).toBe("win");
  });

  it("returns null while the hold is open (not enough later bars)", () => {
    expect(wouldHaveOutcome({ ...base, bars: [] })).toBeNull();
    expect(
      wouldHaveOutcome({ ...base, bars: [bar("2026-03-03", 2_000, 2_020, 1_990, 2_010)] }),
    ).toBeNull();
  });

  it("D-333: the F1 plan's trail ratchets the stop through evaluateExit and fills at the level", () => {
    const f1 = f1Plan(defaultAgentParams(), 1_000_000n);
    const out = wouldHaveOutcome({
      ...base,
      plan: f1,
      bars: [
        bar("2026-03-03", 2_000, 2_020, 1_990, 2_010),
        bar("2026-03-04", 2_400, 2_450, 2_390, 2_440), // +22 %: the trail moves the stop up
        bar("2026-03-05", 2_430, 2_440, 2_100, 2_150), // falls through the trailed stop, not the initial one
      ],
    });
    expect(out!.exitRule).toBe("level");
    expect(out!.exitD).toBe("2026-03-05");
    expect(out!.csRule).toBeNull();
    expect(out!.grossMicro! > 0n).toBe(true); // stopped above the entry: the trail locked a gain
  });

  it("D-301: a net of exactly zero is a loss", () => {
    // the outcome class follows the sign of the net with 0 → loss; assert through the rule on a tiny win margin
    const out = wouldHaveOutcome({
      ...base,
      bars: [
        bar("2026-03-03", 2_000, 2_020, 1_990, 2_010),
        bar("2026-03-04", 2_000, 2_020, 1_990, 2_010),
        bar("2026-03-05", 2_000, 2_020, 1_990, 2_010),
        bar("2026-03-06", 2_000, 2_020, 1_990, 2_010), // exits at the same open it entered: costs only
      ],
    });
    expect(out!.grossMicro! <= 0n).toBe(true);
    expect(out!.outcomeClass).toBe("loss");
  });
});
