// @vitest-environment node
// Fill model (spec 05 ARN-020, ARN-021, ARN-026, ARN-030, ARN-032; DAT-210; M3 T5). HIGH-RISK money
// maths: every expected value is hand-computed in micro-AUD and written as a literal.
// Common setup: P5, ADV A$5M (10 bps bucket), tick A$0.01 from A$2.00, A$0.005 from A$0.10.
import { describe, expect, it } from "vitest";
import { COST_PROFILES } from "@/lib/arena/costs";
import {
  assertBar,
  fillCloseSignalExit,
  fillEntryAtOpen,
  fillIntradayStop,
  fillOrder,
  gateRefusal,
  initialStopFromFill,
  selectExit,
  type Bar,
  type FillEnv,
  type SimulatedFill,
} from "@/lib/arena/fills";
import { makeRational } from "@/lib/money/rational";
import { MIN_PRICE_MICRO } from "@/lib/money/tick";

const ADV = 5_000_000_000_000n;
const bar = (open: bigint, low: bigint, high = open, close = open): Bar => ({
  openMicro: open,
  highMicro: high > open ? high : open,
  lowMicro: low,
  closeMicro: close,
});
const env = (b: Bar, over: Partial<FillEnv> = {}): FillEnv => ({
  bar: b,
  advMicro: ADV,
  profile: COST_PROFILES.P5,
  ...over,
});

describe("entry and close-signal fills happen at the open (ARN-020, ARN-021)", () => {
  it("entry: open + slippage, rounded up onto the tick grid", () => {
    // 10 bps of 10_000_000 = 10_000 = one tick -> 10_010_000. 60 x 10_010_000 = 600_600_000.
    const f = fillEntryAtOpen(env(bar(10_000_000n, 9_900_000n, 10_200_000n, 10_100_000n)), 60n);
    expect(f.rule).toBe("open");
    expect(f.side).toBe("buy");
    expect(f.qty).toBe(60n);
    expect(f.refPriceMicro).toBe(10_000_000n);
    expect(f.slipMicro).toBe(10_000n);
    expect(f.fillPriceMicro).toBe(10_010_000n);
    expect(f.valueMicro).toBe(600_600_000n);
    expect(f.brokerageMicro).toBe(5_000_000n); // P5, A$600.60 <= A$1,000.00
    expect(f.costProfile).toBe("P5");
    expect(f.bar).toEqual(bar(10_000_000n, 9_900_000n, 10_200_000n, 10_100_000n));
  });

  it("CS exit: next open - slippage, rounded down; rule close_signal", () => {
    const f = fillCloseSignalExit(env(bar(10_000_000n, 9_000_000n)), 60n);
    expect(f.rule).toBe("close_signal");
    expect(f.side).toBe("sell");
    expect(f.fillPriceMicro).toBe(9_990_000n);
    expect(f.slipMicro).toBe(10_000n);
    expect(f.valueMicro).toBe(599_400_000n);
    expect(f.brokerageMicro).toBe(5_000_000n);
  });

  it("an entry that gaps up buys at the gapped open, not at any earlier price", () => {
    // open 12_000_000: 10 bps = 12_000 -> raw 12_012_000 -> ceil to 10_000 grid = 12_020_000.
    const f = fillEntryAtOpen(env(bar(12_000_000n, 11_900_000n)), 1n);
    expect(f.refPriceMicro).toBe(12_000_000n);
    expect(f.fillPriceMicro).toBe(12_020_000n);
    expect(f.slipMicro).toBe(20_000n);
  });

  it("an entry that gaps down still pays slippage upward from the open", () => {
    const f = fillEntryAtOpen(env(bar(8_000_000n, 7_900_000n)), 1n);
    expect(f.fillPriceMicro).toBe(8_010_000n); // 10 bps = 8_000 < one tick 10_000
  });

  it("brokerage uses the fill value on the P5 tier boundary (A$1,000.00 inclusive)", () => {
    // 100 x 10_010_000 = 1_001_000_000 > A$1,000.00 -> A$10.00.
    expect(fillEntryAtOpen(env(bar(10_000_000n, 9_000_000n)), 100n).brokerageMicro).toBe(
      10_000_000n,
    );
  });

  it("supplied tick factor, buckets and fee context reach the fill", () => {
    const f = fillEntryAtOpen(
      env(bar(10_000_000n, 9_000_000n), {
        tickCrossFactor: makeRational(3n),
        buckets: [{ fromAdvMicro: 0n, bps: makeRational(1n) }],
        profile: COST_PROFILES.P2,
        feeContext: { firstBuyOfSecurityToday: true },
      }),
      10n,
    );
    expect(f.fillPriceMicro).toBe(10_030_000n); // max(1_000, 3 x 10_000) = 30_000
    expect(f.brokerageMicro).toBe(0n); // P2 free first buy under A$1,000
    expect(f.costProfile).toBe("P2");
  });

  it("rejects a non-positive quantity and an invalid bar", () => {
    expect(() => fillEntryAtOpen(env(bar(10_000_000n, 9_000_000n)), 0n)).toThrow(RangeError);
    expect(() => fillCloseSignalExit(env(bar(10_000_000n, 9_000_000n)), -1n)).toThrow(RangeError);
    expect(() => fillEntryAtOpen(env(bar(10_000_000n, 11_000_000n)), 1n)).toThrow(/invalid bar/);
  });

  it("D-184: a slipped sell price of zero or less fills at the lowest price on the grid", () => {
    // A$0.001 open: slippage is one tick (A$0.001) -> 0, floored to A$0.001.
    expect(fillCloseSignalExit(env(bar(1_000n, 1_000n)), 1n).fillPriceMicro).toBe(1_000n);
  });
});

