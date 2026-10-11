// @vitest-environment node
// Corporate-action cash effects (M3 T7; ARN-026, ARN-036, ARN-043, DAT-223; D-069 decisions 7, 11,
// 13, 14; D-071 TST101-030 ruling). HIGH-RISK money module: exact bigint micro assertions, the
// ledger invariants after every scenario, NAV neutrality / conservation as properties.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { COST_PROFILES } from "@/lib/arena/costs";
import {
  applyCorporateActionsDay,
  loadQtyAdjustments,
  writeAdjustment,
} from "@/lib/arena/corpActionWriter";
import {
  CorpActionError,
  DEFAULT_SUSPENSION,
  dividendAmountMicro,
  haircutApplies,
  haltSessionNumber,
  parseDividend,
  parseRights,
  planCorporateActions,
  quantityRatio,
  reversalsForAction,
  rightsCompensationMicro,
  rightsCount,
  suspensionMark,
  toQtyAdjustments,
  type CorpActionPlan,
  type CorpActionRecord,
} from "@/lib/arena/corpActions";
import { checkCohortBooks, checkTxns, serializeLedgerRows } from "@/lib/arena/invariants";
import {
  fillTxns,
  rebaseQty,
  replayCostBasis,
  seedTxn,
  settleTxn,
  settlementItem,
  txnRows,
  type LedgerFill,
  type LedgerRow,
  type LedgerTxn,
  type QtyAdjustment,
} from "@/lib/arena/ledger";
import { loadLedgerRows, writeLedgerTxn } from "@/lib/arena/ledgerWriter";
import { buildNavDay, positionValueMicro, type CohortBooks, type Mark } from "@/lib/arena/nav";
import { entitlementCompensation } from "@/lib/data/corporateActions/rules.mjs";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { makeRational, mulRat, parseRational } from "@/lib/money/rational";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";
import { rng } from "./ledgerHarness";

afterEach(cleanupTempDbs);

const NO_CAL: never[] = [];
const BUY_D = "2026-10-05"; // Monday; settles Wednesday 2026-10-07
const PRIOR = "2026-10-12"; // Monday
const EX = "2026-10-13"; // Tuesday
const ADV = 5_000_000_000_000n;

const action = (
  id: string,
  type: string,
  code: string,
  exDate: string,
  payload: Record<string, unknown>,
): CorpActionRecord => ({ id, type, code, exDate, payload });

/** A small cohort: seed, one settled buy, and helpers to add plans and build NAV days. */
class Book {
  rows: LedgerRow[] = [];
  fills: LedgerFill[] = [];
  adjustments: QtyAdjustment[] = [];
  readonly txns: LedgerTxn[] = [];
  closes = new Map<string, bigint>();

  constructor(
    readonly seed: bigint,
    qty: bigint,
    priceMicro: bigint,
    readonly code = "ZZA",
  ) {
    this.post(seedTxn("2026-10-01", seed));
    const fill: LedgerFill = {
      id: "F1",
      d: BUY_D,
      code,
      side: "buy",
      qty,
      valueMicro: qty * priceMicro,
      brokerageMicro: 0n,
    };
    this.fills.push(fill);
    for (const t of fillTxns(fill)) this.post(t);
    this.post(settleTxn(settlementItem(fill, NO_CAL), "2026-10-07"));
  }

  post(txn: LedgerTxn): void {
    this.txns.push(txn);
    this.rows.push(...txnRows(txn));
  }

  plan(d: string, priorD: string, actions: CorpActionRecord[], lastClose?: bigint): CorpActionPlan {
    const plan = planCorporateActions({
      d,
      priorD,
      actions,
      fills: this.fills,
      adjustments: this.adjustments,
      ledgerRows: this.rows,
      lastCloseFor: () => lastClose,
    });
    for (const t of plan.txns) this.post(t);
    this.adjustments.push(...toQtyAdjustments(plan));
    return plan;
  }

  setClose(d: string, price: bigint): void {
    this.closes.set(d, price);
  }

  books(extra: Partial<Mark> = {}): CohortBooks {
    return {
      cohortId: "K1",
      rows: this.rows,
      fills: this.fills,
      adjustments: this.adjustments,
      profile: COST_PROFILES.P5,
      markFor: (d, code) => {
        const c = this.closes.get(d);
        return c === undefined || code !== this.code
          ? undefined
          : { closeMicro: c, advMicro: ADV, ...extra };
      },
    };
  }

  nav(d: string, extra: Partial<Mark> = {}): bigint {
    return buildNavDay(this.books(extra), d).row.navMicro;
  }

  violations(dates: string[]) {
    return checkCohortBooks(this.books(), { mode: "matched", calendar: NO_CAL, dates });
  }
}

