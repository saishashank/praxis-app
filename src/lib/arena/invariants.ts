// Nightly ledger invariants (spec 05 ARN-101, ARN-102; M3 design 4.2 step 5; TST-104). Pure
// checks over plain data: they return violations, they never repair and never throw on bad
// books. A violation marks the day `invariants_ok = 0` and stops the cohort (closeBooks, T10).
//
//   1. every txn_id nets to zero on its own rows (double entry, see ledger.ts)
//   2. every fill is posted, and trade / brokerage / settlement / sale-cost amounts tie to the
//      fill; position_cost equals the average-cost basis replayed from the fills
//   3. cash never negative: settled cash >= 0 in both modes, and cash that is committed to
//      payables must be covered (conservative: settled; matched: settled + sale proceeds). A
//      FORCED EXIT (a sale whose fee exceeds its proceeds; exits are never blocked) may draw
//      settled cash below zero: that part is reported as `forced_exit_overdraft`, not fatal
//      (`fatal: false`), the run continues; any other shortfall stays a hard failure
//   4. no shorts (holdings derived from fills)
//   5. unsettled receivables and payables on the ledger equal the unsettled fills
//   6. NAV reconciles exactly (ARN-051): identity, position rows, cash side vs the ledger, and
//      NAV = -equity - fees_paid + (market value - position_cost) + sleeve unrealised
//   7. recomputing from scratch equals the stored daily rows (ARN-102)
//   8. sleeve (ARN-101, T8): the sleeve-margin balance equals the margin of the open real sleeve
//      trade (else 0); accrued financing equals the cumulative formula; price P/L + financing loss
//      never exceeds the margin (closed trades and every open mark); one real trade at a time,
//      shadow trades leave no ledger row; sleeve txns tie to their trade; the lock history is
//      consistent (alternating, loss_to_recover = the locking trade's net loss, no real trade opened
//      while locked, every losing real trade locked). A close that draws main cash for brokerage
//      beyond a consumed margin is a forced exit (non-fatal overdraft), like a forced sale.
import type { CalendarRow } from "@/lib/data/calendar";
import {
  balancesFromRows,
  fillNetMicro,
  pendingSettlements,
  replayCostBasis,
  type LedgerBalances,
  type LedgerFill,
  type LedgerRow,
  type SettlementMode,
} from "./ledger";
import {
  buildNavDay,
  derivePositions,
  navIdentityMicro,
  serializeNavDays,
  type CohortBooks,
  type NavDay,
} from "./nav";
import type { LedgerAccount } from "./schema";
import {
  financingAccruedAt,
  netPlMicro,
  openRealTradeAt,
  type SleeveConfig,
  type SleeveStateEntry,
  type SleeveTrade,
} from "./sleeve";

export type InvariantCode =
  | "txn_inconsistent"
  | "txn_not_balanced"
  | "txn_fill_missing"
  | "txn_tie_mismatch"
  | "position_cost_mismatch"
  | "cost_unbuildable"
  | "nav_equity_reconcile"
  | "forced_exit_overdraft"
  | "txn_reversal_mismatch"
  | "txn_seed_mismatch"
  | "txn_sign"
  | "fill_unposted"
  | "negative_cash"
  | "overcommitted_cash"
  | "short_position"
  | "pending_mismatch"
  | "nav_identity"
  | "nav_positions_sum"
  | "nav_open_count"
  | "nav_cash_mismatch"
  | "liq_above_nav"
  | "nav_unbuildable"
  | "nav_missing"
  | "nav_recompute_mismatch"
  | "stored_flag_not_ok"
  | "sleeve_trade_shape"
  | "sleeve_overlap"
  | "sleeve_txn_shape"
  | "sleeve_txn_tie"
  | "sleeve_shadow_posted"
  | "sleeve_margin_balance"
  | "sleeve_financing_balance"
  | "sleeve_financing_mismatch"
  | "sleeve_loss_over_margin"
  | "sleeve_unreal_orphan"
  | "lock_state_inconsistent"
  | "lock_missing"
  | "lock_unexplained"
  | "stale_mark"
  | "sleeve_opened_while_locked";

