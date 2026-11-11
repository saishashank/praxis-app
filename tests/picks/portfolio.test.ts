// @vitest-environment node
// D-950..D-955 "My portfolio" engine: buys the picks the tracking bought while the strategy's share,
// the slot, the stock and risk caps, the minimum parcel, the cost limit and the cash allow; sells at
// the stop, the gap, the aim, the end of the time frame without support, a weak holding with no
// signal, or the strategy's closing signal; trims a strategy past its band; deterministic. ZZ data.
import { describe, expect, it } from "vitest";
import { getCostProfile } from "@/lib/arena/costs";
import { STRATEGY_NAMES_DEFAULT, MY_PORTFOLIO_PROFILES_DEFAULT } from "@/lib/config/keys";
import {
  simulatePortfolio,
  type DatedBar,
  type FinishedPick,
  type PortfolioParams,
  type PortfolioPick,
  type ProfileParams,
} from "@/lib/picks/portfolio";
import { profileParams, type PortfolioSettings } from "@/lib/picks/portfolioConfig";
import { strategyNames } from "@/lib/picks/portfolioWords";

const M = 1_000_000n;
const NAMES = strategyNames(
  Object.fromEntries(Object.entries(STRATEGY_NAMES_DEFAULT).map(([k, v]) => [k, v.name])),
);
const PROFILE: ProfileParams = {
  holdings: 4,
  riskPpm: 1_000_000,
  stockCapPpm: 300_000,
  smallStockCapPpm: 200_000,
  allocation: { shrinkN: 20, volTilt: 1, weakCash: 0 },
  bandPpm: 100_000,
  minHoldSessions: 0,
};
const P: PortfolioParams = {
  seedMicro: 1_000n * M,
  minParcelMicro: 100n * M,
  strategyCapPpm: 400_000,
  costMaxPpm: 15_000,
  weakAverageSessions: 3,
  weakQuietSessions: 2,
  shortlistAverageSessions: 3,
  costProfile: getCostProfile("P6"),
  profile: PROFILE,
  names: NAMES,
};
const DAYS = [
  "2030-03-01",
  "2030-03-04",
  "2030-03-05",
  "2030-03-06",
  "2030-03-07",
  "2030-03-08",
  "2030-03-11",
  "2030-03-12",
];
const last = DAYS.length - 1;

/** Bars from closes in dollars; the open is the close unless given; high/low overrides per day. */
function bars(
  closes: number[],
  hl: Record<number, [number, number]> = {},
  opens: Record<number, number> = {},
): DatedBar[] {
  return closes.map((c, i) => {
    const o = opens[i] ?? c;
    const [h, l] = hl[i] ?? [Math.max(c, o), Math.min(c, o)];
    const m = (x: number) => BigInt(Math.round(x * 1e6));
    return { d: DAYS[i]!, openMicro: m(o), highMicro: m(h), lowMicro: m(l), closeMicro: m(c) };
  });
}
const flat = (n = DAYS.length, c = 10) => bars(Array.from({ length: n }, () => c));

const pick = (o: Partial<PortfolioPick> & { code: string }): PortfolioPick => ({
  pubD: DAYS[0]!,
  rank: 1,
  strategy: "F1",
  tier: "U1",
  referenceMicro: 10n * M,
  entryD: DAYS[1]!,
  entryMicro: 10n * M,
  stopMicro: 9n * M,
  aimMicro: 50n * M,
  timeFrameSessions: 20,
  ...o,
});

type Extra = {
  signals?: Record<string, string[]>;
  close?: Record<string, string[]>;
  finished?: FinishedPick[];
  p?: Partial<PortfolioParams>;
  profile?: Partial<ProfileParams>;
  asOfD?: string;
};
const run = (picks: PortfolioPick[], barsBy: Record<string, DatedBar[]>, x: Extra = {}) =>
  simulatePortfolio(
    {
      picks,
      finished: x.finished ?? [],
      bars: new Map(Object.entries(barsBy)),
      signalDays: new Map(Object.entries(x.signals ?? {}).map(([k, v]) => [k, new Set(v)])),
      closeSignals: new Map(Object.entries(x.close ?? {}).map(([k, v]) => [k, new Set(v)])),
      advMicro: new Map(),
      asOfD: x.asOfD ?? DAYS[last]!,
    },
    { ...P, ...x.p, profile: { ...PROFILE, ...x.profile } },
  );
