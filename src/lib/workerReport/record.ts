// Run record for the Worker's credential self-check (SEC-101). Only name / ok / detail per
// secret is stored; `detail` was length- and charset-checked by the handler. Never values.
import type { Client } from "@libsql/client";
import { nowIso } from "@/lib/db/time";
import { finishRun, startRun } from "@/lib/runs/runRecord";

export const WORKER_SELFCHECK_JOB = "worker-selfcheck";

export type WorkerResult = { name: string; ok: boolean; detail: string };
export type WorkerReport = { commit: string; results: WorkerResult[] };

export async function recordWorkerReport(db: Client, report: WorkerReport): Promise<void> {
  const startedAt = nowIso();
  const id = await startRun(db, {
    job: WORKER_SELFCHECK_JOB,
    concurrencyKey: `${WORKER_SELFCHECK_JOB}:${startedAt}`,
    commitSha: report.commit,
    now: startedAt,
  });
  const failed = report.results.filter((r) => !r.ok).length;
  await finishRun(db, id, {
    status: failed === 0 ? "success" : "failed",
    itemsProcessed: report.results.length,
    errorSummary: failed === 0 ? undefined : `${failed} check(s) failed`,
    details: report.results.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail })),
  });
}