export type Violation = {
  readonly code: InvariantCode;
  readonly message: string;
  readonly d?: string;
  readonly txnId?: string;
  /** false = reported but the run continues (forced_exit_overdraft). Absent = hard failure. */
  readonly fatal?: false;
};

export const isFatal = (v: Violation): boolean => v.fatal !== false;

function groupByTxn(rows: readonly LedgerRow[]): Map<string, LedgerRow[]> {
  const groups = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const group = groups.get(row.txnId);
    if (group === undefined) groups.set(row.txnId, [row]);
    else group.push(row);
  }
  return groups;
}

function total(rows: readonly LedgerRow[]): bigint {
  let sum = 0n;
  for (const r of rows) sum += r.deltaMicro;
  return sum;
}

function deltaOf(rows: readonly LedgerRow[], account: LedgerAccount): bigint | undefined {
  return rows.find((r) => r.account === account)?.deltaMicro;
}

// ---- 1 and 2: transactions -------------------------------------------------------------------

export type TxnCheckOptions = {
  /** The cohort's seed; when given, the seed txn must equal it. */
  readonly seedMicro?: bigint;
  /** Cost basis removed by each sale (replayCostBasis); when absent it is read from the rows. */
  readonly saleCosts?: ReadonlyMap<string, bigint>;
};

export function checkTxns(
  rows: readonly LedgerRow[],
  fills: readonly LedgerFill[],
  options: TxnCheckOptions = {},
): Violation[] {
  const out: Violation[] = [];
  const fillById = new Map(fills.map((f) => [f.id, f]));
  const groups = groupByTxn(rows);
  const bad = (code: InvariantCode, txnId: string, d: string, message: string) =>
    out.push({ code, txnId, d, message });

  for (const [txnId, group] of groups) {
    const first = group[0];
    const { kind, d } = first;
    const accounts = new Set(group.map((r) => r.account));
    const consistent = group.every(
      (r) => r.kind === kind && r.d === d && r.refType === first.refType && r.refId === first.refId,
    );
    if (!consistent || accounts.size !== group.length) {
      bad("txn_inconsistent", txnId, d, "rows of one txn differ in kind, date, ref or account");
      continue;
    }
    const sum = total(group);
    const fill =
      first.refType === "fill" && first.refId !== null ? fillById.get(first.refId) : undefined;

    if (sum !== 0n) {
      bad("txn_not_balanced", txnId, d, `${kind} nets to ${sum.toString()}, expected 0`);
    }
    if (kind === "buy" || kind === "sell") {
      if (fill === undefined || fill.side !== kind) {
        bad("txn_fill_missing", txnId, d, `${kind} txn has no matching ${kind} fill`);
      } else if (kind === "buy") {
        if (
          deltaOf(group, "cash_pay") !== -fill.valueMicro ||
          deltaOf(group, "position_cost") !== fill.valueMicro
        ) {
          bad("txn_tie_mismatch", txnId, d, "buy postings differ from the fill value");
        }
      } else {
        const cost = options.saleCosts?.get(fill.id) ?? -(deltaOf(group, "position_cost") ?? 0n);
        if (
          deltaOf(group, "cash_recv") !== fill.valueMicro ||
          deltaOf(group, "position_cost") !== -cost ||
          (deltaOf(group, "equity") ?? 0n) !== cost - fill.valueMicro
        ) {
          bad("txn_tie_mismatch", txnId, d, "sell postings differ from the fill value and cost");
        }
      }
    } else if (kind === "brokerage" || kind === "settle") {
      if (fill === undefined) {
        bad("txn_fill_missing", txnId, d, `${kind} txn has no fill to tie to`);
      } else if (kind === "brokerage" && deltaOf(group, "fees_paid") !== fill.brokerageMicro) {
        bad("txn_tie_mismatch", txnId, d, "fees_paid differs from the fill brokerage");
      } else if (
        kind === "settle" &&
        deltaOf(group, "cash_settled") !==
          (fill.side === "buy" ? -fillNetMicro(fill) : fillNetMicro(fill))
      ) {
        bad("txn_tie_mismatch", txnId, d, "settled cash differs from the fill net amount");
      }
    } else if (kind === "seed") {
      const cash = deltaOf(group, "cash_settled") ?? 0n;
      if (cash <= 0n || deltaOf(group, "equity") !== -cash) {
        bad("txn_sign", txnId, d, "seed must be positive cash against equity");
      } else if (options.seedMicro !== undefined && cash !== options.seedMicro) {
        bad(
          "txn_seed_mismatch",
          txnId,
          d,
          `seed is ${cash.toString()}, cohort says ${options.seedMicro.toString()}`,
        );
      }
    } else if (kind === "div_accrue" || kind === "ca_comp") {
      if ((deltaOf(group, "equity") ?? 0n) >= 0n) {
        bad("txn_sign", txnId, d, `${kind} must add income`);
      }
    } else if (kind === "ca_dispose") {
      // a corporate-action disposal removes cost basis; cash received (if any) is settled cash
      const cash = deltaOf(group, "cash_settled") ?? 0n;
      if ((deltaOf(group, "position_cost") ?? 0n) >= 0n || cash < 0n) {
        bad("txn_sign", txnId, d, "ca_dispose must remove cost and may only add settled cash");
      }
    } else if (kind === "reversal") {
      const original =
        first.refType === "txn" && first.refId !== null ? groups.get(first.refId) : undefined;
      const matches =
        original !== undefined &&
        original.length === group.length &&
        group.every((r) => deltaOf(original, r.account) === -r.deltaMicro);
      if (!matches) {
        bad("txn_reversal_mismatch", txnId, d, "reversal does not negate the original txn");
      }
    } else if (kind === "sleeve_open" || kind === "sleeve_close" || kind === "financing") {
      checkSleeveTxnShape(group, kind, bad);
    }
    // sleeve_pnl is not used: the capped price P/L is part of the sleeve_close txn.
  }
  return out;
}

