// The intraday-stream meter (M23 M3; VAL-120, D-1608, D-1723). One `research_meter` row per night for the stream's active cell:
// n is the smaller of the measured candidates and the sessions they cover, against the pre-registered 60 of each (the
// evaluator's own floors, pinned to them by a test). `looked` once the cell holds its one look (the evaluator records it
// through `takeLook`, in `src/lib/intraday/evaluator.ts`); this file never evaluates and never takes a look. The count is one
// aggregate over the market's measured candidates, which stops once the cell has its look.
import type { Client } from "@libsql/client";
import type { ResearchNightOptions } from "../night";
import { streamLineage } from "../lineages/intradayStream";
import { num, str, writeMeter, type MeterStatus } from "./common";

export const INTRADAY_FLOOR_CANDIDATES = 60; // threshold-ok: VAL-118 pre-registered sample (pinned to the evaluator by a test)
export const INTRADAY_FLOOR_SESSIONS = 60; // threshold-ok: VAL-118 pre-registered sample (pinned to the evaluator by a test)

export type IntradayMeter = {
  readonly lineage: string;
  readonly n: number;
  readonly status: MeterStatus;
};

/** One night for one market; null when the stream has no cell yet (the evaluator logs the first one). */
export async function runIntradayMeter(
  db: Client,
  o: ResearchNightOptions,
): Promise<IntradayMeter | null> {
  // rows-ok: the stream's cells of one market by the (market, family, kind) index; one a quarter at most, newest read below
  const cells = await db.execute({
    sql:
      "SELECT cell_id, spec_json, result_at FROM cortex_ledger_cell WHERE market = ? AND family = 'all' " +
      "AND kind = 'intraday_stream' ORDER BY logged_at DESC, cell_id DESC LIMIT 1",
    args: [o.market],
  });
  const cell = cells.rows[0];
  if (cell === undefined) return null;
  const lineage = streamLineage(str(cell.cell_id), o.market);
  if (lineage === null) return null;
  const target = INTRADAY_FLOOR_CANDIDATES;
  const base = { market: o.market, lineage, d: o.d, target, now: o.now };
  if (cell.result_at !== null && cell.result_at !== undefined) {
    await writeMeter(db, { ...base, n: target, status: "looked", projectedD: null });
    return { lineage, n: target, status: "looked" };
  }
  let sampleFrom = "";
  try {
    const spec = JSON.parse(str(cell.spec_json)) as { sampleFrom?: unknown };
    if (typeof spec.sampleFrom === "string") sampleFrom = spec.sampleFrom;
  } catch {
    // a spec that cannot be read counts from the start, as the evaluator does for the first cell
  }
  // rows-ok: one aggregate over the cell's measured candidates (a few rows a session); no scan once the cell has its look
  const c = await db.execute({
    sql:
      "SELECT COUNT(*) AS c, COUNT(DISTINCT session_d) AS s FROM intraday_candidate " +
      "WHERE market = ? AND excess_open_5_ppm IS NOT NULL AND session_d >= ?",
    args: [o.market, sampleFrom],
  });
  // the two floors are the same number (a test pins it), so the smaller count is measured against one target
  const n = Math.min(num(c.rows[0]?.c ?? 0), num(c.rows[0]?.s ?? 0));
  const status: MeterStatus = n >= target ? "met" : "collecting";
  await writeMeter(db, { ...base, n, status });
  return { lineage, n, status };
}
