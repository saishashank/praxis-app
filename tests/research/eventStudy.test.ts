// @vitest-environment node
// M23 R1 (D-1605, D-1627, D-1628): the research engine on small hand-computed fixtures. Every figure below is worked
// out by hand in the comments; prices are whole currency units times 1_000_000 (micro). The cost profile is P6 (the
// greater of 1.00 and 0.03 % of the value, each side).
import { describe, expect, it } from "vitest";
import { matchControls, type ControlCandidate } from "@/lib/research/controls";
import {
  ASSUMED_HAIRCUT_RULE,
  haircutPpm,
  LARGER_ACCOUNT_LABEL,
  NO_COST,
  parcelLabel,
  PARCEL_BASE_MICRO,
  PARCEL_LARGE_MICRO,
  profileCostFn,
  roundTripCostPpm,
  simulateTrade,
} from "@/lib/research/costs";
import {
  bonferroniAlpha,
  countEntries,
  eventStudy,
  lookOutcome,
  oneOpenPerCode,
  splitSetups,
  type Setup,
} from "@/lib/research/eventStudy";
import { entrySessionOf, resolveExit, stopPriceMicro, type PriceBook } from "@/lib/research/exits";

const U = 1_000_000n; // one currency unit in micro
const px = (units: number, hundredths = 0): bigint =>
  BigInt(units) * U + BigInt(hundredths) * 10_000n;
const P6 = profileCostFn("P6");

describe("costs", () => {
  it("P6 at the 600 parcel: 1.00 each side, 2.00 on a 10.00 flat trade = 3333 ppm (2 / 600 = 3333.33)", () => {
    expect(
      roundTripCostPpm({
        code: "ZZ1",
        priceMicro: px(10),
        parcelMicro: PARCEL_BASE_MICRO,
        cost: P6,
      }),
    ).toBe(3333n);
  });

  it("P6 at the 5,000 parcel: 0.03 % of 5,000 = 1.50 each side, 3.00 / 5,000 = 600 ppm", () => {
    expect(
      roundTripCostPpm({
        code: "ZZ1",
        priceMicro: px(10),
        parcelMicro: PARCEL_LARGE_MICRO,
        cost: P6,
      }),
    ).toBe(600n);
  });

  it("a winning trade at both parcels: 600 buys 60 shares, 10.50 out, net 30 - 2 = 28 = 46667 ppm", () => {
    const small = simulateTrade({
      code: "ZZ1",
      entryMicro: px(10),
      exitMicro: px(10, 50),
      parcelMicro: PARCEL_BASE_MICRO,
      cost: P6,
    });
    expect(small.quantity).toBe(60n);
    expect(small.feesMicro).toBe(2n * U);
    expect(small.netMicro).toBe(28n * U);
    expect(small.netPpm).toBe(46667n);
    // 5,000 buys 500 shares; fees 1.50 + 0.03 % of 5,250 (1.575); net 250 - 3.075 = 246.925; / 5,000 = 49385 ppm
    const large = simulateTrade({
      code: "ZZ1",
      entryMicro: px(10),
      exitMicro: px(10, 50),
      parcelMicro: PARCEL_LARGE_MICRO,
      cost: P6,
    });
    expect(large.quantity).toBe(500n);
    expect(large.feesMicro).toBe(3_075_000n);
    expect(large.netPpm).toBe(49385n);
  });

  it("whole shares floor, at least one; the net is over the entry value actually bought", () => {
    // 600 / 7.00 = 85.71 -> 85 shares, value 595
    const r = simulateTrade({
      code: "ZZ1",
      entryMicro: px(7),
      exitMicro: px(7),
      parcelMicro: PARCEL_BASE_MICRO,
      cost: NO_COST,
    });
    expect(r.quantity).toBe(85n);
    expect(r.entryValueMicro).toBe(595n * U);
    expect(r.netPpm).toBe(0n);
    expect(() =>
      simulateTrade({
        code: "ZZ1",
        entryMicro: 0n,
        exitMicro: px(1),
        parcelMicro: PARCEL_BASE_MICRO,
        cost: NO_COST,
      }),
    ).toThrow();
  });

  it("haircut: 1 point per 60 sessions held = 10000 ppm x hold / 60, half away from zero", () => {
    expect(haircutPpm(60, ASSUMED_HAIRCUT_RULE)).toBe(10000n);
    expect(haircutPpm(2, ASSUMED_HAIRCUT_RULE)).toBe(333n); // 333.33
    expect(haircutPpm(21, ASSUMED_HAIRCUT_RULE)).toBe(3500n);
    expect(haircutPpm(20, ASSUMED_HAIRCUT_RULE)).toBe(3333n);
    expect(haircutPpm(9, ASSUMED_HAIRCUT_RULE)).toBe(1500n);
    expect(haircutPpm(7, ASSUMED_HAIRCUT_RULE)).toBe(1167n); // 1166.67
    expect(haircutPpm(30, null)).toBe(0n);
  });

  it("the larger parcel is labelled, the base parcel is not (D-1627)", () => {
    expect(parcelLabel(PARCEL_BASE_MICRO)).toBeNull();
    expect(parcelLabel(PARCEL_LARGE_MICRO)).toBe(LARGER_ACCOUNT_LABEL);
    expect(LARGER_ACCOUNT_LABEL).toBe("Larger account, not your book");
  });
});

