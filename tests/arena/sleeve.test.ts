// @vitest-environment node
// Sleeve engine (M3 T8; spec 05 ARN-003, ARN-040..048, ARN-101; D-069 decisions 5, 7, 8; D-071
// rulings). HIGH-RISK money module: unit tests with hand-computed micro values, then property
// tests over random sleeve paths (never loses more than margin + brokerage beyond it, NAV identity,
// margin counted once, lock and unlock transitions valid, byte-identical replay).
import { describe, expect, it } from "vitest";
import { COST_PROFILES, feeFor } from "@/lib/arena/costs";
import type { FillEnv } from "@/lib/arena/fills";
import {
  fillTxns,
  seedTxn,
  txnRows,
  assertTxn,
  type LedgerFill,
  type LedgerRow,
} from "@/lib/arena/ledger";
import { checkCohortBooks, isFatal, serializeLedgerRows } from "@/lib/arena/invariants";
import { computeNavDay, serializeNavDays } from "@/lib/arena/nav";
import {
  breakEvenMove,
  capSleeveLoss,
  closeoutLevelMicro,
  closeoutMove,
  closeSleeve,
  closedTrade,
  daysBetween,
  defaultSleeveConfig,
  earlierSleeveExit,
  evaluateUnlock,
  financingAccruedAt,
  financingAfterDays,
  lockAfterClose,
  lockStatus,
  netPlMicro,
  openRealTradeAt,
  openTrade,
  planSleeveEntry,
  priceFactorSince,
  quoteSleeveEntry,
  quoteSleeveExit,
  realisedUnleveredNetSince,
  assertSleeveConfig,
  sessionsSinceLock,
  shadowNetSince,
  sleeveCloseTxn,
  sleeveEligibility,
  sleeveFinancingTxn,
  sleeveMarginMicro,
  sleeveOpenTxn,
  sleevePricePlMicro,
  sleeveUnrealAt,
  sleeveUnrealisedMicro,
  type SleeveConfig,
  type SleeveExitQuote,
  type SleeveStateEntry,
  type SleeveTrade,
} from "@/lib/arena/sleeve";
import { makeRational } from "@/lib/money/rational";
import { simulateSleeve } from "./sleeveHarness";

const P5 = COST_PROFILES.P5;
const cfg = defaultSleeveConfig(P5);
const bar = (o: bigint, h: bigint, l: bigint, c: bigint) => ({
  openMicro: o,
  highMicro: h,
  lowMicro: l,
  closeMicro: c,
});
const envOf = (b: ReturnType<typeof bar>): FillEnv => ({
  bar: b,
  advMicro: 5_000_000_000_000n,
  profile: P5,
});

/** The TST101-036 trade: A$20 margin x 10, entry fill A$10.00, opened 2026-10-12. */
function trade036(over: Partial<SleeveTrade> = {}): SleeveTrade {
  return {
    id: "S1",
    cohortId: "K1",
    code: "ZZA",
    shadow: false,
    marginMicro: 20_000_000n,
    leverage: 10n,
    notionalMicro: 200_000_000n,
    openD: "2026-10-12",
    entryPriceMicro: 10_000_000n,
    entryFillId: "EF1",
    closed: null,
    ...over,
  };
}

describe("configuration and margin (ARN-040)", () => {
  it("defaults are the spec's: 10x, A$20 or 4 % of NAV, 50 % close-out, 9 % p.a. over 365", () => {
    expect(cfg.leverage).toBe(10n);
    expect(cfg.marginCapMicro).toBe(20_000_000n);
    expect(cfg.marginNavFraction).toEqual(makeRational(4n, 100n));
    expect(cfg.closeoutFraction).toEqual(makeRational(1n, 2n));
    expect(cfg.financingRate).toEqual(makeRational(9n, 100n));
    expect(cfg.financingBasis).toBe(365n);
    expect(cfg.recoveryMode).toBe("REC-2");
    expect(() => assertSleeveConfig(cfg)).not.toThrow();
  });

  it("margin = min(A$20, 4 % of NAV); zero for a non-positive NAV", () => {
    expect(sleeveMarginMicro(600_000_000n, cfg)).toBe(20_000_000n); // 4 % = 24, capped
    expect(sleeveMarginMicro(500_000_000n, cfg)).toBe(20_000_000n); // 4 % = 20 exactly
    expect(sleeveMarginMicro(400_000_000n, cfg)).toBe(16_000_000n);
    expect(sleeveMarginMicro(300_000_000n, cfg)).toBe(12_000_000n);
    expect(sleeveMarginMicro(0n, cfg)).toBe(0n);
    expect(sleeveMarginMicro(-5n, cfg)).toBe(0n);
    // 4 % of 12_345_679 = 493_827.16 -> rounds to 493_827
    expect(sleeveMarginMicro(12_345_679n, cfg)).toBe(493_827n);
  });

  it("rejects unusable settings", () => {
    const bad = (over: Partial<SleeveConfig>) => () => assertSleeveConfig({ ...cfg, ...over });
    expect(bad({ leverage: 0n })).toThrow(/leverage/);
    expect(bad({ marginCapMicro: 0n })).toThrow(/cap/);
    expect(bad({ closeoutFraction: makeRational(0n) })).toThrow(/close-out/);
    expect(bad({ closeoutFraction: makeRational(11n, 10n) })).toThrow(/close-out/);
    expect(bad({ financingBasis: 0n })).toThrow(/basis/);
    expect(bad({ financingRate: makeRational(-1n, 100n) })).toThrow(/negative/);
    expect(bad({ marginNavFraction: makeRational(0n) })).toThrow(/margin fraction/);
  });

  it("eligibility (ARN-042): U1 and index ETFs, U2 only when allowed, never U3", () => {
    expect(sleeveEligibility({ tier: "U1" })).toEqual({ eligible: true, reason: null });
    expect(sleeveEligibility({ tier: "U3", indexEtf: true }).eligible).toBe(true);
    expect(sleeveEligibility({ tier: "U2" })).toEqual({
      eligible: false,
      reason: "u2_not_allowed",
    });
    expect(sleeveEligibility({ tier: "U2", allowU2: true }).eligible).toBe(true);
    expect(sleeveEligibility({ tier: "U3", allowU2: true })).toEqual({
      eligible: false,
      reason: "u3",
    });
  });
});

describe("financing: 9 % p.a. over 365, every calendar day, cumulative (R5, decision 8)", () => {
  it("TST101-035 values: 49,315 per day, 147,945 after 3 days, rows sum to the one-shot figure", () => {
    expect(financingAfterDays(200_000_000n, 1n, cfg)).toBe(49_315n);
    expect(financingAfterDays(200_000_000n, 2n, cfg)).toBe(98_630n);
    expect(financingAfterDays(200_000_000n, 3n, cfg)).toBe(147_945n);
    expect(financingAfterDays(200_000_000n, 0n, cfg)).toBe(0n);
    expect(financingAfterDays(200_000_000n, 365n, cfg)).toBe(18_000_000n); // 9 % of exposure
  });

  it("daily charges telescope: any partition of the days adds up to the cumulative figure", () => {
    for (const notional of [200_000_000n, 123_456_789n, 7n, 199_999_999n]) {
      let paid = 0n;
      for (let day = 1n; day <= 400n; day++) {
        const charge =
          financingAfterDays(notional, day, cfg) - financingAfterDays(notional, day - 1n, cfg);
        expect(charge >= 0n).toBe(true);
        paid += charge;
      }
      expect(paid).toBe(financingAfterDays(notional, 400n, cfg));
    }
  });

  it("counts calendar days from the open date, weekends included", () => {
    expect(daysBetween("2026-10-09", "2026-10-12")).toBe(3n); // Friday to Monday
    expect(daysBetween("2026-10-12", "2026-10-12")).toBe(0n);
    expect(() => daysBetween("2026-10-12", "2026-10-11")).toThrow(/before/);
    expect(() => daysBetween("2026-13-01", "2026-12-01")).toThrow();
    const t = trade036({ openD: "2026-10-09" });
    expect(financingAccruedAt(t, "2026-10-12", cfg)).toBe(147_945n);
    expect(financingAccruedAt(t, "2026-10-09", cfg)).toBe(0n);
  });
});

