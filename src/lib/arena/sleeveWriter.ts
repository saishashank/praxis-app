// DB side of the sleeve engine (M3 design 3, 4.2 steps 3/5/6, 4.6; migration 0007; sleeve.ts holds
// the arithmetic). Every call is ONE write transaction: a trade open (order + fill + sleeve_trade +
// margin posting), a financing catch-up, a close (fill + close update + ledger + lock row) or an
// unlock row land together or not at all. Append-only and replay-safe: running a step twice writes
// nothing the second time (`written: false`); when the stored rows differ from what the inputs
// would write the call raises `sleeve_conflict` / `state_conflict` / `txn_conflict` and writes
// nothing (ARN-102). Money goes in as bigint; reads accept bigint (intMode "bigint") or safe numbers.
import type { Client, Row, Transaction } from "@libsql/client";
import { assertInt64, type Micro } from "@/lib/money/micro";
import type { CalendarRow } from "@/lib/data/calendar";
import { feeFor } from "./costs";
import { fillStatement } from "./fillWriter";
import type { QtyAdjustment } from "./ledger";
import { LedgerWriteError, loadLedgerRows, toBig, writeLedgerTxnIn } from "./ledgerWriter";
import {
  closeSleeve,
  closedTrade,
  evaluateUnlock,
  financingAccruedAt,
  lockAfterClose,
  lockStatus,
  netPlMicro,
  priceFactorSince,
  realisedUnleveredNetSince,
  sessionsSinceLock,
  shadowNetSince,
  sleeveCloseTxn,
  sleeveFinancingTxn,
  sleeveOpenTxn,
  type SleeveCloseResult,
  type SleeveConfig,
  type SleeveEntryQuote,
  type SleeveExitQuote,
  type SleeveStateEntry,
  type SleeveTrade,
} from "./sleeve";
import type { RecoveryMode, SleeveClosedBy, SleeveLockState } from "./schema";

export type SleeveWriteErrorCode =
  | "sleeve_conflict"
  | "sleeve_locked"
  | "sleeve_not_locked"
  | "sleeve_already_open"
  | "sleeve_not_found"
  | "financing_mismatch"
  | "ledger_mismatch"
  | "state_conflict"
  | "trigger_refused"
  | "constraint_refused";

export class SleeveWriteError extends Error {
  readonly code: SleeveWriteErrorCode;
  constructor(code: SleeveWriteErrorCode, message: string) {
    super(message);
    this.name = "SleeveWriteError";
    this.code = code;
  }
}

const TRIGGER_PREFIXES = ["sleeve_trade:", "fill:", "order:", "forever table", "append-only"];

function refusal(error: unknown): SleeveWriteError | null {
  const message = error instanceof Error ? error.message : String(error);
  if (TRIGGER_PREFIXES.some((p) => message.includes(p))) {
    return new SleeveWriteError("trigger_refused", message);
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
    return new SleeveWriteError("constraint_refused", message);
  }
  return null;
}

const text = (value: unknown): string => String(value);
const textOrNull = (value: unknown): string | null => (value === null ? null : String(value));

