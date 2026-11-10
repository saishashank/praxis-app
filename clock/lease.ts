// Job lease in the main database (INFRA T3; REQ\infra\INFRA_REQUIREMENT.md §5.3; migration 0029_job_run).
// A job starts only if no `running` row of its concurrency group has a heartbeat newer than 2 minutes. The
// check and the insert are ONE statement, so two runners (the clock and a `praxis run`) cannot both win.
// The runner heartbeats every 30 s, so a crashed run simply goes stale and the group frees itself, also
// across a clock restart.
import type { Arg, Stmt, StmtResult } from "../worker/src/db";

/** Runs statements in order in one request (worker/src/db.ts `pipeline` bound to an env and a fetch). */
export type LeaseDb = (stmts: Stmt[]) => Promise<StmtResult[]>;

export const LEASE_STALE_MS = 120_000;
export const HEARTBEAT_MS = 30_000;

export type RunStatus = "running" | "success" | "failed" | "timeout" | "skipped" | "standby";
export type JobRunRow = {
  id: number;
  job: string;
  slotId: string | null;
  localDate: string;
  status: RunStatus;
  startedAt: string;
  heartbeatAt: string;
  exitCode: number | null;
  logPath: string | null;
};

const iso = (ms: number): string => new Date(ms).toISOString();

export type AcquireInput = {
  job: string;
  slotId: string | null;
  localDate: string;
  /** Every job name that may not run at the same time (the job's group plus exclusive partners). */
  blocking: readonly string[];
  nowMs: number;
  staleMs?: number;
};

/** The new run id, or null when the lease is held (a `running` row with a fresh heartbeat). */
export async function acquire(db: LeaseDb, a: AcquireInput): Promise<number | null> {
  const marks = a.blocking.map(() => "?").join(", ");
  const fresh = iso(a.nowMs - (a.staleMs ?? LEASE_STALE_MS));
  const [ins, last] = await db([
    {
      sql:
        "INSERT INTO job_run (job, slot_id, local_date, status, started_at, heartbeat_at) " +
        "SELECT ?, ?, ?, 'running', ?, ? " +
        `WHERE NOT EXISTS (SELECT 1 FROM job_run WHERE status = 'running' AND heartbeat_at > ? AND job IN (${marks}))`,
      args: [a.job, a.slotId, a.localDate, iso(a.nowMs), iso(a.nowMs), fresh, ...a.blocking],
    },
    { sql: "SELECT last_insert_rowid()" },
  ]);
  if (!ins || ins.affected !== 1) return null;
  const id = Number(last?.rows[0]?.[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function setLogPath(db: LeaseDb, id: number, logPath: string): Promise<void> {
  await db([{ sql: "UPDATE job_run SET log_path = ? WHERE id = ?", args: [logPath, id] }]);
}

/** Keeps the lease alive. Returns false when the row is no longer `running` (finished or swept). */
export async function heartbeat(db: LeaseDb, id: number, nowMs: number): Promise<boolean> {
  const [r] = await db([
    {
      sql: "UPDATE job_run SET heartbeat_at = ? WHERE id = ? AND status = 'running'",
      args: [iso(nowMs), id],
    },
  ]);
  return (r?.affected ?? 0) === 1;
}

export async function finish(
  db: LeaseDb,
  id: number,
  status: Exclude<RunStatus, "running">,
  exitCode: number | null,
  nowMs: number,
): Promise<void> {
  await db([
    {
      sql: "UPDATE job_run SET status = ?, exit_code = ?, heartbeat_at = ? WHERE id = ?",
      args: [status, exitCode, iso(nowMs), id],
    },
  ]);
}

/** One DELETE: runs that finished more than `days` days ago (the cloud maintenance script is untouched). */
export async function pruneOld(db: LeaseDb, nowMs: number, days = 30): Promise<number> {
  const [r] = await db([
    {
      sql: "DELETE FROM job_run WHERE status <> 'running' AND started_at < ?",
      args: [iso(nowMs - days * 86_400_000)],
    },
  ]);
  return r?.affected ?? 0;
}

/** A run that never started (queued past its wait limit): one `skipped` row, so the night shows it. */
export async function recordSkipped(
  db: LeaseDb,
  a: { job: string; slotId: string | null; localDate: string; nowMs: number },
): Promise<void> {
  await db([
    {
      sql:
        "INSERT INTO job_run (job, slot_id, local_date, status, started_at, heartbeat_at) " +
        "VALUES (?, ?, ?, 'skipped', ?, ?)",
      args: [a.job, a.slotId, a.localDate, iso(a.nowMs), iso(a.nowMs)],
    },
  ]);
}

/** `running` rows whose heartbeat is stale belong to a dead runner: mark them failed. Returns the count. */
export async function recoverStale(
  db: LeaseDb,
  nowMs: number,
  staleMs: number = LEASE_STALE_MS,
): Promise<number> {
  const [r] = await db([
    {
      sql: "UPDATE job_run SET status = 'failed' WHERE status = 'running' AND heartbeat_at <= ?",
      args: [iso(nowMs - staleMs)],
    },
  ]);
  return r?.affected ?? 0;
}

const COLS = "id, job, slot_id, local_date, status, started_at, heartbeat_at, exit_code, log_path";
const toRow = (r: (string | number | null)[]): JobRunRow => ({
  id: Number(r[0]),
  job: String(r[1]),
  slotId: r[2] === null ? null : String(r[2]),
  localDate: String(r[3]),
  status: String(r[4]) as RunStatus,
  startedAt: String(r[5]),
  heartbeatAt: String(r[6]),
  exitCode: r[7] === null ? null : Number(r[7]),
  logPath: r[8] === null ? null : String(r[8]),
});

export async function runById(db: LeaseDb, id: number): Promise<JobRunRow | null> {
  const [r] = await db([{ sql: `SELECT ${COLS} FROM job_run WHERE id = ?`, args: [id] }]);
  const row = r?.rows[0];
  return row ? toRow(row) : null;
}

/** Newest runs first. `job` narrows to one job. */
export async function recentRuns(db: LeaseDb, limit: number, job?: string): Promise<JobRunRow[]> {
  const args: Arg[] = job === undefined ? [limit] : [job, limit];
  const [r] = await db([
    {
      sql:
        `SELECT ${COLS} FROM job_run ` +
        (job === undefined ? "" : "WHERE job = ? ") +
        "ORDER BY id DESC LIMIT ?",
      args,
    },
  ]);
  return (r?.rows ?? []).map(toRow);
}
