// @vitest-environment node
// M21 R1 (VAL-121, D-1228, D-1296): known-answer would-have shorts. Money is integer micro; the entry and the cover slippage
// come from `csExitSlippedPrice` (E1). Synthetic data only (SEC-110).
import { describe, expect, it } from "vitest";
import { COST_PROFILES, feeFor } from "@/lib/arena/costs";
import { csExitSlippedPrice, type FillEnv } from "@/lib/arena/fills";
import {
  HOLD_SESSIONS,
  STOP_PPM,
  borrowMicro,
  calendarDaysBetween,
  scoreShortSetup,
  type ShortBar,
  type ShortScoreInput,
} from "@/lib/shortShadow/score";

const M = 1_000_000n;
const PROFILE = COST_PROFILES.P5;
const ADV = 50_000_000n * M;
const bar = (d: string, o: number, h: number, l: number, c: number): ShortBar => ({
  d,
  open: BigInt(Math.round(o * 1e6)),
  high: BigInt(Math.round(h * 1e6)),
  low: BigInt(Math.round(l * 1e6)),
  close: BigInt(Math.round(c * 1e6)),
  volume: 1_000_000n,
});
const envOf = (b: ShortBar): FillEnv => ({
  bar: { openMicro: b.open, highMicro: b.high, lowMicro: b.low, closeMicro: b.close },
  advMicro: ADV,
  profile: PROFILE,
});
const base = (bars: ShortBar[], extra: Partial<ShortScoreInput> = {}): ShortScoreInput => ({
  d: "2030-01-07", // a Monday
  bars,
  calendar: [],
  asOf: "2030-03-01",
  advMicro: ADV,
  profile: PROFILE,
  parcelMicro: 1000n * M,
  borrowBpsPa: 300,
  ...extra,
});
// 2030-01-08 (Tue) to 2030-01-22 (Tue): the 10 sessions after the entry session are 9,10,11,14,15,16,17,18,21,22 Jan
const SESSIONS = [
  "2030-01-08",
  "2030-01-09",
  "2030-01-10",
  "2030-01-11",
  "2030-01-14",
  "2030-01-15",
  "2030-01-16",
  "2030-01-17",
  "2030-01-18",
  "2030-01-21",
  "2030-01-22",
  "2030-01-23",
];
const quiet = (d: string): ShortBar => bar(d, 10, 10.2, 9.8, 10);

describe("borrow and day count", () => {
  it("round half away from zero: A$1,000 at 300 bps a year for 3 days is 246,575 micro", () => {
    expect(borrowMicro(1_000n * M, 300, 3)).toBe(246_575n); // 1e9 x 300 x 3 / 3.65e6 = 246575.34
    expect(borrowMicro(365n * 10_000n * M, 300, 1)).toBe(300_000_000n); // exact: 3.65e12 x 300 x 1 / 3.65e6
    expect(borrowMicro(1n, 300, 1)).toBe(0n);
  });
  it("a weekend counts as calendar days", () => {
    expect(calendarDaysBetween("2030-01-11", "2030-01-14")).toBe(3);
  });
  it("the stop is 10 % above the entry", () => {
    expect(STOP_PPM).toBe(1_100_000n);
    expect(HOLD_SESSIONS).toBe(10);
  });
});

