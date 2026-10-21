// Heartbeat incidents (PLT-074, NFR-006): S2, one open incident per kind (an episode is not
// repeated every day). With a notify context the open goes through notifyIncident (M5 T11): one
// incident email per incident; without it the row is recorded and nothing is sent.
import type { Client } from "@libsql/client";
import { notifyIncident, type NotifyCtx } from "@/lib/incidents/notify";

/**
 * Opens an S2 incident unless one of the same kind is already open. Returns true when a new row
 * was inserted. detail_json holds short facts only (never a secret).
 * One open incident per kind (any severity, so an escalated one is not opened again).
 */
export async function openS2Once(
  db: Client,
  kind: string,
  detail: Record<string, unknown>,
  now: string,
  notify?: Omit<NotifyCtx, "db" | "now">,
  summary?: string,
): Promise<boolean> {
  const r = await notifyIncident({ ...notify, db, now: () => new Date(now) }, kind, "S2", {
    summary: summary ?? `Heartbeat: ${kind}`,
    detail,
  });
  return r.opened;
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