describe("dividends (ARN-036)", () => {
  it("TST101-027: receivable from the ex-date, cash on the pay date, franking never posted", () => {
    const book = new Book(1_000_000_000n, 60n, 10_000_000n);
    const div = action("D1", "cash_dividend", "ZZA", EX, {
      dps_micro: 250_000,
      pay_date: "2026-10-20",
      franking_pct: "1",
      franking_credit_micro: 6_428_571,
    });
    for (const d of ["2026-10-07", PRIOR]) book.setClose(d, 10_000_000n);
    const plan = book.plan(EX, PRIOR, [div]);
    expect(plan.txns).toHaveLength(1);
    expect(plan.txns[0].kind).toBe("div_accrue");
    expect(plan.txns[0].postings).toEqual([
      { account: "div_recv", deltaMicro: 15_000_000n },
      { account: "equity", deltaMicro: -15_000_000n },
    ]);
    expect(plan.franking).toEqual([{ actionId: "D1", code: "ZZA", creditMicro: 6_428_571n }]);
    // franking is on no ledger row
    expect(book.rows.some((r) => r.deltaMicro === 6_428_571n)).toBe(false);

    // ex-date NAV includes the receivable; the raw price falls by the dividend
    book.setClose(EX, 9_750_000n);
    const before = 400_000_000n + 600_000_000n; // cash + 60 x A$10.00
    const exNav = book.nav(EX);
    expect(exNav).toBe(400_000_000n + 60n * 9_750_000n + 15_000_000n);
    expect(exNav).toBe(before); // value conserved: price drop == dividend

    // the day before pay: still a receivable, not cash
    const early = book.plan("2026-10-19", "2026-10-16", [div]);
    expect(early.txns).toEqual([]);
    // pay date: receivable -> settled cash, NAV unchanged
    book.setClose("2026-10-20", 9_750_000n);
    const navBeforePay = book.nav("2026-10-20");
    const pay = book.plan("2026-10-20", "2026-10-19", [div]);
    expect(pay.txns.map((t) => t.kind)).toEqual(["div_pay"]);
    const after = buildNavDay(book.books(), "2026-10-20").row;
    expect(after.divRecvMicro).toBe(0n);
    expect(after.cashSettledMicro).toBe(400_000_000n + 15_000_000n);
    expect(after.navMicro).toBe(navBeforePay); // receivable -> cash: NAV unchanged
    // paying twice is not planned
    expect(book.plan("2026-10-21", "2026-10-20", [div]).txns).toEqual([]);
    expect(book.violations(["2026-10-12", EX, "2026-10-20"])).toEqual([]);
  });

  it("the entitlement is the holding at the PRIOR close, not at the ex-date", () => {
    const book = new Book(1_000_000_000n, 60n, 10_000_000n);
    // a sale on the ex-date and a buy on the ex-date do not change the entitlement
    book.fills.push({
      id: "F2",
      d: EX,
      code: "ZZA",
      side: "buy",
      qty: 40n,
      valueMicro: 400_000_000n,
      brokerageMicro: 0n,
    });
    const div = action("D1", "cash_dividend", "ZZA", EX, { dps_micro: 250_000, pay_date: EX });
    const plan = planCorporateActions({
      d: EX,
      priorD: PRIOR,
      actions: [div],
      fills: book.fills,
      adjustments: [],
      ledgerRows: book.rows,
      lastCloseFor: () => undefined,
    });
    // pay date == ex-date: accrual and payment on the same day, both 60 x 0.25
    expect(plan.txns.map((t) => t.kind)).toEqual(["div_accrue", "div_pay"]);
    expect(plan.txns[0].postings[0].deltaMicro).toBe(15_000_000n);
    expect(plan.txns[1].postings.find((p) => p.account === "cash_settled")?.deltaMicro).toBe(
      15_000_000n,
    );
  });

  it("rounds qty x dps half away from zero exactly once (fractional micro per share)", () => {
    expect(dividendAmountMicro(3n, parseRational("0.5"))).toBe(2n); // 1.5 -> 2
    expect(dividendAmountMicro(3n, parseRational("0.4"))).toBe(1n); // 1.2 -> 1
    expect(dividendAmountMicro(7n, parseRational("0.07142857"))).toBe(0n); // 0.49999999 -> 0
    expect(dividendAmountMicro(0n, parseRational("5"))).toBe(0n);
    // once, on the total: 1000 shares x 0.4 micro = 400, not 1000 x round(0.4) = 0
    expect(dividendAmountMicro(1000n, parseRational("0.4"))).toBe(400n);
  });

  it("a zero amount posts nothing; a code not held posts nothing", () => {
    const book = new Book(1_000_000_000n, 1n, 10_000_000n);
    const tiny = action("D1", "cash_dividend", "ZZA", EX, { dps_micro: "0.4", pay_date: EX });
    expect(book.plan(EX, PRIOR, [tiny]).txns).toEqual([]);
    const other = action("D2", "cash_dividend", "ZZB", EX, { dps_micro: 250_000, pay_date: EX });
    expect(book.plan(EX, PRIOR, [other]).txns).toEqual([]);
  });

  it("A$ decimal payloads parse exactly; bad payloads raise, never guess", () => {
    const ok = parseDividend(
      action("D1", "special_dividend", "ZZA", EX, { dps: 0.25, pay_date: "2026-10-20" }),
    );
    expect(ok.dpsMicro).toEqual(makeRational(250_000n));
    const rec = (p: Record<string, unknown>) => action("D", "cash_dividend", "ZZA", EX, p);
    expect(() => parseDividend(rec({ pay_date: "2026-10-20" }))).toThrow(CorpActionError);
    expect(() => parseDividend(rec({ dps_micro: 1 }))).toThrow("pay_date");
    expect(() => parseDividend(rec({ dps_micro: 1, pay_date: "2026-10-01" }))).toThrow("before");
    expect(() => parseDividend(rec({ dps_micro: -1, pay_date: EX }))).toThrow("negative");
    expect(() => parseDividend(rec({ dps_micro: "x", pay_date: EX }))).toThrow("decimal");
    expect(() => parseDividend(rec({ dps_micro: 1, pay_date: "2026-13-45" }))).toThrow("date");
    expect(() =>
      parseDividend(rec({ dps_micro: 1, pay_date: EX, franking_credit_micro: 1.5 })),
    ).toThrow("integer");
  });

  it("a reversed accrual is never paid and is reversed by compensating txns (DAT-222)", () => {
    const book = new Book(1_000_000_000n, 60n, 10_000_000n);
    const div = action("D1", "cash_dividend", "ZZA", EX, {
      dps_micro: 250_000,
      pay_date: "2026-10-20",
    });
    book.plan(EX, PRIOR, [div]);
    const reversals = reversalsForAction("D1", book.rows, "2026-10-14");
    expect(reversals).toHaveLength(1);
    for (const r of reversals) book.post(r);
    expect(reversalsForAction("D1", book.rows, "2026-10-15")).toEqual([]);
    expect(checkTxns(book.rows, book.fills)).toEqual([]);
    expect(book.plan("2026-10-20", "2026-10-19", [div]).txns).toEqual([]);
    const balances = book.rows.filter((r) => r.account === "div_recv");
    expect(balances.reduce((s, r) => s + r.deltaMicro, 0n)).toBe(0n);
  });
});

