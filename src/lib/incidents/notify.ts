// notifyIncident: the one door every incident writer goes through (M5 T11, design 4.8, NFR-006,
// EML-021; D-066, D-051, D-063, D-101, D-105). It opens ONE open incident per kind (guarded
// INSERT, any severity, so an escalated incident is not opened a second time) and, for S1/S2, sends
// the incident email `inc:<id>:open` through `sendEmail` (the reserved incident slot for the day's
// first one, the pool after; `email_mode`, caps and recipient are the core's). A repeat finds the
// open row and the claimed key (`duplicate`): never a second email. S3 is in-app only, so a single
// LLM fallback or a provider quota rules-only mode never emails (EML-021). Without `env` the
// incident is recorded and nothing is sent (unit callers). An email problem never throws out of
// here: the incident row is the record. Facts are short text, never a secret.
import type { Client } from "@libsql/client";
import { emailKeys } from "@/lib/email/keys";
import type { EmailEnvVars, EmailProvider } from "@/lib/email/provider";
import { LiveSendBlockedError } from "@/lib/email/provider";
import { sendEmail, type SendStatus } from "@/lib/email/send";
import { formatMelbourne } from "@/lib/health/format";

export type Severity = "S1" | "S2" | "S3";

export interface NotifyCtx {
  db: Pick<Client, "execute">;
  /** Absent = record only, no email. */
  env?: EmailEnvVars;
  now?: () => Date;
  provider?: EmailProvider;
  sleep?: (ms: number) => Promise<void>;
}

export interface IncidentFacts {
  summary: string;
  /** Short facts for detail_json (never a secret). */
  detail?: Record<string, unknown>;
  component?: string;
  impact?: string;
  fix?: string;
  fixPath?: string;
}

type Spec = { component: string; impact: string; fix: string; fixPath: string };

/** Defaults per kind; a caller's facts override them. */
export const INCIDENT_SPECS: Readonly<Record<string, Spec>> = {
  worker_blind: {
    component: "Worker",
    impact: "The Worker has reported nothing today; scheduled jobs may not be running.",
    fix: "Check the Worker deployment and its clock in System Health.",
    fixPath: "/health",
  },
  sentinel_blind: {
    component: "Sentinel",
    impact: "Announcements are not being read; P0 alerts may be late or missing.",
    fix: "Check the ASX feed state and the Worker poll in System Health.",
    fixPath: "/health#sentinel",
  },
  completion_marker_missing: {
    component: "Data pipeline",
    impact: "Batch 1 left no completion marker; tonight's review inputs may be incomplete.",
    fix: "Check the Batch 1 run in System Health.",
    fixPath: "/health",
  },
  review_missing: {
    component: "Evening Review",
    impact: "No Evening Review email was sent for today.",
    fix: "Open the Evening Review in the app and check the email record in System Health.",
    fixPath: "/health",
  },
  universe_shrink: {
    component: "Universe",
    impact: "The listed-companies import was rejected as a suspicious shrink; the old list stays.",
    fix: "Check the import file and re-run it if it is correct.",
    fixPath: "/health",
  },
  unapproved_production_code: {
    component: "Deployment",
    impact: "The running code is not the approved release.",
    fix: "Follow the OPS-045 steps: compare the commit with the approved deployment.",
    fixPath: "/health",
  },
  data_quality_two_nights: {
    component: "Data quality",
    impact: "The U1 quality gate failed two nights running; no new entries were allowed.",
    fix: "Check the data quality flags and the source status in System Health.",
    fixPath: "/health",
  },
  asx_trip: {
    component: "ASX source",
    impact: "The ASX source tripped on errors and is switched off until reset.",
    fix: "Check the ASX source, then reset the trip in System Health.",
    fixPath: "/health#sentinel",
  },
  quota_high: {
    component: "Quota",
    impact: "A free-tier quota is at 90 percent or more of its limit.",
    fix: "Review usage in System Health before the limit is reached.",
    fixPath: "/health",
  },
  degrade_mode: {
    component: "Quota",
    impact: "The app entered degrade mode to protect a quota.",
    fix: "Review usage in System Health.",
    fixPath: "/health",
  },
  backup_failure: {
    component: "Backup",
    impact: "The latest backup did not complete.",
    fix: "Check the backup job and its keys; run it again.",
    fixPath: "/health",
  },
  ledger_invariant: {
    component: "Ledger",
    impact: "A ledger invariant was violated; affected books are held.",
    fix: "Open the Control Room and follow the ledger runbook.",
    fixPath: "/health",
  },
  dispatch_auth: {
    component: "Worker dispatch",
    impact:
      "GitHub refused the Worker's dispatch token (401/403); scheduled jobs are not starting.",
    fix: "Check and rotate the dispatch token in the Worker secrets, then update the expiry date.",
    fixPath: "/health",
  },
  provider_auth: {
    component: "Provider",
    impact: "A provider refused our key (401/403); calls to it fail.",
    fix: "Check and rotate the provider key, then update the expiry date.",
    fixPath: "/health",
  },
};