/** Every fill dated on or before `upToD` must have its trade txn (and fee txn when the fee > 0). */
export function checkFillsPosted(
  rows: readonly LedgerRow[],
  fills: readonly LedgerFill[],
  upToD: string,
): Violation[] {
  const have = new Set(rows.map((r) => r.txnId));
  const out: Violation[] = [];
  for (const f of fills) {
    if (f.d > upToD) continue;
    const missing = [`fill:${f.id}`, ...(f.brokerageMicro > 0n ? [`fee:${f.id}`] : [])].filter(
      (id) => !have.has(id),
    );
    for (const txnId of missing) {
      out.push({ code: "fill_unposted", txnId, d: f.d, message: `fill ${f.id} is not posted` });
    }
  }
  return out;
}

// ---- 3 and 5: balances -----------------------------------------------------------------------

export function checkBalances(
  balances: LedgerBalances,
  mode: SettlementMode,
  d: string,
  forcedDrawMicro: bigint = 0n,
): Violation[] {
  const out: Violation[] = [];
  let forcedReported = false;
  const forced = (message: string) => {
    if (forcedReported) return;
    forcedReported = true;
    out.push({ code: "forced_exit_overdraft", d, message, fatal: false });
  };
  if (balances.cash_settled < 0n) {
    const message = `settled cash is ${balances.cash_settled.toString()}`;
    if (balances.cash_settled + forcedDrawMicro >= 0n) forced(message);
    else out.push({ code: "negative_cash", d, message });
  }
  const covered =
    mode === "matched"
      ? balances.cash_settled + balances.cash_recv + balances.cash_pay
      : balances.cash_settled + balances.cash_pay;
  if (covered < 0n) {
    const message = `${mode} cash covers payables short by ${(-covered).toString()}`;
    if (covered + forcedDrawMicro >= 0n) forced(message);
    else out.push({ code: "overcommitted_cash", d, message });
  }
  return out;
}

