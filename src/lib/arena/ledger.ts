// Cash ledger: double-entry style postings, T+2 settlement and available cash (M3 design 2, 3, 4.2;
// spec 05 ARN-025, ARN-051, ARN-101; D-069 decisions 11, 13, 15; D-071 TST101-026 ruling).
// HIGH-RISK money module: bigint micro-AUD only, no division, no rounding (every figure here is a
// sum or difference of integers that other modules have already rounded once).
//
// SIGN CONVENTION (debit-positive double entry). Assets and the expense are positive, liabilities
// and equity are negative, and EVERY txn nets to zero on its own rows:
//   assets       cash_settled, cash_recv, div_recv, sleeve_margin, position_cost (cost basis held)
//   expense      fees_paid                                   (positive, cumulative)
//   liabilities  cash_pay, fin_accrued                       (stored negative)
//   equity       equity: seed capital, realised P/L, dividend income, financing (stored negative)
//
// LEDGER IDENTITY. With A = cash_settled + cash_recv + div_recv + sleeve_margin, L = cash_pay +
// fin_accrued, P = position_cost, E = fees_paid and Q = equity, every txn nets to zero so
// A + P + E + L + Q = 0 at all times. NAV (ARN-051) is A + L + market value of positions + sleeve
// unrealised P/L, hence
//   NAV = -Q - E + (market value - P) + sleeve unrealised
//       = (seed capital + realised P/L + income - financing) - fees + unrealised stock P/L + sleeve unrealised.
// invariants.ts checks this reconciliation exactly (nav_equity_reconcile).
//
// FLOW PER FILL (same for `matched` and `conservative`; the modes differ only in AVAILABLE cash):
//   buy  at trade date T : cash_pay -value, position_cost +value        (payable, settles T+2)
//   sell at trade date T : cash_recv +value, position_cost -cost, equity -(value - cost)
//                          (cost = average cost of the shares sold; realised P/L to equity)
//   brokerage            : cash_pay / cash_recv -fee, fees_paid +fee   (fee netted into the item)
//   settlement at T+2    : cash_pay +net, cash_settled -net   (buy)
//                          cash_recv -net, cash_settled +net  (sell)
// Corrections are compensating `reversal` txns (decision 13), never edits.
import { assertInt64, type Micro } from "@/lib/money/micro";
import { makeRational, mulRat, type Rational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { addDays, nextTradingDay, type CalendarRow } from "@/lib/data/calendar";
import { LEDGER_ACCOUNTS, type LedgerAccount, type LedgerKind } from "./schema";

export const SETTLEMENT_MODES = ["matched", "conservative"] as const;
/** ARN-025: matched (default) or conservative. */
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];
/** ARN-025: AU settlement is T+2 trading sessions (ARN-027 trading calendar). */
export const SETTLEMENT_LAG_SESSIONS = 2;

export type Posting = { readonly account: LedgerAccount; readonly deltaMicro: Micro };

export type LedgerTxn = {
  readonly txnId: string;
  /** Sydney trading date YYYY-MM-DD of the posting. */
  readonly d: string;
  readonly kind: LedgerKind;
  readonly refType: string | null;
  readonly refId: string | null;
  readonly postings: readonly Posting[];
};

/** One `cash_ledger` row without the surrogate id and the cohort. */
export type LedgerRow = {
  readonly txnId: string;
  readonly d: string;
  readonly account: LedgerAccount;
  readonly deltaMicro: Micro;
  readonly kind: LedgerKind;
  readonly refType: string | null;
  readonly refId: string | null;
};

/** What the ledger needs from a `fill` row. */
export type LedgerFill = {
  readonly id: string;
  readonly d: string;
  readonly code: string;
  readonly side: "buy" | "sell";
  readonly qty: bigint;
  readonly valueMicro: Micro;
  readonly brokerageMicro: Micro;
};

export type LedgerBalances = Readonly<Record<LedgerAccount, Micro>>;

