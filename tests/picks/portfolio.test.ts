// @vitest-environment node
// D-913 "Follow the picks" portfolio: buys the picks the tracking bought while a slot and cash allow,
// sells at the stop, the aim, the end of the time frame without support, or a weak holding with no
// signal; keeps a holding that is picked again or still signalled; cash waits. Synthetic ZZ data.
import { describe, expect, it } from "vitest";
import { getCostProfile } from "@/lib/arena/costs";
import {
  simulatePortfolio,
  type DatedBar,
  type PortfolioParams,
  type PortfolioPick,
} from "@/lib/picks/portfolio";

const M = 1_000_000n;
const P: PortfolioParams = {
  seedMicro: 5_000n * M,
  slots: 5,
  minParcelMicro: 500n * M,
  weakAverageSessions: 3,
  weakQuietSessions: 2,
  costProfile: getCostProfile("P5"),
};
const DAYS = ["2030-03-01", "2030-03-04", "2030-03-05", "2030-03-06", "2030-03-07", "2030-03-08"];

/** Bars from closes in dollars; high/low default to the close, with optional overrides per day. */
function bars(closes: number[], hl: Record<number, [number, number]> = {}): DatedBar[] {
  return closes.map((c, i) => {
    const [h, l] = hl[i] ?? [c, c];
    const m = (x: number) => BigInt(Math.round(x * 1e6));
    return { d: DAYS[i]!, openMicro: m(c), highMicro: m(h), lowMicro: m(l), closeMicro: m(c) };
  });
}

const pick = (o: Partial<PortfolioPick> & { code: string }): PortfolioPick => ({
  pubD: DAYS[0]!,
  rank: 1,
  entryD: DAYS[1]!,
  entryMicro: 10n * M,
  stopMicro: 9n * M,
  aimMicro: 12n * M,
  timeFrameSessions: 10,
  ...o,
});

const run = (
  picks: PortfolioPick[],
  barsBy: Record<string, DatedBar[]>,
  signals: Record<string, string[]> = {},
  p: Partial<PortfolioParams> = {},
  asOfD = DAYS[5]!,
) =>
  simulatePortfolio(
    {
      picks,
      bars: new Map(Object.entries(barsBy)),
      signalDays: new Map(Object.entries(signals).map(([k, v]) => [k, new Set(v)])),
      advMicro: new Map(),
      asOfD,
    },
    { ...P, ...p },
  );

describe("simulatePortfolio (D-913)", () => {
  it("buys about a fifth of the value and sells at the aim; the cash comes back", () => {
    const r = run([pick({ code: "ZZA" })], {
      ZZA: bars([10, 10, 10.5, 11, 11.5, 11.5], { 4: [12.2, 11.4] }),
    });
    const t = r.trades[0]!;
    expect(t.entryD).toBe(DAYS[1]);
    expect(t.qty).toBe(100n); // $1,000 slot / $10
    expect(t.exitReason).toBe("aim");
    expect(t.exitMicro).toBe(12n * M);
    expect(t.netMicro! > 0n).toBe(true);
    const last = r.days.at(-1)!;
    expect(last.holdings).toBe(0);
    expect(last.cashMicro).toBe(P.seedMicro + t.netMicro!);
  });

  it("sells at the stop-loss", () => {
    const r = run([pick({ code: "ZZA" })], {
      ZZA: bars([10, 10, 9.5, 9.5, 9.5, 9.5], { 2: [9.6, 8.8] }),
    });
    expect(r.trades[0]).toMatchObject({ exitReason: "stop", exitD: DAYS[2] });
    expect(r.trades[0]!.netMicro! < 0n).toBe(true);
  });

  it("holds at most `slots` stocks; a fill with every slot taken is skipped, by rank", () => {
    const flat = bars([10, 10, 10, 10, 10, 10]);
    const r = run(
      [
        pick({ code: "ZZA", rank: 1 }),
        pick({ code: "ZZB", rank: 2 }),
        pick({ code: "ZZC", rank: 3 }),
      ],
      { ZZA: flat, ZZB: flat, ZZC: flat },
      { ZZA: DAYS, ZZB: DAYS, ZZC: DAYS },
      { slots: 2 },
    );
    expect(r.trades.map((t) => t.code)).toEqual(["ZZA", "ZZB"]);
    expect(r.skipped).toEqual([{ pubD: DAYS[0], rank: 3, code: "ZZC", reason: "full" }]);
    expect(r.days.at(-1)!.holdings).toBe(2);
  });

  it("time frame over: sold at the next open without support, kept while a strategy signals it", () => {
    const flat = bars([10, 10, 10, 10, 10, 10]);
    const sold = run([pick({ code: "ZZA", timeFrameSessions: 2 })], { ZZA: flat }, { ZZA: DAYS });
    // signalled on every day: kept; now remove the signal on the session the time frame ends
    expect(sold.trades[0]!.exitD).toBeNull();
    const quiet = run(
      [pick({ code: "ZZA", timeFrameSessions: 2 })],
      { ZZA: flat },
      { ZZA: [DAYS[1]!] },
    );
    expect(quiet.trades[0]).toMatchObject({ exitReason: "time_frame", exitD: DAYS[3] });
  });

  it("weak: under the buy price and the average with no signal, sold at the next open", () => {
    const r = run([pick({ code: "ZZA", stopMicro: 5n * M })], {
      ZZA: bars([10.4, 10, 9.8, 9.6, 9.4, 9.4]),
    });
    const t = r.trades[0]!;
    expect(t.exitReason).toBe("weak");
    expect(t.exitD! > DAYS[1]!).toBe(true);
    // the same path with a fresh signal every day is kept
    const kept = run(
      [pick({ code: "ZZA", stopMicro: 5n * M })],
      { ZZA: bars([10.4, 10, 9.8, 9.6, 9.4, 9.4]) },
      { ZZA: DAYS },
    );
    expect(kept.trades[0]!.exitD).toBeNull();
  });

  it("picked again while held: not bought twice, kept under the new plan (stop never lower)", () => {
    const flat = bars([10, 10, 10, 10, 10, 10]);
    const r = run(
      [
        pick({ code: "ZZA", timeFrameSessions: 2 }),
        pick({
          code: "ZZA",
          pubD: DAYS[2]!,
          entryD: DAYS[3]!,
          stopMicro: 8n * M,
          timeFrameSessions: 10,
        }),
      ],
      { ZZA: flat },
    );
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.exitD).toBeNull(); // the re-pick on day 2 reset the time frame
    expect(r.skipped).toEqual([{ pubD: DAYS[2], rank: 1, code: "ZZA", reason: "held" }]);
  });

  it("no picks: nothing; cash only between trades", () => {
    expect(run([], {})).toEqual({ trades: [], days: [], skipped: [] });
    const r = run([pick({ code: "ZZA", entryD: null, entryMicro: null })], {
      ZZA: bars([10, 10, 10, 10, 10, 10]),
    });
    expect(r.trades).toEqual([]);
    expect(r.days.every((d) => d.valueMicro === P.seedMicro && d.holdings === 0)).toBe(true);
  });
});