/** Receivable and payable balances equal the unsettled fills' net amounts. */
export function checkPending(
  balances: LedgerBalances,
  pending: readonly { readonly side: "buy" | "sell"; readonly netMicro: bigint }[],
  d: string,
): Violation[] {
  let receivable = 0n;
  let payable = 0n;
  for (const item of pending) {
    if (item.side === "sell") receivable += item.netMicro;
    else payable += item.netMicro;
  }
  const out: Violation[] = [];
  if (balances.cash_recv !== receivable) {
    out.push({ code: "pending_mismatch", d, message: "receivable differs from unsettled sales" });
  }
  if (-balances.cash_pay !== payable) {
    out.push({ code: "pending_mismatch", d, message: "payable differs from unsettled purchases" });
  }
  return out;
}

// ---- 6: one NAV day --------------------------------------------------------------------------

export function checkNavDay(day: NavDay, balances?: LedgerBalances): Violation[] {
  const { row, positions } = day;
  const out: Violation[] = [];
  const d = row.d;
  if (navIdentityMicro(row) !== row.navMicro) {
    out.push({ code: "nav_identity", d, message: "NAV is not cash + market value (ARN-051)" });
  }
  let sum = 0n;
  for (const p of positions) sum += p.valueMicro;
  if (sum !== row.positionsMicro) {
    out.push({ code: "nav_positions_sum", d, message: "positions value differs from the rows" });
  }
  if (BigInt(positions.length) !== row.openPositions) {
    out.push({ code: "nav_open_count", d, message: "open_positions differs from the rows" });
  }
  if (row.liqNavMicro > row.navMicro) {
    out.push({ code: "liq_above_nav", d, message: "liquidation NAV is above NAV" });
  }
  if (
    balances !== undefined &&
    (row.cashSettledMicro !== balances.cash_settled ||
      row.recvMicro !== balances.cash_recv ||
      row.payMicro !== -balances.cash_pay ||
      row.divRecvMicro !== balances.div_recv ||
      row.sleeveMarginMicro !== balances.sleeve_margin ||
      row.finAccruedMicro !== -balances.fin_accrued)
  ) {
    out.push({ code: "nav_cash_mismatch", d, message: "NAV cash side differs from the ledger" });
  }
  if (
    balances !== undefined &&
    row.navMicro !==
      -balances.equity -
        balances.fees_paid +
        (row.positionsMicro - balances.position_cost) +
        row.sleeveUnrealMicro
  ) {
    out.push({
      code: "nav_equity_reconcile",
      d,
      message:
        "NAV differs from -equity - fees + (market value - position cost) + sleeve unrealised",
    });
  }
  return out;
}

// ---- 7: stored versus recomputed -------------------------------------------------------------

const asVerdictOk = (day: NavDay): NavDay => ({
  row: { ...day.row, invariantsOk: 1 },
  positions: day.positions,
});

/** Stored and recomputed rows must serialise identically (the verdict flag is judged apart). */
export function compareStoredNav(stored: NavDay, recomputed: NavDay): Violation[] {
  const a = serializeNavDays([asVerdictOk(stored)]);
  const b = serializeNavDays([asVerdictOk(recomputed)]);
  const out: Violation[] = [];
  if (a !== b) {
    out.push({
      code: "nav_recompute_mismatch",
      d: stored.row.d,
      message: `stored ${a.split("\n")[0]} != recomputed ${b.split("\n")[0]}`,
    });
  }
  if (stored.row.invariantsOk !== 1) {
    out.push({
      code: "stored_flag_not_ok",
      d: stored.row.d,
      message: "stored with invariants_ok = 0",
    });
  }
  return out;
}

// ---- 8: sleeve (ARN-101, T8) -------------------------------------------------------------------

type BadFn = (code: InvariantCode, txnId: string, d: string, message: string) => void;

const SLEEVE_ACCOUNTS: Record<string, readonly LedgerAccount[]> = {
  sleeve_open: ["cash_settled", "sleeve_margin", "fees_paid"],
  sleeve_close: ["sleeve_margin", "fin_accrued", "equity", "cash_settled", "fees_paid"],
  financing: ["fin_accrued", "equity"],
};