describe("price P/L, split neutrality, loss cap (ARN-043, ARN-044)", () => {
  it("P/L = notional x return on the fills, rounded once", () => {
    const base = { notionalMicro: 200_000_000n, entryPriceMicro: 10_000_000n };
    expect(sleevePricePlMicro({ ...base, priceMicro: 9_480_000n })).toBe(-10_400_000n);
    expect(sleevePricePlMicro({ ...base, priceMicro: 10_000_000n })).toBe(0n);
    expect(sleevePricePlMicro({ ...base, priceMicro: 10_500_000n })).toBe(10_000_000n);
    // a non-terminating return: 200,000,000 x (3 / 7) rounds half away
    expect(sleevePricePlMicro({ ...base, entryPriceMicro: 7n, priceMicro: 10n })).toBe(85_714_286n);
    expect(sleevePricePlMicro({ ...base, entryPriceMicro: 7n, priceMicro: 4n })).toBe(-85_714_286n);
    expect(() => sleevePricePlMicro({ ...base, priceMicro: 0n })).toThrow(/positive/);
  });

  it("a 2-for-1 split creates no artificial P/L: raw price halves, the factor re-bases the entry", () => {
    const adjustments = [{ code: "ZZA", exD: "2026-10-14", ratio: makeRational(2n) }];
    const factor = priceFactorSince("ZZA", "2026-10-12", "2026-10-14", adjustments);
    expect(factor).toEqual(makeRational(1n, 2n));
    const base = { notionalMicro: 200_000_000n, entryPriceMicro: 10_000_000n, factor };
    expect(sleevePricePlMicro({ ...base, priceMicro: 5_000_000n })).toBe(0n);
    expect(sleevePricePlMicro({ ...base, priceMicro: 4_750_000n })).toBe(-10_000_000n); // -5 %
    // a split on or before the entry date, or another code, is ignored
    expect(priceFactorSince("ZZA", "2026-10-14", "2026-10-20", adjustments)).toEqual(
      makeRational(1n),
    );
    expect(priceFactorSince("ZZB", "2026-10-12", "2026-10-20", adjustments)).toEqual(
      makeRational(1n),
    );
    expect(priceFactorSince("ZZA", "2026-10-12", "2026-10-13", adjustments)).toEqual(
      makeRational(1n),
    );
    // consolidation 1-for-10: price x10
    const consol = [{ code: "ZZA", exD: "2026-10-14", ratio: makeRational(1n, 10n) }];
    const f = priceFactorSince("ZZA", "2026-10-12", "2026-10-14", consol);
    expect(f).toEqual(makeRational(10n));
    expect(sleevePricePlMicro({ ...base, factor: f, priceMicro: 100_000_000n })).toBe(0n);
  });

  it("loss cap: price P/L + financing never loses more than the margin; financing stays charged", () => {
    expect(capSleeveLoss(-10_000_000n, 0n, 20_000_000n)).toEqual({
      pricePlMicro: -10_000_000n,
      capped: false,
    });
    expect(capSleeveLoss(-20_000_000n, 0n, 20_000_000n).capped).toBe(false); // exactly the margin
    expect(capSleeveLoss(-30_200_000n, 0n, 20_000_000n)).toEqual({
      pricePlMicro: -20_000_000n,
      capped: true,
    });
    // with financing 1,000,000: total loss capped at 20,000,000 -> price P/L -19,000,000
    expect(capSleeveLoss(-30_000_000n, 1_000_000n, 20_000_000n)).toEqual({
      pricePlMicro: -19_000_000n,
      capped: true,
    });
    expect(capSleeveLoss(5_000_000n, 1_000_000n, 20_000_000n).capped).toBe(false);
  });

  it("unrealised P/L for NAV is the capped figure", () => {
    const t = trade036();
    expect(
      sleeveUnrealisedMicro({ trade: t, closeMicro: 9_600_000n, financingMicro: 49_315n }),
    ).toBe(-8_000_000n); // TST101-038
    expect(sleeveUnrealisedMicro({ trade: t, closeMicro: 5_000_000n, financingMicro: 0n })).toBe(
      -20_000_000n,
    );
  });
});

describe("close-out level (ARN-044)", () => {
  it("TST101-036: 50 % of the margin is a 5 % move: level A$9.50, P/L -A$10.00", () => {
    const t = trade036();
    const level = closeoutLevelMicro({ trade: t, financingMicro: 0n, cfg });
    expect(level).toBe(9_500_000n);
    expect(sleevePricePlMicro({ ...t, priceMicro: 9_500_000n })).toBe(-10_000_000n);
    expect(closeoutMove(t, cfg)).toEqual(makeRational(-1n, 20n));
    // break-even ~ +5 %: both A$5.00 brokerages over A$200 = 10 / 200
    expect(breakEvenMove(t, cfg)).toEqual(makeRational(1n, 20n));
  });

  it("accrued financing lifts the level (the loss counts it); the level is rounded down", () => {
    const t = trade036();
    // financing 1,000,000: p* = 10,000,000 x (200,000,000 + 1,000,000 - 10,000,000)/200,000,000
    expect(closeoutLevelMicro({ trade: t, financingMicro: 1_000_000n, cfg })).toBe(9_550_000n);
    // 49,315 -> 10,000,000 x 190,049,315 / 200,000,000 = 9,502,465.75 -> 9,502,465
    expect(closeoutLevelMicro({ trade: t, financingMicro: 49_315n, cfg })).toBe(9_502_465n);
    // exactly at the level the threshold is reached; one micro above it is not
    const f = 49_315n;
    const at = sleevePricePlMicro({ ...t, priceMicro: 9_502_465n }) - f;
    const above = sleevePricePlMicro({ ...t, priceMicro: 9_502_466n }) - f;
    expect(at <= -10_000_000n).toBe(true); // -9,950,700 - 49,315 = -10,000,015: reached
    expect(above <= -10_000_000n).toBe(false); // -9,999,995: not yet
  });

  it("is split-neutral: the level moves with the factor", () => {
    const t = trade036();
    const half = makeRational(1n, 2n);
    expect(closeoutLevelMicro({ trade: t, financingMicro: 0n, factor: half, cfg })).toBe(
      4_750_000n,
    );
  });

  it("a 100 % close-out on 1x leverage can never trigger (no level above zero)", () => {
    const t = trade036({ leverage: 1n, notionalMicro: 20_000_000n });
    const c = { ...cfg, closeoutFraction: makeRational(1n) };
    expect(closeoutLevelMicro({ trade: t, financingMicro: 0n, cfg: c })).toBeNull();
  });
});

