// @vitest-environment node
// Positions, daily NAV and liquidation NAV (M3 T6). HIGH-RISK: exact bigint micro assertions.
import { describe, expect, it } from "vitest";
import { COST_PROFILES } from "@/lib/arena/costs";
import { fillCloseSignalExit } from "@/lib/arena/fills";
import {
  fillTxns,
  seedTxn,
  txnRows,
  zeroBalances,
  type LedgerFill,
  type LedgerRow,
} from "@/lib/arena/ledger";
import {
  buildNavDay,
  buildNavSeries,
  computeNavDay,
  derivePositions,
  liquidationValueMicro,
  navIdentityMicro,
  positionValueMicro,
  serializeNavDays,
  withInvariantsOk,
  type CohortBooks,
  type Mark,
} from "@/lib/arena/nav";
import { makeRational } from "@/lib/money/rational";

const P5 = COST_PROFILES.P5;
const ADV5M = 5_000_000_000_000n;
const fill = (over: Partial<LedgerFill> & { id: string }): LedgerFill => ({
  d: "2026-10-13",
  code: "ZZA",
  side: "buy",
  qty: 60n,
  valueMicro: 588_600_000n,
  brokerageMicro: 5_000_000n,
  ...over,
});
const mark = (closeMicro: bigint, over: Partial<Mark> = {}): Mark => ({
  closeMicro,
  advMicro: ADV5M,
  ...over,
});

describe("derivePositions (decision 11: derived from fills)", () => {
  it("nets buys and sells per code up to the date; flat positions disappear", () => {
    const fills = [
      fill({ id: "F1", qty: 60n }),
      fill({ id: "F2", qty: 20n, side: "sell", d: "2026-10-14" }),
      fill({ id: "F3", qty: 10n, code: "ZZB", d: "2026-10-14" }),
      fill({ id: "F4", qty: 10n, code: "ZZB", side: "sell", d: "2026-10-15" }),
    ];
    expect(derivePositions(fills, [], "2026-10-13").positions).toEqual(new Map([["ZZA", 60n]]));
    expect(derivePositions(fills, [], "2026-10-14").positions).toEqual(
      new Map([
        ["ZZA", 40n],
        ["ZZB", 10n],
      ]),
    );
    expect(derivePositions(fills, [], "2026-10-15").positions).toEqual(new Map([["ZZA", 40n]]));
    expect(derivePositions([], [], "2026-10-15").positions.size).toBe(0);
  });

  it("reports a short instead of hiding it", () => {
    const state = derivePositions([fill({ id: "F1", side: "sell", qty: 5n })], [], "2026-10-13");
    expect(state.shorts).toEqual([{ code: "ZZA", qty: -5n }]);
    expect(state.positions.size).toBe(0);
  });

  it("a same-day buy and sell nets within the day before the short check", () => {
    const fills = [fill({ id: "F1", side: "sell", qty: 5n }), fill({ id: "F2", qty: 5n })];
    const state = derivePositions(fills, [], "2026-10-13");
    expect(state.shorts).toEqual([]);
    expect(state.positions.size).toBe(0);
  });

  it("a split re-bases the holding of the prior close; a same-day fill is already post-split", () => {
    const fills = [
      fill({ id: "F1", qty: 60n }),
      fill({ id: "F2", qty: 10n, d: "2026-10-20" }), // on the ex-date, in post-split terms
    ];
    const split = { code: "ZZA", exD: "2026-10-20", ratio: makeRational(2n) };
    expect(derivePositions(fills, [split], "2026-10-19").positions.get("ZZA")).toBe(60n);
    expect(derivePositions(fills, [split], "2026-10-20").positions.get("ZZA")).toBe(130n);
  });

  it("a consolidation divides exactly; two adjustments the same day apply in code order", () => {
    const fills = [fill({ id: "F1", qty: 60n }), fill({ id: "F2", qty: 9n, code: "ZZB" })];
    const adj = [
      { code: "ZZB", exD: "2026-10-20", ratio: makeRational(1n, 3n) },
      { code: "ZZA", exD: "2026-10-20", ratio: makeRational(1n, 5n) },
      { code: "ZZC", exD: "2026-10-20", ratio: makeRational(7n) }, // nothing held: ignored
    ];
    const state = derivePositions(fills, adj, "2026-10-20");
    expect(state.positions).toEqual(
      new Map([
        ["ZZA", 12n],
        ["ZZB", 3n],
      ]),
    );
  });

  it("two adjustments of one code on one ex-date both apply", () => {
    const two = [
      { code: "ZZA", exD: "2026-10-20", ratio: makeRational(2n) },
      { code: "ZZA", exD: "2026-10-20", ratio: makeRational(3n) },
    ];
    expect(
      derivePositions([fill({ id: "F1", qty: 10n })], two, "2026-10-20").positions.get("ZZA"),
    ).toBe(60n);
  });

  it("rounds a fractional result down (ARN-023; corporate-action proposal D-074)", () => {
    const adj = [{ code: "ZZA", exD: "2026-10-20", ratio: makeRational(1n, 7n) }];
    const held = derivePositions([fill({ id: "F1" })], adj, "2026-10-20").positions.get("ZZA");
    expect(held).toBe(8n); // fill() default qty is 60
  });

  it("neutral split: value before and after the ex-date is equal (TST101-028)", () => {
    const fills = [fill({ id: "F1", qty: 60n })];
    const split = { code: "ZZA", exD: "2026-10-20", ratio: makeRational(2n) };
    const before = derivePositions(fills, [split], "2026-10-19").positions.get("ZZA") ?? 0n;
    const after = derivePositions(fills, [split], "2026-10-20").positions.get("ZZA") ?? 0n;
    expect(before * 10_000_000n).toBe(after * 5_000_000n);
  });
});

