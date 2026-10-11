// @vitest-environment node
// Ledger invariants (ARN-101, ARN-102; M3 T6): every check fires on the fault it exists for, and
// stays silent on good books. HIGH-RISK money module: exact bigint micro assertions.
import { describe, expect, it } from "vitest";
import { COST_PROFILES } from "@/lib/arena/costs";
import {
  checkBalances,
  checkCohortBooks,
  checkFillsPosted,
  checkNavDay,
  checkPending,
  checkTxns,
  compareStoredNav,
  isFatal,
  replayIdentical,
  serializeLedgerRows,
} from "@/lib/arena/invariants";
import {
  balancesFromRows,
  fillTxns,
  reversalTxn,
  seedTxn,
  settleTxn,
  settlementItem,
  txnRows,
  zeroBalances,
  type LedgerFill,
  type LedgerRow,
} from "@/lib/arena/ledger";
import {
  buildNavDay,
  computeNavDay,
  withInvariantsOk,
  type CohortBooks,
  type NavDay,
} from "@/lib/arena/nav";
import type { LedgerKind } from "@/lib/arena/schema";
import { simulate } from "./ledgerHarness";

const NO_CAL: never[] = [];
const buy: LedgerFill = {
  id: "F1",
  d: "2026-10-13",
  code: "ZZA",
  side: "buy",
  qty: 60n,
  valueMicro: 588_600_000n,
  brokerageMicro: 5_000_000n,
};
const sell: LedgerFill = {
  ...buy,
  id: "F2",
  side: "sell",
  d: "2026-10-14",
  qty: 20n,
  valueMicro: 196_000_000n,
};
const SELL_COST = 196_200_000n; // 20 of 60 shares bought for 588,600,000
const goodRows = (): LedgerRow[] => [
  ...txnRows(seedTxn("2026-10-12", 600_000_000n)),
  ...fillTxns(buy).flatMap(txnRows),
  ...fillTxns(sell, SELL_COST).flatMap(txnRows),
  ...txnRows(settleTxn(settlementItem(buy, NO_CAL), "2026-10-15")),
];
const row = (over: Partial<LedgerRow> & { txnId: string }): LedgerRow => ({
  d: "2026-10-13",
  account: "cash_settled",
  deltaMicro: 1n,
  kind: "seed",
  refType: null,
  refId: null,
  ...over,
});
const codes = (v: { code: string }[]) => v.map((x) => x.code);