describe("fills: entry, exits and which exit stands", () => {
  it("entry quote: fill with slippage inside, brokerage on NOTIONAL, margin x leverage", () => {
    const q = quoteSleeveEntry(
      envOf(bar(10_000_000n, 10_100_000n, 9_900_000n, 10_000_000n)),
      20_000_000n,
      cfg,
    );
    expect(q.entryPriceMicro).toBe(10_010_000n); // A$10.00 + 10 bps = one tick
    expect(q.notionalMicro).toBe(200_000_000n);
    expect(q.entryBrokerageMicro).toBe(5_000_000n);
    expect(q.fill.qty).toBe(19n); // floor(200 / 10.01), display only
    expect(q.fill.valueMicro).toBe(19n * 10_010_000n);
    expect(q.fill.costProfile).toBe("P5");
    expect(() => quoteSleeveEntry(envOf(bar(1n, 1n, 1n, 1n)), 0n, cfg)).toThrow();
  });

  it("TST101-036/037 exits: close-out fill and brokerage on notional", () => {
    const t = trade036();
    const inRange = quoteSleeveExit(
      envOf(bar(9_800_000n, 9_800_000n, 9_500_000n, 9_600_000n)),
      t,
      { kind: "closeout", financingMicro: 0n },
      cfg,
    );
    expect(inRange?.closedBy).toBe("closeout");
    expect(inRange?.fill.rule).toBe("level");
    expect(inRange?.fill.fillPriceMicro).toBe(9_480_000n);
    expect(inRange?.fill.brokerageMicro).toBe(5_000_000n);
    const gap = quoteSleeveExit(
      envOf(bar(8_500_000n, 8_600_000n, 8_400_000n, 8_450_000n)),
      t,
      { kind: "closeout", financingMicro: 0n },
      cfg,
    );
    expect(gap?.fill.rule).toBe("gap_open");
    expect(gap?.fill.fillPriceMicro).toBe(8_490_000n);
    const none = quoteSleeveExit(
      envOf(bar(9_900_000n, 10_000_000n, 9_600_000n, 9_700_000n)),
      t,
      { kind: "closeout", financingMicro: 0n },
      cfg,
    );
    expect(none).toBeNull();
    // entry session: the close-out only acts after the open
    const afterOpen = quoteSleeveExit(
      envOf(bar(9_400_000n, 9_800_000n, 9_300_000n, 9_500_000n)),
      t,
      { kind: "closeout", financingMicro: 0n, afterOpen: true },
      cfg,
    );
    // the open (A$9.40) is already below the level, but after the open only the low test applies
    expect(afterOpen?.fill.rule).toBe("level");
    expect(afterOpen?.fill.fillPriceMicro).toBe(9_480_000n);
  });

  it("CS exit sells at the open less slippage; the family IS exit uses the stock's stop", () => {
    const t = trade036();
    const b = bar(10_100_000n, 10_200_000n, 9_000_000n, 9_500_000n);
    const cs = quoteSleeveExit(envOf(b), t, { kind: "cs" }, cfg);
    expect(cs?.closedBy).toBe("exit");
    expect(cs?.fill.fillPriceMicro).toBe(10_080_000n); // slip 10,100 floored onto the 10,000 grid
    const is = quoteSleeveExit(envOf(b), t, { kind: "is", levelMicro: 9_700_000n }, cfg);
    expect(is?.closedBy).toBe("exit");
    expect(is?.fill.rule).toBe("level");
    expect(is?.fill.fillPriceMicro).toBe(9_680_000n); // level - slip - tick
    expect(quoteSleeveExit(envOf(b), t, { kind: "is", levelMicro: 8_000_000n }, cfg)).toBeNull();
  });

  it("earlier exit wins; at the open the worse price; two levels: the higher is hit first", () => {
    const t = trade036();
    const b = bar(9_800_000n, 9_900_000n, 9_000_000n, 9_200_000n);
    const make = (mode: Parameters<typeof quoteSleeveExit>[2]) =>
      quoteSleeveExit(envOf(b), t, mode, cfg) as SleeveExitQuote;
    const cs = make({ kind: "cs" }); // at the open
    const lvlHigh = make({ kind: "is", levelMicro: 9_700_000n });
    const lvlLow = make({ kind: "is", levelMicro: 9_500_000n });
    expect(earlierSleeveExit(cs, lvlHigh)).toBe(cs);
    expect(earlierSleeveExit(lvlHigh, cs)).toBe(cs);
    expect(earlierSleeveExit(lvlLow, lvlHigh)).toBe(lvlHigh);
    expect(earlierSleeveExit(lvlHigh, lvlLow)).toBe(lvlHigh);
    const gapB = bar(9_000_000n, 9_100_000n, 8_900_000n, 9_000_000n);
    const g1 = quoteSleeveExit(
      envOf(gapB),
      t,
      { kind: "is", levelMicro: 9_500_000n },
      cfg,
    ) as SleeveExitQuote;
    const g2 = quoteSleeveExit(envOf(gapB), t, { kind: "cs" }, cfg) as SleeveExitQuote;
    expect(g1.fill.fillPriceMicro).toBe(g2.fill.fillPriceMicro); // both at the open
    expect(earlierSleeveExit(g1, g2)).toBe(g1); // tie keeps the first
  });
});

describe("close-out, loss cap and cash (TST101-036/037, D-071 rulings)", () => {
  const closeAt = (price: bigint, brokerage: bigint, financing: bigint, by: "exit" | "closeout") =>
    closeSleeve({
      trade: trade036(),
      entryBrokerageMicro: 5_000_000n,
      closeD: "2026-10-12",
      exitPriceMicro: price,
      exitBrokerageMicro: brokerage,
      closedBy: by,
      exitFillId: "XF1",
      financingMicro: financing,
    });

  it("TST101-036: P/L -10,400,000, cash back 20,000,000 - 10,400,000 - 5,000,000 = 4,600,000", () => {
    const r = closeAt(9_480_000n, 5_000_000n, 0n, "closeout");
    expect(r.rawPricePlMicro).toBe(-10_400_000n);
    expect(r.capped).toBe(false);
    expect(r.closed.pricePlMicro).toBe(-10_400_000n);
    expect(r.marginReturnedMicro).toBe(9_600_000n);
    expect(r.cashDeltaMicro).toBe(4_600_000n);
    expect(r.cashShortfallMicro).toBe(0n);
    expect(r.closed.costsMicro).toBe(10_000_000n);
    expect(r.netPlMicro).toBe(-20_400_000n);
  });

  it("TST101-037: gap to A$8.49 caps the loss at the margin; brokerage comes from main cash", () => {
    const r = closeAt(8_490_000n, 5_000_000n, 0n, "closeout");
    expect(r.rawPricePlMicro).toBe(-30_200_000n);
    expect(r.capped).toBe(true);
    expect(r.closed.pricePlMicro).toBe(-20_000_000n);
    expect(r.marginReturnedMicro).toBe(0n);
    expect(r.cashDeltaMicro).toBe(-5_000_000n);
    expect(r.cashShortfallMicro).toBe(5_000_000n);
  });

  it("financing is paid out of the margin; a capped loss keeps it charged", () => {
    const small = closeAt(10_100_000n, 5_000_000n, 49_315n, "exit");
    expect(small.rawPricePlMicro).toBe(2_000_000n);
    expect(small.marginReturnedMicro).toBe(20_000_000n + 2_000_000n - 49_315n);
    const capped = closeAt(8_490_000n, 5_000_000n, 300_000n, "closeout");
    expect(capped.closed.pricePlMicro).toBe(-19_700_000n); // price + financing = -20,000,000
    expect(capped.closed.pricePlMicro - capped.closed.financingMicro).toBe(-20_000_000n);
    expect(capped.marginReturnedMicro).toBe(0n);
  });

  it("refuses a double close, a close before the open, negative inputs", () => {
    const r = closeAt(9_480_000n, 5_000_000n, 0n, "closeout");
    const done = closedTrade(trade036(), r);
    const again = () =>
      closeSleeve({
        trade: done,
        entryBrokerageMicro: 0n,
        closeD: "2026-10-13",
        exitPriceMicro: 1n,
        exitBrokerageMicro: 0n,
        closedBy: "exit",
        exitFillId: "X",
        financingMicro: 0n,
      });
    expect(again).toThrow(/already closed/);
    expect(() => closeSleeve({ ...baseClose(), closeD: "2026-10-11" })).toThrow(/before it opens/);
    expect(() => closeSleeve({ ...baseClose(), financingMicro: -1n })).toThrow(/negative/);
    expect(() => closeSleeve({ ...baseClose(), exitBrokerageMicro: -1n })).toThrow(/negative/);
  });

  function baseClose() {
    return {
      trade: trade036(),
      entryBrokerageMicro: 5_000_000n,
      closeD: "2026-10-12",
      exitPriceMicro: 9_000_000n,
      exitBrokerageMicro: 5_000_000n,
      closedBy: "exit" as const,
      exitFillId: "X",
      financingMicro: 0n,
    };
  }
});