describe("assertBar", () => {
  it("accepts a consistent bar and rejects each kind of inconsistency", () => {
    expect(() => assertBar(bar(10n, 5n, 12n, 11n))).not.toThrow();
    expect(() => assertBar(bar(0n, 0n))).toThrow(RangeError);
    expect(() =>
      assertBar({ openMicro: 10n, highMicro: 9n, lowMicro: 5n, closeMicro: 8n }),
    ).toThrow(RangeError);
    expect(() =>
      assertBar({ openMicro: 10n, highMicro: 12n, lowMicro: 11n, closeMicro: 11n }),
    ).toThrow(RangeError);
    expect(() =>
      assertBar({ openMicro: 10n, highMicro: 12n, lowMicro: 5n, closeMicro: 0n }),
    ).toThrow(RangeError);
    expect(() =>
      assertBar({ openMicro: 10n, highMicro: 12n, lowMicro: 5n, closeMicro: 13n }),
    ).toThrow(RangeError);
  });
});

describe("IS exit fills (ARN-021)", () => {
  it("gap through the stop: session opens below the level, fill at open - slippage", () => {
    // TST-101 case 032: level 1_000_000, open 950_000, tick 5_000, slip 5_000 -> 945_000.
    const f = fillIntradayStop(env(bar(950_000n, 950_000n)), 100n, 1_000_000n);
    expect(f?.rule).toBe("gap_open");
    expect(f?.refPriceMicro).toBe(950_000n);
    expect(f?.fillPriceMicro).toBe(945_000n);
    expect(f?.slipMicro).toBe(5_000n);
    expect(f?.valueMicro).toBe(94_500_000n);
    expect(f?.brokerageMicro).toBe(5_000_000n);
  });

  it("opening exactly at the level counts as a gap (opens at or below)", () => {
    const f = fillIntradayStop(env(bar(1_000_000n, 980_000n)), 1n, 1_000_000n);
    expect(f?.rule).toBe("gap_open");
    expect(f?.fillPriceMicro).toBe(995_000n); // 1_000_000 - 5_000
  });

  it("stop hit inside the range: level - slippage - 1 tick (case 033)", () => {
    // open 1_020_000, low 980_000, level 1_000_000: slip 5_000, tick 5_000 -> 990_000.
    const f = fillIntradayStop(env(bar(1_020_000n, 980_000n)), 1n, 1_000_000n);
    expect(f?.rule).toBe("level");
    expect(f?.refPriceMicro).toBe(1_000_000n);
    expect(f?.fillPriceMicro).toBe(990_000n);
    expect(f?.slipMicro).toBe(10_000n); // includes the extra tick
  });

  it("a low equal to the level reaches it", () => {
    const f = fillIntradayStop(env(bar(1_020_000n, 1_000_000n)), 1n, 1_000_000n);
    expect(f?.fillPriceMicro).toBe(990_000n);
  });

  it("a low one micro above the level does not trigger", () => {
    expect(fillIntradayStop(env(bar(1_020_000n, 1_000_001n)), 1n, 1_000_000n)).toBeNull();
  });

  it("D-184: a sell never fills below the lowest price on the grid (A$0.001)", () => {
    // level 2_000 (A$0.002, tick 1_000): slip one tick -> 1_000, minus one tick = 0 -> floor 1_000
    const level = fillIntradayStop(env(bar(3_000n, 1_000n, 3_000n)), 1_000n, 2_000n);
    expect(level?.rule).toBe("level");
    expect(level?.fillPriceMicro).toBe(MIN_PRICE_MICRO);
    // a gap open at A$0.001: open minus a tick would be zero -> floor
    const gap = fillIntradayStop(env(bar(1_000n, 1_000n)), 1_000n, 2_000n);
    expect(gap?.rule).toBe("gap_open");
    expect(gap?.fillPriceMicro).toBe(MIN_PRICE_MICRO);
    const cs = fillCloseSignalExit(env(bar(1_000n, 1_000n)), 1_000n);
    expect(cs.fillPriceMicro).toBe(MIN_PRICE_MICRO);
    expect(MIN_PRICE_MICRO).toBe(1_000n);
  });

  it("a stop at the A$2.00 band edge uses the level's own tick (A$0.01)", () => {
    // level 2_000_000 (A$2.00, tick 10_000): slip max(2_000, 10_000) = 10_000 -> 1_990_000,
    // minus one tick (10_000) = 1_980_000.
    const f = fillIntradayStop(env(bar(2_100_000n, 1_900_000n)), 1n, 2_000_000n);
    expect(f?.fillPriceMicro).toBe(1_980_000n);
  });

  it("afterOpen: the open cannot gap through a stop set from this session's own fill", () => {
    const b = bar(9_900_000n, 9_880_000n);
    // level above the open (stop distance smaller than the entry slippage): normal rule gaps.
    const gap = fillIntradayStop(env(b), 1n, 9_950_000n);
    expect(gap?.rule).toBe("gap_open");
    expect(gap?.fillPriceMicro).toBe(9_890_000n); // open 9_900_000 - 10_000
    // afterOpen: only the low test; low 9_880_000 <= level -> level rule: 9_950_000 - 10_000 -
    // 10_000 = 9_930_000.
    const after = fillIntradayStop(env(b), 1n, 9_950_000n, { afterOpen: true });
    expect(after?.rule).toBe("level");
    expect(after?.fillPriceMicro).toBe(9_930_000n);
    expect(
      fillIntradayStop(env(bar(9_900_000n, 9_900_000n)), 1n, 9_800_000n, { afterOpen: true }),
    ).toBeNull();
  });

  it("entry then initial stop in one session (TST-101 31 + 34)", () => {
    const b = bar(10_000_000n, 9_500_000n, 10_100_000n, 9_600_000n);
    const entry = fillEntryAtOpen(env(b), 10n);
    expect(entry.fillPriceMicro).toBe(10_010_000n);
    const stop = initialStopFromFill(entry.fillPriceMicro, 500_000n);
    expect(stop).toBe(9_510_000n);
    // Active after the open; the low 9_500_000 reaches 9_510_000: 9_510_000 - 10_000 - 10_000.
    const exit = fillIntradayStop(env(b), 10n, stop, { afterOpen: true });
    expect(exit?.fillPriceMicro).toBe(9_490_000n);
    expect(exit?.valueMicro).toBe(94_900_000n);
  });

  it("guards: non-positive level, quantity, or a stop fill that consumes the price", () => {
    expect(() => fillIntradayStop(env(bar(10_000_000n, 9_000_000n)), 1n, 0n)).toThrow(RangeError);
    expect(() => fillIntradayStop(env(bar(10_000_000n, 9_000_000n)), 0n, 9_500_000n)).toThrow(
      RangeError,
    );
    // level A$0.002 (tick 1_000): slip 1_000 -> 1_000, minus a tick -> 0, floored to A$0.001 (D-184).
    expect(fillIntradayStop(env(bar(5_000n, 1_500n)), 1n, 2_000n)?.fillPriceMicro).toBe(1_000n);
  });
});