describe("checkTxns", () => {
  it("good books give no violation", () => {
    expect(checkTxns(goodRows(), [buy, sell], { seedMicro: 600_000_000n })).toEqual([]);
  });

  it("rows of one txn that differ in kind, date, ref, or repeat an account are inconsistent", () => {
    const a = row({ txnId: "t", kind: "seed" });
    expect(
      codes(checkTxns([a, row({ txnId: "t", account: "cash_recv", kind: "sell" })], [])),
    ).toEqual(["txn_inconsistent"]);
    expect(
      codes(checkTxns([a, row({ txnId: "t", account: "cash_recv", d: "2026-10-14" })], [])),
    ).toEqual(["txn_inconsistent"]);
    expect(
      codes(checkTxns([a, row({ txnId: "t", account: "cash_recv", refType: "x" })], [])),
    ).toEqual(["txn_inconsistent"]);
    expect(
      codes(checkTxns([a, row({ txnId: "t", account: "cash_recv", refId: "x" })], [])),
    ).toEqual(["txn_inconsistent"]);
    expect(codes(checkTxns([a, a], []))).toEqual(["txn_inconsistent"]);
  });

  it("an internal txn that does not net to zero is flagged", () => {
    const rows = goodRows().map((r) =>
      r.txnId === "fee:F1" && r.account === "fees_paid"
        ? { ...r, deltaMicro: r.deltaMicro + 1n }
        : r,
    );
    const found = checkTxns(rows, [buy, sell]);
    expect(codes(found)).toContain("txn_not_balanced");
    expect(codes(found)).toContain("txn_tie_mismatch"); // fees_paid also differs from the fill
  });

  it("buy and sell must match a fill of the same side and value", () => {
    const rows = goodRows();
    expect(codes(checkTxns(rows, [sell]))).toContain("txn_fill_missing"); // F1 unknown
    expect(codes(checkTxns(rows, [{ ...buy, side: "sell" }, sell]))).toContain("txn_fill_missing");
    expect(codes(checkTxns(rows, [{ ...buy, valueMicro: buy.valueMicro + 1n }, sell]))).toContain(
      "txn_tie_mismatch",
    );
    expect(codes(checkTxns(rows, [buy, { ...sell, valueMicro: sell.valueMicro + 1n }]))).toContain(
      "txn_tie_mismatch",
    );
    expect(codes(checkTxns(rows, [buy, sell], { saleCosts: new Map([["F2", 1n]]) }))).toContain(
      "txn_tie_mismatch",
    );
    const noRef = rows.map((r) =>
      r.txnId === "fill:F2" ? { ...r, refType: null, refId: null } : r,
    );
    expect(codes(checkTxns(noRef, [buy, sell]))).toContain("txn_fill_missing");
  });

  it("brokerage and settlement must tie to their fill", () => {
    const rows = goodRows();
    const orphan = [
      row({ txnId: "x", kind: "brokerage", refType: "fill", refId: "F9", deltaMicro: 0n }),
    ];
    expect(codes(checkTxns(orphan, []))).toEqual(["txn_fill_missing"]);
    const orphanSettle = [
      row({ txnId: "y", kind: "settle", refType: "fill", refId: "F9", deltaMicro: 0n }),
    ];
    expect(codes(checkTxns(orphanSettle, []))).toEqual(["txn_fill_missing"]);
    expect(codes(checkTxns(rows, [{ ...buy, brokerageMicro: 4_000_000n }, sell]))).toContain(
      "txn_tie_mismatch",
    );
    // settle of a purchase pays net 593,600,000; a different fill fee changes the expected amount
    expect(codes(checkTxns(rows, [{ ...buy, brokerageMicro: 6_000_000n }, sell]))).toContain(
      "txn_tie_mismatch",
    );
    const sellSettle = [
      ...fillTxns(sell, SELL_COST).flatMap(txnRows),
      ...txnRows(settleTxn(settlementItem(sell, NO_CAL), "2026-10-16")),
    ];
    expect(checkTxns(sellSettle, [sell])).toEqual([]);
    expect(codes(checkTxns(sellSettle, [{ ...sell, brokerageMicro: 1n }]))).toContain(
      "txn_tie_mismatch",
    );
  });

  it("seed must be positive and equal the cohort's seed when given", () => {
    const minus = [
      row({ txnId: "seed", deltaMicro: -5n }),
      row({ txnId: "seed", account: "equity", deltaMicro: 5n }),
    ];
    expect(codes(checkTxns(minus, []))).toEqual(["txn_sign"]);
    const plus = [
      row({ txnId: "seed", deltaMicro: 600n }),
      row({ txnId: "seed", account: "equity", deltaMicro: -600n }),
    ];
    expect(checkTxns(plus, [])).toEqual([]);
    expect(checkTxns(plus, [], { seedMicro: 600n })).toEqual([]);
    expect(codes(checkTxns(plus, [], { seedMicro: 601n }))).toEqual(["txn_seed_mismatch"]);
  });

  it("dividend accrual and compensation must add value; financing and P/L are not tied", () => {
    const kinds: LedgerKind[] = ["div_accrue", "ca_comp"];
    const pair = (txnId: string, kind: LedgerKind, a: string, v: bigint, b: string) => [
      row({ txnId, kind, account: a as never, deltaMicro: v }),
      row({ txnId, kind, account: b as never, deltaMicro: -v }),
    ];
    for (const kind of kinds) {
      expect(checkTxns(pair("a", kind, "div_recv", 5n, "equity"), [])).toEqual([]);
      expect(codes(checkTxns(pair("a", kind, "div_recv", -5n, "equity"), []))).toEqual([
        "txn_sign",
      ]);
    }
    for (const kind of ["financing", "sleeve_pnl"] as LedgerKind[]) {
      expect(checkTxns(pair("f", kind, "fin_accrued", -5n, "equity"), [])).toEqual([]);
    }
    // every kind must balance: a single-row txn does not
    expect(
      codes(
        checkTxns(
          [row({ txnId: "f", kind: "financing", account: "fin_accrued", deltaMicro: -5n })],
          [],
        ),
      ),
    ).toEqual(["txn_not_balanced"]);
  });

  it("a reversal must negate its original exactly", () => {
    const original = fillTxns(sell, SELL_COST)[0];
    const base = [...txnRows(original), ...txnRows(reversalTxn(original, "2026-10-14"))];
    expect(checkTxns(base, [sell])).toEqual([]);
    const missingOriginal = txnRows(reversalTxn(original, "2026-10-14"));
    expect(codes(checkTxns(missingOriginal, [sell]))).toEqual(["txn_reversal_mismatch"]);
    const off = base.map((r) =>
      r.txnId.startsWith("rev:") ? { ...r, deltaMicro: r.deltaMicro - 1n } : r,
    );
    expect(codes(checkTxns(off, [sell]))).toContain("txn_reversal_mismatch");
    const wrongRef = base.map((r) => (r.txnId.startsWith("rev:") ? { ...r, refType: "fill" } : r));
    expect(codes(checkTxns(wrongRef, [sell]))).toContain("txn_reversal_mismatch");
    const extraRow = [
      ...base,
      row({
        txnId: "rev:fill:F2",
        account: "fees_paid",
        kind: "reversal",
        refType: "txn",
        refId: "fill:F2",
        d: "2026-10-14",
      }),
    ];
    expect(codes(checkTxns(extraRow, [sell]))).toContain("txn_reversal_mismatch");
  });
});