const GENERIC: Spec = {
  component: "System",
  impact: "A system check failed.",
  fix: "Open System Health.",
  fixPath: "/health",
};

export interface NotifyResult {
  opened: boolean;
  id: number | null;
  severity: Severity;
  email: SendStatus | null;
}

const KIND_RE = /^[a-z][a-z0-9_]{1,60}$/;

/** Sends an incident's open or S1 mail; maps a core outcome and never throws on a send error. */
export async function emailIncident(
  ctx: NotifyCtx,
  event: "open" | "s1",
  row: { id: number; at: string; kind: string; severity: "S1" | "S2" },
  facts: IncidentFacts,
  allowAuthIncident = true,
): Promise<SendStatus | null> {
  if (!ctx.env) return null;
  const spec = INCIDENT_SPECS[row.kind] ?? GENERIC;
  const f = {
    incidentId: String(row.id),
    severity: row.severity,
    component: facts.component ?? spec.component,
    summary: facts.summary,
    since: formatMelbourne(row.at),
    impact: facts.impact ?? spec.impact,
    fix: facts.fix ?? spec.fix,
    fixPath: facts.fixPath ?? spec.fixPath,
  };
  const sc = {
    db: ctx.db,
    env: ctx.env,
    now: ctx.now,
    provider: ctx.provider,
    sleep: ctx.sleep,
  };
  try {
    const out =
      event === "open"
        ? await sendEmail(sc, "incident_open", emailKeys.incidentOpen(String(row.id)), f)
        : await sendEmail(sc, "incident_s1", emailKeys.incidentS1(String(row.id)), f);
    if (out.authFailure && allowAuthIncident && row.kind !== "provider_auth") {
      // 401/403 from the email provider: one in-app incident (its own email may fail again).
      await notifyIncident(
        ctx,
        "provider_auth",
        "S2",
        { summary: "The email provider refused our key (401/403)" },
        false,
      );
    }
    return out.status;
  } catch (e) {
    if (e instanceof LiveSendBlockedError) throw e;
    return "failed";
  }
}

/**
 * Opens (once per kind) and emails (once per incident) an incident. Throws only on a database
 * error from the guarded INSERT (callers keep their existing "write failed" handling).
 */
export async function notifyIncident(
  ctx: NotifyCtx,
  kind: string,
  severity: Severity,
  facts: IncidentFacts,
  allowAuthIncident = true,
): Promise<NotifyResult> {
  if (!KIND_RE.test(kind)) throw new Error("invalid incident kind");
  const now = (ctx.now ?? (() => new Date()))();
  const ins = await ctx.db.execute({
    sql:
      "INSERT INTO incident (at, severity, kind, detail_json) SELECT ?, ?, ?, ? " +
      "WHERE NOT EXISTS (SELECT 1 FROM incident WHERE kind = ? AND resolved_at IS NULL)",
    args: [now.toISOString(), severity, kind, JSON.stringify(facts.detail ?? {}), kind],
  });
  const row = await ctx.db.execute({
    sql: "SELECT id, at, severity FROM incident WHERE kind = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1",
    args: [kind],
  });
  const r = row.rows[0];
  const id = r ? Number(r.id) : null;
  const sev = (r ? String(r.severity) : severity) as Severity;
  const res: NotifyResult = { opened: ins.rowsAffected === 1, id, severity: sev, email: null };
  if (id === null || sev === "S3") return res;
  res.email = await emailIncident(
    ctx,
    "open",
    { id, at: String(r.at), kind, severity: sev },
    facts,
    allowAuthIncident,
  );
  return res;
}