describe("position value and liquidation value", () => {
  it("is quantity x raw close; a haircut rounds once, half away from zero (R6)", () => {
    expect(positionValueMicro(60n, mark(9_500_000n))).toBe(570_000_000n);
    expect(positionValueMicro(60n, mark(10_000_000n, { haircut: makeRational(1n, 2n) }))).toBe(
      300_000_000n,
    );
    // 3 x 1,000,001 x 1/2 = 1,500,001.5 -> 1,500,002 (the half goes away from zero)
    expect(positionValueMicro(3n, mark(1_000_001n, { haircut: makeRational(1n, 2n) }))).toBe(
      1_500_002n,
    );
    expect(positionValueMicro(3n, mark(1_000_001n, { haircut: null }))).toBe(3_000_003n);
  });

  it("refuses a haircut outside 0..1", () => {
    expect(() => positionValueMicro(1n, mark(5n, { haircut: makeRational(-1n, 2n) }))).toThrow(
      "between 0 and 1",
    );
    expect(() => positionValueMicro(1n, mark(5n, { haircut: makeRational(3n, 2n) }))).toThrow(
      "between 0 and 1",
    );
    expect(positionValueMicro(2n, mark(5n, { haircut: makeRational(1n) }))).toBe(10n);
    expect(positionValueMicro(2n, mark(5n, { haircut: makeRational(0n) }))).toBe(0n);
  });

  it("liquidation value equals the CS-exit fill value less its brokerage (same slippage rule)", () => {
    const close = 9_800_000n;
    const exit = fillCloseSignalExit(
      {
        bar: { openMicro: close, highMicro: close, lowMicro: close, closeMicro: close },
        advMicro: ADV5M,
        profile: P5,
      },
      60n,
    );
    expect(liquidationValueMicro(60n, mark(close), { profile: P5 })).toBe(
      exit.valueMicro - exit.brokerageMicro,
    );
  });

  it("a haircut position cannot trade: it stays at its haircut value", () => {
    const m = mark(10_000_000n, { haircut: makeRational(1n, 2n) });
    expect(liquidationValueMicro(60n, m, { profile: P5 })).toBe(300_000_000n);
  });
});

