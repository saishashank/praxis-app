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

/** Sum of `quote_run.requests` for the session (read only; the table is WP2's). */
export async function quoteRequestsToday(db: Exec, market: string, d: string): Promise<number> {
  const r = await db.execute({
    sql: "SELECT COALESCE(SUM(requests), 0) AS n FROM quote_run WHERE market = ? AND session_d = ?",
    args: [market, d],
  });
  return Number(r.rows[0]?.n ?? 0);
}