describe("exits", () => {
  const book = (opens: Record<number, bigint>, lows: Record<number, bigint> = {}): PriceBook => ({
    open: (_c, s) => opens[s],
    low: (_c, s) => lows[s],
  });

  it("time exit: in at the open after the signal, out at the open `hold` sessions later", () => {
    expect(entrySessionOf(4)).toBe(5);
    const r = resolveExit({
      rule: { kind: "time" },
      code: "ZZ1",
      entrySession: 5,
      hold: 3,
      entryMicro: px(10),
      prices: book({ 8: px(11) }),
    });
    expect(r).toEqual({ session: 8, priceMicro: px(11), reason: "time" });
  });

  it("a missing open is an unfilled setup, never a guess", () => {
    expect(
      resolveExit({
        rule: { kind: "time" },
        code: "ZZ1",
        entrySession: 5,
        hold: 3,
        entryMicro: px(10),
        prices: book({}),
      }),
    ).toBeUndefined();
  });

  it("stop: 5 % below 10.00 is 9.50; the first low at or below it exits at the NEXT open", () => {
    expect(stopPriceMicro(px(10), 50_000)).toBe(px(9, 50));
    const r = resolveExit({
      rule: { kind: "stop", stopBelowPpm: 50_000 },
      code: "ZZ1",
      entrySession: 5,
      hold: 4,
      entryMicro: px(10),
      prices: book({ 7: px(9, 20), 9: px(12) }, { 5: px(9, 90), 6: px(9, 50) }),
    });
    expect(r).toEqual({ session: 7, priceMicro: px(9, 20), reason: "stop" });
    const none = resolveExit({
      rule: { kind: "stop", stopBelowPpm: 50_000 },
      code: "ZZ1",
      entrySession: 5,
      hold: 4,
      entryMicro: px(10),
      prices: book({ 9: px(12) }, { 5: px(9, 90), 6: px(9, 60), 7: px(9, 51), 8: px(9, 99) }),
    });
    expect(none).toEqual({ session: 9, priceMicro: px(12), reason: "time" });
  });

  it("a stop rule without a low accessor is a programming error", () => {
    expect(() =>
      resolveExit({
        rule: { kind: "stop", stopBelowPpm: 1 },
        code: "Z",
        entrySession: 1,
        hold: 2,
        entryMicro: px(1),
        prices: { open: () => px(1) },
      }),
    ).toThrow();
  });
});

describe("controls", () => {
  const pool: ControlCandidate[] = [
    ...Array.from({ length: 30 }, (_, i) => ({
      code: `ZZC${String(i).padStart(2, "0")}`,
      tier: "T1",
      volDecile: 3,
    })),
    { code: "ZZX1", tier: "T2", volDecile: 3 },
    { code: "ZZX2", tier: "T1", volDecile: 4 },
  ];
  const subject = { code: "ZZS", tier: "T1", volDecile: 3 };

  it("matches tier and volatility decile, caps at k, is sorted by code and repeatable", () => {
    const a = matchControls({ subject, pool, matchOn: ["tier", "volDecile"], k: 20, scope: "s:1" });
    const b = matchControls({
      subject,
      pool: pool.slice().reverse(),
      matchOn: ["tier", "volDecile"],
      k: 20,
      scope: "s:1",
    });
    expect(a).toHaveLength(20);
    expect(a.map((c) => c.code)).toEqual(b.map((c) => c.code));
    expect(a.map((c) => c.code)).toEqual(
      a
        .map((c) => c.code)
        .slice()
        .sort(),
    );
    expect(a.every((c) => c.tier === "T1" && c.volDecile === 3)).toBe(true);
    const other = matchControls({
      subject,
      pool,
      matchOn: ["tier", "volDecile"],
      k: 20,
      scope: "s:2",
    });
    expect(other.map((c) => c.code)).not.toEqual(a.map((c) => c.code));
  });

  it("tier-only matching admits the other decile; the subject never controls itself; fewer than k is fine", () => {
    const t = matchControls({
      subject: { ...subject, code: "ZZC00" },
      pool,
      matchOn: ["tier"],
      k: 100,
      scope: "s:3",
    });
    expect(t.map((c) => c.code)).toContain("ZZX2");
    expect(t.map((c) => c.code)).not.toContain("ZZC00");
    expect(t).toHaveLength(30); // 29 other T1/3 + ZZX2
    expect(
      matchControls({
        subject: { code: "Q", tier: "T9" },
        pool,
        matchOn: ["tier"],
        k: 5,
        scope: "s:4",
      }),
    ).toEqual([]);
  });
});

