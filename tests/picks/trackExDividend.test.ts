// @vitest-environment node
// FAM-007 (D-219) in the pick tracker: the dividend going ex moves the stop trigger on that session only.
import { describe, expect, it } from "vitest";
import { getCostProfile } from "@/lib/arena/costs";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { pickExDividends, simulateOutcome, type DatedBar, type Levels } from "@/lib/picks/track";

const profile = getCostProfile("P5");
const L: Levels = {
  buyMaxMicro: 10_050_000n,
  stopMicro: 9_200_000n,
  aimMicro: 12_000_000n,
  timeFrameSessions: 5,
  validUntilD: "2030-03-29",
  sizeMicro: 1_000_000_000n,
};
const bar = (d: string, o: number, h: number, l: number, c: number): DatedBar => ({
  d,
  openMicro: BigInt(Math.round(o * 1e6)),
  highMicro: BigInt(Math.round(h * 1e6)),
  lowMicro: BigInt(Math.round(l * 1e6)),
  closeMicro: BigInt(Math.round(c * 1e6)),
});
const MON = "2030-03-25";
const TUE = "2030-03-26";
// bought Monday; Tuesday (ex-date) lows at 9.15: 9.15 + 0.10 = 9.25 > 9.20 stop with the dividend
const bars = [bar(MON, 10.0, 10.2, 9.9, 10.1), bar(TUE, 9.6, 9.7, 9.15, 9.5)];
const env = { advMicro: 5_000_000_000n, profile, asOfD: TUE };

describe("simulateOutcome with an ex-date dividend", () => {
  it("without a dividend the low 9.15 stops the position out", () => {
    expect(simulateOutcome(L, bars, env).state).toBe("closed");
  });

  it("the dividend lifts the low above the stop on the ex-date, so it stays open", () => {
    const out = simulateOutcome(L, bars, {
      ...env,
      exDividends: [{ exD: TUE, dpsMicro: 100_000n }],
    });
    expect(out.state).toBe("bought");
  });

  it("a dividend on another session changes nothing", () => {
    const out = simulateOutcome(L, bars, {
      ...env,
      exDividends: [{ exD: MON, dpsMicro: 100_000n }],
    });
    expect(out.state).toBe("closed");
  });
});

describe("pickExDividends (GL-02)", () => {
  const rec = (knownAt: string | null): CorpActionRecord => ({
    id: "1",
    code: "ZZA",
    type: "cash_dividend",
    exDate: TUE,
    payload: { dps: "0.10", pay_date: "2030-04-10" },
    knownAt,
  });
  const cutoffOf = (d: string): string => `${d}T07:10:00.000Z`;

  it("keeps a dividend known by the previous session's cut-off", () => {
    expect(
      pickExDividends([rec("2030-03-25T07:10:00.000Z")], "ZZA", bars, "2030-03-24", cutoffOf),
    ).toEqual([{ exD: TUE, dpsMicro: 100_000n }]);
  });

  it("drops one confirmed after it, and one for another code", () => {
    expect(
      pickExDividends([rec("2030-03-25T07:10:00.001Z")], "ZZA", bars, "2030-03-24", cutoffOf),
    ).toEqual([]);
    expect(pickExDividends([rec(null)], "ZZB", bars, "2030-03-24", cutoffOf)).toEqual([]);
  });
});
