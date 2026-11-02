// Engine of the YAML watchdog script (M5 T12, docs/M5_design.md 4.8, D-096 decisions 11, 12, 42;
// NFR-006). scripts/watchdog/run.mjs bundles this file (like the arena CLIs) and calls it, so the
// direct "minimal review" uses the app's own renderer and send core (one renderer, one email key
// `review:<d>`, one idempotency key). Nothing here reads a secret except through `env`; nothing
// prints. Tests inject the database and the mock provider.
import { createClient, type Client } from "@libsql/client";
import { emailKeys, melbourneDate } from "@/lib/email/keys";
import {
  guardRecipient,
  ownerAddress,
  type EmailEnvVars,
  type EmailProvider,
} from "@/lib/email/provider";
import { RESEND_FROM } from "@/lib/email/resend";
import { selectProvider } from "@/lib/email/select";
import { sendEmail, type SendOutcome } from "@/lib/email/send";
import { notifyIncident } from "@/lib/incidents/notify";
import { readEmailSwitch } from "@/lib/email/switch";
import { renderIncident } from "@/lib/email/templates/notices";
import type { ReviewFacts } from "@/lib/email/templates/review";
import {
  HEARTBEAT_EVENING_JOB,
  HEARTBEAT_MORNING_JOB,
  KIND_EVENING_HEARTBEAT_MISSING,
  WORKER_CLOCK_JOB,
} from "@/lib/heartbeat/state";

export { melbourneDate, emailKeys };

export type WatchdogSlot = "2040" | "2150" | "manual";
export const SLOTS: readonly WatchdogSlot[] = ["2040", "2150", "manual"];

export interface Problem {
  /** Short stable kind; part of the incident email key. */
  kind: string;
  summary: string;
  impact: string;
  fix: string;
}

export function openDb(env: EmailEnvVars): Client {
  return createClient({ url: env.TURSO_MAIN_URL ?? "", authToken: env.TURSO_MAIN_TOKEN });
}

