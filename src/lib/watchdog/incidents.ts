// Incident rows (NFR-006, OPS-011). Only what the watchdog needs now: open an S1 once, list the
// open S1 incidents. Emailing the Owner is EML work (TODO below), not done here.
import type { Client } from "@libsql/client";
import { nowIso } from "@/lib/db/time";

export const KIND_UNAPPROVED_CODE = "unapproved_production_code";

export type IncidentRow = { id: number; at: string; severity: "S1" | "S2" | "S3"; kind: string };

/**
 * Opens an S1 incident unless one of the same kind is already open (one incident per episode;
 * a repeat check never duplicates it). Returns true when a new row was inserted.
 * TODO (EML-021, NFR-006): send the S1 incident email (with the OPS-045 steps) when this inserts.
 */
export async function openS1Once(
  db: Client,
  kind: string,
  detail: Record<string, unknown>,
  now: string = nowIso(),
): Promise<boolean> {
  const res = await db.execute({
    sql: `INSERT INTO incident (at, severity, kind, detail_json)
          SELECT ?, 'S1', ?, ? WHERE NOT EXISTS
            (SELECT 1 FROM incident WHERE kind = ? AND severity = 'S1' AND resolved_at IS NULL)`,
    args: [now, kind, JSON.stringify(detail), kind],
  });
  return res.rowsAffected > 0;
}

export async function listOpenS1(db: Client, limit = 20): Promise<IncidentRow[]> {
  const res = await db.execute({
    sql: `SELECT id, at, severity, kind FROM incident
          WHERE severity = 'S1' AND resolved_at IS NULL ORDER BY at DESC, id DESC LIMIT ?`,
    args: [limit],
  });
  return res.rows.map((r) => ({
    id: Number(r.id),
    at: String(r.at),
    severity: "S1",
    kind: String(r.kind),
  }));
}