describe("checkFillsPosted", () => {
  it("every fill dated up to the check date needs its trade and (fee > 0) fee txn", () => {
    expect(checkFillsPosted(goodRows(), [buy, sell], "2026-10-15")).toEqual([]);
    const noFee = goodRows().filter((r) => r.txnId !== "fee:F1");
    expect(checkFillsPosted(noFee, [buy, sell], "2026-10-15")).toEqual([
      { code: "fill_unposted", txnId: "fee:F1", d: "2026-10-13", message: "fill F1 is not posted" },
    ]);
    const noTrade = goodRows().filter((r) => r.txnId !== "fill:F2");
    expect(codes(checkFillsPosted(noTrade, [buy, sell], "2026-10-15"))).toEqual(["fill_unposted"]);
    expect(checkFillsPosted(noTrade, [buy, sell], "2026-10-13")).toEqual([]); // F2 is later
    const free = { ...buy, id: "F5", brokerageMicro: 0n };
    expect(checkFillsPosted(fillTxns(free).flatMap(txnRows), [free], "2026-10-13")).toEqual([]);
  });
});

describe("checkBalances (cash never negative)", () => {
  const b = (over: Partial<ReturnType<typeof zeroBalances>>) => ({ ...zeroBalances(), ...over });
  it("settled cash below zero is negative cash in either mode", () => {
    for (const mode of ["matched", "conservative"] as const) {
      expect(codes(checkBalances(b({ cash_settled: -1n }), mode, "d"))).toContain("negative_cash");
    }
  });

  it("conservative: payables must be covered by settled cash alone", () => {
    const covered = b({ cash_settled: 100n, cash_pay: -100n, cash_recv: 50n });
    expect(checkBalances(covered, "conservative", "d")).toEqual([]);
    const short = b({ cash_settled: 100n, cash_pay: -101n, cash_recv: 50n });
    expect(codes(checkBalances(short, "conservative", "d"))).toEqual(["overcommitted_cash"]);
    expect(checkBalances(short, "matched", "d")).toEqual([]); // sale proceeds may fund it
    const worse = b({ cash_settled: 100n, cash_pay: -151n, cash_recv: 50n });
    expect(codes(checkBalances(worse, "matched", "d"))).toEqual(["overcommitted_cash"]);
  });
});

describe("a sale whose fee exceeds its proceeds", () => {
  it("overdraws settled cash once settled, and the invariant says so (sizing buffer's job)", () => {
    const tiny: LedgerFill = {
      ...sell,
      id: "F7",
      qty: 1n,
      valueMicro: 2_000_000n,
      brokerageMicro: 5_000_000n,
    };
    const rows = [
      ...txnRows(seedTxn("2026-10-12", 1_000_000n)),
      ...fillTxns(tiny, 2_000_000n).flatMap(txnRows),
      ...txnRows(settleTxn(settlementItem(tiny, NO_CAL), "2026-10-16")),
    ];
    const balances = balancesFromRows(rows);
    expect(balances.cash_settled).toBe(-2_000_000n);
    expect(codes(checkBalances(balances, "conservative", "2026-10-16"))).toContain("negative_cash");
    expect(checkTxns(rows, [tiny])).toEqual([]); // the postings themselves are sound
  });
});