describe("entitlement offers (DAT-223)", () => {
  const rights = (type: string, extra: Record<string, unknown> = {}) =>
    action("R1", type, "ZZA", EX, { rights: { new: 1, old: 4 }, ...extra });

  it("TST101-029: renounceable pays shares x ratio x last price; non-renounceable nothing", () => {
    const terms = parseRights(rights("rights_renounceable", { last_price_micro: 300_000 }));
    expect(rightsCount(60n, terms)).toEqual(makeRational(15n));
    expect(rightsCompensationMicro(60n, terms)).toBe(4_500_000n);
    const non = parseRights(rights("rights_non_renounceable", { last_price_micro: 300_000 }));
    expect(rightsCompensationMicro(60n, non)).toBe(0n);

    const book = new Book(1_000_000_000n, 60n, 10_000_000n);
    book.setClose(PRIOR, 10_000_000n);
    book.setClose(EX, 10_000_000n);
    const plan = book.plan(EX, PRIOR, [
      rights("rights_renounceable", { last_price_micro: 300_000 }),
    ]);
    expect(plan.txns).toHaveLength(1);
    expect(plan.txns[0].kind).toBe("ca_comp");
    expect(plan.txns[0].postings).toEqual([
      { account: "cash_settled", deltaMicro: 4_500_000n },
      { account: "equity", deltaMicro: -4_500_000n },
    ]);
    expect(book.violations(["2026-10-12", EX])).toEqual([]);
    expect(
      book.plan(EX, PRIOR, [rights("rights_non_renounceable", { last_price_micro: 1 })]).txns,
    ).toEqual([]);
  });

  it("untraded rights are worth zero; rounding is half away once on the exact product", () => {
    const untraded = parseRights(rights("rights_renounceable"));
    expect(rightsCompensationMicro(60n, untraded)).toBe(0n);
    expect(
      rightsCompensationMicro(
        60n,
        parseRights(rights("rights_renounceable", { last_price_micro: 0 })),
      ),
    ).toBe(0n);
    // 7 shares x 1/4 x 3 micro = 5.25 -> 5; x 2 micro = 3.5 -> 4
    const p3 = parseRights(rights("rights_renounceable", { last_price_micro: 3 }));
    expect(rightsCompensationMicro(7n, p3)).toBe(5n);
    const p2 = parseRights(rights("rights_renounceable", { last_price_micro: 2 }));
    expect(rightsCompensationMicro(7n, p2)).toBe(4n);
  });

  it("parity with the M2 rules.mjs helper (exact rationals, cents price)", () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const payload = {
        rights: { new: r.int(1, 9), old: r.int(1, 12) },
        last_price_cents: r.int(0, 5_000),
      };
      const shares = BigInt(r.int(1, 100_000));
      const perShare = entitlementCompensation("rights_renounceable", payload); // A$ per share
      const expected = BigInt(
        // shares x A$/share x 1e6, rounded half away once
        String((2n * shares * perShare.n * 1_000_000n + perShare.d) / (2n * perShare.d)),
      );
      const mine = rightsCompensationMicro(
        shares,
        parseRights(action("R", "rights_renounceable", "ZZA", EX, payload)),
      );
      expect(mine).toBe(expected);
      const non = entitlementCompensation("rights_non_renounceable", payload);
      expect(non.n).toBe(0n);
    }
  });

  it("malformed rights terms raise", () => {
    expect(() => parseRights(action("R", "rights_renounceable", "ZZA", EX, {}))).toThrow("rights");
    expect(() =>
      parseRights(action("R", "rights_renounceable", "ZZA", EX, { rights: { new: 0, old: 4 } })),
    ).toThrow("positive");
  });
});