const buys = (r: ReturnType<typeof run>) => r.trades.filter((t) => t.side === "buy");
const sells = (r: ReturnType<typeof run>) => r.trades.filter((t) => t.side === "sell");

describe("buying (D-950, D-952)", () => {
  it("one strategy in play: its share is capped at 40 %, the buy is the slot (a quarter)", () => {
    const r = run([pick({ code: "ZZA" })], { ZZA: flat() });
    expect(buys(r)).toEqual([
      expect.objectContaining({ seq: 1, pos: 1, d: DAYS[1], qty: 25n, feeMicro: 1n * M }),
    ]);
    expect(r.splits[0]).toMatchObject({
      d: DAYS[1],
      shares: [{ strategy: "F1", targetPpm: 400_000 }],
      cashPpm: 600_000,
    });
    expect(r.splits[0]!.words).toBe(
      "Follow the trend 40%, cash 60%. First split, from the strategies' records so far.",
    );
    expect(buys(r)[0]!.words).toBe(
      "Bought as a Follow the trend pick: 25% of the money (Follow the trend's share is 40%).",
    );
    expect(r.holdings).toEqual([expect.objectContaining({ code: "ZZA", qty: 25n, pos: 1 })]);
    expect(r.days.at(-1)).toMatchObject({ holdings: 1, valueMicro: 999n * M, fallPpm: -1000 });
  });

  it("the stock cap, the smaller-company cap and the risk cap each bind", () => {
    const one = (o: Partial<PortfolioPick>, profile: Partial<ProfileParams>) =>
      buys(run([pick({ code: "ZZA", ...o })], { ZZA: flat() }, { profile }))[0]?.qty;
    expect(one({}, { holdings: 1, stockCapPpm: 300_000 })).toBe(30n); // 30 % of A$1,000
    expect(one({ tier: "U3" }, { holdings: 1 })).toBe(20n); // 20 % for a smaller company
    // risk: 2 % of A$1,000 lost at a stop 10 % away -> A$200
    expect(one({}, { riskPpm: 20_000 })).toBe(20n);
  });

  it("skips a held stock, a full portfolio, a stop above the buy, and a buy under the parcel", () => {
    const r = run(
      [pick({ code: "ZZA" }), pick({ code: "ZZA", rank: 2 }), pick({ code: "ZZB", rank: 3 })],
      { ZZA: flat(), ZZB: flat() },
      { profile: { holdings: 1 } },
    );
    expect(r.skipped.map((s) => [s.code, s.reason])).toEqual(
      expect.arrayContaining([
        ["ZZA", "held"],
        ["ZZB", "full"],
      ]),
    );
    const stop = run([pick({ code: "ZZC", stopMicro: 10n * M })], { ZZC: flat() });
    expect(stop.skipped).toEqual([{ pubD: DAYS[0], rank: 1, code: "ZZC", reason: "stop" }]);
    const small = run(
      [pick({ code: "ZZA" })],
      { ZZA: flat() },
      { p: { minParcelMicro: 300n * M } },
    );
    expect(small.skipped[0]!.reason).toBe("small");
    expect(small.trades).toEqual([]);
  });

  it("cost guard: no buy whose brokerage both ways is more than the limit of the buy", () => {
    // A$250 buy, A$1 each way = 0.8 %: refused at a 0.5 % limit, made at 1.5 %
    const refused = run([pick({ code: "ZZA" })], { ZZA: flat() }, { p: { costMaxPpm: 5_000 } });
    expect(refused.skipped[0]!.reason).toBe("cost");
    expect(refused.trades).toEqual([]);
    // the P5 schedule (A$5 each way) is refused at 1.5 % on A$250 (4 %)
    const dear = run(
      [pick({ code: "ZZA" })],
      { ZZA: flat() },
      { p: { costProfile: getCostProfile("P5") } },
    );
    expect(dear.skipped[0]!.reason).toBe("cost");
  });

  it("cash is respected: never spends more than it has", () => {
    const r = run(
      [pick({ code: "ZZA" })],
      { ZZA: flat() },
      {
        p: { seedMicro: 120n * M, minParcelMicro: 10n * M, costMaxPpm: 100_000 },
        profile: { holdings: 1 },
      },
    );
    // 30 % of A$120 = A$36 -> 3 shares (the stock cap is under the 40 % share)
    expect(buys(r)[0]!.qty).toBe(3n);
    expect(r.days.every((d) => d.cashMicro >= 0n)).toBe(true);
  });

  it("a strategy with no room left buys nothing more (the share is full)", () => {
    const r = run(
      [pick({ code: "ZZA" }), pick({ code: "ZZB", rank: 2 })],
      { ZZA: flat(), ZZB: flat() },
      { profile: { holdings: 4, stockCapPpm: 300_000 } },
    );
    // F1 has 40 %: A$250 then A$150 (its room), not a third
    expect(buys(r).map((t) => t.qty)).toEqual([25n, 14n]);
    const r2 = run(
      [pick({ code: "ZZA" }), pick({ code: "ZZB", rank: 2 }), pick({ code: "ZZC", rank: 3 })],
      { ZZA: flat(), ZZB: flat(), ZZC: flat() },
    );
    expect(r2.skipped.find((s) => s.code === "ZZC")?.reason).toBe("share");
  });

  it("several strategies: each gets its share, the larger share buys first", () => {
    const r = run(
      [
        pick({ code: "ZZA", strategy: "F1", stopMicro: 9n * M }),
        pick({ code: "ZZB", rank: 2, strategy: "SL", stopMicro: 9_500_000n }),
      ],
      { ZZA: flat(), ZZB: flat() },
    );
    // no record: equal evidence; SL's stop is half as far, so it gets twice the weight (capped)
    expect(r.splits[0]!.shares).toEqual([
      { strategy: "SL", targetPpm: 400_000 },
      { strategy: "F1", targetPpm: 333_333 },
    ]);
    expect(
      r.splits[0]!.words.startsWith("Nightly shortlist 40%, Follow the trend 33%, cash 27%."),
    ).toBe(true);
    expect(buys(r).map((t) => t.code)).toEqual(["ZZB", "ZZA"]);
  });
});

