// DB writers and loaders for cash_ledger, nav_daily and nav_daily_pos (M3 design 3, 4.6; migration
// 0007). Append-only: every insert is `ON CONFLICT DO NOTHING`, never a REPLACE form. Each call is
// ONE write transaction (a txn's postings, or a NAV day with its position rows, land together or
// not at all). A re-run is idempotent: when the stored rows already equal what would be written,
// nothing happens and `written` is false; when they differ the call raises `txn_conflict` /
// `nav_conflict` (a replay must reproduce the rows exactly, ARN-102) and writes nothing.
// Money goes in as bigint; reads accept bigint (intMode "bigint") or a safe-integer number.
import type { Client, Row } from "@libsql/client";
import { assertInt64 } from "@/lib/money/micro";
import { assertTxn, txnRows, type LedgerFill, type LedgerRow, type LedgerTxn } from "./ledger";
import { serializeNavDays, type NavDay, type NavDayRow, type NavPosRow } from "./nav";
import type { LedgerAccount, LedgerKind } from "./schema";

export type LedgerWriteErrorCode =
  "txn_conflict" | "nav_conflict" | "trigger_refused" | "constraint_refused";

export class LedgerWriteError extends Error {
  readonly code: LedgerWriteErrorCode;
  constructor(code: LedgerWriteErrorCode, message: string) {
    super(message);
    this.name = "LedgerWriteError";
    this.code = code;
  }
}

const TRIGGER_PREFIXES = ["append-only", "forever table"];

function refusal(error: unknown): LedgerWriteError | null {
  const message = String(error);
  if (TRIGGER_PREFIXES.some((p) => message.includes(p))) {
    return new LedgerWriteError("trigger_refused", message);
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
    return new LedgerWriteError("constraint_refused", message);
  }
  return null;
}

/** An INTEGER column value as bigint (intMode "bigint", or a safe-integer number). */
export function toBig(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError("expected an integer column value");
}

const text = (value: unknown): string => String(value);
const textOrNull = (value: unknown): string | null => (value === null ? null : String(value));

function rowKey(r: LedgerRow): string {
  return [r.d, r.account, r.deltaMicro, r.kind, r.refType ?? "", r.refId ?? ""].join("|");
}

// ---- cash_ledger -----------------------------------------------------------------------------

export type LedgerWriteResult = { readonly written: boolean };

/**
 * Write one balanced transaction (all postings, one transaction). The txn must be balanced
 * (assertTxn). If this cohort already holds rows for the same txn_id: identical rows are a no-op,
 * anything else raises `txn_conflict`.
 */