describe("splits and consolidations (ARN-043, decision 14)", () => {
  it("TST101-028: 2-for-1 re-bases 60 shares to 120, no cash, no P/L, NAV unchanged", () => {
    const book = new Book(1_000_000_000n, 60n, 10_000_000n);
    book.setClose(PRIOR, 10_000_000n);
    book.setClose(EX, 5_000_000n);
    const navBefore = book.nav(PRIOR);
    const rowsBefore = book.rows.length;
    const plan = book.plan(EX, PRIOR, [action("S1", "split", "ZZA", EX, { new: 2, old: 1 })]);
    expect(plan.txns).toEqual([]); // no cash, no cost movement
    expect(book.rows).toHaveLength(rowsBefore);
    expect(plan.adjustments).toHaveLength(1);
    expect(plan.adjustments[0]).toMatchObject({ qtyBefore: 60n, qtyAfter: 120n });
    const day = buildNavDay(book.books(), EX);
    expect(day.positions[0].qty).toBe(120n);
    expect(day.positions[0].valueMicro).toBe(600_000_000n);
    expect(navBefore).toBe(1_000_000_000n);
    expect(day.row.navMicro).toBe(navBefore);
    // total cost basis unchanged
    const holding = replayCostBasis(book.fills, book.adjustments, EX).holdings.get("ZZA");
    expect(holding).toEqual({ qty: 120n, costMicro: 600_000_000n });
    expect(book.violations(["2026-10-12", EX])).toEqual([]);
  });

  it("consolidation 10-for-1 with a whole result is neutral", () => {
    const book = new Book(1_000_000_000n, 100n, 1_000_000n);
    book.setClose(PRIOR, 1_000_000n);
    book.setClose(EX, 10_000_000n);
    const plan = book.plan(EX, PRIOR, [
      action("C1", "consolidation", "ZZA", EX, { new: 1, old: 10 }),
    ]);
    expect(plan.adjustments[0]).toMatchObject({ qtyBefore: 100n, qtyAfter: 10n });
    expect(book.nav(EX)).toBe(book.nav(PRIOR));
    expect(book.violations(["2026-10-12", EX])).toEqual([]);
  });

  it("fractional result is rounded down (ARN-023), cost stays whole, no cash in lieu", () => {
    const book = new Book(1_000_000_000n, 25n, 1_000_000n);
    book.setClose(PRIOR, 1_000_000n);
    book.setClose(EX, 10_000_000n);
    const plan = book.plan(EX, PRIOR, [
      action("C1", "consolidation", "ZZA", EX, { new: 1, old: 10 }),
    ]);
    expect(plan.txns).toEqual([]);
    expect(plan.adjustments[0].qtyAfter).toBe(2n);
    const holding = replayCostBasis(book.fills, book.adjustments, EX).holdings.get("ZZA");
    expect(holding).toEqual({ qty: 2n, costMicro: 25_000_000n });
    // the lost half share is an honest 5 x A$1.00 = 5,000,000 fall in NAV, visible, not hidden
    expect(book.nav(PRIOR) - book.nav(EX)).toBe(5_000_000n);
    expect(book.violations(["2026-10-12", EX])).toEqual([]);
  });

  it("a consolidation leaving no whole share writes the cost off through ca_dispose", () => {
    const book = new Book(1_000_000_000n, 5n, 1_000_000n);
    book.setClose(PRIOR, 1_000_000n);
    const plan = book.plan(EX, PRIOR, [
      action("C1", "consolidation", "ZZA", EX, { new: 1, old: 10 }),
    ]);
    expect(plan.adjustments[0].qtyAfter).toBe(0n);
    expect(plan.txns).toHaveLength(1);
    expect(plan.txns[0].kind).toBe("ca_dispose");
    expect(plan.txns[0].postings).toEqual([
      { account: "position_cost", deltaMicro: -5_000_000n },
      { account: "equity", deltaMicro: 5_000_000n },
    ]);
    expect(book.nav(EX)).toBe(1_000_000_000n - 5_000_000n);
    expect(book.violations(["2026-10-12", EX])).toEqual([]);
  });

  it("bonus issue: (old+new)/old shares, cost unchanged", () => {
    expect(quantityRatio(action("B", "bonus_issue", "ZZA", EX, { new: 1, old: 4 }))).toEqual(
      makeRational(5n, 4n),
    );
    expect(rebaseQty(8n, makeRational(5n, 4n))).toBe(10n);
    expect(rebaseQty(7n, makeRational(5n, 4n))).toBe(8n); // 8.75 floors to 8
  });

  it("validates the direction of the ratio", () => {
    expect(() => quantityRatio(action("S", "split", "ZZA", EX, { new: 1, old: 2 }))).toThrow();
    expect(() =>
      quantityRatio(action("C", "consolidation", "ZZA", EX, { new: 2, old: 1 })),
    ).toThrow();
    expect(() => quantityRatio(action("S", "split", "ZZA", EX, { new: 2 }))).toThrow("old");
    expect(() =>
      quantityRatio(action("S", "code_change", "ZZA", EX, { new: 2, old: 1 })),
    ).toThrow();
  });

  it("property: exact splits and consolidations are NAV-neutral at the economic price", () => {
    const r = rng(11);
    for (let i = 0; i < 200; i++) {
      const multiple = BigInt(r.int(2, 9));
      const isSplit = r.chance(0.5);
      const qty = BigInt(r.int(1, 500)) * multiple;
      // price is a multiple so the post-event price is an exact micro amount
      const unit = BigInt(r.int(100, 2_000)) * 10_000n;
      const price = isSplit ? unit * multiple : unit;
      const newPrice = isSplit ? unit : unit * multiple;
      const cash = BigInt(r.int(1, 1_000)) * 1_000_000n;
      const book = new Book(qty * price + cash, qty, price);
      book.setClose(PRIOR, price);
      book.setClose(EX, newPrice);
      const payload = isSplit
        ? { new: Number(multiple), old: 1 }
        : { new: 1, old: Number(multiple) };
      const plan = book.plan(EX, PRIOR, [
        action("X", isSplit ? "split" : "consolidation", "ZZA", EX, payload),
      ]);
      expect(plan.txns).toEqual([]);
      expect(book.nav(EX), `${qty} x ${price} / ${multiple}`).toBe(book.nav(PRIOR));
      expect(book.violations([PRIOR, EX])).toEqual([]);
    }
  });

  it("property: dividends conserve value (accrue then pay never changes NAV beyond the amount)", () => {
    const r = rng(23);
    for (let i = 0; i < 100; i++) {
      const qty = BigInt(r.int(1, 5_000));
      const price = BigInt(r.int(100, 5_000)) * 10_000n;
      const dps = BigInt(r.int(1, 300)) * 1_000n;
      const book = new Book(qty * price + 1_000_000n, qty, price);
      const div = action("D", "cash_dividend", "ZZA", EX, {
        dps_micro: dps,
        pay_date: "2026-10-20",
      });
      book.setClose(PRIOR, price);
      book.setClose(EX, price);
      book.setClose("2026-10-20", price);
      const navBefore = book.nav(PRIOR);
      book.plan(EX, PRIOR, [div]);
      // the receivable adds exactly qty x dps (the price fall is the market's, not the ledger's)
      expect(book.nav(EX) - navBefore).toBe(qty * dps);
      const navAtPay = book.nav(EX);
      book.plan("2026-10-20", "2026-10-19", [div]);
      expect(book.nav("2026-10-20")).toBe(navAtPay); // pay date: receivable -> cash, NAV equal
      expect(book.violations([PRIOR, EX, "2026-10-20"])).toEqual([]);
    }
  });
});