describe("selling (D-953)", () => {
  it("at the aim; the cash comes back with the net result", () => {
    const r = run([pick({ code: "ZZA", aimMicro: 12n * M })], {
      ZZA: bars([10, 10, 10.5, 11, 11.5, 11.5, 11.5, 11.5], { 4: [12.2, 11.4] }),
    });
    const s = sells(r)[0]!;
    expect(s).toMatchObject({
      d: DAYS[4],
      reason: "aim",
      priceMicro: 12n * M,
      closes: true,
      pos: 1,
    });
    expect(s.netMicro).toBe(25n * 12n * M - 1n * M - (250n * M + 1n * M));
    expect(s.words).toBe("Sold at the aim.");
    expect(r.holdings).toEqual([]);
  });

  it("at the stop-loss, and at the open when it gaps below it", () => {
    const stop = run([pick({ code: "ZZA" })], {
      ZZA: bars([10, 10, 10, 9.5, 9.5, 9.5, 9.5, 9.5], { 3: [10, 8.9] }),
    });
    expect(sells(stop)[0]).toMatchObject({ reason: "stop", d: DAYS[3] });
    const gap = run([pick({ code: "ZZA" })], {
      ZZA: bars([10, 10, 10, 8, 8, 8, 8, 8], {}, { 3: 8.5 }),
    });
    expect(sells(gap)[0]).toMatchObject({ reason: "gap", d: DAYS[3] });
    expect(sells(gap)[0]!.words).toContain("below the stop-loss");
  });

  it("time frame over: sold at the next open without support, kept while a strategy signals it", () => {
    const kept = run(
      [pick({ code: "ZZA", timeFrameSessions: 2 })],
      { ZZA: flat() },
      { signals: { ZZA: DAYS } },
    );
    expect(sells(kept)).toEqual([]);
    const quiet = run(
      [pick({ code: "ZZA", timeFrameSessions: 2 })],
      { ZZA: flat() },
      { signals: { ZZA: [DAYS[1]!] } },
    );
    expect(sells(quiet)[0]).toMatchObject({ reason: "time_frame", d: DAYS[3] });
  });

  it("weak: under the buy price and the average with no signal, sold at the next open", () => {
    const path = bars([10.4, 10, 9.8, 9.6, 9.4, 9.4, 9.4, 9.4]);
    const r = run([pick({ code: "ZZA", stopMicro: 5n * M })], { ZZA: path });
    expect(sells(r)[0]!.reason).toBe("weak");
    expect(sells(r)[0]!.words).toContain("3-day average");
    const kept = run(
      [pick({ code: "ZZA", stopMicro: 5n * M })],
      { ZZA: path },
      { signals: { ZZA: DAYS } },
    );
    expect(sells(kept)).toEqual([]);
  });

  it("the strategy's closing signal: sold at the next open", () => {
    const r = run([pick({ code: "ZZA" })], { ZZA: flat() }, { close: { "F1|ZZA": [DAYS[2]!] } });
    expect(sells(r)[0]).toMatchObject({ reason: "strategy_exit", d: DAYS[3], closes: true });
    expect(sells(r)[0]!.words).toBe("Sold: Follow the trend gave its sell signal.");
    // another strategy's closing signal does not sell it
    const other = run(
      [pick({ code: "ZZA" })],
      { ZZA: flat() },
      { close: { "F2|ZZA": [DAYS[2]!] } },
    );
    expect(sells(other)).toEqual([]);
  });

  it("the shortlist's closing signal: a close under its average", () => {
    const r = run(
      [pick({ code: "ZZA", strategy: "SL", stopMicro: 5n * M })],
      { ZZA: bars([10, 10, 10.2, 9.9, 9.9, 9.9, 9.9, 9.9]) },
      { signals: { ZZA: DAYS } },
    );
    expect(sells(r)[0]).toMatchObject({ reason: "strategy_exit", d: DAYS[4] });
    expect(sells(r)[0]!.words).toContain("Nightly shortlist trend broke");
  });

  it("picked again while held: not bought twice, kept under the new plan (stop never lower)", () => {
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
      { ZZA: flat() },
    );
    expect(buys(r)).toHaveLength(1);
    expect(sells(r)).toEqual([]); // the re-pick on day 2 reset the time frame
    expect(r.skipped).toEqual([{ pubD: DAYS[2], rank: 1, code: "ZZA", reason: "held" }]);
  });

  it("a split re-bases the shares and the levels", () => {
    const r = simulatePortfolio(
      {
        picks: [pick({ code: "ZZA" })],
        finished: [],
        bars: new Map([["ZZA", bars([10, 10, 10, 5, 5, 5, 5, 5])]]),
        signalDays: new Map(),
        closeSignals: new Map(),
        actions: new Map([["ZZA", [{ exD: DAYS[3]!, ratio: { num: 2n, den: 1n } }]]]),
        advMicro: new Map(),
        asOfD: DAYS[last]!,
      },
      P,
    );
    expect(r.holdings[0]).toMatchObject({ qty: 50n, entryMicro: 5n * M });
    expect(sells(r)).toEqual([]);
  });
});

