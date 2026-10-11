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
// Sleeve invariants (margin balance, loss cap, lock state) join in T8.
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
  | "stored_flag_not_ok";

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
    }
    // financing and sleeve_pnl: balanced is all there is to check until T8.
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

// ---- whole cohort ----------------------------------------------------------------------------

export type CohortCheckOptions = {
  readonly mode: SettlementMode;
  readonly calendar: readonly CalendarRow[];
  /** Dates to verify, oldest first. */
  readonly dates: readonly string[];
  /** Stored nav_daily rows to compare with the recomputation, if any. */
  readonly stored?: readonly NavDay[];
  readonly seedMicro?: bigint;
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