/** Run `body` in one write transaction; typed errors pass through, others are mapped. */
async function inTransaction<T>(db: Client, body: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await db.transaction("write");
  try {
    const result = await body(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    if (error instanceof SleeveWriteError || error instanceof LedgerWriteError) throw error;
    throw refusal(error) ?? error;
  } finally {
    tx.close();
  }
}

// ---- reading ---------------------------------------------------------------------------------------

const TRADE_COLUMNS = `id, cohort_id, code, margin_micro, leverage, notional_micro, entry_fill_id,
  exit_fill_id, price_pl_micro, financing_micro, closed_by, shadow, open_d, entry_price_micro,
  close_d, exit_price_micro, costs_micro`;

function tradeFrom(r: Row): SleeveTrade {
  const closedBy = textOrNull(r.closed_by);
  return {
    id: text(r.id),
    cohortId: text(r.cohort_id),
    code: text(r.code),
    shadow: toBig(r.shadow) === 1n,
    marginMicro: toBig(r.margin_micro),
    leverage: toBig(r.leverage),
    notionalMicro: toBig(r.notional_micro),
    openD: text(r.open_d),
    entryPriceMicro: toBig(r.entry_price_micro),
    entryFillId: textOrNull(r.entry_fill_id),
    closed:
      closedBy === null
        ? null
        : {
            closeD: text(r.close_d),
            exitPriceMicro: toBig(r.exit_price_micro),
            closedBy: closedBy as SleeveClosedBy,
            exitFillId: textOrNull(r.exit_fill_id),
            pricePlMicro: toBig(r.price_pl_micro),
            financingMicro: toBig(r.financing_micro),
            costsMicro: toBig(r.costs_micro),
          },
  };
}

type Reader = Pick<Client, "execute">;

async function readTrade(db: Reader, id: string): Promise<SleeveTrade | null> {
  const rs = await db.execute({
    sql: `SELECT ${TRADE_COLUMNS} FROM sleeve_trade WHERE id = ?`,
    args: [id],
  });
  return rs.rows.length === 0 ? null : tradeFrom(rs.rows[0]);
}

/** All sleeve trades of a cohort (real and shadow), oldest first. */
export async function loadSleeveTrades(db: Reader, cohortId: string): Promise<SleeveTrade[]> {
  const rs = await db.execute({
    sql: `SELECT ${TRADE_COLUMNS} FROM sleeve_trade WHERE cohort_id = ? ORDER BY open_d, id`,
    args: [cohortId],
  });
  return rs.rows.map(tradeFrom);
}

/**
 * Entry brokerage of a trade: the entry fill's brokerage for a real trade; recomputed from the
 * profile for a shadow trade (it has no fill; the fee depends on the notional only).
 */
export async function loadEntryBrokerage(
  db: Reader,
  trade: SleeveTrade,
  cfg: SleeveConfig,
): Promise<Micro> {
  if (trade.shadow || trade.entryFillId === null) {
    return feeFor(cfg.profile, trade.notionalMicro, "buy", cfg.feeContext);
  }
  const rs = await db.execute({
    sql: "SELECT brokerage_micro FROM fill WHERE id = ?",
    args: [trade.entryFillId],
  });
  if (rs.rows.length === 0) throw new SleeveWriteError("sleeve_not_found", "entry fill missing");
  return toBig(rs.rows[0].brokerage_micro);
}

function stateFrom(r: Row): SleeveStateEntry {
  return {
    seq: Number(toBig(r.seq)), // money-float-ok: a small sequence number, not money
    state: text(r.state) as SleeveLockState,
    d: text(r.d),
    lossToRecoverMicro: toBig(r.loss_to_recover_micro),
    mode: text(r.mode) as RecoveryMode,
  };
}

export async function loadSleeveStates(db: Reader, cohortId: string): Promise<SleeveStateEntry[]> {
  const rs = await db.execute({
    sql: `SELECT cohort_id, seq, state, d, loss_to_recover_micro, mode FROM sleeve_state
          WHERE cohort_id = ? ORDER BY seq`,
    args: [cohortId],
  });
  return rs.rows.map(stateFrom);
}

// ---- sleeve_state and cohort_event --------------------------------------------------------------------

function sameState(a: SleeveStateEntry, b: SleeveStateEntry): boolean {
  return (
    a.state === b.state &&
    a.d === b.d &&
    a.lossToRecoverMicro === b.lossToRecoverMicro &&
    a.mode === b.mode
  );
}

/** Append one lock/unlock row (idempotent by seq; a different stored row raises). */
async function appendStateIn(
  tx: Transaction,
  cohortId: string,
  entry: SleeveStateEntry,
  detail: Record<string, string>,
): Promise<boolean> {
  const states = await loadSleeveStates(tx, cohortId);
  const stored = states.find((s) => s.seq === entry.seq);
  if (stored !== undefined) {
    if (sameState(stored, entry)) return false;
    throw new SleeveWriteError("state_conflict", `sleeve_state ${cohortId}#${entry.seq} differs`);
  }
  if (entry.seq !== states.length + 1) {
    throw new SleeveWriteError("state_conflict", `sleeve_state seq ${entry.seq} is not next`);
  }
  await tx.execute({
    sql: `INSERT INTO sleeve_state (cohort_id, seq, state, d, loss_to_recover_micro, mode)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      cohortId,
      entry.seq,
      entry.state,
      entry.d,
      assertInt64(entry.lossToRecoverMicro),
      entry.mode,
    ],
  });
  const next = await tx.execute({
    sql: "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM cohort_event WHERE cohort_id = ?",
    args: [cohortId],
  });
  const kind = entry.state === "locked" ? "lock" : "unlock";
  const json = JSON.stringify({
    mode: entry.mode,
    loss_to_recover_micro: entry.lossToRecoverMicro.toString(),
    ...detail,
  });
  await tx.execute({
    sql: "INSERT INTO cohort_event (cohort_id, seq, kind, d, detail_json) VALUES (?, ?, ?, ?, ?)",
    args: [cohortId, toBig(next.rows[0].n), kind, entry.d, json],
  });
  return true;
}

// ---- open ---------------------------------------------------------------------------------------------

export type OpenSleeveInput = {
  readonly cohortId: string;
  /** From `openTrade`: open, with `entryFillId` set for a real trade. */
  readonly trade: SleeveTrade;
  /** From `quoteSleeveEntry`; the fill row and the entry brokerage come from it. */
  readonly quote: SleeveEntryQuote;
  /** Real trades: ids of the sleeve_open order and its fill; session the order was decided. */
  readonly orderId?: string;
  readonly fillId?: string;
  readonly decidedD?: string;
};

export type SleeveWriteResult = { readonly written: boolean };

function sameOpen(a: SleeveTrade, b: SleeveTrade): boolean {
  return (
    a.cohortId === b.cohortId &&
    a.code === b.code &&
    a.shadow === b.shadow &&
    a.marginMicro === b.marginMicro &&
    a.leverage === b.leverage &&
    a.notionalMicro === b.notionalMicro &&
    a.openD === b.openD &&
    a.entryPriceMicro === b.entryPriceMicro &&
    a.entryFillId === b.entryFillId
  );
}

/**
 * Open a sleeve trade (ARN-040/041). Real: sleeve_open order, its fill, the sleeve_trade row and
 * the margin posting (cash -> sleeve_margin, entry brokerage as a cost) in one transaction;
 * refused while another real trade is open or the sleeve is locked. Shadow (ARN-048): only the
 * sleeve_trade row, allowed only while locked, no fills and no ledger rows.
 */
export async function writeSleeveOpen(
  db: Client,
  input: OpenSleeveInput,
): Promise<SleeveWriteResult> {
  const t = input.trade;
  if (t.closed !== null) throw new RangeError("an opening trade cannot be closed");
  if (t.cohortId !== input.cohortId) throw new RangeError("trade belongs to another cohort");
  if (!t.shadow && (t.entryFillId === null || input.orderId === undefined)) {
    throw new RangeError("a real sleeve trade needs an entry fill id and an order id");
  }
  return inTransaction(db, async (tx) => {
    const stored = await readTrade(tx, t.id);
    if (stored !== null) {
      if (sameOpen(stored, t)) return { written: false };
      throw new SleeveWriteError(
        "sleeve_conflict",
        `sleeve trade ${t.id} already exists differently`,
      );
    }
    const states = await loadSleeveStates(tx, input.cohortId);
    const locked = lockStatus(states).locked;
    if (t.shadow && !locked) {
      throw new SleeveWriteError(
        "sleeve_not_locked",
        "a shadow sleeve trade is logged only while locked",
      );
    }
    if (!t.shadow && locked) {
      throw new SleeveWriteError(
        "sleeve_locked",
        "the sleeve is locked; open a shadow trade instead",
      );
    }
    const open = await tx.execute({
      sql: `SELECT id FROM sleeve_trade WHERE cohort_id = ? AND shadow = ? AND closed_by IS NULL`,
      args: [input.cohortId, t.shadow ? 1 : 0],
    });
    if (open.rows.length > 0) {
      throw new SleeveWriteError(
        "sleeve_already_open",
        `sleeve trade ${text(open.rows[0].id)} is still open (one at a time, ARN-040)`,
      );
    }
    if (!t.shadow) {
      const orderId = input.orderId as string;
      const fillId = t.entryFillId as string;
      await tx.execute({
        sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty)
              VALUES (?, ?, ?, ?, 'buy', 'sleeve_open', ?)`,
        args: [orderId, input.cohortId, input.decidedD ?? t.openD, t.code, input.quote.fill.qty],
      });
      await tx.execute(
        fillStatement({
          fillId,
          orderId,
          cohortId: input.cohortId,
          d: t.openD,
          code: t.code,
          fill: input.quote.fill,
        }),
      );
      await tx.execute({
        sql: "UPDATE arena_order SET status = 'filled', fill_d = ? WHERE id = ?",
        args: [t.openD, orderId],
      });
    }
    await tx.execute({
      sql: `INSERT INTO sleeve_trade (id, cohort_id, code, margin_micro, leverage, notional_micro,
              entry_fill_id, shadow, open_d, entry_price_micro)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        t.id,
        t.cohortId,
        t.code,
        assertInt64(t.marginMicro),
        t.leverage,
        assertInt64(t.notionalMicro),
        t.entryFillId,
        t.shadow ? 1 : 0,
        t.openD,
        assertInt64(t.entryPriceMicro),
      ],
    });
    if (!t.shadow) {
      await writeLedgerTxnIn(tx, input.cohortId, sleeveOpenTxn(t, input.quote.entryBrokerageMicro));
    }
    return { written: true };
  });
}

// ---- financing ---------------------------------------------------------------------------------------

/** One trade's posted financing rows (date, positive amount), oldest first. */
async function financingRows(
  db: Reader,
  cohortId: string,
  tradeId: string,
): Promise<{ d: string; amount: Micro }[]> {
  const rs = await db.execute({
    sql: `SELECT d, delta_micro FROM cash_ledger
          WHERE cohort_id = ? AND kind = 'financing' AND account = 'fin_accrued'
            AND ref_type = 'sleeve_trade' AND ref_id = ? ORDER BY d, id`,
    args: [cohortId, tradeId],
  });
  return rs.rows.map((r) => ({ d: text(r.d), amount: -toBig(r.delta_micro) }));
}

/**
 * Bring a trade's posted financing up to the cumulative figure at the end of `d` (R5). If a row for
 * `d` already exists the call is a replay: the row must equal the cumulative figure less the rows
 * before `d` (else `financing_mismatch`) and nothing is written. Rows dated after `d` forbid a new
 * row for `d` (a day cannot be posted out of order).
 */
async function financingCatchUpIn(
  tx: Transaction,
  trade: SleeveTrade,
  d: string,
  cfg: SleeveConfig,
): Promise<{ written: boolean; accruedMicro: Micro }> {
  const target = financingAccruedAt(trade, d, cfg);
  const rows = await financingRows(tx, trade.cohortId, trade.id);
  const sum = (list: { amount: Micro }[]) => list.reduce((t, r) => t + r.amount, 0n);
  const before = sum(rows.filter((r) => r.d < d));
  const today = rows.filter((r) => r.d === d);
  const increment = target - before;
  if (today.length > 0) {
    if (sum(today) !== increment) {
      throw new SleeveWriteError(
        "financing_mismatch",
        `financing posted for ${d} is ${sum(today).toString()}, the cumulative formula says ${increment.toString()}`,
      );
    }
    return { written: false, accruedMicro: target };
  }
  if (rows.some((r) => r.d > d)) {
    throw new SleeveWriteError("financing_mismatch", `financing is already posted beyond ${d}`);
  }
  if (increment < 0n) {
    throw new SleeveWriteError(
      "financing_mismatch",
      `posted financing ${before.toString()} exceeds the cumulative ${target.toString()}`,
    );
  }
  if (increment === 0n) return { written: false, accruedMicro: target };
  const result = await writeLedgerTxnIn(
    tx,
    trade.cohortId,
    sleeveFinancingTxn(trade, d, increment),
  );
  return { written: result.written, accruedMicro: target };
}

/**
 * Close-the-books step 3 for one open real trade: post the financing accrued up to the end of `d`
 * (cumulative formula, so the daily rows sum to the one-shot figure, R5). Idempotent: a second run
 * finds nothing to add; a stored day whose amount differs raises `financing_mismatch`. A closed
 * trade can still be replayed for days up to its close date.
 */
export async function writeSleeveFinancing(
  db: Client,
  input: {
    readonly cohortId: string;
    readonly tradeId: string;
    readonly d: string;
    readonly cfg: SleeveConfig;
  },
): Promise<SleeveWriteResult & { readonly accruedMicro: Micro }> {
  return inTransaction(db, async (tx) => {
    const trade = await readTrade(tx, input.tradeId);
    if (trade === null || trade.cohortId !== input.cohortId) {
      throw new SleeveWriteError("sleeve_not_found", `no sleeve trade ${input.tradeId}`);
    }
    if (trade.shadow) throw new RangeError("a shadow sleeve trade accrues nothing");
    if (trade.closed !== null && input.d > trade.closed.closeD) {
      throw new SleeveWriteError("sleeve_conflict", `sleeve trade ${trade.id} closed earlier`);
    }
    return financingCatchUpIn(tx, trade, input.d, input.cfg);
  });
}

// ---- close ---------------------------------------------------------------------------------------------

export type CloseSleeveInput = {
  readonly cohortId: string;
  readonly tradeId: string;
  readonly cfg: SleeveConfig;
  readonly closeD: string;
  /** From `quoteSleeveExit` (or `earlierSleeveExit`): fill rules, price and brokerage on notional. */
  readonly exit: SleeveExitQuote;
  /** Real trades: ids of the sleeve_close order and its fill; session it was decided. */
  readonly orderId?: string;
  readonly fillId?: string;
  readonly decidedD?: string;
  /** Quantity re-bases (for the split-neutral factor, ARN-043 s11). */
  readonly adjustments?: readonly QtyAdjustment[];
};

export type CloseSleeveResult = {
  readonly written: boolean;
  readonly result: SleeveCloseResult;
  /** The lock row this close created (a real trade with a net loss), else null. */
  readonly lock: SleeveStateEntry | null;
};

function sameClosed(a: SleeveTrade, b: SleeveTrade): boolean {
  const x = a.closed;
  const y = b.closed;
  if (x === null || y === null) return x === y;
  return (
    x.closeD === y.closeD &&
    x.exitPriceMicro === y.exitPriceMicro &&
    x.closedBy === y.closedBy &&
    x.exitFillId === y.exitFillId &&
    x.pricePlMicro === y.pricePlMicro &&
    x.financingMicro === y.financingMicro &&
    x.costsMicro === y.costsMicro
  );
}

async function balanceOf(tx: Reader, cohortId: string, account: string): Promise<Micro> {
  const rs = await tx.execute({
    sql: "SELECT COALESCE(SUM(delta_micro), 0) AS s FROM cash_ledger WHERE cohort_id = ? AND account = ?",
    args: [cohortId, account],
  });
  return toBig(rs.rows[0].s);
}

/**
 * Close a sleeve trade (ARN-043/044/045/046): financing catch-up to `closeD`, the sleeve_close
 * order and fill, the one-way sleeve_trade close, the ledger close posting (margin released,
 * financing paid, capped P/L to equity, cash back less exit brokerage) and, for a real trade with a
 * negative net result, the lock row with loss_to_recover - all in one transaction. A shadow trade
 * closes with the same arithmetic and nothing else.
 */
export async function writeSleeveClose(
  db: Client,
  input: CloseSleeveInput,
): Promise<CloseSleeveResult> {
  return inTransaction(db, async (tx) => {
    const trade = await readTrade(tx, input.tradeId);
    if (trade === null || trade.cohortId !== input.cohortId) {
      throw new SleeveWriteError("sleeve_not_found", `no sleeve trade ${input.tradeId}`);
    }
    if (!trade.shadow && (input.orderId === undefined || input.fillId === undefined)) {
      throw new RangeError("a real sleeve close needs an order id and a fill id");
    }
    const open: SleeveTrade = { ...trade, closed: null };
    const entryFee = await loadEntryBrokerage(tx, open, input.cfg);
    const fill = input.exit.fill;
    const result = closeSleeve({
      trade: open,
      entryBrokerageMicro: entryFee,
      closeD: input.closeD,
      exitPriceMicro: fill.fillPriceMicro,
      exitBrokerageMicro: fill.brokerageMicro,
      closedBy: input.exit.closedBy,
      exitFillId: trade.shadow ? null : (input.fillId as string),
      financingMicro: financingAccruedAt(open, input.closeD, input.cfg),
      factor: priceFactorSince(trade.code, trade.openD, input.closeD, input.adjustments ?? []),
    });
    const wanted = closedTrade(open, result);
    if (trade.closed !== null) {
      if (sameClosed(trade, wanted)) return { written: false, result, lock: null };
      throw new SleeveWriteError("sleeve_conflict", `sleeve trade ${trade.id} closed differently`);
    }
    if (!trade.shadow) {
      await financingCatchUpIn(tx, open, input.closeD, input.cfg);
      const margin = await balanceOf(tx, input.cohortId, "sleeve_margin");
      const accrued = -(await balanceOf(tx, input.cohortId, "fin_accrued"));
      if (margin !== trade.marginMicro || accrued !== result.closed.financingMicro) {
        throw new SleeveWriteError(
          "ledger_mismatch",
          `sleeve ledger balances (margin ${margin.toString()}, financing ${accrued.toString()}) differ from the trade`,
        );
      }
      const orderId = input.orderId as string;
      await tx.execute({
        sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty)
              VALUES (?, ?, ?, ?, 'sell', 'sleeve_close', ?)`,
        args: [orderId, input.cohortId, input.decidedD ?? input.closeD, trade.code, fill.qty],
      });
      await tx.execute(
        fillStatement({
          fillId: input.fillId as string,
          orderId,
          cohortId: input.cohortId,
          d: input.closeD,
          code: trade.code,
          fill,
        }),
      );
      await tx.execute({
        sql: "UPDATE arena_order SET status = 'filled', fill_d = ? WHERE id = ?",
        args: [input.closeD, orderId],
      });
    }
    const c = result.closed;
    const updated = await tx.execute({
      sql: `UPDATE sleeve_trade SET closed_by = ?, price_pl_micro = ?, financing_micro = ?,
              exit_fill_id = ?, close_d = ?, exit_price_micro = ?, costs_micro = ?
            WHERE id = ? AND closed_by IS NULL`,
      args: [
        c.closedBy,
        assertInt64(c.pricePlMicro),
        assertInt64(c.financingMicro),
        c.exitFillId,
        c.closeD,
        assertInt64(c.exitPriceMicro),
        assertInt64(c.costsMicro),
        trade.id,
      ],
    });
    if (updated.rowsAffected !== 1) {
      throw new SleeveWriteError("sleeve_conflict", `sleeve trade ${trade.id} was not open`);
    }
    let lock: SleeveStateEntry | null = null;
    if (!trade.shadow) {
      await writeLedgerTxnIn(tx, input.cohortId, sleeveCloseTxn(open, result));
      lock = lockAfterClose(await loadSleeveStates(tx, input.cohortId), wanted, input.cfg);
      if (lock !== null) {
        await appendStateIn(tx, input.cohortId, lock, {
          trade_id: trade.id,
          net_pl_micro: netPlMicro(c).toString(),
        });
      }
    }
    return { written: true, result, lock };
  });
}

