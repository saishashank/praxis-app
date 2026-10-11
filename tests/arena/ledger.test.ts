// @vitest-environment node
// Cash ledger, settlement and available cash (M3 T6). HIGH-RISK: exact bigint micro assertions.
import { describe, expect, it } from "vitest";
import type { CalendarRow } from "@/lib/data/calendar";
import { makeRational } from "@/lib/money/rational";
import {
  assertTradingDate,
  assertTxn,
  availableCash,
  balancesFromRows,
  divAccrueTxn,
  divPayTxn,
  fillNetMicro,
  fillTxns,
  pendingSettlements,
  replayCostBasis,
  reversalTxn,
  seedTxn,
  settleTxn,
  settlementDate,
  settlementItem,
  settlementsDue,
  txnRows,
  zeroBalances,
  type LedgerFill,
  type LedgerTxn,
} from "@/lib/arena/ledger";

const holiday = (d: string): CalendarRow => ({ d, kind: "holiday", close_time: null });
const NO_HOLIDAYS: CalendarRow[] = [];
const COST = 90_000_000n; // cost basis of the 10 shares sold

const sell = (over: Partial<LedgerFill> = {}): LedgerFill => ({
  id: "F1",
  d: "2026-10-13", // Tuesday
  code: "ZZA",
  side: "sell",
  qty: 10n,
  valueMicro: 99_900_000n,
  brokerageMicro: 5_000_000n,
  ...over,
});
const buy = (over: Partial<LedgerFill> = {}): LedgerFill =>
  sell({ id: "F2", side: "buy", valueMicro: 588_600_000n, ...over });

function expectRange(fn: () => unknown, text: string) {
  expect(fn).toThrow(RangeError);
  expect(fn).toThrow(text);
}

describe("assertTradingDate and assertTxn", () => {
  it("accepts a canonical date and refuses anything else", () => {
    expect(() => assertTradingDate("2026-10-13")).not.toThrow();
    expectRange(() => assertTradingDate("2026-1-3"), "bad date");
    expectRange(() => assertTradingDate("2026-02-30"), "bad date");
    expect(() => assertTradingDate(20261013 as unknown as string)).toThrow(RangeError);
  });

  it("refuses an empty id, no postings, unknown or repeated accounts, zero and unbalanced", () => {
    const ok: LedgerTxn = seedTxn("2026-10-13", 600_000_000n);
    expect(() => assertTxn(ok)).not.toThrow();
    expectRange(() => assertTxn({ ...ok, txnId: "" }), "txn id is empty");
    expectRange(() => assertTxn({ ...ok, d: "13/10/2026" }), "bad date");
    expectRange(() => assertTxn({ ...ok, postings: [] }), "no postings");
    expectRange(
      () => assertTxn({ ...ok, postings: [{ account: "bogus" as never, deltaMicro: 1n }] }),
      "unknown account",
    );
    expectRange(
      () =>
        assertTxn({
          ...ok,
          postings: [
            { account: "cash_settled", deltaMicro: 1n },
            { account: "cash_settled", deltaMicro: 2n },
          ],
        }),
      "twice",
    );
    expectRange(
      () => assertTxn({ ...ok, postings: [{ account: "cash_settled", deltaMicro: 0n }] }),
      "zero posting",
    );
    expectRange(
      () => assertTxn({ ...ok, postings: [{ account: "cash_settled", deltaMicro: 5n }] }),
      "does not net to zero",
    );
    expectRange(
      () =>
        assertTxn({
          ...ok,
          postings: [
            { account: "cash_settled", deltaMicro: 2n ** 63n },
            { account: "equity", deltaMicro: -(2n ** 63n) },
          ],
        }),
      "outside the SQLite INTEGER (int64) range",
    );
  });
});

