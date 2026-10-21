// Thin writer for one fill (M3 design 3, 4.6; migration 0007 triggers). In ONE write transaction:
//   1. insert the `fill` row (the trigger needs a matching PENDING order),
//   2. move the order pending -> filled (the trigger needs the fill row to exist),
//   3. optionally open the trade (entry, with the initial stop) or close it (exit).
// Any failure rolls the whole thing back, so there is never a fill without its order move, nor an
// order marked filled without a fill. Money goes in as bigint (libsql accepts bigint arguments);
// quantities are bigint too, so no number conversion touches a money path.
import type { Client, InStatement } from "@libsql/client";
import { assertInt64 } from "@/lib/money/micro";
import type { ExitType } from "./schema";
import type { SimulatedFill } from "./fills";

export type FillWriteErrorCode =
  | "order_not_found"
  | "order_not_pending"
  | "trigger_refused"
  | "constraint_refused"
  | "trade_not_found";

/** Typed failure; the transaction has been rolled back when this is thrown. */
export class FillWriteError extends Error {
  readonly code: FillWriteErrorCode;
  constructor(code: FillWriteErrorCode, message: string) {
    super(message);
    this.name = "FillWriteError";
    this.code = code;
  }
}

export type TradeWrite =
  | { readonly kind: "open"; readonly tradeId: string; readonly stopMicro: bigint }
  | { readonly kind: "close"; readonly tradeId: string; readonly exitType: ExitType };

export type FillWriteInput = {
  readonly fillId: string;
  readonly orderId: string;
  readonly cohortId: string;
  /** Sydney trading date of the fill (YYYY-MM-DD); also becomes the order's `fill_d`. */
  readonly d: string;
  readonly code: string;
  readonly fill: SimulatedFill;
  readonly trade?: TradeWrite;
};

export type FillWriteResult = { readonly written: boolean };

const TRIGGER_PREFIXES = ["fill:", "order:", "trade:", "forever table", "append-only"];

function refusal(error: unknown): FillWriteError | null {
  const message = error instanceof Error ? error.message : "";
  if (TRIGGER_PREFIXES.some((p) => message.includes(p))) {
    return new FillWriteError("trigger_refused", message);
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
    return new FillWriteError("constraint_refused", message);
  }
  return null;
}

/** The INSERT for one fill row (shared with sleeveWriter, which writes the sleeve's fills). */
export function fillStatement(input: FillWriteInput): InStatement {
  const f = input.fill;
  return {
    sql: `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro,
            slip_micro, fill_price_micro, value_micro, brokerage_micro, cost_profile,
            bar_o_micro, bar_h_micro, bar_l_micro, bar_c_micro)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.fillId,
      input.orderId,
      input.cohortId,
      input.d,
      input.code,
      f.side,
      f.qty,
      f.rule,
      assertInt64(f.refPriceMicro),
      assertInt64(f.slipMicro),
      assertInt64(f.fillPriceMicro),
      assertInt64(f.valueMicro),
      assertInt64(f.brokerageMicro),
      f.costProfile,
      assertInt64(f.bar.openMicro),
      assertInt64(f.bar.highMicro),
      assertInt64(f.bar.lowMicro),
      assertInt64(f.bar.closeMicro),
    ],
  };
}

/**
 * Write one fill and move its order to `filled`, atomically. Idempotent for a replay: if the same
 * fill id is already stored for this order (order already `filled`), nothing is written and
 * `written` is false. A different state raises a typed `FillWriteError`.
 */
export async function writeFill(db: Client, input: FillWriteInput): Promise<FillWriteResult> {
  const tx = await db.transaction("write");
  try {
    const order = await tx.execute({
      sql: "SELECT status FROM arena_order WHERE id = ? AND cohort_id = ?",
      args: [input.orderId, input.cohortId],
    });
    if (order.rows.length === 0) {
      throw new FillWriteError("order_not_found", `order ${input.orderId} not found`);
    }
    const status = String(order.rows[0].status);
    if (status === "filled") {
      const same = await tx.execute({
        sql: "SELECT 1 FROM fill WHERE id = ? AND order_id = ?",
        args: [input.fillId, input.orderId],
      });
      if (same.rows.length > 0) {
        await tx.rollback();
        return { written: false };
      }
    }
    if (status !== "pending") {
      throw new FillWriteError("order_not_pending", `order ${input.orderId} is ${status}`);
    }
    await tx.execute(fillStatement(input));
    await tx.execute({
      sql: "UPDATE arena_order SET status = 'filled', fill_d = ? WHERE id = ?",
      args: [input.d, input.orderId],
    });
    const trade = input.trade;
    if (trade?.kind === "open") {
      await tx.execute({
        sql: `INSERT INTO trade (id, cohort_id, code, entry_fill_id, stop_micro)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          trade.tradeId,
          input.cohortId,
          input.code,
          input.fillId,
          assertInt64(trade.stopMicro),
        ],
      });
    } else if (trade?.kind === "close") {
      const closed = await tx.execute({
        sql: `UPDATE trade SET exit_fill_id = ?, exit_type = ?
              WHERE id = ? AND cohort_id = ? AND exit_type IS NULL`,
        args: [input.fillId, trade.exitType, trade.tradeId, input.cohortId],
      });
      if (closed.rowsAffected === 0) {
        throw new FillWriteError("trade_not_found", `no open trade ${trade.tradeId}`);
      }
    }
    await tx.commit();
    return { written: true };
  } catch (error) {
    await tx.rollback();
    if (error instanceof FillWriteError) throw error;
    throw refusal(error) ?? error;
  } finally {
    tx.close();
  }
}