describe("forced exits (sale fee above proceeds) versus a hard negative cash failure", () => {
  const fills: LedgerFill[] = [
    { ...buy, id: "F1", d: "2026-10-13", qty: 2n, valueMicro: 4_000_000n, brokerageMicro: 0n },
    {
      ...sell,
      id: "F2",
      d: "2026-10-14",
      qty: 1n,
      valueMicro: 2_000_000n,
      brokerageMicro: 5_000_000n,
    },
  ];
  const rows = [
    ...txnRows(seedTxn("2026-10-12", 4_000_000n)),
    ...fillTxns(fills[0]).flatMap(txnRows),
    ...txnRows(settleTxn(settlementItem(fills[0], NO_CAL), "2026-10-15")),
    ...fillTxns(fills[1], 2_000_000n).flatMap(txnRows),
    ...txnRows(settleTxn(settlementItem(fills[1], NO_CAL), "2026-10-16")),
  ];
  const books: CohortBooks = {
    cohortId: "K1",
    rows,
    fills,
    markFor: () => ({ closeMicro: 2_000_000n, advMicro: 5_000_000_000_000n }),
    profile: COST_PROFILES.P5,
  };
  const dates = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];

  it("is reported as forced_exit_overdraft, not fatal, and the run's other checks still hold", () => {
    const found = checkCohortBooks(books, { mode: "conservative", calendar: [], dates });
    expect(found.filter(isFatal)).toEqual([]);
    const forced = found.filter((v) => v.code === "forced_exit_overdraft");
    expect(forced.map((v) => v.d)).toEqual(["2026-10-16"]);
    expect(forced[0].fatal).toBe(false);
    expect(isFatal(forced[0])).toBe(false);
  });

  it("the same overdraft without a forced exit behind it is a hard failure", () => {
    const b = (cash: bigint, pay = 0n) => ({
      ...zeroBalances(),
      cash_settled: cash,
      cash_pay: pay,
    });
    expect(codes(checkBalances(b(-5n), "conservative", "d", 3n))).toEqual([
      "negative_cash",
      "overcommitted_cash",
    ]);
    expect(checkBalances(b(-5n), "conservative", "d", 5n).map((v) => v.code)).toEqual([
      "forced_exit_overdraft",
    ]);
    expect(codes(checkBalances(b(5n, -9n), "conservative", "d", 3n))).toEqual([
      "overcommitted_cash",
    ]);
    expect(checkBalances(b(5n, -9n), "conservative", "d", 4n).map((v) => v.code)).toEqual([
      "forced_exit_overdraft",
    ]);
    expect(isFatal({ code: "negative_cash", message: "x" })).toBe(true);
  });

  it("books with a forced draw but a further, unrelated shortfall stay fatal", () => {
    const broke = { ...books, rows: rows.filter((r) => r.txnId !== "seed") };
    expect(
      codes(checkCohortBooks(broke, { mode: "conservative", calendar: [], dates }).filter(isFatal)),
    ).toContain("negative_cash");
  });
});