describe("entries are counted first", () => {
  const set = (n: number, hold = 2): Setup[] =>
    Array.from({ length: n }, (_, i) => ({ code: `ZZ${i}`, signalSession: i, hold }));

  it("setups, distinct sessions and blocks of the longest hold, from entries alone", () => {
    expect(countEntries(set(6))).toEqual({ setups: 6, sessions: 6, blocks: 3, blockSessions: 2 });
    // two setups on one session count one session
    expect(countEntries([...set(4), { code: "ZZ9", signalSession: 0, hold: 2 }])).toMatchObject({
      setups: 5,
      sessions: 4,
      blocks: 2,
    });
  });

  it("one open position per code: an entry before the previous exit is dropped, at the exit open it is kept", () => {
    const s: Setup[] = [
      { code: "ZZA", signalSession: 0, hold: 3 }, // entry 1, exit 4
      { code: "ZZA", signalSession: 2, hold: 3 }, // entry 3 < 4: dropped
      { code: "ZZA", signalSession: 3, hold: 3 }, // entry 4 = exit open: kept
      { code: "ZZB", signalSession: 2, hold: 3 },
    ];
    expect(oneOpenPerCode(s).map((x) => `${x.code}${x.signalSession}`)).toEqual([
      "ZZA0",
      "ZZB2",
      "ZZA3",
    ]);
  });

  it("split: development before the boundary, holdout from it", () => {
    const { development, holdout } = splitSetups(set(6), 4);
    expect(development.map((s) => s.signalSession)).toEqual([0, 1, 2, 3]);
    expect(holdout.map((s) => s.signalSession)).toEqual([4, 5]);
  });

  it("Bonferroni: 0.10 / k", () => {
    expect(bonferroniAlpha(1)).toBeCloseTo(0.1, 12);
    expect(bonferroniAlpha(5)).toBeCloseTo(0.02, 12);
    expect(() => bonferroniAlpha(0)).toThrow();
  });
});

// The 6-setup table. Setup i signals at session i (0..5), hold 2: entry at session i+1 at 10.00, exit at session i+3.
// Exit prices 10.50, 10.20, 9.90, 10.10, 9.70, 10.30 -> after P6 fees (2.00 of 600) the nets are
//   28, 10, -8, 4, -20, 16 currency units on a 600 entry value = 46667, 16667, -13333, 6667, -33333, 26667 ppm.
// Controls are two flat codes at 10.00: net -2.00 = -3333 ppm. Excess = 50000, 20000, -10000, 10000, -30000, 30000
// (sum 70000, mean 11666.67). Haircut at hold 2: 333 ppm each; after it the sum is 70000 - 1998 = 68002 (mean 11333.67).
const EXIT_PRICE: Record<string, bigint> = {
  ZZA: px(10, 50),
  ZZB: px(10, 20),
  ZZC: px(9, 90),
  ZZD: px(10, 10),
  ZZE: px(9, 70),
  ZZF: px(10, 30),
};
const CODES = ["ZZA", "ZZB", "ZZC", "ZZD", "ZZE", "ZZF"];
const table: Setup[] = CODES.map((code, i) => ({
  code,
  signalSession: i,
  hold: 2,
  tier: "T1",
  volDecile: 3,
}));
const tablePrices: PriceBook = {
  open: (code, session) => {
    const i = CODES.indexOf(code);
    if (i >= 0) return session === i + 3 ? EXIT_PRICE[code] : px(10);
    return px(10); // the controls are flat
  },
};
const tablePool = (): ControlCandidate[] => [
  { code: "ZZK1", tier: "T1", volDecile: 3 },
  { code: "ZZK2", tier: "T1", volDecile: 3 },
];
const baseParams = {
  lineage: "zz_table",
  parcelMicro: PARCEL_BASE_MICRO,
  cost: P6,
  floors: { minSetups: 6, minBlocks: 3 },
  haircut: ASSUMED_HAIRCUT_RULE,
  matchOn: ["tier", "volDecile"] as const,
  replicates: 300,
};