describe("TST101-038 style NAV day: every ARN-051 term once", () => {
  const balances = {
    ...zeroBalances(),
    cash_settled: 100_000_000n,
    cash_recv: 94_900_000n,
    div_recv: 15_000_000n,
    sleeve_margin: 20_000_000n,
    fin_accrued: -49_315n,
  };
  const day = computeNavDay({
    cohortId: "K1",
    d: "2026-10-14",
    balances,
    positions: new Map([["ZZA", 60n]]),
    markFor: () => mark(9_500_000n),
    profile: P5,
    sleeveUnrealMicro: -8_000_000n,
  });

  it("adds receivable, holdings, dividend, margin, unrealised and subtracts financing", () => {
    expect(day.row).toMatchObject({
      cashSettledMicro: 100_000_000n,
      recvMicro: 94_900_000n,
      payMicro: 0n,
      positionsMicro: 570_000_000n,
      divRecvMicro: 15_000_000n,
      sleeveMarginMicro: 20_000_000n,
      sleeveUnrealMicro: -8_000_000n,
      finAccruedMicro: 49_315n,
      navMicro: 791_850_685n,
      openPositions: 1n,
      invariantsOk: 1,
    });
    expect(navIdentityMicro(day.row)).toBe(791_850_685n);
    expect(day.positions).toEqual([
      {
        cohortId: "K1",
        d: "2026-10-14",
        code: "ZZA",
        qty: 60n,
        closeMicro: 9_500_000n,
        valueMicro: 570_000_000n,
        haircut: 0,
      },
    ]);
  });

  it("liquidation NAV is NAV less the sell slippage and brokerage on the holding", () => {
    // sell fill at 9.50 less 1 tick (10 bps = 9,500 < one tick 10,000): 9,490,000 x 60 = 569,400,000,
    // brokerage P5 tier 1 (A$5.00, value <= A$1,000) -> 564,400,000; cost = 570,000,000 - 564,400,000.
    expect(day.row.liqNavMicro).toBe(791_850_685n - 5_600_000n);
  });

  it("payables reduce NAV and a haircut position is flagged", () => {
    const d2 = computeNavDay({
      cohortId: "K1",
      d: "2026-10-14",
      balances: { ...zeroBalances(), cash_settled: 1_000_000n, cash_pay: -400_000n },
      positions: new Map([["ZZA", 2n]]),
      markFor: () => mark(5_000_000n, { haircut: makeRational(1n, 2n) }),
      profile: P5,
    });
    expect(d2.row.payMicro).toBe(400_000n);
    expect(d2.row.navMicro).toBe(1_000_000n - 400_000n + 5_000_000n);
    expect(d2.row.liqNavMicro).toBe(d2.row.navMicro);
    expect(d2.positions[0].haircut).toBe(1);
  });

  it("sorts positions by code", () => {
    const d3 = computeNavDay({
      cohortId: "K1",
      d: "2026-10-14",
      balances: zeroBalances(),
      positions: new Map([
        ["ZZB", 1n],
        ["ZZA", 1n],
      ]),
      markFor: () => mark(5_000_000n),
      profile: P5,
    });
    expect(d3.positions.map((p) => p.code)).toEqual(["ZZA", "ZZB"]);
  });

  it("withInvariantsOk only changes the verdict flag", () => {
    const bad = withInvariantsOk(day, false);
    expect(bad.row.invariantsOk).toBe(0);
    expect(bad.row.navMicro).toBe(day.row.navMicro);
    expect(bad.positions).toBe(day.positions);
    expect(withInvariantsOk(bad, true).row.invariantsOk).toBe(1);
  });
});