describe("seed, fills, fees", () => {
  it("seed puts the seed in settled cash against seed capital in equity", () => {
    const t = seedTxn("2026-10-12", 600_000_000n);
    expect(txnRows(t)).toEqual([
      {
        txnId: "seed",
        d: "2026-10-12",
        account: "cash_settled",
        deltaMicro: 600_000_000n,
        kind: "seed",
        refType: null,
        refId: null,
      },
      {
        txnId: "seed",
        d: "2026-10-12",
        account: "equity",
        deltaMicro: -600_000_000n,
        kind: "seed",
        refType: null,
        refId: null,
      },
    ]);
    expectRange(() => seedTxn("2026-10-12", 0n), "seed must be a positive");
  });

  it("a sale books a receivable, removes cost basis and posts realised P/L to equity; then the fee", () => {
    const [trade, fee] = fillTxns(sell(), COST);
    expect(trade).toMatchObject({ txnId: "fill:F1", kind: "sell", refType: "fill", refId: "F1" });
    expect(trade.postings).toEqual([
      { account: "cash_recv", deltaMicro: 99_900_000n },
      { account: "position_cost", deltaMicro: -90_000_000n },
      { account: "equity", deltaMicro: -9_900_000n },
    ]);
    expect(fee).toMatchObject({ txnId: "fee:F1", kind: "brokerage" });
    expect(fee.postings).toEqual([
      { account: "cash_recv", deltaMicro: -5_000_000n },
      { account: "fees_paid", deltaMicro: 5_000_000n },
    ]);
    expect(fillNetMicro(sell())).toBe(94_900_000n);
  });

  it("a purchase books a payable of value (negative) and the fee into the same payable", () => {
    const [trade, fee] = fillTxns(buy());
    expect(trade.postings).toEqual([
      { account: "cash_pay", deltaMicro: -588_600_000n },
      { account: "position_cost", deltaMicro: 588_600_000n },
    ]);
    expect(fee.postings[0]).toEqual({ account: "cash_pay", deltaMicro: -5_000_000n });
    expect(fillNetMicro(buy())).toBe(593_600_000n);
  });

  it("a zero fee (P2 free first buy) posts no fee txn; bad fills are refused", () => {
    expect(fillTxns(buy({ brokerageMicro: 0n }))).toHaveLength(1);
    expectRange(() => fillTxns(sell({ qty: 0n }), COST), "quantity");
    expectRange(() => fillTxns(sell({ valueMicro: 0n }), COST), "fill value");
    expectRange(() => fillTxns(sell({ brokerageMicro: -1n }), COST), "negative");
    expectRange(() => fillTxns(sell()), "needs its cost basis");
    expectRange(() => fillTxns(sell(), 0n), "sale cost basis");
  });

  it("a sale at exactly cost posts no realised P/L row; a loss posts a positive equity delta", () => {
    expect(fillTxns(sell(), 99_900_000n)[0].postings.map((p) => p.account)).toEqual([
      "cash_recv",
      "position_cost",
    ]);
    expect(fillTxns(sell(), 120_000_000n)[0].postings[2]).toEqual({
      account: "equity",
      deltaMicro: 20_100_000n,
    });
  });
});

describe("settlement dates (T+2 trading sessions)", () => {
  it("skips weekends: Tue to Thu, Thu to Mon, Fri to Tue", () => {
    expect(settlementDate("2026-10-13", NO_HOLIDAYS)).toBe("2026-10-15");
    expect(settlementDate("2026-10-15", NO_HOLIDAYS)).toBe("2026-10-19");
    expect(settlementDate("2026-10-16", NO_HOLIDAYS)).toBe("2026-10-20");
  });

  it("skips calendar holidays: Thu with Monday closed settles Tuesday; Fri with Mon closed Wed", () => {
    const cal = [holiday("2026-10-19")];
    expect(settlementDate("2026-10-15", cal)).toBe("2026-10-20");
    expect(settlementDate("2026-10-16", cal)).toBe("2026-10-21");
  });

  it("a long weekend: holidays on Good Friday and Easter Monday", () => {
    const cal = [holiday("2027-03-26"), holiday("2027-03-29")];
    expect(settlementDate("2027-03-25", cal)).toBe("2027-03-31");
    expect(settlementDate("2027-03-24", cal)).toBe("2027-03-30");
  });

  it("builds the item with the net amount", () => {
    expect(settlementItem(sell(), NO_HOLIDAYS)).toEqual({
      fillId: "F1",
      side: "sell",
      tradeD: "2026-10-13",
      settleD: "2026-10-15",
      netMicro: 94_900_000n,
    });
  });
});