/** Shape of one sleeve txn (accounts and signs); ties to the trade row are in checkSleeveStatic. */
function checkSleeveTxnShape(group: readonly LedgerRow[], kind: string, bad: BadFn): void {
  const first = group[0];
  if (first.refType !== "sleeve_trade") return;
  const allowed = SLEEVE_ACCOUNTS[kind] ?? [];
  if (group.some((r) => !allowed.includes(r.account))) {
    bad("sleeve_txn_shape", first.txnId, first.d, `${kind} uses an account it may not`);
    return;
  }
  const margin = deltaOf(group, "sleeve_margin") ?? 0n;
  const fees = deltaOf(group, "fees_paid") ?? 0n;
  if (fees < 0n) bad("sleeve_txn_shape", first.txnId, first.d, `${kind} has negative brokerage`);
  if (kind === "sleeve_open") {
    const cash = deltaOf(group, "cash_settled") ?? 0n;
    if (margin <= 0n || cash !== -(margin + fees)) {
      bad(
        "sleeve_txn_shape",
        first.txnId,
        first.d,
        "open must move margin and brokerage out of cash",
      );
    }
  } else if (kind === "sleeve_close") {
    if (margin >= 0n)
      bad("sleeve_txn_shape", first.txnId, first.d, "close must release the margin");
    if ((deltaOf(group, "fin_accrued") ?? 0n) < 0n) {
      bad("sleeve_txn_shape", first.txnId, first.d, "close must pay down accrued financing");
    }
  } else {
    const fin = deltaOf(group, "fin_accrued") ?? 0n;
    if (fin >= 0n || deltaOf(group, "equity") !== -fin) {
      bad("sleeve_txn_shape", first.txnId, first.d, "financing must be a positive expense");
    }
  }
}

export type SleeveCheckOptions = {
  readonly trades: readonly SleeveTrade[];
  readonly states: readonly SleeveStateEntry[];
  readonly cfg: SleeveConfig;
};

const sumOf = (rows: readonly LedgerRow[]): bigint => rows.reduce((t, r) => t + r.deltaMicro, 0n);

/**
 * Date-independent sleeve checks: trade shape and cap, one real trade at a time, ledger txns tied
 * to their trade, shadow trades never posted, and a consistent lock history.
 */
