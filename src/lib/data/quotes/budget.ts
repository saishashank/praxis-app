// M17 WP1: request budget accounting (D-400). The daily budget is shared by the poll and the scan.
import type { Exec } from "../../cortex/store/common";
import type { QuoteBudget } from "./types";

/** Politeness budget for the unofficial host, shared by both streams. */
export const QUOTE_REQUESTS_PER_DAY = 2000; // threshold-ok: politeness budget for the unofficial host, D-400
export const QUOTE_NARROW_AT = 0.8; // threshold-ok: narrowing threshold, D-400
export const QUOTE_STOP_AT = 0.95; // threshold-ok: stop threshold, D-400

export type BudgetBand = "ok" | "narrow" | "stop";

/** Requests a run may still make: the lower of the run cap and what is left of the day. */
export function requestsAllowed(b: QuoteBudget): number {
  const left = Math.max(0, b.dayMax - b.usedToday);
  return Math.max(0, Math.min(b.perRunMax, left));
}

/** Band of the daily budget: narrow at 80 %, stop at 95 %. */
export function budgetBand(b: Pick<QuoteBudget, "dayMax" | "usedToday">): BudgetBand {
  if (b.dayMax <= 0) return "stop";
  const used = b.usedToday / b.dayMax;
  if (used >= QUOTE_STOP_AT) return "stop";
  if (used >= QUOTE_NARROW_AT) return "narrow";
  return "ok";
}

/** Slot suffix of the row that reconciles a claim to the requests actually made (D-697). */
export const DONE_SUFFIX = "+done";

/**
 * Requests charged to the session (read only; the table is WP2's). A claim reserves a count before
 * any request (D-442); the table is append-only, so a run that made fewer requests (deadline, pause,
 * cut) adds a `<slot>+done` row with the actual count, which then replaces the claim's count
 * (V2-S7, D-697). A run killed before that row is written stays charged in full (fail safe).
 */
export async function quoteRequestsToday(db: Exec, market: string, d: string): Promise<number> {
  const r = await db.execute({
    sql:
      "SELECT COALESCE(SUM(CASE " +
      "WHEN q.slot_minute LIKE '%' || ? THEN q.requests " +
      "WHEN EXISTS (SELECT 1 FROM quote_run x WHERE x.market = q.market AND x.session_d = q.session_d " +
      "AND x.purpose = q.purpose AND x.slot_minute = q.slot_minute || ?) THEN 0 " +
      "ELSE q.requests END), 0) AS n FROM quote_run q WHERE q.market = ? AND q.session_d = ?",
    args: [DONE_SUFFIX, DONE_SUFFIX, market, d],
  });
  return Number(r.rows[0]?.n ?? 0);
}