describe("pending settlements and settlement postings", () => {
  const fills = [
    buy({ id: "F3", d: "2026-10-14" }),
    sell({ id: "F2", d: "2026-10-13" }),
    buy({ id: "F1", d: "2026-10-13" }),
    sell({ id: "F9", d: "2026-10-13", valueMicro: 5_000_000n }), // net exactly zero
  ];

  it("lists unsettled fills in settlement order, receipts first, ignoring zero nets", () => {
    const pending = pendingSettlements(fills, new Set(), NO_HOLIDAYS);
    expect(pending.map((p) => p.fillId)).toEqual(["F2", "F1", "F3"]);
    expect(
      pendingSettlements(fills, new Set(["F2", "F1"]), NO_HOLIDAYS).map((p) => p.fillId),
    ).toEqual(["F3"]);
  });

  it("orders ties by fill id when date and side are equal", () => {
    const two = [sell({ id: "F8" }), sell({ id: "F7" })];
    expect(pendingSettlements(two, new Set(), NO_HOLIDAYS).map((p) => p.fillId)).toEqual([
      "F7",
      "F8",
    ]);
  });

  it("settling a sale moves net proceeds from receivable to settled cash", () => {
    const item = settlementItem(sell(), NO_HOLIDAYS);
    const t = settleTxn(item, "2026-10-15");
    expect(t).toMatchObject({
      txnId: "settle:F1",
      kind: "settle",
      refType: "fill",
    });
    expect(t.postings).toEqual([
      { account: "cash_recv", deltaMicro: -94_900_000n },
      { account: "cash_settled", deltaMicro: 94_900_000n },
    ]);
  });

  it("settling a purchase clears the payable and spends settled cash", () => {
    const t = settleTxn(settlementItem(buy(), NO_HOLIDAYS), "2026-10-15");
    expect(t.postings).toEqual([
      { account: "cash_pay", deltaMicro: 593_600_000n },
      { account: "cash_settled", deltaMicro: -593_600_000n },
    ]);
  });

  it("refuses to settle a zero item", () => {
    expectRange(
      () => settleTxn({ ...settlementItem(sell(), NO_HOLIDAYS), netMicro: 0n }, "2026-10-15"),
      "nothing to settle",
    );
  });

  it("settlementsDue returns only items due, receipts before payments, dated today", () => {
    const pending = pendingSettlements(fills, new Set(), NO_HOLIDAYS);
    expect(settlementsDue(pending, "2026-10-14")).toEqual([]);
    const due = settlementsDue(pending, "2026-10-15");
    expect(due.map((t) => t.txnId)).toEqual(["settle:F2", "settle:F1"]);
    expect(due.every((t) => t.d === "2026-10-15")).toBe(true);
    expect(settlementsDue(pending, "2026-10-16").map((t) => t.txnId)).toEqual([
      "settle:F2",
      "settle:F1",
      "settle:F3",
    ]);
  });
});

describe("available cash: matched versus conservative (ARN-025, D-071 TST101-026)", () => {
  // Settled cash 100,000,000; a sale on Tue 2026-10-13 nets 94,900,000 and settles Thu 2026-10-15.
  const rows = [
    ...txnRows(seedTxn("2026-10-12", 100_000_000n)),
    ...fillTxns(sell(), COST).flatMap(txnRows),
  ];
  const balances = balancesFromRows(rows);
  const pending = pendingSettlements([sell()], new Set(), NO_HOLIDAYS);
  const at = (mode: "matched" | "conservative", sessionD: string) =>
    availableCash({ mode, balances, pending, sessionD });

  it("matched: proceeds fund a buy the same session", () => {
    expect(at("matched", "2026-10-13")).toBe(194_900_000n);
  });

  it("conservative: nothing before the settlement session, all of it from its start", () => {
    expect(at("conservative", "2026-10-13")).toBe(100_000_000n);
    expect(at("conservative", "2026-10-14")).toBe(100_000_000n);
    expect(at("conservative", "2026-10-15")).toBe(194_900_000n);
    expect(at("conservative", "2026-10-16")).toBe(194_900_000n);
  });

  it("after the settlement posting both modes agree on 194,900,000", () => {
    const settled = balancesFromRows([...rows, ...txnRows(settleTxn(pending[0], "2026-10-15"))]);
    expect(settled.cash_settled).toBe(194_900_000n);
    for (const mode of ["matched", "conservative"] as const) {
      expect(availableCash({ mode, balances: settled, pending: [], sessionD: "2026-10-15" })).toBe(
        194_900_000n,
      );
    }
  });

  it("a purchase commits cash at once in both modes (payables are always deducted)", () => {
    const withBuy = balancesFromRows([...rows, ...fillTxns(buy()).flatMap(txnRows)]);
    const both = [...pending, settlementItem(buy(), NO_HOLIDAYS)];
    expect(
      availableCash({ mode: "matched", balances: withBuy, pending: both, sessionD: "2026-10-13" }),
    ).toBe(194_900_000n - 593_600_000n);
    expect(
      availableCash({
        mode: "conservative",
        balances: withBuy,
        pending: both,
        sessionD: "2026-10-15",
      }),
    ).toBe(194_900_000n - 593_600_000n);
  });

  it("holiday after the sale moves the conservative release date", () => {
    const cal = [holiday("2026-10-14")];
    const p = pendingSettlements([sell()], new Set(), cal);
    expect(p[0].settleD).toBe("2026-10-16");
    expect(
      availableCash({ mode: "conservative", balances, pending: p, sessionD: "2026-10-15" }),
    ).toBe(100_000_000n);
    expect(
      availableCash({ mode: "conservative", balances, pending: p, sessionD: "2026-10-16" }),
    ).toBe(194_900_000n);
  });

  it("settled cash only: no pending, both modes equal", () => {
    const only = balancesFromRows(txnRows(seedTxn("2026-10-12", 600_000_000n)));
    expect(availableCash({ mode: "matched", balances: only, pending: [], sessionD: "x" })).toBe(
      600_000_000n,
    );
    expect(
      availableCash({ mode: "conservative", balances: only, pending: [], sessionD: "x" }),
    ).toBe(600_000_000n);
  });
});