describe("eventStudy on the 6-setup table", () => {
  it("net, control, excess and haircut per setup are the hand-computed integers", () => {
    const r = eventStudy(table, { prices: tablePrices, pool: tablePool }, baseParams);
    if (r.status !== "looked") throw new Error("expected a look");
    expect(r.rows.map((x) => x.netPpm)).toEqual([46667, 16667, -13333, 6667, -33333, 26667]);
    expect(r.rows.map((x) => x.controlPpm)).toEqual([-3333, -3333, -3333, -3333, -3333, -3333]);
    expect(r.rows.map((x) => x.excessPpm)).toEqual([50000, 20000, -10000, 10000, -30000, 30000]);
    expect(r.rows.map((x) => x.afterHaircutPpm)).toEqual([
      49667, 19667, -10333, 9667, -30333, 29667,
    ]);
    expect(r.withHaircut.n).toBe(6);
    expect(r.withHaircut.meanPpm).toBeCloseTo(68002 / 6, 9);
    expect(r.withoutHaircut.meanPpm).toBeCloseTo(70000 / 6, 9);
    expect(r.counts).toEqual({ setups: 6, sessions: 6, blocks: 3, blockSessions: 2 });
    expect(r.unfilled).toBe(0);
    expect(r.unmatched).toBe(0);
  });

  it("the lower bound is deterministic for a seed, at most the mean, and at most the point value", () => {
    const a = eventStudy(table, { prices: tablePrices, pool: tablePool }, baseParams);
    const b = eventStudy(table, { prices: tablePrices, pool: tablePool }, baseParams);
    expect(a).toEqual(b);
    if (a.status !== "looked") throw new Error("expected a look");
    expect(a.withHaircut.lowerPpm).not.toBeNull();
    expect(a.withHaircut.lowerPpm!).toBeLessThanOrEqual(a.withHaircut.meanPpm);
    expect(a.withHaircut.lowerPpm!).toBeGreaterThanOrEqual(-30333);
  });

  it("a smaller tail probability gives a lower (or equal) bound", () => {
    const loose = eventStudy(
      table,
      { prices: tablePrices, pool: tablePool },
      { ...baseParams, alpha: 0.1 },
    );
    const tight = eventStudy(
      table,
      { prices: tablePrices, pool: tablePool },
      { ...baseParams, alpha: bonferroniAlpha(5) },
    );
    if (loose.status !== "looked" || tight.status !== "looked") throw new Error("expected looks");
    expect(tight.withHaircut.alpha).toBeCloseTo(0.02, 12);
    expect(tight.withHaircut.lowerPpm!).toBeLessThanOrEqual(loose.withHaircut.lowerPpm!);
  });

  it("an identical excess in every setup puts the bound exactly on it, and the verdict follows the bound", () => {
    const same: PriceBook = {
      open: (code, session) =>
        CODES.includes(code) && session === CODES.indexOf(code) + 3 ? px(10, 50) : px(10),
    };
    const r = eventStudy(table, { prices: same, pool: tablePool }, baseParams);
    if (r.status !== "looked") throw new Error("expected a look");
    // every excess 50000, after haircut 49667: every replicate mean is 49667
    expect(r.withHaircut.lowerPpm).toBe(49667);
    expect(r.verdict).toBe("PASS");
    const flat: PriceBook = { open: () => px(10) };
    const n = eventStudy(table, { prices: flat, pool: tablePool }, baseParams);
    if (n.status !== "looked") throw new Error("expected a look");
    expect(n.withHaircut.lowerPpm).toBe(-333); // excess 0, haircut 333
    expect(n.verdict).toBe("NULL");
  });

  it("costs at 600 and 5,000: the same setups change only through the fees", () => {
    const small = eventStudy(table, { prices: tablePrices, pool: tablePool }, baseParams);
    const large = eventStudy(
      table,
      { prices: tablePrices, pool: tablePool },
      { ...baseParams, parcelMicro: PARCEL_LARGE_MICRO },
    );
    if (small.status !== "looked" || large.status !== "looked") throw new Error("expected looks");
    expect(large.parcelMicro).toBe(PARCEL_LARGE_MICRO.toString());
    // ZZA at 5,000: 49385 ppm net (see costs); the control flat trade is -600
    expect(large.rows[0]!.netPpm).toBe(49385);
    expect(large.rows[0]!.controlPpm).toBe(-600);
    expect(large.rows[0]!.excessPpm).toBe(49985);
    // fee drag is smaller at the larger parcel, so every net is higher than at 600 (same gross prices)
    large.rows.forEach((row, i) => expect(row.netPpm).toBeGreaterThan(small.rows[i]!.netPpm));
  });

  it("without a pool the excess is the net itself; unfilled and unmatched setups are counted", () => {
    const none = eventStudy(table, { prices: tablePrices }, baseParams);
    if (none.status !== "looked") throw new Error("expected a look");
    expect(none.rows.map((x) => x.excessPpm)).toEqual([46667, 16667, -13333, 6667, -33333, 26667]);
    const missing: PriceBook = {
      open: (c, s) => (c === "ZZC" ? undefined : tablePrices.open(c, s)),
    };
    const m = eventStudy(table, { prices: missing, pool: tablePool }, baseParams);
    if (m.status !== "looked") throw new Error("expected a look");
    expect(m.unfilled).toBe(1);
    expect(m.withHaircut.n).toBe(5);
    const noMatch = eventStudy(table, { prices: tablePrices, pool: () => [] }, baseParams);
    if (noMatch.status !== "looked") throw new Error("expected a look");
    expect(noMatch.unmatched).toBe(6);
    expect(noMatch.verdict).toBe("INCONCLUSIVE");
    expect(noMatch.withHaircut.lowerPpm).toBeNull();
  });
});