describe("double-entry reconciliation", () => {
  it("NAV must equal -equity - fees + (market value - position cost) + sleeve unrealised", () => {
    const balances = { ...zeroBalances(), cash_settled: 1_000_000n, equity: -1_000_000n };
    const day = computeNavDay({
      cohortId: "K1",
      d: "2026-10-14",
      balances,
      positions: new Map(),
      markFor: () => undefined,
      profile: COST_PROFILES.P5,
    });
    expect(checkNavDay(day, balances)).toEqual([]);
    expect(codes(checkNavDay(day, { ...balances, equity: -999_999n }))).toContain(
      "nav_equity_reconcile",
    );
    expect(codes(checkNavDay(day, { ...balances, position_cost: 1n }))).toContain(
      "nav_equity_reconcile",
    );
  });

  it("position_cost on the ledger must equal the cost basis replayed from the fills", () => {
    const sim = simulate({ seed: 4, days: 20, mode: "matched" });
    const options = { mode: sim.mode, calendar: sim.calendar, dates: sim.dates };
    expect(checkCohortBooks(sim.books, options)).toEqual([]);
    const drift = [
      ...sim.rows,
      ...[
        { account: "position_cost" as const, deltaMicro: 1n },
        { account: "equity" as const, deltaMicro: -1n },
      ].map((p) => ({
        txnId: "drift",
        d: sim.dates[0],
        kind: "financing" as const,
        refType: null,
        refId: null,
        ...p,
      })),
    ];
    expect(codes(checkCohortBooks({ ...sim.books, rows: drift }, options))).toContain(
      "position_cost_mismatch",
    );
  });

  it("a sale larger than the holding cannot be costed: reported, not thrown", () => {
    const books: CohortBooks = {
      cohortId: "K1",
      rows: [],
      fills: [{ ...sell, id: "F9", qty: 5n }],
      markFor: () => undefined,
      profile: COST_PROFILES.P5,
    };
    const found = codes(
      checkCohortBooks(books, { mode: "matched", calendar: [], dates: ["2026-10-14"] }),
    );
    expect(found).toContain("cost_unbuildable");
    expect(found).toContain("short_position");
  });
});

describe("checkPending", () => {
  const items = [
    { side: "sell" as const, netMicro: 90n },
    { side: "buy" as const, netMicro: 40n },
  ];
  it("receivable and payable balances equal the unsettled fills", () => {
    expect(checkPending({ ...zeroBalances(), cash_recv: 90n, cash_pay: -40n }, items, "d")).toEqual(
      [],
    );
    expect(
      codes(checkPending({ ...zeroBalances(), cash_recv: 91n, cash_pay: -40n }, items, "d")),
    ).toEqual(["pending_mismatch"]);
    expect(
      codes(checkPending({ ...zeroBalances(), cash_recv: 90n, cash_pay: -41n }, items, "d")),
    ).toEqual(["pending_mismatch"]);
    expect(checkPending(zeroBalances(), [], "d")).toEqual([]);
  });
});

describe("checkNavDay", () => {
  const balances = {
    ...zeroBalances(),
    cash_settled: 1_000_000n,
    div_recv: 5n,
    fin_accrued: -2n,
    equity: -1_000_003n,
  };
  const day = computeNavDay({
    cohortId: "K1",
    d: "2026-10-14",
    balances,
    positions: new Map([["ZZA", 2n]]),
    markFor: () => ({ closeMicro: 5_000_000n, advMicro: 5_000_000_000_000n }),
    profile: COST_PROFILES.P5,
  });
  const tamper = (over: Partial<NavDay["row"]>): NavDay => ({
    row: { ...day.row, ...over },
    positions: day.positions,
  });

  it("a consistent day passes, with or without the ledger balances", () => {
    expect(checkNavDay(day)).toEqual([]);
    expect(checkNavDay(day, balances)).toEqual([]);
  });

  it("flags a NAV that is not cash + market value, bad position sum, bad count, liq above NAV", () => {
    expect(codes(checkNavDay(tamper({ navMicro: day.row.navMicro + 1n })))).toEqual([
      "nav_identity",
    ]);
    expect(codes(checkNavDay(tamper({ positionsMicro: 1n })))).toContain("nav_positions_sum");
    expect(codes(checkNavDay(tamper({ openPositions: 3n })))).toEqual(["nav_open_count"]);
    expect(codes(checkNavDay(tamper({ liqNavMicro: day.row.navMicro + 1n })))).toEqual([
      "liq_above_nav",
    ]);
  });

  it("flags each cash-side field that differs from the ledger", () => {
    const fields: Partial<NavDay["row"]>[] = [
      { cashSettledMicro: day.row.cashSettledMicro + 1n },
      { recvMicro: 1n },
      { payMicro: 1n },
      { divRecvMicro: 1n },
      { sleeveMarginMicro: 1n },
      { finAccruedMicro: 1n },
    ];
    for (const f of fields) {
      expect(codes(checkNavDay(tamper(f), balances))).toContain("nav_cash_mismatch");
    }
  });
});