describe("dividends (placeholder) and reversal", () => {
  it("accrual books a receivable with an income leg; payment turns it into cash", () => {
    const a = divAccrueTxn({ d: "2026-10-14", refId: "D1", amountMicro: 15_000_000n });
    expect(a).toMatchObject({
      txnId: "divacc:D1",
      kind: "div_accrue",
    });
    const p = divPayTxn({ d: "2026-10-30", refId: "D1", amountMicro: 15_000_000n });
    expect(p.postings).toEqual([
      { account: "div_recv", deltaMicro: -15_000_000n },
      { account: "cash_settled", deltaMicro: 15_000_000n },
    ]);
    const balances = balancesFromRows([...txnRows(a), ...txnRows(p)]);
    expect(balances.div_recv).toBe(0n);
    expect(balances.cash_settled).toBe(15_000_000n);
    expectRange(() => divAccrueTxn({ d: "2026-10-14", refId: "D1", amountMicro: 0n }), "positive");
    expectRange(() => divPayTxn({ d: "2026-10-14", refId: "D1", amountMicro: -1n }), "positive");
  });

  it("a reversal negates every posting, restoring balances", () => {
    const original = fillTxns(sell(), COST)[0];
    const rev = reversalTxn(original, "2026-10-14");
    expect(rev).toMatchObject({
      txnId: "rev:fill:F1",
      kind: "reversal",
      refType: "txn",
      refId: "fill:F1",
    });
    const net = balancesFromRows([...txnRows(original), ...txnRows(rev)]);
    expect(net).toEqual(zeroBalances());
  });
});