describe("initial stop from the actual fill (ARN-021)", () => {
  it("is fill - distance, never open - distance", () => {
    expect(initialStopFromFill(10_010_000n, 500_000n)).toBe(9_510_000n);
  });

  it("refuses a zero or negative distance and a stop at or below zero", () => {
    expect(() => initialStopFromFill(10_010_000n, 0n)).toThrow(RangeError);
    expect(() => initialStopFromFill(10_010_000n, -1n)).toThrow(RangeError);
    expect(() => initialStopFromFill(10_010_000n, 10_010_000n)).toThrow(RangeError);
    expect(() => initialStopFromFill(10_010_000n, 20_000_000n)).toThrow(RangeError);
  });
});

describe("selectExit: CS versus IS in one session (ARN-021, ruling D-071 on case 034)", () => {
  const b = bar(9_800_000n, 9_500_000n);
  const cs = fillCloseSignalExit(env(b), 1n);
  const level = fillIntradayStop(env(b), 1n, 9_510_000n);
  const gap = fillIntradayStop(env(b), 1n, 9_900_000n);

  it("TST-101 case 034 fills", () => {
    expect(cs.fillPriceMicro).toBe(9_790_000n);
    expect(level?.fillPriceMicro).toBe(9_490_000n);
  });

  it("a CS exit at the open is earlier than an intraday stop and wins", () => {
    expect(selectExit(cs, level)).toBe(cs);
  });

  it("both at the open: the worse (lower) fill stands, an equal price keeps the IS fill", () => {
    expect(gap?.rule).toBe("gap_open");
    expect(selectExit(cs, gap)).toBe(gap); // identical price at the open -> IS
    const worseCs: SimulatedFill = { ...cs, fillPriceMicro: 9_000_000n };
    expect(selectExit(worseCs, gap)).toBe(worseCs);
    const betterCs: SimulatedFill = { ...cs, fillPriceMicro: 9_900_000n };
    expect(selectExit(betterCs, gap)).toBe(gap);
  });

  it("only one exit applies", () => {
    expect(selectExit(null, null)).toBeNull();
    expect(selectExit(cs, null)).toBe(cs);
    expect(selectExit(null, level)).toBe(level);
  });
});