describe("trimming (D-954)", () => {
  const rising = bars([10, 10, 32, 32, 32, 32, 32, 32]);
  it("a strategy past its share by more than the band is trimmed at the next open", () => {
    const r = run([pick({ code: "ZZA" })], { ZZA: rising });
    const trim = sells(r)[0]!;
    // value 749 + 800 = 1,549; 40 % = 619.6; over 180.4 -> 6 shares at A$32
    expect(trim).toMatchObject({ reason: "rebalance", d: DAYS[3], qty: 6n, closes: false, pos: 1 });
    expect(trim.words).toBe(
      "Trimmed: Follow the trend had 52% of the money, more than 10% over its 40% share.",
    );
    expect(r.holdings[0]!.qty).toBe(19n);
  });

  it("not within the band, not before the minimum holding time, not when the cost is too high", () => {
    expect(
      sells(run([pick({ code: "ZZA" })], { ZZA: rising }, { profile: { bandPpm: 200_000 } })),
    ).toEqual([]);
    const slow = run([pick({ code: "ZZA" })], { ZZA: rising }, { profile: { minHoldSessions: 4 } });
    expect(sells(slow)[0]!.d).toBe(DAYS[5]); // held 4 sessions first
    const dear = run(
      [pick({ code: "ZZA" })],
      { ZZA: rising },
      { p: { costProfile: getCostProfile("P3") } },
    );
    // A$6.50 on a A$192 sale is 3.4 % (a buy would be 6.8 %): the buy itself is refused first
    expect(dear.trades).toEqual([]);
  });

  it("a trim that would leave less than the parcel sells the whole holding", () => {
    // a losing record arrives after the buy: F1's share falls to 16 % (60 % of 40 % kept as cash)
    const losing: FinishedPick[] = Array.from({ length: 40 }, () => ({
      strategy: "F1",
      exitD: DAYS[1]!,
      netPpm: -20_000,
    }));
    const x: Extra = {
      finished: losing,
      p: { minParcelMicro: 200n * M },
      profile: { bandPpm: 50_000, allocation: { shrinkN: 20, volTilt: 1, weakCash: 0.6 } },
    };
    const whole = run([pick({ code: "ZZA" })], { ZZA: flat() }, x);
    // over by A$90 -> 10 shares, leaving A$150 under the A$200 parcel: all 25 are sold
    expect(sells(whole)[0]).toMatchObject({ reason: "rebalance", qty: 25n, closes: true });
    // with a A$100 parcel the trim would be partial, A$100 for A$1 brokerage (each side may cost half
    // the 1.5 % limit): too dear, not made; with a 3 % limit it is made
    const part = { ...x, p: { minParcelMicro: 100n * M } };
    expect(sells(run([pick({ code: "ZZA" })], { ZZA: flat() }, part))).toEqual([]);
    const cheap = run(
      [pick({ code: "ZZA" })],
      { ZZA: flat() },
      {
        ...x,
        p: { minParcelMicro: 100n * M, costMaxPpm: 30_000 },
      },
    );
    expect(sells(cheap)[0]).toMatchObject({ reason: "rebalance", qty: 10n, closes: false });
  });
});

