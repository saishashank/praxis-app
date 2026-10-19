// Incident route core for the Worker (M5 T6; PLT-018, NFR-006, D-100 follow-up; D-101). The Worker
// never emails and never writes the incident itself any more: it asks the app, signed, and the app
// opens ONE open incident per kind (guarded INSERT) and, for S2/S1 kinds, sends the incident email
// `inc:<id>:open` through the email core (reserved incident slot for the day's first one, pool
// after; switch, caps and recipient are the core's). The call is idempotent: a repeat finds the
// open incident and the email key already claimed (`duplicate`), so a Worker that asks on every
// blind tick costs one tiny request and never a second email. S3 kinds are in-app only.
import { emailKeys } from "@/lib/email/keys";
import { sendEmail, type SendStatus } from "@/lib/email/send";
import { formatMelbourne } from "@/lib/health/format";
import { nowOf, type AlertCtx } from "./deliver";

export type IncidentKind = "sentinel_blind" | "sentinel_ingest_failed";

type Spec = {
  severity: "S1" | "S2" | "S3";
  component: string;
  summary: (windowMin: number) => string;
  impact: string;
  fix: string;
  fixPath: string;
  email: boolean;
};

export const DEFAULT_BLIND_MIN = 15; // threshold-ok: registry default sentinel_blind_alert_min

/** The kinds the Worker may open through the route, and nothing else. */
export const INCIDENT_KINDS: Readonly<Record<IncidentKind, Spec>> = {
  sentinel_blind: {
    severity: "S2",
    component: "Sentinel",
    summary: (m) => `Sentinel is blind: no successful ASX poll for ${m} minutes`,
    impact: "Announcements are not being read; P0 alerts may be late or missing.",
    fix: "Check the ASX feed state and the Worker poll in System Health.",
    fixPath: "/health#sentinel",
    email: true,
  },
  sentinel_ingest_failed: {
    severity: "S3",
    component: "Sentinel",
    summary: () => "A feed body could not be handed to the app after 3 attempts",
    impact: "Its announcements may arrive with a later feed.",
    fix: "No action unless it repeats.",
    fixPath: "/health#sentinel",
    email: false,
  },
};

export type OpenResult = {
  opened: boolean;
  id: number | null;
  severity: "S1" | "S2" | "S3";
  email: SendStatus | null;
};

export async function openIncident(
  ctx: AlertCtx,
  kind: IncidentKind,
  o: { windowMin?: number; nowMs?: number } = {},
): Promise<OpenResult> {
  const spec = INCIDENT_KINDS[kind];
  const now = o.nowMs !== undefined ? new Date(o.nowMs) : nowOf(ctx);
  const windowMin = o.windowMin ?? DEFAULT_BLIND_MIN;
  const ins = await ctx.db.execute({
    sql:
      "INSERT INTO incident (at, severity, kind, detail_json) SELECT ?, ?, ?, ? " +
      "WHERE NOT EXISTS (SELECT 1 FROM incident WHERE kind = ? AND resolved_at IS NULL)",
    args: [
      now.toISOString(),
      spec.severity,
      kind,
      JSON.stringify({ source: "asx_announcements", window_min: windowMin }),
      kind,
    ],
  });
  const row = await ctx.db.execute({
    sql: "SELECT id, at FROM incident WHERE kind = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1",
    args: [kind],
  });
  const id = row.rows.length ? Number(row.rows[0].id) : null;
  const res: OpenResult = {
    opened: ins.rowsAffected === 1,
    id,
    severity: spec.severity,
    email: null,
  };
  if (!spec.email || id === null) return res;
  const out = await sendEmail(
    { db: ctx.db, env: ctx.env, now: () => now, provider: ctx.provider, sleep: ctx.sleep },
    "incident_open",
    emailKeys.incidentOpen(String(id)),
    {
      incidentId: String(id),
      severity: spec.severity === "S1" ? "S1" : "S2",
      component: spec.component,
      summary: spec.summary(windowMin),
      since: formatMelbourne(String(row.rows[0].at)),
      impact: spec.impact,
      fix: spec.fix,
      fixPath: spec.fixPath,
    },
  );
  res.email = out.status;
  return res;
}
