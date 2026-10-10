// Heartbeat incidents (PLT-074, NFR-006): S2, one open incident per kind (an episode is not
// repeated every day). Emailing the Owner is EML work (TODO below), not done here.
import type { Client } from "@libsql/client";

/**
 * Opens an S2 incident unless one of the same kind is already open. Returns true when a new row
 * was inserted. detail_json holds short facts only (never a secret).
 * TODO (EML-021, NFR-006): send the incident email when this inserts (M5; none in data-only mode).
 */
export async function openS2Once(
  db: Client,
  kind: string,
  detail: Record<string, unknown>,
  now: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: `INSERT INTO incident (at, severity, kind, detail_json)
          SELECT ?, 'S2', ?, ? WHERE NOT EXISTS
            (SELECT 1 FROM incident WHERE kind = ? AND severity = 'S2' AND resolved_at IS NULL)`,
    args: [now, kind, JSON.stringify(detail), kind],
  });
  return res.rowsAffected > 0;
}

export type OpenS2 = { id: number; at: string; kind: string };

/** Open S2 incidents, newest first (System Health, Owner only). */
export async function listOpenS2(db: Client, limit = 20): Promise<OpenS2[]> {
  const res = await db.execute({
    sql: `SELECT id, at, kind FROM incident
          WHERE severity = 'S2' AND resolved_at IS NULL ORDER BY at DESC, id DESC LIMIT ?`,
    args: [limit],
  });
  return res.rows.map((r) => ({ id: Number(r.id), at: String(r.at), kind: String(r.kind) }));
}