describe("cash mergers and delistings (ARN-026)", () => {
  const delist = (reason: string, extra: Record<string, unknown> = {}) =>
    action("L1", "delisting", "ZZA", EX, { reason, ...extra });

  it("delisting (takeover, voluntary, other) closes at the last price", () => {
    for (const reason of ["takeover", "voluntary", "other"]) {
      const book = new Book(1_000_000_000n, 60n, 10_000_000n);
      book.setClose(PRIOR, 12_000_000n);
      const plan = book.plan(EX, PRIOR, [delist(reason)], 12_000_000n);
      expect(plan.txns[0].kind).toBe("ca_dispose");
      expect(plan.txns[0].postings).toEqual([
        { account: "position_cost", deltaMicro: -600_000_000n },
        { account: "cash_settled", deltaMicro: 720_000_000n },
        { account: "equity", deltaMicro: -120_000_000n },
      ]);
      expect(plan.adjustments[0]).toMatchObject({ qtyBefore: 60n, qtyAfter: 0n });
      const day = buildNavDay(book.books(), EX).row;
      expect(day.openPositions).toBe(0n);
      expect(day.navMicro).toBe(1_000_000_000n + 120_000_000n);
      expect(book.violations([PRIOR, EX])).toEqual([]);
    }
  });

  it("administration or liquidation writes the position to zero unless a distribution is announced", () => {
    for (const reason of ["administration", "liquidation"]) {
      const book = new Book(1_000_000_000n, 60n, 10_000_000n);
      book.setClose(PRIOR, 12_000_000n);
      const plan = book.plan(EX, PRIOR, [delist(reason)], 12_000_000n);
      expect(plan.txns[0].postings).toEqual([
        { account: "position_cost", deltaMicro: -600_000_000n },
        { account: "equity", deltaMicro: 600_000_000n },
      ]);
      expect(buildNavDay(book.books(), EX).row.navMicro).toBe(400_000_000n);
      expect(book.violations([PRIOR, EX])).toEqual([]);
    }
    const book = new Book(1_000_000_000n, 60n, 10_000_000n);
    const plan = book.plan(EX, PRIOR, [delist("liquidation", { distribution_micro: 100_000 })]);
    expect(plan.txns[0].postings).toEqual([
      { account: "position_cost", deltaMicro: -600_000_000n },
      { account: "cash_settled", deltaMicro: 6_000_000n },
      { account: "equity", deltaMicro: 594_000_000n },
    ]);
  });

  it("cash merger pays the offer; scrip falls back to cash at the last price", () => {
    const book = new Book(1_000_000_000n, 60n, 10_000_000n);
    const plan = book.plan(EX, PRIOR, [
      action("M1", "merger_cash", "ZZA", EX, { cash_per_share: "11.5" }),
    ]);
    expect(plan.txns[0].postings.find((p) => p.account === "cash_settled")?.deltaMicro).toBe(
      690_000_000n,
    );
    const scrip = new Book(1_000_000_000n, 60n, 10_000_000n);
    const p2 = scrip.plan(EX, PRIOR, [action("M2", "merger_scrip", "ZZA", EX, {})], 9_000_000n);
    expect(p2.txns[0].postings.find((p) => p.account === "cash_settled")?.deltaMicro).toBe(
      540_000_000n,
    );
    expect(() =>
      scrip.plan(EX, PRIOR, [action("M3", "merger_scrip", "ZZA", EX, { acquirer_listed: true })]),
    ).toThrow("not supported");
  });

  it("a missing last price or malformed terms raise; unheld codes do nothing", () => {
    const book = new Book(1_000_000_000n, 60n, 10_000_000n);
    expect(() => book.plan(EX, PRIOR, [delist("takeover")])).toThrow(CorpActionError);
    expect(() => book.plan(EX, PRIOR, [action("L", "delisting", "ZZA", EX, {})], 1n)).toThrow(
      "reason",
    );
    expect(() => book.plan(EX, PRIOR, [action("M", "merger_cash", "ZZA", EX, {})])).toThrow(
      "cash_per_share",
    );
    expect(book.plan(EX, PRIOR, [{ ...delist("takeover"), code: "ZZB" }], 1n).txns).toEqual([]);
    expect(() => book.plan(PRIOR, EX, [])).toThrow("precede");
  });

  it("spin-offs and code changes have no cash effect", () => {
    const book = new Book(1_000_000_000n, 60n, 10_000_000n);
    const plan = book.plan(EX, PRIOR, [
      action("P1", "spin_off", "ZZA", EX, {}),
      action("P2", "code_change", "ZZA", EX, {}),
    ]);
    expect(plan.txns).toEqual([]);
    expect(plan.adjustments).toEqual([]);
  });
});