export function zeroBalances(): LedgerBalances {
  return {
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
}

/** Accept only a canonical, real calendar date (addDays parses strictly and re-prints). */
export function assertTradingDate(d: string): void {
  if (typeof d !== "string" || addDays(d, 0) !== d) {
    throw new RangeError(`not a canonical YYYY-MM-DD date: ${JSON.stringify(d)}`);
  }
}

function isLedgerAccount(value: string): value is LedgerAccount {
  return (LEDGER_ACCOUNTS as readonly string[]).includes(value);
}

/**
 * Structural check of one transaction: non-empty id, a real date, at least one posting, known
 * accounts used once each, no zero or out-of-range amounts, and postings netting to zero.
 */
export function assertTxn(txn: LedgerTxn): void {
  if (txn.txnId.length === 0) throw new RangeError("txn id is empty");
  assertTradingDate(txn.d);
  if (txn.postings.length === 0) throw new RangeError(`txn ${txn.txnId} has no postings`);
  const seen = new Set<string>();
  let total = 0n;
  for (const p of txn.postings) {
    if (!isLedgerAccount(p.account)) throw new RangeError(`unknown account ${p.account}`);
    if (seen.has(p.account)) throw new RangeError(`txn ${txn.txnId} posts ${p.account} twice`);
    seen.add(p.account);
    if (p.deltaMicro === 0n) throw new RangeError(`txn ${txn.txnId} has a zero posting`);
    total += assertInt64(p.deltaMicro);
  }
  if (total !== 0n) {
    throw new RangeError(`txn ${txn.txnId} does not net to zero (off by ${total.toString()})`);
  }
}

function build(
  txnId: string,
  d: string,
  kind: LedgerKind,
  refType: string | null,
  refId: string | null,
  postings: readonly Posting[],
): LedgerTxn {
  const txn: LedgerTxn = { txnId, d, kind, refType, refId, postings };
  assertTxn(txn);
  return txn;
}

export function txnRows(txn: LedgerTxn): LedgerRow[] {
  return txn.postings.map((p) => ({
    txnId: txn.txnId,
    d: txn.d,
    account: p.account,
    deltaMicro: p.deltaMicro,
    kind: txn.kind,
    refType: txn.refType,
    refId: txn.refId,
  }));
}

function positive(value: Micro, what: string): Micro {
  if (value <= 0n) throw new RangeError(`${what} must be a positive amount`);
  return value;
}

/** Seed (ARN-001): the starting cash, against seed capital in equity. */
export function seedTxn(d: string, seedMicro: Micro): LedgerTxn {
  positive(seedMicro, "seed");
  return build("seed", d, "seed", null, null, [
    { account: "cash_settled", deltaMicro: seedMicro },
    { account: "equity", deltaMicro: -seedMicro },
  ]);
}

/** Cash the buyer pays (value + fee) or the seller receives (value - fee) at settlement. */
export function fillNetMicro(fill: LedgerFill): Micro {
  return fill.side === "buy"
    ? fill.valueMicro + fill.brokerageMicro
    : fill.valueMicro - fill.brokerageMicro;
}

/**
 * The trade-date postings of one fill: the trade itself, then the brokerage (omitted when the fee
 * is zero, e.g. the P2 free first buy). A sale needs `saleCostMicro`, the cost basis of the shares
 * sold (replayCostBasis); the difference to the sale value is the realised P/L, posted to equity.
 */
export function fillTxns(fill: LedgerFill, saleCostMicro?: Micro): LedgerTxn[] {
  if (fill.qty <= 0n) throw new RangeError("fill quantity must be positive");
  positive(fill.valueMicro, "fill value");
  if (fill.brokerageMicro < 0n) throw new RangeError("brokerage cannot be negative");
  const buy = fill.side === "buy";
  const tradeAccount: LedgerAccount = buy ? "cash_pay" : "cash_recv";
  let postings: Posting[];
  if (buy) {
    postings = [
      { account: "cash_pay", deltaMicro: -fill.valueMicro },
      { account: "position_cost", deltaMicro: fill.valueMicro },
    ];
  } else {
    if (saleCostMicro === undefined) throw new RangeError("a sale needs its cost basis");
    positive(saleCostMicro, "sale cost basis");
    postings = [
      { account: "cash_recv", deltaMicro: fill.valueMicro },
      { account: "position_cost", deltaMicro: -saleCostMicro },
    ];
    if (fill.valueMicro !== saleCostMicro) {
      postings.push({ account: "equity", deltaMicro: saleCostMicro - fill.valueMicro });
    }
  }
  const txns: LedgerTxn[] = [
    build(`fill:${fill.id}`, fill.d, fill.side, "fill", fill.id, postings),
  ];
  if (fill.brokerageMicro > 0n) {
    txns.push(
      build(`fee:${fill.id}`, fill.d, "brokerage", "fill", fill.id, [
        { account: tradeAccount, deltaMicro: -fill.brokerageMicro },
        { account: "fees_paid", deltaMicro: fill.brokerageMicro },
      ]),
    );
  }
  return txns;
}

// ---- cost basis (average cost, derived from fills) -------------------------------------------

/** Quantity re-base on an ex-date: new quantity = held quantity x ratio (ratio = 1 / factor). */
export type QtyAdjustment = {
  readonly code: string;
  readonly exD: string;
  readonly ratio: Rational;
};

export type CostReplay = {
  /** Cost basis removed by each sale, by fill id. */
  readonly saleCostByFillId: ReadonlyMap<string, Micro>;
  /** Shares and cost basis still held per code. */
  readonly holdings: ReadonlyMap<string, { readonly qty: bigint; readonly costMicro: Micro }>;
};

/**
 * Average-cost replay of the fills dated on or before `asOfD`, in (date, fill id) order; on an
 * ex-date the quantity adjustments come first and change quantity, never cost (decision 14). A
 * partial sale removes round_half_away(cost x qty sold / qty held), once; a sale of everything
 * removes the whole remaining cost, so cost never drifts. Selling more than is held is refused.
 */
export function replayCostBasis(
  fills: readonly LedgerFill[],
  adjustments: readonly QtyAdjustment[],
  asOfD: string,
): CostReplay {
  type Event = { d: string; rank: number; key: string; fill?: LedgerFill; adj?: QtyAdjustment };
  const events: Event[] = [
    ...fills
      .filter((f) => f.d <= asOfD)
      .map((fill) => ({ d: fill.d, rank: 1, key: fill.id, fill })),
    ...adjustments
      .filter((a) => a.exD <= asOfD)
      .map((adj) => ({ d: adj.exD, rank: 0, key: adj.code, adj })),
  ];
  events.sort((a, b) =>
    a.d !== b.d
      ? a.d < b.d
        ? -1
        : 1
      : a.rank !== b.rank
        ? a.rank - b.rank
        : a.key < b.key
          ? -1
          : 1,
  );
  const holdings = new Map<string, { qty: bigint; costMicro: Micro }>();
  const saleCostByFillId = new Map<string, Micro>();
  for (const e of events) {
    if (e.adj !== undefined) {
      const held = holdings.get(e.adj.code);
      if (held === undefined) continue;
      const scaled = mulRat(makeRational(held.qty), e.adj.ratio);
      if (scaled.den !== 1n)
        throw new RangeError(`fractional quantity after adjusting ${e.adj.code}`);
      held.qty = scaled.num;
    } else if (e.fill !== undefined) {
      const f = e.fill;
      const held = holdings.get(f.code) ?? { qty: 0n, costMicro: 0n };
      if (f.side === "buy") {
        held.qty += f.qty;
        held.costMicro += f.valueMicro;
        holdings.set(f.code, held);
      } else {
        if (f.qty > held.qty) throw new RangeError(`sale ${f.id} exceeds the holding of ${f.code}`);
        const removed =
          f.qty === held.qty
            ? held.costMicro
            : roundHalfAwayFromZero(makeRational(held.costMicro * f.qty, held.qty));
        saleCostByFillId.set(f.id, removed);
        held.qty -= f.qty;
        held.costMicro -= removed;
        if (held.qty === 0n) holdings.delete(f.code);
      }
    }
  }
  return { saleCostByFillId, holdings };
}

// ---- settlement ------------------------------------------------------------------------------

/** One unsettled fill: what it will pay or receive, and the session it settles. */
export type SettlementItem = {
  readonly fillId: string;
  readonly side: "buy" | "sell";
  readonly tradeD: string;
  readonly settleD: string;
  /** buy: amount payable (value + fee, positive); sell: amount receivable (value - fee). */
  readonly netMicro: Micro;
};

/** T+2 trading sessions after the trade date, skipping weekends and calendar holidays. */
export function settlementDate(tradeD: string, calendar: readonly CalendarRow[]): string {
  let d = tradeD;
  for (let i = 0; i < SETTLEMENT_LAG_SESSIONS; i++) d = nextTradingDay(d, calendar);
  return d;
}

export function settlementItem(fill: LedgerFill, calendar: readonly CalendarRow[]): SettlementItem {
  return {
    fillId: fill.id,
    side: fill.side,
    tradeD: fill.d,
    settleD: settlementDate(fill.d, calendar),
    netMicro: fillNetMicro(fill),
  };
}

function compareItems(a: SettlementItem, b: SettlementItem): number {
  if (a.settleD !== b.settleD) return a.settleD < b.settleD ? -1 : 1;
  if (a.side !== b.side) return a.side === "sell" ? -1 : 1; // receipts before payments
  return a.fillId < b.fillId ? -1 : 1; // fill ids are unique
}

/**
 * Fills not yet settled, in settlement order. A fill whose net is exactly zero has nothing to
 * settle and never appears.
 */
export function pendingSettlements(
  fills: readonly LedgerFill[],
  settledFillIds: ReadonlySet<string>,
  calendar: readonly CalendarRow[],
): SettlementItem[] {
  return fills
    .filter((f) => !settledFillIds.has(f.id))
    .map((f) => settlementItem(f, calendar))
    .filter((item) => item.netMicro !== 0n)
    .sort(compareItems);
}

/** The settlement posting for one item, dated `d` (normally its settlement session). */
export function settleTxn(item: SettlementItem, d: string): LedgerTxn {
  if (item.netMicro === 0n) throw new RangeError("a zero item has nothing to settle");
  const buy = item.side === "buy";
  return build(`settle:${item.fillId}`, d, "settle", "fill", item.fillId, [
    { account: buy ? "cash_pay" : "cash_recv", deltaMicro: buy ? item.netMicro : -item.netMicro },
    { account: "cash_settled", deltaMicro: buy ? -item.netMicro : item.netMicro },
  ]);
}

/** Settlement txns for every pending item due on or before `d`: receipts first, then payments. */
export function settlementsDue(pending: readonly SettlementItem[], d: string): LedgerTxn[] {
  return pending
    .filter((item) => item.settleD <= d)
    .sort(compareItems)
    .map((item) => settleTxn(item, d));
}

/**
 * Cash a buy filling in session `sessionD` can use (ARN-025, D-069 decision 15, D-071 TST101-026).
 *   matched      settled cash + unsettled sale proceeds + (negative) payables: proceeds fund buys
 *                at once.
 *   conservative settled cash + sale proceeds whose settlement session is `sessionD` or earlier
 *                (available from the START of the T+2 session) + payables.
 * Payables are always deducted in full: that cash is already committed. `pending` must hold the
 * unsettled items consistent with `balances`. The result may be negative (an overdraft the
 * invariants flag); callers size against max(0, result).
 */
export function availableCash(input: {
  readonly mode: SettlementMode;
  readonly balances: LedgerBalances;
  readonly pending: readonly SettlementItem[];
  readonly sessionD: string;
}): Micro {
  const b = input.balances;
  if (input.mode === "matched") return b.cash_settled + b.cash_recv + b.cash_pay;
  let dueReceipts = 0n;
  for (const item of input.pending) {
    if (item.side === "sell" && item.settleD <= input.sessionD) dueReceipts += item.netMicro;
  }
  return b.cash_settled + dueReceipts + b.cash_pay;
}

// ---- dividends (placeholder; the corporate-action engine is T7) --------------------------------

/** Ex-date: the receivable enters NAV; the income goes to equity. Franking is not posted. */
export function divAccrueTxn(input: {
  readonly d: string;
  readonly refId: string;
  readonly amountMicro: Micro;
}): LedgerTxn {
  positive(input.amountMicro, "dividend");
  return build(`divacc:${input.refId}`, input.d, "div_accrue", "dividend", input.refId, [
    { account: "div_recv", deltaMicro: input.amountMicro },
    { account: "equity", deltaMicro: -input.amountMicro },
  ]);
}

/** Pay date: the receivable becomes settled cash. */
export function divPayTxn(input: {
  readonly d: string;
  readonly refId: string;
  readonly amountMicro: Micro;
}): LedgerTxn {
  positive(input.amountMicro, "dividend");
  return build(`divpay:${input.refId}`, input.d, "div_pay", "dividend", input.refId, [
    { account: "div_recv", deltaMicro: -input.amountMicro },
    { account: "cash_settled", deltaMicro: input.amountMicro },
  ]);
}

/** Compensating transaction (decision 13): every posting negated. */
export function reversalTxn(original: LedgerTxn, d: string): LedgerTxn {
  return build(
    `rev:${original.txnId}`,
    d,
    "reversal",
    "txn",
    original.txnId,
    original.postings.map((p) => ({ account: p.account, deltaMicro: -p.deltaMicro })),
  );
}

// ---- balances --------------------------------------------------------------------------------

/** Sum of all rows dated on or before `upToD` (all rows when omitted), per account. */
export function balancesFromRows(rows: readonly LedgerRow[], upToD?: string): LedgerBalances {
  const totals: Record<LedgerAccount, Micro> = { ...zeroBalances() };
  for (const row of rows) {
    if (upToD === undefined || row.d <= upToD) totals[row.account] += row.deltaMicro;
  }
  return totals;
}