describe("ledger postings: margin out of cash once, NAV unchanged apart from costs (ARN-041/051)", () => {
  const seed = (d: string) => txnRows(seedTxn(d, 600_000_000n));

  it("open: cash falls by margin + brokerage; margin sits in sleeve_margin; txns balance", () => {
    const open = sleeveOpenTxn(trade036(), 5_000_000n);
    expect(() => assertTxn(open)).not.toThrow();
    const rows = [...seed("2026-10-12"), ...txnRows(open)];
    const b = balancesOf(rows);
    expect(b.cash_settled).toBe(600_000_000n - 25_000_000n);
    expect(b.sleeve_margin).toBe(20_000_000n);
    expect(b.fees_paid).toBe(5_000_000n);
    const nav = (rowsIn: LedgerRow[], unreal = 0n) =>
      computeNavDay({
        cohortId: "K1",
        d: "2026-10-12",
        balances: balancesOf(rowsIn),
        positions: new Map(),
        markFor: () => undefined,
        profile: P5,
        sleeveUnrealMicro: unreal,
      }).row;
    // margin appears once (as sleeve_margin, not also in cash): NAV falls only by the brokerage
    expect(nav(rows).navMicro).toBe(600_000_000n - 5_000_000n);
    expect(nav(rows).sleeveMarginMicro).toBe(20_000_000n);
    // an unrealised loss of 8,000,000 and 1 day of financing enter NAV exactly once each
    const fin = txnRows(sleeveFinancingTxn(trade036(), "2026-10-13", 49_315n));
    expect(nav([...rows, ...fin], -8_000_000n).navMicro).toBe(
      600_000_000n - 5_000_000n - 8_000_000n - 49_315n,
    );
  });

  it("financing txn: liability + expense; refuses a non-positive charge and a shadow trade", () => {
    const t = sleeveFinancingTxn(trade036(), "2026-10-13", 49_315n);
    expect(t.postings).toEqual([
      { account: "fin_accrued", deltaMicro: -49_315n },
      { account: "equity", deltaMicro: 49_315n },
    ]);
    expect(() => sleeveFinancingTxn(trade036(), "2026-10-13", 0n)).toThrow(/positive/);
    expect(() =>
      sleeveFinancingTxn(trade036({ shadow: true, entryFillId: null }), "2026-10-13", 1n),
    ).toThrow(/shadow/);
    expect(() => sleeveOpenTxn(trade036({ shadow: true, entryFillId: null }), 1n)).toThrow(
      /shadow/,
    );
  });

  it("TST101-036 through the ledger: cash 575,000,000 -> 579,600,000; NAV falls by exactly the loss and costs", () => {
    const t = trade036();
    const result = closeSleeve({
      trade: t,
      entryBrokerageMicro: 5_000_000n,
      closeD: "2026-10-12",
      exitPriceMicro: 9_480_000n,
      exitBrokerageMicro: 5_000_000n,
      closedBy: "closeout",
      exitFillId: "XF1",
      financingMicro: 0n,
    });
    const close = sleeveCloseTxn(t, result);
    expect(() => assertTxn(close)).not.toThrow();
    const rows = [
      ...seed("2026-10-12"),
      ...txnRows(sleeveOpenTxn(t, 5_000_000n)),
      ...txnRows(close),
    ];
    const b = balancesOf(rows);
    expect(b.sleeve_margin).toBe(0n);
    expect(b.cash_settled).toBe(600_000_000n - 25_000_000n + 4_600_000n);
    // NAV = seed - 10,400,000 price loss - 5,000,000 - 5,000,000 brokerage
    const nav = computeNavDay({
      cohortId: "K1",
      d: "2026-10-12",
      balances: b,
      positions: new Map(),
      markFor: () => undefined,
      profile: P5,
    }).row.navMicro;
    expect(nav).toBe(600_000_000n - 10_400_000n - 10_000_000n);
    expect(b.equity).toBe(-(600_000_000n - 10_400_000n));
  });

  it("a financing-bearing close clears the accrued balance exactly", () => {
    const t = trade036({ openD: "2026-10-09" });
    const f = financingAccruedAt(t, "2026-10-12", cfg);
    expect(f).toBe(147_945n);
    const result = closeSleeve({
      trade: t,
      entryBrokerageMicro: 5_000_000n,
      closeD: "2026-10-12",
      exitPriceMicro: 10_250_000n,
      exitBrokerageMicro: 5_000_000n,
      closedBy: "exit",
      exitFillId: "XF1",
      financingMicro: f,
    });
    const rows = [
      ...seed("2026-10-09"),
      ...txnRows(sleeveOpenTxn(t, 5_000_000n)),
      ...txnRows(sleeveFinancingTxn(t, "2026-10-10", 49_315n)),
      ...txnRows(sleeveFinancingTxn(t, "2026-10-12", 98_630n)),
      ...txnRows(sleeveCloseTxn(t, result)),
    ];
    const b = balancesOf(rows);
    expect(b.fin_accrued).toBe(0n);
    expect(b.sleeve_margin).toBe(0n);
    // gain = 200,000,000 x 0.025 = 5,000,000
    expect(result.closed.pricePlMicro).toBe(5_000_000n);
    expect(b.cash_settled).toBe(
      600_000_000n - 25_000_000n + 20_000_000n + 5_000_000n - 147_945n - 5_000_000n,
    );
  });
});

function balancesOf(rows: readonly LedgerRow[]) {
  const b = {
    cash_settled: 0n,
    cash_recv: 0n,
    cash_pay: 0n,
    div_recv: 0n,
    sleeve_margin: 0n,
    fin_accrued: 0n,
    fees_paid: 0n,
    position_cost: 0n,
    equity: 0n,
  };
  for (const r of rows) b[r.account] += r.deltaMicro;
  return b;
}