/** True when the database answers a trivial query. */
export async function probeDb(db: Pick<Client, "execute">): Promise<boolean> {
  try {
    await db.execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/** Status of the email record `review:<d>` (null = no row). Throws on a database error. */
export async function reviewStatus(db: Pick<Client, "execute">, d: string): Promise<string | null> {
  const r = await db.execute({
    sql: "SELECT status FROM email_message WHERE email_key = ?",
    args: [emailKeys.review(d)],
  });
  return r.rows.length ? String(r.rows[0].status) : null;
}

const MICRO_PER_CENT = 10_000;

/**
 * Minimal review facts from the last completed data for d (NFR-006): live E-executions' NAV and
 * the change from their previous NAV row. Best effort: a missing table or row gives an empty list
 * ("No execution data available"); this never throws.
 */
export async function minimalReviewFacts(
  db: Pick<Client, "execute">,
  env: EmailEnvVars,
  d: string,
  reason: string,
  problems: Problem[],
): Promise<Omit<ReviewFacts, "env" | "appUrl">> {
  let executions: ReviewFacts["executions"] = [];
  try {
    const r = await db.execute({
      sql: `SELECT c.execution_id AS id, n.nav_micro AS nav,
                   (SELECT p.nav_micro FROM nav_daily p
                     WHERE p.cohort_id = n.cohort_id AND p.d < n.d ORDER BY p.d DESC LIMIT 1) AS prev,
                   c.seed_micro AS seed
            FROM nav_daily n JOIN cohort c ON c.id = n.cohort_id
            WHERE n.d = ? AND c.control_idx IS NULL AND c.live = 1
            ORDER BY c.execution_id`,
      args: [d],
    });
    executions = r.rows.map((x) => {
      const nav = Number(x.nav);
      const base = x.prev === null ? Number(x.seed) : Number(x.prev);
      return {
        id: String(x.id),
        label: String(x.id),
        currency: "AUD",
        navCents: Math.round(nav / MICRO_PER_CENT),
        dayPlCents: Math.round((nav - base) / MICRO_PER_CENT),
        progressPct: 0,
        distanceToTargetCents: 0,
        realisedCents: 0,
        unrealisedCents: 0,
        costsCents: 0,
        sleevePlCents: 0,
        sleeve: "none" as const,
        path: `/executions/${String(x.id)}`,
      };
    });
  } catch {
    executions = [];
  }
  void env;
  return {
    variant: "minimal",
    date: d,
    minimalReason: reason,
    arenaActive: executions.length > 0,
    executions,
    scorecard: {
      healthyComponents: 0,
      totalComponents: 0,
      attention: problems.map((p) => ({
        name: p.kind,
        status: "attention" as const,
        daysOpen: 0,
        fix: p.fix,
      })),
    },
    orders: [],
    narrative: null,
    stats: null,
    alerts: [],
    breakerHits: [],
    health: [],
    suppressedEmails: 0,
  };
}

export interface FallbackDeps {
  db: Pick<Client, "execute">;
  env: EmailEnvVars;
  now?: () => Date;
  provider?: EmailProvider;
}

/**
 * The direct minimal review: same email key `review:<d>` as the route's, claimed in the database
 * before sending, so a review the route already sent is a `duplicate` and never a second email.
 */
export function sendFallbackReview(
  deps: FallbackDeps,
  d: string,
  reason: string,
  problems: Problem[] = [],
): Promise<SendOutcome> {
  return minimalReviewFacts(deps.db, deps.env, d, reason, problems).then((facts) =>
    sendEmail(
      { db: deps.db, env: deps.env, now: deps.now, provider: deps.provider },
      "review",
      emailKeys.review(d),
      facts,
      { watchdogFallback: true },
    ),
  );
}

const when = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Melbourne",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

/** Pre-formatted Melbourne time for an email ("19 Oct, 20:40 AEDT"). */
export const melbourneStamp = (at: Date): string => when.format(at);

/**
 * "Database unreachable" (NFR-006 l.15): at most one email per run and slot, sent straight through
 * the provider because no claim can be made. The Resend Idempotency-Key `<env>:dbdown:<d>:<slot>`
 * is the only de-duplication. Returns "sent" | "skipped" (no recipient, provider or URL) | "failed".
 */
export async function sendDbDown(
  env: EmailEnvVars,
  slot: WatchdogSlot,
  now: Date,
  provider?: EmailProvider,
): Promise<"sent" | "skipped" | "failed"> {
  const owner = ownerAddress(env);
  const appUrl = (env.APP_BASE_URL ?? "").trim();
  const inner = provider ?? selectProvider(env);
  if (!owner || !/^https?:\/\//.test(appUrl) || inner.name === "null") return "skipped";
  const d = melbourneDate(now);
  const out = renderIncident({
    env: "production",
    appUrl,
    incidentId: `dbdown:${d}:${slot}`,
    event: "open",
    severity: "S1",
    component: "Database",
    summary: "Database unreachable",
    since: melbourneStamp(now),
    impact:
      "The watchdog could not read the database, so de-duplication and the review check are unavailable. Only heartbeat and watchdog runs alert in this state.",
    fix: "Check the Turso status page and the database in the Turso dashboard, then re-run the watchdog.",
    fixPath: "/system-health",
  });
  try {
    const res = await guardRecipient(inner, owner).send({
      from: RESEND_FROM,
      to: owner,
      subject: out.subject,
      html: out.html,
      text: out.text,
      idempotencyKey: `production:${emailKeys.dbdown(d, slot)}`,
    });
    return res.outcome === "accepted" ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * R3-I3 (D-818): the GitHub watchdog's own "the heartbeat did not run" check, independent of Vercel. At 21:50
 * there must be a finished (`final`) evening record for last night or a finished morning record for today;
 * if there is neither, the Vercel cron has stopped (both heartbeats) and nothing in the app can say so. Opens
 * the same stable kind as the morning look-back (D-802), so the incident is de-duplicated. Armed only once
 * the system has history older than last night (a heartbeat or the Worker clock on an earlier date), so the
 * first day after go-live is silent. Throws on a database error like the other checks.
 */
export async function heartbeatGone(
  db: Pick<Client, "execute">,
  d: string,
): Promise<Problem | null> {
  const prev = new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const recent = await db.execute({
    sql: `SELECT 1 FROM run_record
          WHERE concurrency_key IN (?, ?) AND json_extract(details_json, '$.final') = 1 LIMIT 1`,
    args: [`${HEARTBEAT_EVENING_JOB}:${prev}`, `${HEARTBEAT_MORNING_JOB}:${d}`],
  });
  if (recent.rows.length > 0) return null;
  const history = await db.execute({
    sql: `SELECT 1 FROM run_record
          WHERE (job IN (?, ?) OR job = ?) AND substr(concurrency_key, -10) < ? LIMIT 1`,
    args: [HEARTBEAT_EVENING_JOB, HEARTBEAT_MORNING_JOB, WORKER_CLOCK_JOB, prev],
  });
  if (history.rows.length === 0) return null;
  return {
    kind: KIND_EVENING_HEARTBEAT_MISSING,
    summary: `No heartbeat finished since the evening of ${prev}`,
    impact:
      "Neither the evening heartbeat of last night nor the morning heartbeat of today finished: the Vercel cron may have stopped, so the app's own checks are not running.",
    fix: "Open the Vercel project, Cron Jobs, and check the entries and the last runs; then call the heartbeat route once by hand.",
  };
}

/**
 * Checks after the review step. Read-only. `reviewExpected` follows the production switch: a
 * review is expected in `full` mode or on the one-off test date; otherwise its absence is by design.
 * Throws on a database error (the caller treats that as "database unreachable").
 */
export async function runChecks(
  db: Pick<Client, "execute">,
  d: string,
  slot: WatchdogSlot,
): Promise<Problem[]> {
  const problems: Problem[] = [];
  const clock = await db.execute({
    sql: "SELECT 1 FROM run_record WHERE job = ? AND concurrency_key LIKE ? LIMIT 1",
    args: [WORKER_CLOCK_JOB, `%:${d}`],
  });
  if (!clock.rows.length) {
    problems.push({
      kind: "worker_blind",
      summary: "The Worker has not run today",
      impact: "No scheduled work is being dispatched.",
      fix: "Check the Cloudflare Worker and its cron trigger.",
    });
  }
  const sw = await readEmailSwitch(db, d);
  const expected = sw.mode === "full" || sw.reviewTestDate === d;
  if (expected && (await reviewStatus(db, d)) !== "sent") {
    problems.push({
      kind: "review_missing",
      summary: "No Evening Review email was sent",
      impact: "The Owner has no review for today by email.",
      fix: "Open System Health, find the review run and email record, then re-run the watchdog.",
    });
  }
  if (slot === "2150") {
    const gone = await heartbeatGone(db, d);
    if (gone) problems.push(gone);
    const open = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM incident
            WHERE resolved_at IS NULL AND severity IN ('S1','S2') AND at >= ?`,
      args: [new Date(Date.parse(`${d}T00:00:00Z`) - 12 * 3_600_000).toISOString()],
    });
    if (Number(open.rows[0]?.n ?? 0) > 0) {
      problems.push({
        kind: "incident_open",
        summary: "An incident opened today is still open",
        impact: "NFR-006: the 21:50 run fails while a new incident stays unresolved.",
        fix: "Open System Health, handle the incident and close it.",
      });
    }
  }
  return problems;
}

/**
 * V1-I2 (D-772): a problem goes through the one door every incident writer uses (`notifyIncident`):
 * ONE open incident per stable kind (`worker_blind`, `review_missing`), the same rows the heartbeat
 * opens, so the 20:40 run, the 21:50 run and the heartbeat page the Owner once, and a repeat is a
 * duplicate that sends nothing. `incident_open` ("an incident opened today is still open") is NOT an
 * incident of its own: it only fails the run (NFR-006), so GitHub's failure email is its one alert.
 */
export async function sendProblemEmail(
  deps: FallbackDeps,
  d: string,
  slot: WatchdogSlot,
  p: Problem,
  now: Date,
): Promise<{ status: string }> {
  if (p.kind === "incident_open")
    return { status: "not sent (the open incident is already paged)" };
  const r = await notifyIncident(
    { db: deps.db, env: deps.env, now: () => now, provider: deps.provider },
    p.kind,
    "S2",
    {
      summary: p.summary,
      impact: p.impact,
      fix: p.fix,
      fixPath: "/health",
      component: "Watchdog",
      detail: { source: "watchdog", slot, d },
    },
  );
  return { status: r.email ?? (r.opened ? "recorded" : "already open") };
}