export function checkSleeveStatic(
  rows: readonly LedgerRow[],
  options: SleeveCheckOptions,
): Violation[] {
  const out: Violation[] = [];
  const { trades, states, cfg } = options;
  const v = (code: InvariantCode, message: string, d?: string, txnId?: string) =>
    out.push({
      code,
      message,
      ...(d === undefined ? {} : { d }),
      ...(txnId === undefined ? {} : { txnId }),
    });
  const byId = new Map(trades.map((t) => [t.id, t]));

  // trade shape and the loss cap
  for (const t of trades) {
    const c = t.closed;
    const real = !t.shadow;
    if (
      t.marginMicro <= 0n ||
      t.leverage < 1n ||
      t.notionalMicro !== t.marginMicro * t.leverage ||
      (real && t.entryFillId === null) ||
      (!real && (t.entryFillId !== null || (c !== null && c.exitFillId !== null))) ||
      (real && c !== null && c.exitFillId === null) ||
      (c !== null && c.closeD < t.openD)
    ) {
      v("sleeve_trade_shape", `sleeve trade ${t.id} is malformed`, t.openD);
      continue;
    }
    if (c !== null) {
      if (c.pricePlMicro - c.financingMicro < -t.marginMicro) {
        v("sleeve_loss_over_margin", `sleeve trade ${t.id} lost more than its margin`, c.closeD);
      }
      if (c.financingMicro !== financingAccruedAt(t, c.closeD, cfg)) {
        v(
          "sleeve_financing_mismatch",
          `sleeve trade ${t.id} financing is not the cumulative figure`,
          c.closeD,
        );
      }
    }
  }

  // one trade at a time, separately for real and shadow trades
  for (const shadow of [false, true]) {
    const list = trades
      .filter((t) => t.shadow === shadow)
      .sort((a, b) => (a.openD !== b.openD ? (a.openD < b.openD ? -1 : 1) : a.id < b.id ? -1 : 1));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      if (prev.closed === null || list[i].openD < prev.closed.closeD) {
        v("sleeve_overlap", `sleeve trades ${prev.id} and ${list[i].id} overlap`, list[i].openD);
      }
    }
  }

  // ledger rows tied to their trade
  const perTrade = new Map<string, LedgerRow[]>();
  for (const r of rows.filter((x) => x.refType === "sleeve_trade")) {
    const key = r.refId ?? "";
    perTrade.set(key, [...(perTrade.get(key) ?? []), r]);
  }
  for (const [id, group] of perTrade) {
    const t = byId.get(id);
    if (t === undefined) {
      v(
        "sleeve_txn_tie",
        `ledger rows reference unknown sleeve trade ${id}`,
        group[0].d,
        group[0].txnId,
      );
    } else if (t.shadow) {
      v(
        "sleeve_shadow_posted",
        `shadow sleeve trade ${id} has ledger rows`,
        group[0].d,
        group[0].txnId,
      );
    }
  }
  for (const t of trades.filter((x) => !x.shadow)) {
    const mine = perTrade.get(t.id) ?? [];
    const of = (kind: string) => mine.filter((r) => r.kind === kind);
    const open = of("sleeve_open");
    const entryFee = sumOf(open.filter((r) => r.account === "fees_paid"));
    if (
      open.length === 0 ||
      sumOf(open.filter((r) => r.account === "sleeve_margin")) !== t.marginMicro ||
      open[0].d !== t.openD
    ) {
      v("sleeve_txn_tie", `sleeve trade ${t.id} has no open posting of its margin`, t.openD);
    }
    const fin = -sumOf(of("financing").filter((r) => r.account === "fin_accrued"));
    const close = of("sleeve_close");
    const c = t.closed;
    if (c === null) {
      if (close.length > 0) {
        v("sleeve_txn_tie", `open sleeve trade ${t.id} has a close posting`, t.openD);
      }
      continue;
    }
    const exitFee = sumOf(close.filter((r) => r.account === "fees_paid"));
    const cash = sumOf(close.filter((r) => r.account === "cash_settled"));
    if (
      close.length === 0 ||
      close[0].d !== c.closeD ||
      sumOf(close.filter((r) => r.account === "sleeve_margin")) !== -t.marginMicro ||
      sumOf(close.filter((r) => r.account === "fin_accrued")) !== c.financingMicro ||
      -sumOf(close.filter((r) => r.account === "equity")) !== c.pricePlMicro ||
      cash !== t.marginMicro + c.pricePlMicro - c.financingMicro - exitFee ||
      entryFee + exitFee !== c.costsMicro ||
      fin !== c.financingMicro
    ) {
      v("sleeve_txn_tie", `sleeve trade ${t.id} close postings differ from the trade`, c.closeD);
    }
  }

  // lock history
  let previous: SleeveStateEntry | undefined;
  states.forEach((s, i) => {
    const bad = (message: string) => v("lock_state_inconsistent", message, s.d);
    if (s.seq !== i + 1) bad(`sleeve_state seq ${s.seq} is not ${i + 1}`);
    if (i === 0 && s.state !== "locked") bad("the first sleeve_state must be a lock");
    if (previous !== undefined && previous.state === s.state) bad("lock and unlock must alternate");
    if (s.state === "locked" && s.lossToRecoverMicro <= 0n) {
      bad("a lock records a positive loss_to_recover");
    }
    if (s.state === "unlocked" && s.lossToRecoverMicro !== 0n) {
      bad("an unlock carries no loss_to_recover");
    }
    if (previous !== undefined && s.d < previous.d) bad("sleeve_state dates go backwards");
    previous = s;
  });
  const lockRows = states.filter((s) => s.state === "locked");
  const losers = trades.filter((t) => !t.shadow && t.closed !== null && netPlMicro(t.closed) < 0n);
  for (const t of losers) {
    const c = t.closed as NonNullable<SleeveTrade["closed"]>;
    if (!lockRows.some((s) => s.d === c.closeD && s.lossToRecoverMicro === -netPlMicro(c))) {
      v("lock_missing", `losing sleeve trade ${t.id} did not lock the sleeve`, c.closeD);
    }
  }
  for (const s of lockRows) {
    const explained = losers.some(
      (t) =>
        t.closed !== null &&
        t.closed.closeD === s.d &&
        s.lossToRecoverMicro === -netPlMicro(t.closed),
    );
    if (!explained) v("lock_unexplained", `lock on ${s.d} has no losing sleeve trade`, s.d);
  }
  // no real trade opens while locked: lock day < open day <= unlock day (or not yet unlocked)
  for (const t of trades.filter((x) => !x.shadow)) {
    states.forEach((s, i) => {
      if (s.state !== "locked") return;
      const unlock = states.slice(i + 1).find((x) => x.state === "unlocked");
      if (t.openD > s.d && (unlock === undefined || t.openD <= unlock.d)) {
        v("sleeve_opened_while_locked", `real sleeve trade ${t.id} opened while locked`, t.openD);
      }
    });
  }
  return out;
}

