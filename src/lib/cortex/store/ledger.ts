// cortex_ledger_cell (CTX-031, CTX-034): the per-cell log of every calibration test. A cell is logged
// BEFORE its result (the table has CHECK logged_at < result_at) and the result is set ONCE
// (a guard trigger, like corporate_action.known_at in 0016). Activation trials are charged to
// trial_ledger with kind 'challenger' and rule_version 'cortex:<family>.<rule_version>' (its kind
// CHECK cannot change); see keyEdit.ts for the charge helper.
import { jsonText, parseJson, str, strOrNull, type CortexFamily, type Exec } from "./common";

export type CellSplit = "development" | "validation";

export type LedgerCellRow = {
  cellId: string;
  market: string;
  /** 'all' marks a cell that is not about one family (an Owner key edit). */
  family: CortexFamily | "all";
  angleId: string | null;
  kind: string;
  spec: unknown;
  loggedAt: string;
  resultAt: string | null;
  result: unknown | null;
  split: CellSplit;
  lineageId: string | null;
};

/** Logs a cell with no result yet. A repeat of the same cell_id throws (a cell is logged once). */
export async function logCell(
  db: Exec,
  c: Omit<LedgerCellRow, "resultAt" | "result">,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO cortex_ledger_cell (cell_id, market, family, angle_id, kind, spec_json, logged_at,
            split, lineage_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      c.cellId,
      c.market,
      c.family,
      c.angleId,
      c.kind,
      jsonText(c.spec),
      c.loggedAt,
      c.split,
      c.lineageId,
    ],
  });
}

/**
 * Sets the result of a logged cell, ONCE. Returns false when the cell is missing or already has a
 * result (the row is left as it was). `resultAt` must be later than `loggedAt` (the CHECK).
 */
export async function setCellResult(
  db: Exec,
  cellId: string,
  resultAt: string,
  result: unknown,
): Promise<boolean> {
  const r = await db.execute({
    sql: `UPDATE cortex_ledger_cell SET result_at = ?, result_json = ?
          WHERE cell_id = ? AND result_at IS NULL`,
    args: [resultAt, jsonText(result), cellId],
  });
  return r.rowsAffected > 0;
}

const toRow = (r: Record<string, unknown>): LedgerCellRow => ({
  cellId: str(r.cell_id),
  market: str(r.market),
  family: str(r.family) as LedgerCellRow["family"],
  angleId: strOrNull(r.angle_id),
  kind: str(r.kind),
  spec: parseJson(r.spec_json),
  loggedAt: str(r.logged_at),
  resultAt: strOrNull(r.result_at),
  result: r.result_json === null ? null : parseJson(r.result_json),
  split: str(r.split) as CellSplit,
  lineageId: strOrNull(r.lineage_id),
});

export async function getCell(db: Exec, cellId: string): Promise<LedgerCellRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM cortex_ledger_cell WHERE cell_id = ?",
    args: [cellId],
  });
  return r.rows[0] ? toRow(r.rows[0] as Record<string, unknown>) : null;
}

/** Cells of a family and kind, oldest log first. */
export async function cellsOfKind(
  db: Exec,
  market: string,
  family: CortexFamily | "all",
  kind: string,
): Promise<LedgerCellRow[]> {
  const r = await db.execute({
    sql: `SELECT * FROM cortex_ledger_cell WHERE market = ? AND family = ? AND kind = ?
          ORDER BY logged_at, cell_id`,
    args: [market, family, kind],
  });
  return r.rows.map((x) => toRow(x as Record<string, unknown>));
}

/** Cells logged but not yet resulted. */
export async function openCells(db: Exec, market: string): Promise<LedgerCellRow[]> {
  const r = await db.execute({
    sql: `SELECT * FROM cortex_ledger_cell WHERE market = ? AND result_at IS NULL
          ORDER BY logged_at, cell_id`,
    args: [market],
  });
  return r.rows.map((x) => toRow(x as Record<string, unknown>));
}