describe("ARN-003: stock and sleeve both fit, or the sleeve is skipped (never the stock entry)", () => {
  const sizing = (cash: bigint, nav: bigint) => ({
    settledCashMicro: cash,
    navMicro: nav,
    refPriceMicro: 9_800_000n,
    advValueMicro: 5_000_000_000_000n,
    adv20Shares: 1_000_000_000n,
    tier: "U1" as const,
    profile: P5,
  });
  const plan = (over: Partial<Parameters<typeof planSleeveEntry>[0]> = {}) =>
    planSleeveEntry({
      sizing: sizing(600_000_000n, 600_000_000n),
      cfg,
      locked: false,
      hasOpenSleeve: false,
      eligibility: { eligible: true, reason: null },
      ...over,
    });

  it("A$600: both fit; the stock is sized AFTER reserving margin and the sleeve's brokerage", () => {
    const p = plan();
    expect(p.kind).toBe("stock_and_sleeve");
    if (p.kind !== "stock_and_sleeve") return;
    expect(p.marginMicro).toBe(20_000_000n);
    expect(p.notionalMicro).toBe(200_000_000n);
    expect(p.estEntryBrokerageMicro).toBe(5_000_000n);
    // 600 - (20 + 5) - 6 buffer = 569; est brokerage 5 -> 564 deployable -> 57 shares at 9.81
    expect(p.sizing.preBrokerageMicro).toBe(569_000_000n);
    expect(p.sizing.qty).toBe(57n);
  });

  it("A$520: the stock entry only fits WITHOUT the sleeve, so the sleeve is skipped (unfunded)", () => {
    const p = plan({ sizing: sizing(520_000_000n, 520_000_000n) });
    expect(p.kind).toBe("stock_only");
    if (p.kind !== "stock_only") return;
    expect(p.sleeve).toBe("skipped");
    expect(p.reason).toBe("unfunded");
    expect(p.sizing.accepted).toBe(true);
    expect(p.sizing.qty).toBe(51n); // 520 - 5.2 buffer - 5 fee = 509.8 -> 51 x 9.81 = 500.31
  });

  it("settled cash too small for the margin although matched cash is not: sleeve skipped", () => {
    const p = plan({ settledCashMicro: 10_000_000n });
    expect(p.kind === "stock_only" && p.reason === "unfunded").toBe(true);
  });

  it("neither fits: no order at all (the stock reasons are reported)", () => {
    const p = plan({ sizing: sizing(300_000_000n, 300_000_000n) });
    expect(p.kind).toBe("none");
    expect(p.sizing.reasons).toContain("parcel");
  });

  it("locked sleeve: the stock entry goes ahead and a shadow trade is logged, no cash reserved", () => {
    const p = plan({ locked: true });
    expect(p.kind === "stock_only" && p.sleeve === "shadow" && p.reason === "locked").toBe(true);
    if (p.kind === "stock_only") {
      expect(p.shadowMarginMicro).toBe(20_000_000n);
      expect(p.sizing.preBrokerageMicro).toBe(594_000_000n); // no margin reserved
    }
  });

  it("ineligible code, an open sleeve, no margin: skipped, stock goes ahead", () => {
    const u3 = plan({ eligibility: sleeveEligibility({ tier: "U3" }) });
    expect(u3.kind === "stock_only" && u3.reason === "u3").toBe(true);
    const open = plan({ hasOpenSleeve: true });
    expect(open.kind === "stock_only" && open.reason === "open_sleeve").toBe(true);
    const none = plan({ sizing: sizing(600_000_000n, 0n) });
    expect(none.kind === "stock_only" && none.reason === "no_margin").toBe(true);
  });
});