describe("evidence and profiles (D-951, D-956)", () => {
  const two = [
    pick({ code: "ZZA", strategy: "F1" }),
    pick({ code: "ZZB", rank: 2, strategy: "F2" }),
  ];
  const record = (strategy: "F1" | "F2", n: number, netPpm: number): FinishedPick[] =>
    Array.from({ length: n }, (_, i) => ({
      strategy,
      exitD: "2030-02-01",
      netPpm: netPpm + (i % 2 === 0 ? 1000 : -1000),
    }));

  it("a winning record earns a larger share; a losing one keeps its weak share in cash", () => {
    const win = run(
      two,
      { ZZA: flat(), ZZB: flat() },
      { finished: [...record("F1", 40, 50_000), ...record("F2", 40, 5_000)] },
    );
    const [a, b] = win.splits[0]!.shares;
    expect(a!.strategy).toBe("F1");
    expect(a!.targetPpm).toBeGreaterThan(b!.targetPpm);
    const lose = run(
      [pick({ code: "ZZA" })],
      { ZZA: flat() },
      {
        finished: record("F1", 40, -30_000),
        profile: { allocation: { shrinkN: 20, volTilt: 1, weakCash: 0.5 } },
      },
    );
    expect(lose.splits[0]!.shares[0]!.targetPpm).toBe(200_000);
    expect(lose.splits[0]!.words).toContain("cash 80%");
  });

  it("results finished after the session are not used (no look-ahead)", () => {
    const later = run(
      two,
      { ZZA: flat(), ZZB: flat() },
      {
        finished: record("F1", 40, 50_000).map((f) => ({ ...f, exitD: DAYS[5]! })),
      },
    );
    expect(later.splits[0]!.shares.map((s) => s.targetPpm)).toEqual([400_000, 400_000]);
    // ... and the split changes once they are known, with a reason in words
    expect(later.splits.some((s) => s.d === DAYS[5])).toBe(false);
    const changed = later.splits.find((s) => s.d > DAYS[5]!);
    expect(changed?.words).toMatch(/\. Less for Good company, good news: no finished picks yet/);
  });

  it("the default profiles differ: conservative buys smaller and leans to calm strategies", () => {
    const settings: PortfolioSettings = {
      seedAud: 1000,
      stockMaxPct: 30,
      strategyMaxPct: 40,
      costMaxPct: 1.5,
      minParcelAud: 100,
      costProfile: "P6",
      profiles: MY_PORTFOLIO_PROFILES_DEFAULT,
    };
    const of = (name: "conservative" | "balanced" | "aggressive") =>
      run(
        [
          pick({ code: "ZZA", stopMicro: 9_400_000n }),
          pick({ code: "ZZB", rank: 2, strategy: "SL", stopMicro: 9_700_000n }),
        ],
        { ZZA: flat(), ZZB: flat() },
        { profile: profileParams(settings, name) },
      );
    const qty = (r: ReturnType<typeof run>, code: string) =>
      buys(r).find((t) => t.code === code)?.qty ?? 0n;
    const cons = of("conservative");
    const aggr = of("aggressive");
    expect(qty(cons, "ZZA")).toBeLessThan(qty(aggr, "ZZA"));
    // tilt: the calmer shortlist (3 % stop vs 6 %) gets relatively more in conservative
    const ratio = (r: ReturnType<typeof run>) => {
      const s = r.splits[0]!.shares;
      return (
        s.find((x) => x.strategy === "SL")!.targetPpm /
        s.find((x) => x.strategy === "F1")!.targetPpm
      );
    };
    expect(ratio(cons)).toBeGreaterThanOrEqual(ratio(of("balanced")));
    expect(profileParams(settings, "aggressive").holdings).toBe(3);
    expect(profileParams(settings, "conservative").stockCapPpm).toBe(250_000);
  });
});