// ---- unlock --------------------------------------------------------------------------------------------

export type UnlockCheckInput = {
  readonly cohortId: string;
  /** The close being judged and its NAV (ARN-051). */
  readonly d: string;
  readonly navMicro: Micro;
  readonly calendar: readonly CalendarRow[];
  readonly cfg: SleeveConfig;
};

/** NAV at the close before the locking trade opened (REC-1); the cohort seed when there is none. */
async function referenceNav(db: Reader, cohortId: string, openD: string): Promise<Micro> {
  const nav = await db.execute({
    sql: `SELECT nav_micro FROM nav_daily WHERE cohort_id = ? AND d < ? ORDER BY d DESC LIMIT 1`,
    args: [cohortId, openD],
  });
  if (nav.rows.length > 0) return toBig(nav.rows[0].nav_micro);
  const seed = await db.execute({
    sql: "SELECT seed_micro FROM cohort WHERE id = ?",
    args: [cohortId],
  });
  if (seed.rows.length === 0)
    throw new SleeveWriteError("sleeve_not_found", `no cohort ${cohortId}`);
  return toBig(seed.rows[0].seed_micro);
}

/**
 * Close-the-books step 6 for the sleeve: when the lock's recovery mode (ARN-047) is satisfied at
 * this close, append the unlock row and a cohort_event. Idempotent for a replay of the same close.
 */