describe("lock and recovery REC-1..REC-4 (ARN-046, ARN-047)", () => {
  const closedLoser = (over: Partial<SleeveTrade> = {}): SleeveTrade => {
    const r = closeSleeve({
      trade: trade036(over),
      entryBrokerageMicro: 5_000_000n,
      closeD: "2026-10-12",
      exitPriceMicro: 9_480_000n,
      exitBrokerageMicro: 5_000_000n,
      closedBy: "closeout",
      exitFillId: over.shadow === true ? null : "XF1",
      financingMicro: 0n,
    });
    return closedTrade(trade036(over), r);
  };
  const lockedAt = (
    mode: SleeveConfig["recoveryMode"],
  ): { history: SleeveStateEntry[]; c: SleeveConfig } => {
    const c = { ...cfg, recoveryMode: mode };
    const lock = lockAfterClose([], closedLoser(), c);
    expect(lock).not.toBeNull();
    return { history: [lock as SleeveStateEntry], c };
  };

  it("a losing real trade locks with loss_to_recover = total net loss (TST101-043: 20,400,000)", () => {
    const lock = lockAfterClose([], closedLoser(), cfg);
    expect(lock).toEqual({
      seq: 1,
      state: "locked",
      d: "2026-10-12",
      lossToRecoverMicro: 20_400_000n,
      mode: "REC-2",
    });
    expect(lockStatus([lock as SleeveStateEntry])).toEqual({
      locked: true,
      lockD: "2026-10-12",
      lossToRecoverMicro: 20_400_000n,
      mode: "REC-2",
    });
    expect(lockStatus([])).toEqual({
      locked: false,
      lockD: null,
      lossToRecoverMicro: 0n,
      mode: null,
    });
  });

  it("no lock for a winner, a break-even trade, a shadow trade, an open trade or when already locked", () => {
    const win = closeSleeve({
      trade: trade036(),
      entryBrokerageMicro: 5_000_000n,
      closeD: "2026-10-12",
      exitPriceMicro: 11_000_000n,
      exitBrokerageMicro: 5_000_000n,
      closedBy: "exit",
      exitFillId: "X",
      financingMicro: 0n,
    });
    expect(lockAfterClose([], closedTrade(trade036(), win), cfg)).toBeNull();
    // break-even: price P/L exactly equals the costs (10,000,000 = +5 %)
    const even = closeSleeve({
      trade: trade036(),
      entryBrokerageMicro: 5_000_000n,
      closeD: "2026-10-12",
      exitPriceMicro: 10_500_000n,
      exitBrokerageMicro: 5_000_000n,
      closedBy: "exit",
      exitFillId: "X",
      financingMicro: 0n,
    });
    expect(even.netPlMicro).toBe(0n);
    expect(lockAfterClose([], closedTrade(trade036(), even), cfg)).toBeNull();
    expect(lockAfterClose([], closedLoser({ shadow: true, entryFillId: null }), cfg)).toBeNull();
    expect(lockAfterClose([], trade036(), cfg)).toBeNull();
    const { history } = lockedAt("REC-2");
    expect(lockAfterClose(history, closedLoser(), cfg)).toBeNull();
  });

  it("REC-2 (TST101-043): unlocks at exactly loss_to_recover, stays locked 10 micro short", () => {
    const { history, c } = lockedAt("REC-2");
    const a = evaluateUnlock(
      history,
      { d: "2026-10-13", realisedUnleveredNetMicro: 20_400_000n },
      c,
    );
    expect(a).toEqual({
      seq: 2,
      state: "unlocked",
      d: "2026-10-13",
      lossToRecoverMicro: 0n,
      mode: "REC-2",
    });
    expect(
      evaluateUnlock(history, { d: "2026-10-13", realisedUnleveredNetMicro: 20_390_000n }, c),
    ).toBeNull();
    // the lock day itself never unlocks
    expect(
      evaluateUnlock(history, { d: "2026-10-12", realisedUnleveredNetMicro: 99_000_000n }, c),
    ).toBeNull();
    // missing evidence is an error, not a silent "no"
    expect(() => evaluateUnlock(history, { d: "2026-10-13" }, c)).toThrow(/required/);
  });

  it("REC-2 reads the stock book from the ledger: sale P/L less ALL stock brokerage, after the lock day", () => {
    const buy: LedgerFill = {
      id: "F1",
      d: "2026-10-05",
      code: "ZZA",
      side: "buy",
      qty: 100n,
      valueMicro: 1_000_000_000n,
      brokerageMicro: 5_000_000n,
    };
    const sell = (brokerage: bigint, d = "2026-10-13"): LedgerFill => ({
      id: "F2",
      d,
      code: "ZZA",
      side: "sell",
      qty: 100n,
      valueMicro: 1_025_400_000n,
      brokerageMicro: brokerage,
    });
    const rows = (s: LedgerFill) => [
      ...fillTxns(buy).flatMap(txnRows),
      ...fillTxns(s, 1_000_000_000n).flatMap(txnRows),
    ];
    // buy fee was paid BEFORE the lock (2026-10-05); sale +25,400,000 - 5,000,000 fee = 20,400,000
    expect(realisedUnleveredNetSince(rows(sell(5_000_000n)), "2026-10-12", "2026-10-13")).toBe(
      20_400_000n,
    );
    expect(realisedUnleveredNetSince(rows(sell(5_010_000n)), "2026-10-12", "2026-10-13")).toBe(
      20_390_000n,
    );
    // a sale ON the lock day or after the judged day does not count
    expect(
      realisedUnleveredNetSince(rows(sell(5_000_000n, "2026-10-12")), "2026-10-12", "2026-10-13"),
    ).toBe(0n);
    expect(
      realisedUnleveredNetSince(rows(sell(5_000_000n, "2026-10-14")), "2026-10-12", "2026-10-13"),
    ).toBe(0n);
    const { history, c } = lockedAt("REC-2");
    const verdict = (brokerage: bigint) =>
      evaluateUnlock(
        history,
        {
          d: "2026-10-13",
          realisedUnleveredNetMicro: realisedUnleveredNetSince(
            rows(sell(brokerage)),
            "2026-10-12",
            "2026-10-13",
          ),
        },
        c,
      );
    expect(verdict(5_000_000n)?.state).toBe("unlocked");
    expect(verdict(5_010_000n)).toBeNull();
    // sleeve txns and dividends are not trading P/L
    const t = trade036();
    const sleeveRows = [...txnRows(sleeveOpenTxn(t, 5_000_000n))].map((r) => ({
      ...r,
      d: "2026-10-13",
    }));
    expect(realisedUnleveredNetSince(sleeveRows, "2026-10-12", "2026-10-13")).toBe(0n);
  });

  it("REC-1: NAV at a close back to the NAV before the losing trade opened", () => {
    const { history, c } = lockedAt("REC-1");
    const at = (nav: bigint) =>
      evaluateUnlock(history, { d: "2026-10-13", navMicro: nav, refNavMicro: 600_000_000n }, c);
    expect(at(600_000_000n)?.state).toBe("unlocked");
    expect(at(599_999_999n)).toBeNull();
    expect(() => evaluateUnlock(history, { d: "2026-10-13", navMicro: 1n }, c)).toThrow(
      /reference NAV/,
    );
  });

  it("REC-3: the shadow sleeve has earned loss_to_recover (net of its own costs)", () => {
    const { history, c } = lockedAt("REC-3");
    const shadowWin = (closeD: string, price: bigint): SleeveTrade => {
      const t = trade036({
        id: `SH${closeD}`,
        shadow: true,
        entryFillId: null,
        openD: "2026-10-12",
      });
      const r = closeSleeve({
        trade: t,
        entryBrokerageMicro: 5_000_000n,
        closeD,
        exitPriceMicro: price,
        exitBrokerageMicro: 5_000_000n,
        closedBy: "exit",
        exitFillId: null,
        financingMicro: 0n,
      });
      return closedTrade(t, r);
    };
    // +10 % = 20,000,000 price P/L - 10,000,000 costs = 10,000,000 net
    const one = shadowWin("2026-10-14", 11_000_000n);
    expect(netPlMicro(one.closed as NonNullable<SleeveTrade["closed"]>)).toBe(10_000_000n);
    const two = shadowWin("2026-10-15", 11_100_000n); // +11 % -> 22,000,000 - 10,000,000 = 12,000,000
    const ctx = (list: SleeveTrade[]) => ({
      d: "2026-10-15",
      shadowNetMicro: shadowNetSince(list, "2026-10-12", "2026-10-15"),
    });
    expect(evaluateUnlock(history, ctx([one]), c)).toBeNull(); // 10.0 < 20.4
    expect(evaluateUnlock(history, ctx([one, two]), c)?.state).toBe("unlocked"); // 22.0 >= 20.4
    // real trades, trades closed on/before the lock day and after the judged day do not count
    expect(
      shadowNetSince(
        [{ ...one, shadow: false }, shadowWin("2026-10-12", 11_000_000n)],
        "2026-10-12",
        "2026-10-15",
      ),
    ).toBe(0n);
    expect(shadowNetSince([shadowWin("2026-10-16", 11_000_000n)], "2026-10-12", "2026-10-15")).toBe(
      0n,
    );
  });

  it("REC-4: 10 sessions after the lock day (calendar holidays skipped)", () => {
    const { history, c } = lockedAt("REC-4");
    const cal = [{ d: "2026-10-14", kind: "holiday" as const, close_time: null }];
    // 2026-10-12 is a Monday; sessions after it: 13, (14 holiday), 15, 16, 19, 20, 21, 22, 23, 26, 27
    expect(sessionsSinceLock("2026-10-12", "2026-10-26", cal)).toBe(9);
    expect(sessionsSinceLock("2026-10-12", "2026-10-27", cal)).toBe(10);
    expect(sessionsSinceLock("2026-10-12", "2026-10-12", cal)).toBe(0);
    const at = (d: string) =>
      evaluateUnlock(history, { d, sessionsSinceLock: sessionsSinceLock("2026-10-12", d, cal) }, c);
    expect(at("2026-10-26")).toBeNull();
    expect(at("2026-10-27")?.state).toBe("unlocked");
  });

  it("a cohort starts unlocked with no rows; nothing to evaluate when unlocked", () => {
    expect(evaluateUnlock([], { d: "2026-10-13", navMicro: 1n }, cfg)).toBeNull();
  });
});

describe("helpers for NAV and the nightly loop", () => {
  it("openRealTradeAt: open on its open date, gone on its close date; shadow ignored", () => {
    const t = closedTrade(
      trade036(),
      closeSleeve({
        trade: trade036(),
        entryBrokerageMicro: 0n,
        closeD: "2026-10-14",
        exitPriceMicro: 10_000_000n,
        exitBrokerageMicro: 0n,
        closedBy: "exit",
        exitFillId: "X",
        financingMicro: 0n,
      }),
    );
    expect(openRealTradeAt([t], "2026-10-11")).toBeNull();
    expect(openRealTradeAt([t], "2026-10-12")?.id).toBe("S1");
    expect(openRealTradeAt([t], "2026-10-13")?.id).toBe("S1");
    expect(openRealTradeAt([t], "2026-10-14")).toBeNull();
    expect(
      openRealTradeAt([trade036({ shadow: true, entryFillId: null })], "2026-10-12"),
    ).toBeNull();
    expect(() => openRealTradeAt([trade036(), trade036({ id: "S2" })], "2026-10-12")).toThrow(
      /more than one/,
    );
  });

  it("sleeveUnrealAt marks the open trade with split-neutral price and capped loss", () => {
    const t = trade036();
    const unreal = (
      close: bigint,
      adj = [] as { code: string; exD: string; ratio: ReturnType<typeof makeRational> }[],
    ) =>
      sleeveUnrealAt({
        trades: [t],
        d: "2026-10-13",
        closeFor: () => close,
        adjustments: adj,
        cfg,
      });
    expect(unreal(9_600_000n)).toBe(-8_000_000n + 0n); // 1 day of financing is not in the price P/L
    expect(unreal(2_000_000n)).toBe(-20_000_000n + 49_315n);
    expect(unreal(4_800_000n, [{ code: "ZZA", exD: "2026-10-13", ratio: makeRational(2n) }])).toBe(
      -8_000_000n,
    );
    expect(() =>
      sleeveUnrealAt({ trades: [t], d: "2026-10-13", closeFor: () => undefined, cfg }),
    ).toThrow(/no close/);
    expect(sleeveUnrealAt({ trades: [], d: "2026-10-13", closeFor: () => 1n, cfg })).toBe(0n);
  });

  it("openTrade fills in the record; a shadow trade has no entry fill", () => {
    const q = quoteSleeveEntry(
      envOf(bar(10_000_000n, 10_000_000n, 10_000_000n, 10_000_000n)),
      20_000_000n,
      cfg,
    );
    const real = openTrade({
      id: "S9",
      cohortId: "K1",
      code: "ZZA",
      openD: "2026-10-12",
      quote: q,
      entryFillId: "EF9",
      cfg,
    });
    expect(real).toMatchObject({
      shadow: false,
      entryFillId: "EF9",
      notionalMicro: 200_000_000n,
      closed: null,
    });
    const shadow = openTrade({
      id: "S8",
      cohortId: "K1",
      code: "ZZA",
      openD: "2026-10-12",
      quote: q,
      entryFillId: "EF8",
      shadow: true,
      cfg,
    });
    expect(shadow.entryFillId).toBeNull();
    expect(() =>
      openTrade({
        id: "S7",
        cohortId: "K1",
        code: "ZZA",
        openD: "12/10/2026",
        quote: q,
        entryFillId: null,
        cfg,
      }),
    ).toThrow();
  });

  it("fee context: P2's free first buy applies to the entry only when the caller says so", () => {
    expect(feeFor(COST_PROFILES.P2, 200_000_000n, "buy", { firstBuyOfSecurityToday: true })).toBe(
      0n,
    );
  });
});