describe("replayCostBasis (average cost, one rounding per partial sale)", () => {
  const b = (id: string, d: string, qty: bigint, value: bigint, code = "ZZA"): LedgerFill => ({
    id,
    d,
    code,
    side: "buy",
    qty,
    valueMicro: value,
    brokerageMicro: 0n,
  });
  const s = (id: string, d: string, qty: bigint, code = "ZZA"): LedgerFill => ({
    ...b(id, d, qty, 1n, code),
    side: "sell",
  });

  it("removes cost pro rata, rounds half away once, and the last share takes the exact remainder", () => {
    // 3 shares for 1,000,001: sell 1 -> 333,333.67 -> 333,334 ; sell 1 -> 666,667 x 1/2 = 333,333.5 -> 333,334
    const fills = [
      b("F1", "2026-10-13", 3n, 1_000_001n),
      s("F2", "2026-10-14", 1n),
      s("F3", "2026-10-15", 1n),
      s("F4", "2026-10-16", 1n),
    ];
    const r = replayCostBasis(fills, [], "2026-10-16");
    expect(r.saleCostByFillId.get("F2")).toBe(333_334n);
    expect(r.saleCostByFillId.get("F3")).toBe(333_334n);
    expect(r.saleCostByFillId.get("F4")).toBe(333_333n); // the remainder: nothing is lost
    expect(333_334n + 333_334n + 333_333n).toBe(1_000_001n);
    expect(r.holdings.size).toBe(0);
  });

  it("holds the rest after a partial sale and respects the as-of date", () => {
    const fills = [b("F1", "2026-10-13", 60n, 588_600_000n), s("F2", "2026-10-14", 20n)];
    const r = replayCostBasis(fills, [], "2026-10-14");
    expect(r.saleCostByFillId.get("F2")).toBe(196_200_000n);
    expect(r.holdings.get("ZZA")).toEqual({ qty: 40n, costMicro: 392_400_000n });
    const before = replayCostBasis(fills, [], "2026-10-13");
    expect(before.saleCostByFillId.size).toBe(0);
    expect(before.holdings.get("ZZA")).toEqual({ qty: 60n, costMicro: 588_600_000n });
  });

  it("orders by date then fill id; a split changes quantity and never cost (decision 14)", () => {
    const fills = [
      s("F9", "2026-10-20", 30n), // post-split sale on the ex-date: 120 held after the re-base
      b("F1", "2026-10-13", 60n, 600_000_000n),
    ];
    const split = [{ code: "ZZA", exD: "2026-10-20", ratio: makeRational(2n) }];
    const r = replayCostBasis(fills, split, "2026-10-20");
    expect(r.saleCostByFillId.get("F9")).toBe(150_000_000n); // 30/120 of 600,000,000
    expect(r.holdings.get("ZZA")).toEqual({ qty: 90n, costMicro: 450_000_000n });
  });

  it("an adjustment for a code not held is ignored; a fractional result is rounded down", () => {
    const fills = [b("F1", "2026-10-13", 60n, 600_000_000n)];
    const other = [{ code: "ZZB", exD: "2026-10-20", ratio: makeRational(2n) }];
    expect(replayCostBasis(fills, other, "2026-10-20").holdings.get("ZZA")?.qty).toBe(60n);
    const odd = [{ code: "ZZA", exD: "2026-10-20", ratio: makeRational(1n, 7n) }];
    const rebased = replayCostBasis(fills, odd, "2026-10-20").holdings.get("ZZA");
    expect(rebased).toEqual({ qty: 8n, costMicro: 600_000_000n }); // floor(60/7); cost kept whole
    // two adjustments on the same code and day are applied in a fixed order (both sort equal)
    const two = [
      { code: "ZZA", exD: "2026-10-20", ratio: makeRational(2n) },
      { code: "ZZA", exD: "2026-10-20", ratio: makeRational(3n) },
    ];
    expect(replayCostBasis(fills, two, "2026-10-20").holdings.get("ZZA")?.qty).toBe(360n);
  });

  it("selling more than is held is refused", () => {
    expectRange(
      () =>
        replayCostBasis(
          [b("F1", "2026-10-13", 5n, 5_000_000n), s("F2", "2026-10-14", 6n)],
          [],
          "2026-10-14",
        ),
      "exceeds the holding",
    );
    expectRange(() => replayCostBasis([s("F2", "2026-10-14", 1n)], [], "2026-10-14"), "exceeds");
  });

  it("two fills in one day are taken in id order, whatever the input order", () => {
    const fills = [
      s("F3", "2026-10-14", 1n),
      b("F2", "2026-10-14", 2n, 10n),
      b("F1", "2026-10-14", 1n, 4n),
    ];
    const r = replayCostBasis(fills, [], "2026-10-14");
    expect(r.saleCostByFillId.get("F3")).toBe(5n); // (4 + 10) x 1/3 = 4.67 -> 5
  });
});

describe("balancesFromRows", () => {
  it("sums per account and respects the upper date", () => {
    const rows = [
      ...txnRows(seedTxn("2026-10-12", 100n)),
      ...txnRows(divAccrueTxn({ d: "2026-10-20", refId: "D1", amountMicro: 7n })),
    ];
    expect(balancesFromRows(rows, "2026-10-19").div_recv).toBe(0n);
    expect(balancesFromRows(rows, "2026-10-20").div_recv).toBe(7n);
    expect(balancesFromRows(rows).cash_settled).toBe(100n);
    expect(balancesFromRows([])).toEqual(zeroBalances());
  });
});
