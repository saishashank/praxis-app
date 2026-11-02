// "Run now": the Owner asks for a scheduled job to run at once (D-840..D-849). MONEY-PATH-ADJACENT and
// security-sensitive: it can start Arena, email and backfill jobs, so it is Owner-only, confirm-required,
// audit-first, rate-limited, and it only WRITES A REQUEST. The Worker (worker/src/runNow.ts) decides
// whether the request runs, through the same dispatch path as the schedule and with every safety gate
// of the schedule except the time window.
//
// requestRunNow follows the D-066 controls runner (src/lib/data/controls.ts `commit`): Owner check,
// validation, confirm, ONE audit event first, ONE write transaction on the main database, and a
// `_failed` event if that fails. Checks that could be raced (one pending request per job, the hourly
// limit) are re-made inside the transaction. Error codes: forbidden, unknown_job, invalid,
// confirm_required, already_pending, rate_limited, unavailable.
import { createHmac } from "node:crypto";
import type { Client } from "@libsql/client";
import { requireKey } from "@/lib/auth/audit";
import {
  commit,
  fail,
  Precondition,
  ownerCheck,
  type ControlBase,
  type ControlResult,
} from "@/lib/data/controls";
import { findJob, RUNNABLE_JOBS, validateParams, type Job } from "@/lib/jobs/registry.mjs";
import { melbourneToday } from "@/lib/ops/checklist";

export const RUN_NOW_MARKET = "AU";
/** At most this many requests per job in one hour (a pending one blocks a second anyway). */
export const RUN_NOW_MAX_PER_JOB_HOUR = 6; // threshold-ok: abuse limit, D-843
/** At most this many requests over all jobs in one hour. */
export const RUN_NOW_MAX_PER_HOUR = 30; // threshold-ok: abuse limit, D-843
const HOUR_MS = 3_600_000; // threshold-ok: unit

export type RunNowInput = ControlBase & { jobId: unknown; params?: unknown; confirmed: unknown };

/** A stable one-way tag of the requester (the audit log keeps the full trail). */
export const requesterTag = (key: string, userId: number): string =>
  createHmac("sha256", key).update(`run-now:user:${userId}`).digest("hex");

async function counts(
  db: Pick<Client, "execute">,
  jobId: string,
  sinceIso: string,
): Promise<{ pending: number; jobHour: number; hour: number }> {
  const r = await db.execute({
    sql:
      "SELECT " +
      "COALESCE(SUM(job_id = ? AND status IN ('pending', 'dispatched')), 0) AS pending, " +
      "COALESCE(SUM(job_id = ?), 0) AS job_hour, COUNT(*) AS hour " +
      "FROM run_now_request WHERE requested_at >= ?",
    args: [jobId, jobId, sinceIso],
  });
  const row = r.rows[0]!;
  return { pending: Number(row.pending), jobHour: Number(row.job_hour), hour: Number(row.hour) };
}

/**
 * Owner only. Writes ONE `pending` row of `run_now_request` and nothing else. The job must be in the
 * registry and `runNow`; its parameters are checked by the registry schema (`validateParams`).
 */
export async function requestRunNow(p: RunNowInput): Promise<ControlResult> {
  const nowDate = p.now ?? new Date();
  const now = nowDate.toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  const job = findJob(p.jobId);
  if (job === undefined || !job.runNow) return fail("unknown_job");
  const params = validateParams(job, p.params, melbourneToday(nowDate));
  if (params === null) return fail("invalid");
  if (p.confirmed !== true) return fail("confirm_required");
  const since = new Date(nowDate.getTime() - HOUR_MS).toISOString();
  const paramsJson = JSON.stringify(params);
  try {
    const tag = requesterTag(requireKey(p.env), p.actorId);
    const c = await counts(p.mainDb, job.id, since);
    if (c.pending > 0) return fail("already_pending");
    if (c.jobHour >= RUN_NOW_MAX_PER_JOB_HOUR || c.hour >= RUN_NOW_MAX_PER_HOUR) {
      return fail("rate_limited");
    }
    return await commit(p, now, {
      action: "jobs.run_now_requested",
      targetType: "job",
      targetId: job.id,
      detail: { job: job.id, params },
      apply: async (tx, auditRef) => {
        const again = await counts(tx, job.id, since);
        if (again.pending > 0) throw new Precondition("already_pending");
        if (again.jobHour >= RUN_NOW_MAX_PER_JOB_HOUR || again.hour >= RUN_NOW_MAX_PER_HOUR) {
          throw new Precondition("rate_limited");
        }
        await tx.execute({
          sql:
            "INSERT INTO run_now_request (job_id, market, params_json, requested_by_hmac, " +
            "requested_at, audit_ref, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
          args: [job.id, RUN_NOW_MARKET, paramsJson, tag, now, auditRef, now],
        });
      },
    });
  } catch {
    return fail("unavailable");
  }
}

// ---- read side (Ops page) ----------------------------------------------------------------------

export type RunNowStatus = "pending" | "dispatched" | "done" | "refused" | "expired";
export type LastRequest = {
  status: RunNowStatus;
  /** What the Worker recorded, e.g. "started: HTTP 204" or "refused: not listed". Null while pending. */
  result: string | null;
  requestedAt: string;
  updatedAt: string;
};
export type LastScheduled = { state: string; at: string; d: string };
export type JobRow = {
  job: Job;
  last: LastRequest | null;
  /** The latest scheduled start the Worker recorded for this job (worker_state `slot:<id>:<date>`). */
  scheduled: LastScheduled | null;
};

const STATUSES: readonly string[] = ["pending", "dispatched", "done", "refused", "expired"];
const MAX_SLOT_ROWS = 400; // threshold-ok: bound of the read (about 20 jobs, a few weeks)

/** Reads only; errors propagate so the page can show a neutral message. */
export async function loadRunNowRows(db: Pick<Client, "execute">): Promise<JobRow[]> {
  const [reqs, states] = await Promise.all([
    db.execute(
      "SELECT job_id, status, result, requested_at, updated_at FROM run_now_request " +
        "WHERE id IN (SELECT MAX(id) FROM run_now_request GROUP BY job_id)",
    ),
    db.execute({
      sql: "SELECT key, value_json, updated_at FROM worker_state WHERE key LIKE 'slot:%' ORDER BY updated_at DESC LIMIT ?",
      args: [MAX_SLOT_ROWS],
    }),
  ]);
  const last = new Map<string, LastRequest>();
  for (const r of reqs.rows) {
    const status = String(r.status);
    if (!STATUSES.includes(status)) continue;
    last.set(String(r.job_id), {
      status: status as RunNowStatus,
      result: r.result === null ? null : String(r.result),
      requestedAt: String(r.requested_at),
      updatedAt: String(r.updated_at),
    });
  }
  const sched = new Map<string, LastScheduled>();
  for (const r of states.rows) {
    const parts = String(r.key).split(":");
    if (parts.length !== 3 || sched.has(parts[1]!)) continue; // newest first: keep the first seen
    let state = "unknown";
    try {
      const v = JSON.parse(String(r.value_json)) as { s?: unknown };
      if (typeof v.s === "string") state = v.s;
    } catch {
      // keep "unknown"
    }
    sched.set(parts[1]!, { state, at: String(r.updated_at), d: parts[2]! });
  }
  return RUNNABLE_JOBS.map((job) => ({
    job,
    last: last.get(job.id) ?? null,
    scheduled: sched.get(job.id) ?? null,
  }));
}