/**
 * Sleeve checks for one close: margin balance, financing balance and the loss cap on the NAV row
 * (`day` is the recomputed NAV for its date).
 */
export function checkSleeveDay(
  options: SleeveCheckOptions,
  balances: LedgerBalances,
  day: NavDay,
): Violation[] {
  const out: Violation[] = [];
  const d = day.row.d;
  let open: SleeveTrade | null;
  try {
    open = openRealTradeAt(options.trades, d);
  } catch {
    out.push({ code: "sleeve_overlap", d, message: "more than one real sleeve trade is open" });
    return out;
  }
  const expectedMargin = open === null ? 0n : open.marginMicro;
  if (balances.sleeve_margin !== expectedMargin) {
    out.push({
      code: "sleeve_margin_balance",
      d,
      message: `sleeve margin balance ${balances.sleeve_margin.toString()} != open trade margin ${expectedMargin.toString()}`,
    });
  }
  const expectedFin = open === null ? 0n : financingAccruedAt(open, d, options.cfg);
  if (-balances.fin_accrued !== expectedFin) {
    out.push({
      code: "sleeve_financing_balance",
      d,
      message: `accrued financing ${(-balances.fin_accrued).toString()} != cumulative ${expectedFin.toString()}`,
    });
  }
  if (open === null) {
    if (day.row.sleeveUnrealMicro !== 0n) {
      out.push({
        code: "sleeve_unreal_orphan",
        d,
        message: "sleeve unrealised P/L without an open trade",
      });
    }
  } else if (day.row.sleeveUnrealMicro - day.row.finAccruedMicro < -open.marginMicro) {
    out.push({
      code: "sleeve_loss_over_margin",
      d,
      message: "open sleeve price P/L + financing loss exceeds the margin",
    });
  }
  return out;
}

// ---- whole cohort ----------------------------------------------------------------------------

export type CohortCheckOptions = {
  readonly mode: SettlementMode;
  readonly calendar: readonly CalendarRow[];
  /** Dates to verify, oldest first. */
  readonly dates: readonly string[];
  /** Stored nav_daily rows to compare with the recomputation, if any. */
  readonly stored?: readonly NavDay[];
  readonly seedMicro?: bigint;
  /** Sleeve trades, lock history and settings (ARN-101 sleeve checks); omitted = no sleeve. */
  readonly sleeve?: SleeveCheckOptions;
};

