// Escalation (M5 T11, design 4.8, NFR-006): an S2 incident still open after ESCALATE_AFTER_HOURS
// becomes S1 and the Owner gets ONE more email (`inc:<id>:s1`). Re-running never sends a second
// one (the key is claimed); if the first attempt was suppressed (switch off, no recipient) a later
// run tries again because the real key was not consumed. Incidents that were opened as S1 are not
// escalated (nothing to escalate to). Runs from the evening heartbeat.
import { emailIncident, INCIDENT_SPECS, type NotifyCtx } from "./notify";

export const ESCALATE_AFTER_HOURS = 24; // threshold-ok: design 4.8, one day unresolved

export interface EscalateResult {
  escalated: number[];
  emails: Record<number, string | null>;
}

export async function escalateIncidents(
  ctx: NotifyCtx,
  afterHours: number = ESCALATE_AFTER_HOURS,
): Promise<EscalateResult> {
  const now = (ctx.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - afterHours * 3_600_000).toISOString();
  const res: EscalateResult = { escalated: [], emails: {} };
  const due = await ctx.db.execute({
    sql: `SELECT id, at, kind, severity, detail_json FROM incident
          WHERE resolved_at IS NULL AND at <= ?
            AND (severity = 'S2'
              OR (severity = 'S1' AND json_extract(detail_json, '$.escalated_at') IS NOT NULL))
          ORDER BY id`,
    args: [cutoff],
  });
  for (const r of due.rows) {
    const id = Number(r.id);
    if (String(r.severity) === "S2") {
      const up = await ctx.db.execute({
        sql: `UPDATE incident SET severity = 'S1',
                detail_json = json_set(COALESCE(detail_json, '{}'), '$.escalated_at', ?)
              WHERE id = ? AND severity = 'S2' AND resolved_at IS NULL`,
        args: [now.toISOString(), id],
      });
      if (up.rowsAffected !== 1) continue;
      res.escalated.push(id);
    }
    const spec = INCIDENT_SPECS[String(r.kind)];
    const summary = `Still open after ${afterHours} hours: ${spec ? spec.component : String(r.kind)} (${String(r.kind)})`;
    res.emails[id] = await emailIncident(
      ctx,
      "s1",
      { id, at: String(r.at), kind: String(r.kind), severity: "S1" },
      { summary },
    );
  }
  return res;
}