describe("computeNavDay refuses bad inputs", () => {
  const base = {
    cohortId: "K1",
    d: "2026-10-14",
    balances: zeroBalances(),
    profile: P5,
  };
  it("non-positive quantity, missing close, non-positive close", () => {
    expect(() =>
      computeNavDay({ ...base, positions: new Map([["ZZA", 0n]]), markFor: () => mark(1n) }),
    ).toThrow("must be positive");
    expect(() =>
      computeNavDay({ ...base, positions: new Map([["ZZA", 1n]]), markFor: () => undefined }),
    ).toThrow("no close for ZZA");
    expect(() =>
      computeNavDay({ ...base, positions: new Map([["ZZA", 1n]]), markFor: () => mark(0n) }),
    ).toThrow("close for ZZA must be positive");
  });
});

describe("books: rebuild any day from scratch", () => {
  const f1 = fill({ id: "F1", d: "2026-10-13" });
  const f2 = fill({ id: "F2", d: "2026-10-14", side: "sell", qty: 20n, valueMicro: 196_000_000n });
  const rows: LedgerRow[] = [
    ...txnRows(seedTxn("2026-10-12", 600_000_000n)),
    ...fillTxns(f1).flatMap(txnRows),
    ...fillTxns(f2, 196_200_000n).flatMap(txnRows),
  ];
  const books: CohortBooks = {
    cohortId: "K1",
    rows,
    fills: [f1, f2],
    markFor: (d) => mark(d === "2026-10-13" ? 9_800_000n : 9_900_000n),
    profile: P5,
  };

  it("day by day: cash, payables, receivables and holdings follow the ledger and the fills", () => {
    const series = buildNavSeries(books, ["2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(series[0].row.navMicro).toBe(600_000_000n);
    // 13th: payable 593,600,000 (value + fee) against 60 x 9.80 = 588,000,000
    expect(series[1].row).toMatchObject({
      cashSettledMicro: 600_000_000n,
      payMicro: 593_600_000n,
      positionsMicro: 588_000_000n,
      navMicro: 600_000_000n - 593_600_000n + 588_000_000n,
    });
    // 14th: sale receivable 196,000,000 - 5,000,000, 40 left at 9.90
    expect(series[2].row).toMatchObject({
      recvMicro: 191_000_000n,
      positionsMicro: 396_000_000n,
      navMicro: 600_000_000n - 593_600_000n + 191_000_000n + 396_000_000n,
    });
  });

  it("a short position cannot be valued", () => {
    const shorted: CohortBooks = {
      ...books,
      fills: [fill({ id: "F9", side: "sell", qty: 1n })],
      rows: [],
    };
    expect(() => buildNavDay(shorted, "2026-10-13")).toThrow("short position");
  });

  it("uses the supplied sleeve unrealised P/L and cost options", () => {
    const day = buildNavDay(
      {
        ...books,
        sleeveUnrealFor: () => -1_000_000n,
        tickCrossFactor: makeRational(1n),
        buckets: undefined,
        feeContext: {},
      },
      "2026-10-13",
    );
    expect(day.row.sleeveUnrealMicro).toBe(-1_000_000n);
  });
});

describe("serializeNavDays", () => {
  it("is canonical text, identical for equal days and different for any change", () => {
    const a = computeNavDay({
      cohortId: "K1",
      d: "2026-10-14",
      balances: { ...zeroBalances(), cash_settled: 5n },
      positions: new Map([["ZZA", 1n]]),
      markFor: () => mark(5_000_000n),
      profile: P5,
    });
    const text = serializeNavDays([a]);
    expect(text.split("\n")).toHaveLength(2);
    expect(text.startsWith("nav|K1|2026-10-14|5|0|0|5000000|")).toBe(true);
    expect(text).toContain("pos|K1|2026-10-14|ZZA|1|5000000|5000000|0");
    expect(serializeNavDays([a])).toBe(text);
    expect(serializeNavDays([withInvariantsOk(a, false)])).not.toBe(text);
  });
});
