// @vitest-environment node
// ARN-103/104 pure maths (D-490/D-491): the window runs from the level BEFORE the fill session to the exit
// session; vs market = pick minus market; the summary needs n >= 30 and excludes missed picks.
import { describe, expect, it } from "vitest";
import { benchmarkLabel, type TotalReturnPoint } from "@/lib/picks/benchmark";
import {
  pickMarketStatement,
  vsMarketPpm,
  vsMarketSummary,
  windowReturnPpm,
} from "@/lib/picks/vsMarket";
import type { Outcome } from "@/lib/picks/track";

const pt = (d: string, v: number): TotalReturnPoint => ({ d, levelMicro: BigInt(v) * 1_000_000n });
const series = [pt("2030-01-02", 100), pt("2030-01-03", 110), pt("2030-01-04", 99)];

describe("windowReturnPpm", () => {
  it("uses the level before the fill session", () => {
    expect(windowReturnPpm(series, "2030-01-03", "2030-01-04")).toEqual({
      fromMicro: 100_000_000n,
      toMicro: 99_000_000n,
      retPpm: -10_000,
    });
  });
  it("is null with no session before the window, or a reversed window", () => {
    expect(windowReturnPpm(series, "2030-01-02", "2030-01-04")).toBeNull();
    expect(windowReturnPpm(series, "2030-01-04", "2030-01-03")).toBeNull();
    expect(windowReturnPpm([], "2030-01-03", "2030-01-04")).toBeNull();
  });
  it("takes the last session on or before a non-session end date", () => {
    expect(windowReturnPpm(series, "2030-01-03", "2030-01-05")!.retPpm).toBe(-10_000);
  });
});

describe("vsMarketPpm and the summary", () => {
  it("subtracts", () => expect(vsMarketPpm(30_000, 12_500)).toBe(17_500));
  it("is insufficient under 30 and ignores missed (null) picks", () => {
    const s = vsMarketSummary([
      { vsMarketPpm: 10_000 },
      { vsMarketPpm: -20_000 },
      { vsMarketPpm: null },
    ]);
    expect(s).toEqual({ n: 2, medianPpm: -5_000, beatingPct: 50, insufficient: true });
    expect(vsMarketSummary([])).toMatchObject({ n: 0, medianPpm: null, insufficient: true });
  });
  it("is sufficient at 30", () => {
    const s = vsMarketSummary(Array.from({ length: 30 }, (_, i) => ({ vsMarketPpm: i - 9 })));
    expect(s.insufficient).toBe(false);
    expect(s.n).toBe(30);
    expect(s.beatingPct).toBe(67);
  });
});

describe("pickMarketStatement", () => {
  const closed: Outcome = {
    state: "closed",
    entryD: "2030-01-03",
    entryMicro: 1n,
    exitD: "2030-01-04",
    exitMicro: 1n,
    exitReason: "stop",
    netMicro: 1n,
    netPpm: 5_000,
  };
  const base = {
    key: ["AU", "2030-01-02", "balanced", 1, "pick"],
    basis: "price_only" as const,
    series,
    validUntilD: "2030-01-10",
    withdrawnNight: null,
    settledD: "2030-01-04",
  };
  it("stores pick, market and difference of a closed pick", () => {
    const args = pickMarketStatement({ ...base, sim: closed })!.args as unknown[];
    expect(args).toContain(-10_000); // market
    expect(args).toContain(15_000); // 5 000 - (-10 000)
  });
  it("is null when the index has no data for the window", () => {
    expect(pickMarketStatement({ ...base, series: [], sim: closed })).toBeNull();
  });
  it("labels the basis", () => {
    expect(benchmarkLabel("price_only")).toMatch(/^Price only/);
  });
});