export async function writeLedgerTxn(
  db: Client,
  cohortId: string,
  txn: LedgerTxn,
): Promise<LedgerWriteResult> {
  assertTxn(txn);
  const wanted = txnRows(txn);
  const tx = await db.transaction("write");
  try {
    const existing = await tx.execute({
      sql: `SELECT d, account, delta_micro, kind, ref_type, ref_id FROM cash_ledger
            WHERE cohort_id = ? AND txn_id = ? ORDER BY account`,
      args: [cohortId, txn.txnId],
    });
    if (existing.rows.length > 0) {
      const have = existing.rows.map((r) => rowKey(ledgerRowFrom(r, txn.txnId))).sort();
      const want = wanted.map(rowKey).sort();
      if (have.length !== want.length || have.some((k, i) => k !== want[i])) {
        throw new LedgerWriteError("txn_conflict", `txn ${txn.txnId} already exists differently`);
      }
      await tx.rollback();
      return { written: false };
    }
    for (const r of wanted) {
      const inserted = await tx.execute({
        sql: `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind, ref_type, ref_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        args: [
          cohortId,
          r.d,
          r.txnId,
          r.account,
          assertInt64(r.deltaMicro),
          r.kind,
          r.refType,
          r.refId,
        ],
      });
      if (inserted.rowsAffected !== 1) {
        throw new LedgerWriteError("txn_conflict", `txn ${txn.txnId} collides on ${r.account}`);
      }
    }
    await tx.commit();
    return { written: true };
  } catch (error) {
    await tx.rollback();
    if (error instanceof LedgerWriteError) throw error;
    throw refusal(error) ?? error;
  } finally {
    tx.close();
  }
}

function ledgerRowFrom(r: Row, txnId: string): LedgerRow {
  return {
    txnId,
    d: text(r.d),
    account: text(r.account) as LedgerAccount,
    deltaMicro: toBig(r.delta_micro),
    kind: text(r.kind) as LedgerKind,
    refType: textOrNull(r.ref_type),
    refId: textOrNull(r.ref_id),
  };
}

/** All ledger rows of a cohort in insertion order (id), optionally up to a date. */
export async function loadLedgerRows(
  db: Client,
  cohortId: string,
  upToD?: string,
): Promise<LedgerRow[]> {
  const result = await db.execute({
    sql: `SELECT txn_id, d, account, delta_micro, kind, ref_type, ref_id FROM cash_ledger
          WHERE cohort_id = ? AND d <= ? ORDER BY id`,
    args: [cohortId, upToD ?? "9999-12-31"],
  });
  return result.rows.map((r) => ledgerRowFrom(r, text(r.txn_id)));
}

/** The cohort's fills, in the shape the ledger and positions need. */
export async function loadLedgerFills(db: Client, cohortId: string): Promise<LedgerFill[]> {
  const result = await db.execute({
    sql: `SELECT id, d, code, side, qty, value_micro, brokerage_micro FROM fill
          WHERE cohort_id = ? ORDER BY d, id`,
    args: [cohortId],
  });
  return result.rows.map((r) => ({
    id: text(r.id),
    d: text(r.d),
    code: text(r.code),
    side: text(r.side) === "buy" ? "buy" : "sell",
    qty: toBig(r.qty),
    valueMicro: toBig(r.value_micro),
    brokerageMicro: toBig(r.brokerage_micro),
  }));
}

// ---- nav_daily / nav_daily_pos ---------------------------------------------------------------

function navArgs(row: NavDayRow) {
  return [
    row.cohortId,
    row.d,
    assertInt64(row.cashSettledMicro),
    assertInt64(row.recvMicro),
    assertInt64(row.payMicro),
    assertInt64(row.positionsMicro),
    assertInt64(row.divRecvMicro),
    assertInt64(row.sleeveMarginMicro),
    assertInt64(row.sleeveUnrealMicro),
    assertInt64(row.finAccruedMicro),
    assertInt64(row.navMicro),
    assertInt64(row.liqNavMicro),
    row.openPositions,
    row.invariantsOk,
  ];
}

function navRowFrom(r: Row): NavDayRow {
  return {
    cohortId: text(r.cohort_id),
    d: text(r.d),
    cashSettledMicro: toBig(r.cash_settled_micro),
    recvMicro: toBig(r.recv_micro),
    payMicro: toBig(r.pay_micro),
    positionsMicro: toBig(r.positions_micro),
    divRecvMicro: toBig(r.div_recv_micro),
    sleeveMarginMicro: toBig(r.sleeve_margin_micro),
    sleeveUnrealMicro: toBig(r.sleeve_unreal_micro),
    finAccruedMicro: toBig(r.fin_accrued_micro),
    navMicro: toBig(r.nav_micro),
    liqNavMicro: toBig(r.liq_nav_micro),
    openPositions: toBig(r.open_positions),
    invariantsOk: toBig(r.invariants_ok) === 1n ? 1 : 0,
  };
}

function navPosFrom(r: Row): NavPosRow {
  return {
    cohortId: text(r.cohort_id),
    d: text(r.d),
    code: text(r.code),
    qty: toBig(r.qty),
    closeMicro: toBig(r.close_micro),
    valueMicro: toBig(r.value_micro),
    haircut: toBig(r.haircut) === 1n ? 1 : 0,
  };
}

const NAV_COLUMNS = `cohort_id, d, cash_settled_micro, recv_micro, pay_micro, positions_micro,
  div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro, fin_accrued_micro, nav_micro,
  liq_nav_micro, open_positions, invariants_ok`;

/**
 * Write one NAV day: the nav_daily row and its nav_daily_pos rows in one transaction. A stored
 * day that equals this one is a no-op; a different one raises `nav_conflict`.
 */
export async function writeNavDay(db: Client, day: NavDay): Promise<LedgerWriteResult> {
  const tx = await db.transaction("write");
  try {
    const { cohortId, d } = day.row;
    const stored = await readNavDay(tx, cohortId, d);
    if (stored !== null) {
      if (sameDay(stored, day)) {
        await tx.rollback();
        return { written: false };
      }
      throw new LedgerWriteError(
        "nav_conflict",
        `NAV for ${cohortId} ${d} already exists differently`,
      );
    }
    await tx.execute({
      sql: `INSERT INTO nav_daily (${NAV_COLUMNS})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      args: navArgs(day.row),
    });
    for (const p of day.positions) {
      await tx.execute({
        sql: `INSERT INTO nav_daily_pos (cohort_id, d, code, qty, close_micro, value_micro, haircut)
              VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        args: [
          p.cohortId,
          p.d,
          p.code,
          p.qty,
          assertInt64(p.closeMicro),
          assertInt64(p.valueMicro),
          p.haircut,
        ],
      });
    }
    await tx.commit();
    return { written: true };
  } catch (error) {
    await tx.rollback();
    if (error instanceof LedgerWriteError) throw error;
    throw refusal(error) ?? error;
  } finally {
    tx.close();
  }
}

type Reader = Pick<Client, "execute">;

async function readNavDay(db: Reader, cohortId: string, d: string): Promise<NavDay | null> {
  const row = await db.execute({
    sql: `SELECT ${NAV_COLUMNS} FROM nav_daily WHERE cohort_id = ? AND d = ?`,
    args: [cohortId, d],
  });
  if (row.rows.length === 0) return null;
  const pos = await db.execute({
    sql: `SELECT cohort_id, d, code, qty, close_micro, value_micro, haircut FROM nav_daily_pos
          WHERE cohort_id = ? AND d = ? ORDER BY code`,
    args: [cohortId, d],
  });
  return { row: navRowFrom(row.rows[0]), positions: pos.rows.map(navPosFrom) };
}

function sameDay(a: NavDay, b: NavDay): boolean {
  return serializeNavDays([a]) === serializeNavDays([b]);
}

/** Stored NAV days of a cohort, oldest first, with their position rows (codes ascending). */
export async function loadNavDays(db: Client, cohortId: string): Promise<NavDay[]> {
  const nav = await db.execute({
    sql: `SELECT ${NAV_COLUMNS} FROM nav_daily WHERE cohort_id = ? ORDER BY d`,
    args: [cohortId],
  });
  const pos = await db.execute({
    sql: `SELECT cohort_id, d, code, qty, close_micro, value_micro, haircut FROM nav_daily_pos
          WHERE cohort_id = ? ORDER BY d, code`,
    args: [cohortId],
  });
  const byDate = new Map<string, NavPosRow[]>();
  for (const p of pos.rows.map(navPosFrom)) byDate.set(p.d, [...(byDate.get(p.d) ?? []), p]);
  return nav.rows.map(navRowFrom).map((row) => ({ row, positions: byDate.get(row.d) ?? [] }));
}
