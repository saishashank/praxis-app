// Incident rows (NFR-006, OPS-011). Only what the watchdog needs now: open an S1 once, list the
// open S1 incidents. With a notify context the open goes through notifyIncident (M5 T11, D-051):
// one S1 incident email; without it the row is recorded and nothing is sent.
import type { Client } from "@libsql/client";
import { notifyIncident, type NotifyCtx } from "@/lib/incidents/notify";
import { nowIso } from "@/lib/db/time";

export const KIND_UNAPPROVED_CODE = "unapproved_production_code";

export type IncidentRow = { id: number; at: string; severity: "S1" | "S2" | "S3"; kind: string };

/**
 * Opens an S1 incident unless one of the same kind is already open (one incident per episode;
 * a repeat check never duplicates it). Returns true when a new row was inserted.
 */
export async function openS1Once(
  db: Client,
  kind: string,
  detail: Record<string, unknown>,
  now: string = nowIso(),
  notify?: Omit<NotifyCtx, "db" | "now">,
  summary?: string,
): Promise<boolean> {
  const r = await notifyIncident({ ...notify, db, now: () => new Date(now) }, kind, "S1", {
    summary: summary ?? `Watchdog: ${kind}`,
    detail,
  });
  return r.opened;
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