/** Run every invariant for every date. An empty result means all hold. */
export function checkCohortBooks(books: CohortBooks, options: CohortCheckOptions): Violation[] {
  const adjustments = books.adjustments ?? [];
  let saleCosts: ReadonlyMap<string, bigint> | undefined;
  const out: Violation[] = [];
  try {
    saleCosts = replayCostBasis(books.fills, adjustments, "9999-12-31").saleCostByFillId;
  } catch (error) {
    out.push({ code: "cost_unbuildable", message: (error as Error).message });
  }
  out.push(...checkTxns(books.rows, books.fills, { seedMicro: options.seedMicro, saleCosts }));
  if (options.sleeve !== undefined) out.push(...checkSleeveStatic(books.rows, options.sleeve));
  const storedByDate = new Map((options.stored ?? []).map((s) => [s.row.d, s]));
  const settledAt = books.rows.filter((r) => r.kind === "settle" && r.refType === "fill");
  for (const d of options.dates) {
    out.push(...checkFillsPosted(books.rows, books.fills, d));
    const balances = balancesFromRows(books.rows, d);
    const settled = new Set(settledAt.filter((r) => r.d <= d).map((r) => String(r.refId)));
    let forcedDraw = 0n;
    for (const f of books.fills) {
      const net = fillNetMicro(f);
      if (f.side === "sell" && net < 0n && settled.has(f.id)) forcedDraw -= net;
    }
    for (const r of books.rows) {
      if (
        r.kind === "sleeve_close" &&
        r.account === "cash_settled" &&
        r.d <= d &&
        r.deltaMicro < 0n
      ) {
        forcedDraw -= r.deltaMicro; // exit brokerage beyond a consumed margin (D-071 ruling)
      }
    }
    out.push(...checkBalances(balances, options.mode, d, forcedDraw));
    const pending = pendingSettlements(
      books.fills.filter((f) => f.d <= d),
      settled,
      options.calendar,
    );
    out.push(...checkPending(balances, pending, d));

    if (derivePositions(books.fills, adjustments, d).shorts.length > 0) {
      out.push({ code: "short_position", d, message: "a derived holding is negative" });
      continue;
    }
    if (saleCosts !== undefined) {
      let basis = 0n;
      for (const h of replayCostBasis(books.fills, adjustments, d).holdings.values()) {
        basis += h.costMicro;
      }
      if (basis !== balances.position_cost) {
        out.push({
          code: "position_cost_mismatch",
          d,
          message: "position_cost differs from the cost basis replayed from the fills",
        });
      }
    }
    let recomputed: NavDay;
    try {
      recomputed = buildNavDay(books, d);
    } catch (error) {
      out.push({ code: "nav_unbuildable", d, message: (error as Error).message });
      continue;
    }
    out.push(...checkNavDay(recomputed, balances));
    if (options.sleeve !== undefined) {
      out.push(...checkSleeveDay(options.sleeve, balances, recomputed));
    }
    const stored = storedByDate.get(d);
    if (options.stored !== undefined) {
      if (stored === undefined) {
        out.push({ code: "nav_missing", d, message: "no stored NAV row for this date" });
      } else {
        out.push(...checkNavDay(stored, balances), ...compareStoredNav(stored, recomputed));
      }
    }
  }
  return out;
}

// ---- 8: replay (ARN-102) ---------------------------------------------------------------------

/** Canonical text of ledger rows: ordered by txn then account, bigint as decimal text. */
export function serializeLedgerRows(rows: readonly LedgerRow[]): string {
  return rows
    .map((r) =>
      [r.d, r.txnId, r.account, r.deltaMicro, r.kind, r.refType ?? "", r.refId ?? ""].join("|"),
    )
    .sort()
    .join("\n");
}

/** Two runs are the same replay when ledger rows and NAV series serialise byte for byte. */
export function replayIdentical(
  a: { readonly rows: readonly LedgerRow[]; readonly days: readonly NavDay[] },
  b: { readonly rows: readonly LedgerRow[]; readonly days: readonly NavDay[] },
): boolean {
  return (
    serializeLedgerRows(a.rows) === serializeLedgerRows(b.rows) &&
    serializeNavDays(a.days) === serializeNavDays(b.days)
  );
}