describe("below sample returns before any outcome is read (D-1605)", () => {
  const throwing: PriceBook = {
    open: () => {
      throw new Error("an outcome was read");
    },
    low: () => {
      throw new Error("an outcome was read");
    },
  };
  const throwingPool = (): ControlCandidate[] => {
    throw new Error("the pool was read");
  };

  it("7 setups needed, 6 given: below_sample, accessors never called", () => {
    const r = eventStudy(
      table,
      { prices: throwing, pool: throwingPool },
      { ...baseParams, floors: { minSetups: 7, minBlocks: 3 } },
    );
    expect(r.status).toBe("below_sample");
    if (r.status === "below_sample") {
      expect(r.counts.setups).toBe(6);
      expect(r.reason).toBe("6 setups, the floor is 7");
    }
  });

  it("blocks and sessions floors are entry counts too", () => {
    const a = eventStudy(
      table,
      { prices: throwing },
      { ...baseParams, floors: { minSetups: 6, minBlocks: 4 } },
    );
    expect(a).toMatchObject({ status: "below_sample", reason: "3 blocks, the floor is 4" });
    const b = eventStudy(
      table,
      { prices: throwing },
      { ...baseParams, floors: { minSetups: 6, minBlocks: 3, minSessions: 7 } },
    );
    expect(b).toMatchObject({ status: "below_sample", reason: "6 sessions, the floor is 7" });
  });

  it("the floor counts the setups that survive the one-open-position rule, not the raw list", () => {
    const dup: Setup[] = [...table, { code: "ZZA", signalSession: 1, hold: 2 }]; // entry 2 < ZZA's exit at 3: dropped
    const r = eventStudy(
      dup,
      { prices: throwing },
      { ...baseParams, floors: { minSetups: 7, minBlocks: 3 } },
    );
    expect(r).toMatchObject({ status: "below_sample", counts: { setups: 6 } });
  });

  it("at the floor it does read prices (the accessor is now called)", () => {
    expect(() => eventStudy(table, { prices: throwing }, baseParams)).toThrow(
      "an outcome was read",
    );
  });

  it("lookOutcome: below sample writes nothing; a verdict carries aggregates only", () => {
    const below = eventStudy(
      table,
      { prices: throwing },
      { ...baseParams, floors: { minSetups: 7, minBlocks: 3 } },
    );
    expect(lookOutcome(below)).toEqual({
      status: "below_sample",
      reason: "6 setups, the floor is 7",
    });
    const looked = lookOutcome(
      eventStudy(table, { prices: tablePrices, pool: tablePool }, baseParams),
    );
    if ("status" in looked) throw new Error("expected a verdict");
    expect(["PASS", "NULL", "INCONCLUSIVE"]).toContain(looked.verdict);
    expect(looked.nSetups).toBe(6);
    expect(looked.nBlocks).toBe(3);
    expect(JSON.stringify(looked)).not.toContain("ZZ");
  });
});