describe("scoreShortSetup", () => {
  it("a time exit: sold at the next open less slippage, covered at the open after 10 sessions plus slippage", () => {
    const bars = SESSIONS.map(quiet);
    const r = scoreShortSetup(base(bars))!;
    expect(r.status).toBe("closed");
    if (r.status !== "closed") return;
    const entry = csExitSlippedPrice(envOf(bars[0]!), bars[0]!.open);
    expect(r.entryD).toBe("2030-01-08");
    expect(r.entryMicro).toBe(entry);
    expect(entry).toBeLessThan(bars[0]!.open);
    expect(r.exitReason).toBe("time");
    expect(r.exitD).toBe("2030-01-22");
    const slip = bars[10]!.open - csExitSlippedPrice(envOf(bars[10]!), bars[10]!.open);
    expect(r.exitMicro).toBe(bars[10]!.open + slip);
    const qty = (1000n * M) / entry;
    expect(r.qty).toBe(qty);
    const fees =
      feeFor(PROFILE, qty * entry, "sell", { quantity: qty }) +
      feeFor(PROFILE, qty * r.exitMicro, "buy", { quantity: qty });
    expect(r.feesMicro).toBe(fees);
    expect(r.borrowMicro).toBe(borrowMicro(qty * entry, 300, 14)); // 8 Jan to 22 Jan, 14 calendar days
    expect(r.netMicro).toBe(qty * entry - qty * r.exitMicro - fees - r.borrowMicro);
    expect(
      Math.abs(r.netPpm - (Number(r.netMicro) * 1e6) / Number(qty * entry)),
    ).toBeLessThanOrEqual(0.5);
  });

  it("a stop hit: the intraday high reaches entry x 1.10, covered at the stop plus slippage, borrow over the weekend", () => {
    const bars = SESSIONS.map(quiet);
    bars[4] = bar("2030-01-14", 10, 13, 9.9, 12); // Monday: the high is far above the stop
    const r = scoreShortSetup(base(bars))!;
    if (r.status !== "closed") throw new Error("closed expected");
    const entry = csExitSlippedPrice(envOf(bars[0]!), bars[0]!.open);
    const stop = (entry * STOP_PPM + M / 2n) / M;
    expect(r.exitReason).toBe("stop");
    expect(r.exitD).toBe("2030-01-14");
    const slip = stop - csExitSlippedPrice(envOf(bars[4]!), stop);
    expect(r.exitMicro).toBe(stop + slip);
    expect(r.borrowMicro).toBe(borrowMicro(r.qty * entry, 300, 6)); // Tue 8 to Mon 14: a weekend inside
    expect(r.netMicro).toBeLessThan(0n);
  });

  it("a gap above the stop covers at the open, not at the stop", () => {
    const bars = SESSIONS.map(quiet);
    bars[2] = bar("2030-01-10", 14, 14.5, 13.8, 14.2); // opens above entry x 1.10
    const r = scoreShortSetup(base(bars))!;
    if (r.status !== "closed") throw new Error("closed expected");
    expect(r.exitReason).toBe("gap");
    expect(r.exitD).toBe("2030-01-10");
    const slip = bars[2]!.open - csExitSlippedPrice(envOf(bars[2]!), bars[2]!.open);
    expect(r.exitMicro).toBe(bars[2]!.open + slip);
  });

  it("the entry session's own high can stop the short out, but its open is never a gap", () => {
    const bars = SESSIONS.map(quiet);
    bars[0] = bar("2030-01-08", 10, 12, 9.9, 11);
    const r = scoreShortSetup(base(bars))!;
    if (r.status !== "closed") throw new Error("closed expected");
    expect(r.exitReason).toBe("stop");
    expect(r.exitD).toBe("2030-01-08");
  });

  it("an unfilled entry: no bar on the next trading day", () => {
    const bars = SESSIONS.slice(1).map(quiet); // 9 Jan onward: nothing on 8 Jan
    expect(scoreShortSetup(base(bars))).toEqual({ status: "unfilled" });
  });

  it("before the entry session has come there is nothing to score yet; after it, unfilled", () => {
    expect(scoreShortSetup(base([], { asOf: "2030-01-07" }))).toBeNull();
    expect(scoreShortSetup(base([], { asOf: "2030-01-08" }))).toEqual({ status: "unfilled" });
  });

  it("the hold is still open: not enough later bars and no stop", () => {
    const bars = SESSIONS.slice(0, 6).map(quiet);
    expect(scoreShortSetup(base(bars))).toBeNull();
  });
});