describe("compareStoredNav", () => {
  const day = computeNavDay({
    cohortId: "K1",
    d: "2026-10-14",
    balances: { ...zeroBalances(), cash_settled: 9n },
    positions: new Map(),
    markFor: () => undefined,
    profile: COST_PROFILES.P5,
  });
  it("equal rows pass; a changed field or a stored zero verdict is reported", () => {
    expect(compareStoredNav(day, day)).toEqual([]);
    const changed: NavDay = { row: { ...day.row, navMicro: 10n }, positions: [] };
    expect(codes(compareStoredNav(changed, day))).toEqual(["nav_recompute_mismatch"]);
    expect(codes(compareStoredNav(withInvariantsOk(day, false), day))).toEqual([
      "stored_flag_not_ok",
    ]);
  });
});

describe("checkCohortBooks", () => {
  const sim = simulate({ seed: 11, days: 40, mode: "conservative" });
  const options = { mode: sim.mode, calendar: sim.calendar, dates: sim.dates, stored: sim.days };

  it("simulated books pass every invariant, stored rows included", () => {
    expect(checkCohortBooks(sim.books, { ...options, seedMicro: sim.seedMicro })).toEqual([]);
  });

  it("without stored rows only the recomputation is checked", () => {
    expect(checkCohortBooks(sim.books, { ...options, stored: undefined })).toEqual([]);
  });

  it("a missing stored day is reported", () => {
    const found = checkCohortBooks(sim.books, { ...options, stored: sim.days.slice(1) });
    expect(found).toEqual([
      { code: "nav_missing", d: sim.dates[0], message: "no stored NAV row for this date" },
    ]);
  });

  it("a tampered stored day is a recompute mismatch", () => {
    const stored = sim.days.map((x, i) =>
      i === 5 ? { row: { ...x.row, navMicro: x.row.navMicro + 1n }, positions: x.positions } : x,
    );
    const found = codes(checkCohortBooks(sim.books, { ...options, stored }));
    expect(found).toContain("nav_recompute_mismatch");
    expect(found).toContain("nav_identity");
  });

  it("a deleted ledger row breaks posting, pending and txn checks", () => {
    const victim = sim.rows.find((r) => r.kind === "buy") as LedgerRow;
    const books: CohortBooks = {
      ...sim.books,
      rows: sim.rows.filter((r) => r.txnId !== victim.txnId),
    };
    const found = codes(checkCohortBooks(books, options));
    expect(found).toContain("fill_unposted");
  });

  it("a short position is reported and that day is not valued", () => {
    const books: CohortBooks = {
      ...sim.books,
      fills: [...sim.fills, { ...sell, id: "FX", d: sim.dates[0], code: "ZZQ", qty: 1n }],
    };
    const found = checkCohortBooks(books, { ...options, stored: undefined });
    expect(codes(found)).toContain("short_position");
    expect(codes(found)).not.toContain("nav_unbuildable");
  });

  it("a missing close makes the day unbuildable, reported not thrown", () => {
    const heldDay = sim.days.find((x) => x.positions.length > 0) as NavDay;
    const books: CohortBooks = {
      ...sim.books,
      markFor: (d, code) => (d === heldDay.row.d ? undefined : sim.books.markFor(d, code)),
    };
    expect(codes(checkCohortBooks(books, { ...options, stored: undefined }))).toContain(
      "nav_unbuildable",
    );
  });

  it("buildNavDay reproduces every simulated day exactly", () => {
    for (const x of sim.days) expect(buildNavDay(sim.books, x.row.d)).toEqual(x);
  });
});

describe("replay (ARN-102)", () => {
  it("row serialisation ignores order; replayIdentical needs rows and days equal", () => {
    const rows = goodRows();
    expect(serializeLedgerRows(rows)).toBe(serializeLedgerRows([...rows].reverse()));
    const day = computeNavDay({
      cohortId: "K1",
      d: "2026-10-14",
      balances: balancesFromRows(rows),
      positions: new Map(),
      markFor: () => undefined,
      profile: COST_PROFILES.P5,
    });
    const a = { rows, days: [day] };
    expect(replayIdentical(a, { rows: [...rows].reverse(), days: [day] })).toBe(true);
    expect(replayIdentical(a, { rows: rows.slice(1), days: [day] })).toBe(false);
    expect(replayIdentical(a, { rows, days: [withInvariantsOk(day, false)] })).toBe(false);
    expect(serializeLedgerRows([row({ txnId: "t", refType: "a", refId: "b" })])).toBe(
      "2026-10-13|t|cash_settled|1|seed|a|b",
    );
  });
});