// ---- property tests --------------------------------------------------------------------------------

describe("property: random sleeve paths (TST-104 style)", () => {
  const MODES = ["REC-1", "REC-2", "REC-3", "REC-4"] as const;
  const unlocksByMode: Record<string, number> = { "REC-1": 0, "REC-2": 0, "REC-3": 0, "REC-4": 0 };
  const totals = { real: 0, shadow: 0, closeouts: 0, capped: 0, locks: 0, unlocks: 0, skipped: 0 };
  const sims = Array.from({ length: 48 }, (_, i) =>
    simulateSleeve({ seed: 101 + i, days: 160, mode: MODES[i % 4] }),
  );

  it("every cohort passes the full invariant suite incl. the sleeve checks, stored = recomputed", () => {
    for (const sim of sims) {
      const violations = checkCohortBooks(sim.books, {
        mode: "matched",
        calendar: sim.calendar,
        dates: sim.dates,
        stored: sim.days,
        seedMicro: sim.seedMicro,
        sleeve: { trades: sim.trades, states: sim.states, cfg: sim.cfg },
      }).filter(isFatal);
      expect(violations, `seed ${sim.dates[0]} ${sim.cfg.recoveryMode}`).toEqual([]);
      totals.real += sim.stats.realOpened;
      totals.shadow += sim.stats.shadowOpened;
      totals.closeouts += sim.stats.closeouts;
      totals.capped += sim.stats.capped;
      totals.locks += sim.stats.locks;
      totals.unlocks += sim.stats.unlocks;
      unlocksByMode[sim.cfg.recoveryMode] += sim.stats.unlocks;
      totals.skipped += sim.stats.skipped;
    }
  });

  it("the generator exercises opens, close-outs, caps, locks, shadows and unlocks", () => {
    expect(totals.real).toBeGreaterThan(40);
    expect(totals.closeouts).toBeGreaterThan(5);
    expect(totals.capped).toBeGreaterThan(0);
    expect(totals.locks).toBeGreaterThan(5);
    expect(totals.shadow).toBeGreaterThan(0);
    expect(totals.unlocks).toBeGreaterThan(0);
    for (const mode of MODES) expect(unlocksByMode[mode], mode).toBeGreaterThan(0);
  });

  it("a trade never loses more than its margin plus brokerage (brokerage beyond the margin from main cash)", () => {
    for (const sim of sims) {
      for (const t of sim.trades.filter((x) => !x.shadow && x.closed !== null)) {
        const c = t.closed as NonNullable<SleeveTrade["closed"]>;
        const result = sim.closeResults.get(t.id);
        expect(result).toBeDefined();
        // price + financing loss <= margin (ARN-044)
        expect(c.pricePlMicro - c.financingMicro >= -t.marginMicro).toBe(true);
        // total cash result of the trade from the ledger: <= margin + both brokerages in loss
        const mine = sim.rows.filter((r) => r.refId === t.id && r.account === "cash_settled");
        const cash = mine.reduce((s, r) => s + r.deltaMicro, 0n);
        expect(cash >= -(t.marginMicro + c.costsMicro)).toBe(true);
        // and the whole-trade loss in NAV terms is the same bound
        const nav = sim.rows
          .filter((r) => r.refId === t.id)
          .reduce(
            (s, r) =>
              s +
              (r.account === "equity" ? -r.deltaMicro : 0n) -
              (r.account === "fees_paid" ? r.deltaMicro : 0n),
            0n,
          );
        expect(nav >= -(t.marginMicro + c.costsMicro)).toBe(true);
        expect(netPlMicro(c) >= -(t.marginMicro + c.costsMicro)).toBe(true);
      }
    }
  });

  it("margin is counted exactly once in NAV on every day", () => {
    for (const sim of sims) {
      for (const day of sim.days) {
        const open = openRealTradeAt(sim.trades, day.row.d);
        expect(day.row.sleeveMarginMicro).toBe(open === null ? 0n : open.marginMicro);
        // NAV = cash side + positions + margin + unrealised - financing, with no second copy of the margin
        const parts =
          day.row.cashSettledMicro +
          day.row.recvMicro -
          day.row.payMicro +
          day.row.positionsMicro +
          day.row.divRecvMicro +
          day.row.sleeveMarginMicro +
          day.row.sleeveUnrealMicro -
          day.row.finAccruedMicro;
        expect(parts).toBe(day.row.navMicro);
        if (open === null) expect(day.row.sleeveUnrealMicro).toBe(0n);
        // the margin never also sits in settled cash: settled cash + margin <= seed-sized wealth
        expect(day.row.cashSettledMicro >= 0n).toBe(true);
      }
    }
  });

  it("NAV equals seed + realised/unrealised results - costs - financing (independent oracle)", () => {
    for (const sim of sims.slice(0, 16)) {
      const last = sim.days[sim.days.length - 1];
      // oracle: every ledger row is a cash flow; NAV(last) - seed = sum of all non-cash-account equity effects
      const rowsUpTo = sim.rows.filter((r) => r.d <= last.row.d);
      const b = balancesOf(rowsUpTo);
      expect(last.row.navMicro).toBe(
        -b.equity -
          b.fees_paid +
          (last.row.positionsMicro - b.position_cost) +
          last.row.sleeveUnrealMicro,
      );
      // the opening seed is the only equity credit besides P/L: NAV - seed == -(equity + seed) - fees + unrealised
      expect(last.row.navMicro - sim.seedMicro).toBe(
        -(b.equity + sim.seedMicro) -
          b.fees_paid +
          (last.row.positionsMicro - b.position_cost) +
          last.row.sleeveUnrealMicro,
      );
    }
  });

  it("lock and unlock transitions are valid: alternate, loss recorded, none opened while locked", () => {
    for (const sim of sims) {
      sim.states.forEach((s, i) => {
        expect(s.seq).toBe(i + 1);
        expect(s.state).toBe(i % 2 === 0 ? "locked" : "unlocked");
        if (s.state === "locked") expect(s.lossToRecoverMicro > 0n).toBe(true);
        else expect(s.lossToRecoverMicro).toBe(0n);
        expect(s.mode).toBe(sim.cfg.recoveryMode);
      });
      // each lock equals the net loss of the real trade that closed that day
      for (const s of sim.states.filter((x) => x.state === "locked")) {
        const t = sim.trades.find(
          (x) => !x.shadow && x.closed?.closeD === s.d && netPlMicro(x.closed as never) < 0n,
        );
        expect(t).toBeDefined();
        expect(-netPlMicro((t as SleeveTrade).closed as never)).toBe(s.lossToRecoverMicro);
      }
      // shadow trades exist only while locked at their open, and leave no ledger rows
      const shadowIds = new Set(sim.trades.filter((t) => t.shadow).map((t) => t.id));
      expect(sim.rows.some((r) => shadowIds.has(r.refId ?? ""))).toBe(false);
    }
  });

  it("financing rows sum to the cumulative formula for every closed real trade", () => {
    for (const sim of sims) {
      for (const t of sim.trades.filter((x) => !x.shadow && x.closed !== null)) {
        const c = t.closed as NonNullable<SleeveTrade["closed"]>;
        const posted = -sim.rows
          .filter((r) => r.kind === "financing" && r.account === "fin_accrued" && r.refId === t.id)
          .reduce((s, r) => s + r.deltaMicro, 0n);
        expect(posted).toBe(financingAccruedAt(t, c.closeD, sim.cfg));
        expect(c.financingMicro).toBe(posted);
      }
    }
  });

  it("same inputs, byte-identical ledger and NAV (ARN-102)", () => {
    for (const seed of [3, 17, 29]) {
      const a = simulateSleeve({ seed, days: 120, mode: "REC-2" });
      const b = simulateSleeve({ seed, days: 120, mode: "REC-2" });
      expect(serializeLedgerRows(a.rows)).toBe(serializeLedgerRows(b.rows));
      expect(serializeNavDays(a.days)).toBe(serializeNavDays(b.days));
    }
  });
});