describe("determinism and the record", () => {
  it("the same input in any order gives the same result", () => {
    const picks = [
      pick({ code: "ZZA" }),
      pick({ code: "ZZB", rank: 2, strategy: "SL", stopMicro: 9_500_000n }),
      pick({ code: "ZZC", rank: 3, strategy: "F3", entryD: DAYS[2]! }),
    ];
    const b = { ZZA: rising(), ZZB: flat(), ZZC: flat() };
    const one = run(picks, b);
    const two = run([...picks].reverse(), b);
    expect(two).toEqual(one);
    expect(run(picks, b)).toEqual(one);
    function rising() {
      return bars([10, 10, 11, 12, 13, 14, 15, 16]);
    }
  });

  it("the fall from the peak is tracked", () => {
    const r = run(
      [pick({ code: "ZZA", stopMicro: 5n * M })],
      {
        ZZA: bars([10, 10, 12, 8, 8, 8, 8, 8]),
      },
      { signals: { ZZA: DAYS } },
    );
    const worst = Math.min(...r.days.map((d) => d.fallPpm));
    expect(worst).toBeLessThan(0);
    expect(r.days.every((d) => d.fallPpm <= 0)).toBe(true);
  });

  it("no picks: nothing; a pick never bought leaves the money in cash", () => {
    expect(run([], {})).toEqual({ trades: [], holdings: [], days: [], splits: [], skipped: [] });
    const r = run([pick({ code: "ZZA", entryD: null, entryMicro: null })], { ZZA: flat() });
    expect(r.trades).toEqual([]);
    expect(r.splits).toEqual([]);
    expect(r.days.every((d) => d.valueMicro === P.seedMicro && d.holdings === 0)).toBe(true);
  });

  it("refuses a profile without holdings", () => {
    expect(() =>
      run([pick({ code: "ZZA" })], { ZZA: flat() }, { profile: { holdings: 0 } }),
    ).toThrow(RangeError);
  });
});