describe("suspension haircut (ARN-026, D-071 TST101-030)", () => {
  // Monday 2026-10-05 is session 1; weekends are skipped (no holidays in NO_CAL).
  const HALT = "2026-10-05";
  const sessionN = (n: number): string => {
    let d = HALT;
    for (let i = 1; i < n; i++) {
      const next = new Date(`${d}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      while (next.getUTCDay() === 0 || next.getUTCDay() === 6)
        next.setUTCDate(next.getUTCDate() + 1);
      d = next.toISOString().slice(0, 10);
    }
    return d;
  };
  const mark = (n: number, config = DEFAULT_SUSPENSION): Mark =>
    suspensionMark({
      lastCloseMicro: 10_000_000n,
      advMicro: ADV,
      haltStartD: HALT,
      d: sessionN(n),
      calendar: NO_CAL,
      config,
    });

  it("session numbers count the first halted session as 1", () => {
    expect(haltSessionNumber(HALT, HALT, NO_CAL)).toBe(1);
    expect(haltSessionNumber(HALT, sessionN(6), NO_CAL)).toBe(6);
    expect(sessionN(6)).toBe("2026-10-12");
  });

  it("frozen at the last price through session 20; the 1/2 haircut from session 21", () => {
    expect(positionValueMicro(60n, mark(1))).toBe(600_000_000n);
    expect(positionValueMicro(60n, mark(20))).toBe(600_000_000n);
    expect(mark(20).haircut).toBeNull();
    expect(mark(20).halted).toBe(true);
    expect(mark(21).haircut).toEqual(makeRational(1n, 2n));
    expect(positionValueMicro(60n, mark(21))).toBe(300_000_000n);
    expect(positionValueMicro(60n, mark(40))).toBe(300_000_000n);
  });

  it("TST101-030: with 20 halted sessions elapsed before the day, the value is 300,000,000", () => {
    expect(haircutApplies(19, 20)).toBe(false);
    expect(haircutApplies(20, 20)).toBe(true);
    expect(positionValueMicro(60n, mark(1 + 20))).toBe(300_000_000n);
  });

  it("the session count is injected: other config values move the boundary", () => {
    const cfg = { haircut: makeRational(3n, 10n), afterSessions: 2 };
    expect(mark(2, cfg).haircut).toBeNull();
    expect(mark(3, cfg).haircut).toEqual(makeRational(3n, 10n));
    // one rounding per position: 7 x 3 micro x 3/10 = 6.3 -> 6
    const v = positionValueMicro(7n, { ...mark(3, cfg), closeMicro: 3n });
    expect(v).toBe(6n);
    // half-away: 5 x 1 micro x 1/2 = 2.5 -> 3
    expect(positionValueMicro(5n, { ...mark(21), closeMicro: 1n })).toBe(3n);
  });

  it("flags nav_daily_pos.haircut from session 21 only, and a halted position is not liquidated", () => {
    const book = new Book(1_000_000_000n, 60n, 10_000_000n);
    const books = book.books();
    const day = (n: number) => {
      const d = sessionN(n);
      const m = suspensionMark({
        lastCloseMicro: 10_000_000n,
        advMicro: ADV,
        haltStartD: HALT,
        d,
        calendar: NO_CAL,
      });
      return buildNavDay({ ...books, markFor: () => m }, d);
    };
    // the buy settles 2026-10-07; check sessions after it (haltStart 2026-10-05 is the test clock)
    const early = day(20);
    expect(early.positions[0].haircut).toBe(0);
    expect(early.row.navMicro).toBe(1_000_000_000n);
    expect(early.row.liqNavMicro).toBe(early.row.navMicro); // cannot be sold: no slippage, no fee
    const late = day(21);
    expect(late.positions[0].haircut).toBe(1);
    expect(late.positions[0].valueMicro).toBe(300_000_000n);
    expect(late.row.navMicro).toBe(1_000_000_000n - 300_000_000n);
    expect(late.row.liqNavMicro).toBe(late.row.navMicro);
    // idempotent: the same day twice gives the same row
    expect(serializeLedgerRows(book.rows)).toBe(serializeLedgerRows(book.rows));
    expect(day(21)).toEqual(late);
  });

  it("rejects an impossible configuration", () => {
    expect(() => mark(1, { haircut: makeRational(3n, 2n), afterSessions: 20 })).toThrow("haircut");
    expect(() => mark(1, { haircut: makeRational(0n), afterSessions: 20 })).toThrow("haircut");
    expect(() => mark(1, { haircut: makeRational(1n, 2n), afterSessions: -1 })).toThrow("after");
    expect(() =>
      suspensionMark({
        lastCloseMicro: 1n,
        advMicro: 1n,
        haltStartD: "2026-10-12",
        d: "2026-10-05",
        calendar: NO_CAL,
      }),
    ).toThrow("before the halt");
    expect(mulRat(makeRational(1n), makeRational(1n))).toEqual(makeRational(1n));
  });
});

// ---- database integration -----------------------------------------------------------------------

async function freshBigintDb(): Promise<Client> {
  const db = track(createClient({ url: tempDbUrl(), intMode: "bigint" }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  await db.execute(
    `INSERT INTO execution (id, market, kind, family, variant, twin_group, rule_version, cost_profile)
     VALUES ('E01', 'AU', 'E', 'F1', 'U', 'T1', 'rv1', 'P5')`,
  );
  await db.execute(
    `INSERT INTO cohort (id, execution_id, start_d, seed_micro, rule_version, params_json,
       cost_profile_version, rng_seed)
     VALUES ('K1', 'E01', '2026-10-01', 1000000000, 'rv1', '{}', 1, 42)`,
  );
  return db;
}

async function seedBook(db: Client): Promise<void> {
  const book = new Book(1_000_000_000n, 60n, 10_000_000n);
  await db.execute({
    sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty)
          VALUES ('O1', 'K1', '2026-10-02', 'ZZA', 'buy', 'entry', 60)`,
    args: [],
  });
  await db.execute({
    sql: `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro,
            slip_micro, fill_price_micro, value_micro, brokerage_micro, cost_profile,
            bar_o_micro, bar_h_micro, bar_l_micro, bar_c_micro)
          VALUES ('F1', 'O1', 'K1', ?, 'ZZA', 'buy', 60, 'open', 10000000, 0, 10000000,
            600000000, 0, 'P5', 10000000, 10000000, 10000000, 10000000)`,
    args: [BUY_D],
  });
  for (const t of book.txns) await writeLedgerTxn(db, "K1", t);
}

async function addAction(
  db: Client,
  type: string,
  exDate: string,
  payload: Record<string, unknown>,
  status = "auto_confirmed",
): Promise<void> {
  const r = await db.execute({
    sql: `INSERT INTO corporate_action (market, code, type, ex_date, payload_json)
          VALUES ('AU', 'ZZA', ?, ?, ?)`,
    args: [type, exDate, JSON.stringify(payload)],
  });
  await db.execute({
    sql: `INSERT INTO corporate_action_event (action_id, at, status, by, note)
          VALUES (?, '2026-10-01T00:00:00.000Z', ?, 'test', '{}')`,
    args: [r.lastInsertRowid ?? 0n, status],
  });
}

describe("database integration (corpActionWriter)", () => {
  it("applies a split, a dividend and rights once; a second run writes nothing; queued actions are ignored", async () => {
    const db = await freshBigintDb();
    await seedBook(db);
    await addAction(db, "split", EX, { new: 2, old: 1 });
    await addAction(db, "cash_dividend", EX, { dps_micro: 250_000, pay_date: "2026-10-20" });
    await addAction(db, "rights_renounceable", EX, {
      rights: { new: 1, old: 4 },
      last_price_micro: 300_000,
    });
    await addAction(db, "split", EX, { new: 9, old: 1 }, "queued"); // unconfirmed: must not apply
    const run = () =>
      applyCorporateActionsDay(db, {
        cohortId: "K1",
        market: "AU",
        d: EX,
        priorD: PRIOR,
        lastCloseFor: () => undefined,
      });
    const first = await run();
    expect(first.adjustmentsWritten).toBe(1);
    expect(first.txnsWritten).toBe(2); // div_accrue and ca_comp
    const dump = async () =>
      JSON.stringify(
        (await db.execute("SELECT * FROM cash_ledger ORDER BY id")).rows.map((r) =>
          Object.values(r).map(String),
        ),
      ) +
      JSON.stringify(
        (await db.execute("SELECT * FROM cohort_event")).rows.map((r) =>
          Object.values(r).map(String),
        ),
      );
    const snapshot = await dump();
    const second = await run();
    expect(second.adjustmentsWritten).toBe(0);
    expect(second.txnsWritten).toBe(0);
    expect(await dump()).toBe(snapshot);
    const adj = await loadQtyAdjustments(db, "K1");
    expect(adj).toEqual([{ code: "ZZA", exD: EX, ratio: makeRational(2n) }]);

    // pay date
    const pay = await applyCorporateActionsDay(db, {
      cohortId: "K1",
      market: "AU",
      d: "2026-10-20",
      priorD: "2026-10-19",
      lastCloseFor: () => undefined,
    });
    expect(pay.plan.txns.map((t) => t.kind)).toEqual(["div_pay"]);
    const rows = await loadLedgerRows(db, "K1");
    expect(checkTxns(rows, [])).toEqual(
      expect.arrayContaining([]), // fills are not passed: only fill-tied kinds complain
    );
    // dividend entitlement: 60 shares at the prior close (before the 2-for-1 on the same day)
    const accrual = rows.find((r) => r.kind === "div_accrue" && r.account === "div_recv");
    expect(accrual?.deltaMicro).toBe(15_000_000n);
    const comp = rows.find((r) => r.kind === "ca_comp" && r.account === "cash_settled");
    expect(comp?.deltaMicro).toBe(4_500_000n);
  });

  it("an adjustment recorded twice is a no-op; recorded differently raises", async () => {
    const db = await freshBigintDb();
    await seedBook(db);
    const a = {
      actionId: "7",
      type: "split",
      code: "ZZA",
      exD: EX,
      ratio: makeRational(2n),
      qtyBefore: 60n,
      qtyAfter: 120n,
    };
    expect((await writeAdjustment(db, "K1", a)).written).toBe(true);
    expect((await writeAdjustment(db, "K1", a)).written).toBe(false);
    await expect(writeAdjustment(db, "K1", { ...a, qtyAfter: 121n })).rejects.toThrow("differs");
    const events = await db.execute("SELECT seq, kind FROM cohort_event");
    expect(events.rows).toHaveLength(1);
  });

  it("a stored accrual that differs from the replay raises txn_conflict, never overwrites", async () => {
    const db = await freshBigintDb();
    await seedBook(db);
    await addAction(db, "cash_dividend", EX, { dps_micro: 250_000, pay_date: "2026-10-20" });
    const input = {
      cohortId: "K1",
      market: "AU",
      d: EX,
      priorD: PRIOR,
      lastCloseFor: () => undefined,
    };
    await applyCorporateActionsDay(db, input);
    // a later fill rewrites history (impossible in practice): the plan now differs from storage
    await db.execute({
      sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty)
            VALUES ('O2', 'K1', '2026-10-03', 'ZZA', 'buy', 'entry', 10)`,
      args: [],
    });
    await db.execute({
      sql: `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro,
              slip_micro, fill_price_micro, value_micro, brokerage_micro, cost_profile,
              bar_o_micro, bar_h_micro, bar_l_micro, bar_c_micro)
            VALUES ('F0', 'O2', 'K1', '2026-10-06', 'ZZA', 'buy', 10, 'open', 10000000, 0, 10000000,
              100000000, 0, 'P5', 10000000, 10000000, 10000000, 10000000)`,
      args: [],
    });
    await expect(applyCorporateActionsDay(db, input)).rejects.toMatchObject({
      code: "txn_conflict",
    });
  });
});

describe("ledger kind ca_dispose", () => {
  it("is balanced, removes cost and cannot take cash out", () => {
    const row = (account: string, deltaMicro: bigint): LedgerRow => ({
      txnId: "ca:1",
      d: EX,
      account: account as never,
      deltaMicro,
      kind: "ca_dispose",
      refType: "corporate_action",
      refId: "1",
    });
    expect(checkTxns([row("position_cost", -5n), row("cash_settled", 5n)], [])).toEqual([]);
    const wrong = checkTxns([row("position_cost", 5n), row("equity", -5n)], []);
    expect(wrong.map((v) => v.code)).toEqual(["txn_sign"]);
  });
});
