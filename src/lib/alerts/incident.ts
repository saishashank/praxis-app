// Incident route core for the Worker (M5 T6; PLT-018, NFR-006, D-100 follow-up; D-101). The Worker
// never emails and never writes the incident itself any more: it asks the app, signed, and the app
// opens ONE open incident per kind (guarded INSERT) and, for S2/S1 kinds, sends the incident email
// `inc:<id>:open` through the email core (reserved incident slot for the day's first one, pool
// after; switch, caps and recipient are the core's). The call is idempotent: a repeat finds the
// open incident and the email key already claimed (`duplicate`), so a Worker that asks on every
// blind tick costs one tiny request and never a second email. S3 kinds are in-app only.
import type { SendStatus } from "@/lib/email/send";
import { notifyIncident } from "@/lib/incidents/notify";
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
  // One door for every incident writer (M5 T11): S3 kinds are recorded only, never emailed.
  const r = await notifyIncident(
    {
      db: ctx.db,
      env: spec.email ? ctx.env : undefined,
      now: () => now,
      provider: ctx.provider,
      sleep: ctx.sleep,
    },
    kind,
    spec.severity,
    {
      summary: spec.summary(windowMin),
      detail: { source: "asx_announcements", window_min: windowMin },
      component: spec.component,
      impact: spec.impact,
      fix: spec.fix,
      fixPath: spec.fixPath,
    },
  );
  return { opened: r.opened, id: r.id, severity: spec.severity, email: r.email };
}