export async function runSleeveUnlockCheck(
  db: Client,
  input: UnlockCheckInput,
): Promise<{ readonly unlocked: SleeveStateEntry | null }> {
  const states = await loadSleeveStates(db, input.cohortId);
  const status = lockStatus(states);
  if (!status.locked || status.lockD === null) {
    // A replay of the unlock day: the unlock row is already stored and equals what would be written.
    return { unlocked: null };
  }
  const trades = await loadSleeveTrades(db, input.cohortId);
  const locking = trades
    .filter((t) => !t.shadow && t.closed !== null && t.closed.closeD === status.lockD)
    .sort((a, b) => (a.openD < b.openD ? 1 : -1))[0];
  const ctx = {
    d: input.d,
    navMicro: input.navMicro,
    refNavMicro:
      status.mode === "REC-1" && locking !== undefined
        ? await referenceNav(db, input.cohortId, locking.openD)
        : undefined,
    realisedUnleveredNetMicro:
      status.mode === "REC-2"
        ? realisedUnleveredNetSince(
            await loadLedgerRows(db, input.cohortId, input.d),
            status.lockD,
            input.d,
          )
        : undefined,
    shadowNetMicro:
      status.mode === "REC-3" ? shadowNetSince(trades, status.lockD, input.d) : undefined,
    sessionsSinceLock:
      status.mode === "REC-4"
        ? sessionsSinceLock(status.lockD, input.d, input.calendar)
        : undefined,
  };
  const entry = evaluateUnlock(states, ctx, input.cfg);
  if (entry === null) return { unlocked: null };
  await inTransaction(db, async (tx) => {
    await appendStateIn(tx, input.cohortId, entry, { mode_check: status.mode ?? "" });
  });
  return { unlocked: entry };
}