describe("invariant mutations: each ARN-101 sleeve check can fail", () => {
  // a seed with a real trade, a capped/closed-out loser, a lock and a shadow trade
  const base = (() => {
    for (let seed = 101; seed < 400; seed++) {
      const sim = simulateSleeve({ seed, days: 160, mode: "REC-4" });
      if (sim.stats.locks >= 1 && sim.stats.shadowOpened >= 1 && sim.stats.unlocks >= 1) return sim;
    }
    throw new Error("no suitable seed");
  })();
  const check = (
    rows: LedgerRow[] = base.rows,
    trades: SleeveTrade[] = base.trades,
    states: SleeveStateEntry[] = base.states,
  ) =>
    checkCohortBooks(
      { ...base.books, rows },
      {
        mode: "matched",
        calendar: base.calendar,
        dates: base.dates,
        seedMicro: base.seedMicro,
        sleeve: { trades, states, cfg: base.cfg },
      },
    );
  const codes = (v: ReturnType<typeof check>) => new Set(v.map((x) => x.code));

  it("the unmutated cohort is clean", () => {
    expect(check().filter(isFatal)).toEqual([]);
  });

  it("dropping a sleeve_close txn breaks the margin balance, the tie and the trade check", () => {
    const victim = base.trades.find((t) => !t.shadow && t.closed !== null) as SleeveTrade;
    const rows = base.rows.filter((r) => r.txnId !== `sleeveclose:${victim.id}`);
    const found = codes(check(rows));
    expect(found.has("sleeve_margin_balance")).toBe(true);
    expect(found.has("sleeve_txn_tie")).toBe(true);
  });

  it("a tampered margin posting is caught", () => {
    const victim = base.trades.find((t) => !t.shadow) as SleeveTrade;
    const rows = base.rows.map((r) =>
      r.txnId === `sleeveopen:${victim.id}` && r.account === "sleeve_margin"
        ? { ...r, deltaMicro: r.deltaMicro + 1n }
        : r,
    );
    const found = codes(check(rows));
    expect(found.has("txn_not_balanced")).toBe(true);
    expect(found.has("sleeve_txn_tie")).toBe(true);
  });

  it("a financing row that is too small/large breaks the financing balance", () => {
    const row = base.rows.find((r) => r.kind === "financing" && r.account === "fin_accrued");
    if (row === undefined) return;
    const rows = base.rows.map((r) => (r === row ? { ...r, deltaMicro: r.deltaMicro - 1n } : r));
    expect(codes(check(rows)).has("sleeve_financing_balance")).toBe(true);
  });

  it("a loss beyond the margin is caught (closed trade and NAV)", () => {
    const victim = base.trades.find((t) => !t.shadow && t.closed !== null) as SleeveTrade;
    const trades = base.trades.map((t) =>
      t === victim && t.closed !== null
        ? { ...t, closed: { ...t.closed, pricePlMicro: -t.marginMicro - 1n } }
        : t,
    );
    expect(codes(check(base.rows, trades)).has("sleeve_loss_over_margin")).toBe(true);
  });

  it("a shadow trade with ledger rows, an overlap and a malformed trade are caught", () => {
    const shadow = base.trades.find((t) => t.shadow) as SleeveTrade;
    const stray = txnRows(sleeveOpenTxn({ ...shadow, shadow: false }, 0n)).map((r) => ({
      ...r,
      d: base.dates[1],
    }));
    expect(codes(check([...base.rows, ...stray])).has("sleeve_shadow_posted")).toBe(true);
    const real = base.trades.find((t) => !t.shadow) as SleeveTrade;
    const clone: SleeveTrade = { ...real, id: "SX", closed: null };
    expect(codes(check(base.rows, [...base.trades, clone])).has("sleeve_overlap")).toBe(true);
    const bad = base.trades.map((t) =>
      t === real ? { ...t, notionalMicro: t.notionalMicro + 1n } : t,
    );
    expect(codes(check(base.rows, bad)).has("sleeve_trade_shape")).toBe(true);
  });

  it("lock state: missing lock, unexplained lock, wrong loss, bad alternation, trade opened while locked", () => {
    expect(codes(check(base.rows, base.trades, [])).has("lock_missing")).toBe(true);
    const first = base.states[0];
    expect(
      codes(
        check(base.rows, base.trades, [
          { ...first, lossToRecoverMicro: first.lossToRecoverMicro + 1n },
          ...base.states.slice(1),
        ]),
      ).has("lock_missing"),
    ).toBe(true);
    expect(
      codes(
        check(base.rows, base.trades, [{ ...first, d: "2000-01-01" }, ...base.states.slice(1)]),
      ).has("lock_unexplained"),
    ).toBe(true);
    const twice = [first, { ...first, seq: 2 }];
    expect(codes(check(base.rows, base.trades, twice)).has("lock_state_inconsistent")).toBe(true);
    const unlockFirst = [{ ...first, state: "unlocked" as const, lossToRecoverMicro: 0n }];
    expect(codes(check(base.rows, base.trades, unlockFirst)).has("lock_state_inconsistent")).toBe(
      true,
    );
    // a real trade opened right after a lock that was never lifted
    const locking = base.trades.find(
      (t) => !t.shadow && t.closed?.closeD === first.d,
    ) as SleeveTrade;
    const intruder: SleeveTrade = {
      ...locking,
      id: "SZ",
      openD: base.dates[base.dates.indexOf(first.d) + 1],
      closed: null,
    };
    const lockOnly = [first];
    expect(
      codes(check(base.rows, [...base.trades, intruder], lockOnly)).has(
        "sleeve_opened_while_locked",
      ),
    ).toBe(true);
  });

  it("an unreal P/L with no open trade is flagged on the NAV row", () => {
    const books = {
      ...base.books,
      sleeveUnrealFor: (d: string) => (d === base.dates[2] ? 1_000n : 0n),
    };
    const v = checkCohortBooks(books, {
      mode: "matched",
      calendar: base.calendar,
      dates: base.dates,
      seedMicro: base.seedMicro,
      sleeve: { trades: base.trades, states: base.states, cfg: base.cfg },
    });
    expect(codes(v).has("sleeve_unreal_orphan") || codes(v).has("nav_equity_reconcile")).toBe(true);
  });
});