describe("quality gate: entries only (DAT-210)", () => {
  it("allowed decision gives no refusal", () => {
    expect(gateRefusal({ allowed: true, reason: "ok" }, "creation")).toBeNull();
    expect(gateRefusal({ allowed: true, reason: "ok" }, "fill")).toBeNull();
  });

  it("blocked: rejected at creation, cancelled at fill, with the gate's own reason", () => {
    for (const reason of ["no_quality_score", "u1_gate_failed", "code_blocked"] as const) {
      expect(gateRefusal({ allowed: false, reason }, "creation")).toEqual({
        status: "rejected",
        reason: "gate",
        detail: reason,
      });
      expect(gateRefusal({ allowed: false, reason }, "fill")).toEqual({
        status: "cancelled",
        reason: "gate",
        detail: reason,
      });
    }
  });

  it("a missing decision is a block, never a pass", () => {
    expect(gateRefusal(undefined, "fill")).toEqual({
      status: "cancelled",
      reason: "gate",
      detail: "no_gate_decision",
    });
  });
});

describe("fillOrder", () => {
  const ok = { allowed: true, reason: "ok" } as const;
  const blocked = { allowed: false, reason: "u1_gate_failed" } as const;
  const b = bar(10_000_000n, 9_500_000n);

  it("entry: filled at the open with the initial stop from the actual fill", () => {
    const r = fillOrder(
      { kind: "entry", qty: 10n, stopDistanceMicro: 500_000n },
      { ...env(b), gate: ok },
    );
    expect(r.status).toBe("filled");
    if (r.status !== "filled") throw new Error("unreachable");
    expect(r.fill.fillPriceMicro).toBe(10_010_000n);
    expect(r.initialStopMicro).toBe(9_510_000n);
  });

  it("entry refused when the gate blocks it at fill time", () => {
    expect(
      fillOrder(
        { kind: "entry", qty: 10n, stopDistanceMicro: 500_000n },
        { ...env(b), gate: blocked },
      ),
    ).toEqual({ status: "cancelled", reason: "gate", detail: "u1_gate_failed" });
  });

  it("entry with no gate decision is cancelled", () => {
    expect(fillOrder({ kind: "entry", qty: 10n, stopDistanceMicro: 500_000n }, env(b))).toEqual({
      status: "cancelled",
      reason: "gate",
      detail: "no_gate_decision",
    });
  });

  it("entry on a halted code is cancelled (no fill)", () => {
    expect(
      fillOrder(
        { kind: "entry", qty: 10n, stopDistanceMicro: 500_000n },
        { ...env(b), gate: ok, halted: true },
      ),
    ).toEqual({ status: "cancelled", reason: "halted", detail: "halted" });
  });

  it("exits fill regardless of a blocking gate", () => {
    const cs = fillOrder({ kind: "exit_cs", qty: 10n }, { ...env(b), gate: blocked });
    expect(cs.status).toBe("filled");
    if (cs.status === "filled") {
      expect(cs.fill.fillPriceMicro).toBe(9_990_000n);
      expect(cs.initialStopMicro).toBeNull();
    }
    const is = fillOrder(
      { kind: "exit_is", qty: 10n, levelMicro: 9_600_000n },
      { ...env(b), gate: blocked },
    );
    expect(is.status).toBe("filled");
    if (is.status === "filled") expect(is.fill.rule).toBe("level");
    // and with no gate decision at all
    expect(fillOrder({ kind: "exit_cs", qty: 10n }, env(b)).status).toBe("filled");
  });

  it("an IS stop that is not reached stays unfilled", () => {
    expect(
      fillOrder(
        { kind: "exit_is", qty: 10n, levelMicro: 9_000_000n },
        { ...env(b), gate: blocked },
      ),
    ).toEqual({ status: "unfilled", reason: "stop_not_reached" });
  });

  it("exits on a halted code stay unfilled (frozen, ARN-026)", () => {
    expect(fillOrder({ kind: "exit_cs", qty: 10n }, { ...env(b), halted: true })).toEqual({
      status: "unfilled",
      reason: "halted",
    });
    expect(
      fillOrder({ kind: "exit_is", qty: 10n, levelMicro: 9_600_000n }, { ...env(b), halted: true }),
    ).toEqual({ status: "unfilled", reason: "halted" });
  });
});
