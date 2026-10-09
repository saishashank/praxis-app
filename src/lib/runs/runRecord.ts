// Run records (PLT-017, DAT-141, PLT-076). Retention 180 days (DAT-142).
import type { Client } from "@libsql/client";
import { nowIso } from "@/lib/db/time";

export type RunStatus = "running" | "success" | "failed" | "skipped" | "degraded";

export type RunRow = {
  id: number;
  job: string;
  market: string | null;
  concurrencyKey: string;
  scheduledFor: string | null;
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  itemsProcessed: number;
  rowsRead: number;
  rowsWritten: number;
  llmTokens: number;
  durationMs: number | null;
  errorSummary: string | null;
  details: unknown;
  commitSha: string | null;
};

const MAX_ERROR = 500;

export async function startRun(
  db: Client,
  p: {
    job: string;
    market?: string;
    concurrencyKey: string;
    scheduledFor?: string;
    commitSha?: string;
    now?: string;
  },
): Promise<number> {
  const res = await db.execute({
    sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, status, commit_sha)
          VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    args: [
      p.job,
      p.market ?? null,
      p.concurrencyKey,
      p.scheduledFor ?? null,
      p.now ?? nowIso(),
      p.commitSha ?? null,
    ],
  });
  return Number(res.lastInsertRowid);
}

export async function finishRun(
  db: Client,
  id: number,
  r: {
    status: Exclude<RunStatus, "running">;
    itemsProcessed?: number;
    rowsRead?: number;
    rowsWritten?: number;
    llmTokens?: number;
    errorSummary?: string;
    details?: unknown;
    now?: string;
  },
): Promise<void> {
  const cur = await db.execute({
    sql: "SELECT started_at FROM run_record WHERE id = ?",
    args: [id],
  });
  if (!cur.rows.length) throw new Error("run not found");
  const endedAt = r.now ?? nowIso();
  const duration = Math.max(0, Date.parse(endedAt) - Date.parse(String(cur.rows[0].started_at)));
  await db.execute({
    sql: `UPDATE run_record SET status = ?, ended_at = ?, duration_ms = ?, items_processed = ?, rows_read = ?,
          rows_written = ?, llm_tokens = ?, error_summary = ?, details_json = ? WHERE id = ?`,
    args: [
      r.status,
      endedAt,
      duration,
      r.itemsProcessed ?? 0,
      r.rowsRead ?? 0,
      r.rowsWritten ?? 0,
      r.llmTokens ?? 0,
      r.errorSummary === undefined ? null : r.errorSummary.slice(0, MAX_ERROR),
      r.details === undefined ? null : JSON.stringify(r.details),
      id,
    ],
  });
}

export async function hasSuccess(db: Client, concurrencyKey: string): Promise<boolean> {
  const res = await db.execute({
    sql: "SELECT 1 FROM run_record WHERE concurrency_key = ? AND status = 'success' LIMIT 1",
    args: [concurrencyKey],
  });
  return res.rows.length > 0;
}

function toRow(r: Record<string, unknown>): RunRow {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: Number(r.id),
    job: String(r.job),
    market: s(r.market),
    concurrencyKey: String(r.concurrency_key),
    scheduledFor: s(r.scheduled_for),
    startedAt: String(r.started_at),
    endedAt: s(r.ended_at),
    status: String(r.status) as RunStatus,
    itemsProcessed: Number(r.items_processed),
    rowsRead: Number(r.rows_read),
    rowsWritten: Number(r.rows_written),
    llmTokens: Number(r.llm_tokens),
    durationMs: n(r.duration_ms),
    errorSummary: s(r.error_summary),
    details: r.details_json === null ? undefined : JSON.parse(String(r.details_json)),
    commitSha: s(r.commit_sha),
  };
}

// For System Health: the most recent run and the most recent success of every job.
export async function latestPerJob(
  db: Client,
): Promise<{ job: string; last: RunRow; lastSuccess: RunRow | null }[]> {
  const last = await db.execute(
    `SELECT * FROM run_record r WHERE id = (SELECT id FROM run_record WHERE job = r.job ORDER BY started_at DESC, id DESC LIMIT 1) ORDER BY job`,
  );
  const ok = await db.execute(
    `SELECT * FROM run_record r WHERE status = 'success' AND id = (SELECT id FROM run_record WHERE job = r.job AND status = 'success' ORDER BY started_at DESC, id DESC LIMIT 1)`,
  );
  const okBy = new Map(ok.rows.map((r) => [String(r.job), toRow(r)]));
  return last.rows.map((r) => ({
    job: String(r.job),
    last: toRow(r),
    lastSuccess: okBy.get(String(r.job)) ?? null,
  }));
}

export async function pruneRuns(db: Client, now: string, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.parse(now) - retentionDays * 86_400_000).toISOString();
  const res = await db.execute({
    sql: "DELETE FROM run_record WHERE started_at < ?",
    args: [cutoff],
  });
  return res.rowsAffected;
}
