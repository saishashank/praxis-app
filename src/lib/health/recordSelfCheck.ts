// Writes one run record per self-check call (SEC-101). Only name / ok / pending / detail per
// secret is stored - `detail` is already a safe short string - never values.
import type { Client } from "@libsql/client";
import { nowIso } from "@/lib/db/time";
import { finishRun, startRun } from "@/lib/runs/runRecord";
import type { SelfCheckReport } from "@/lib/selfcheck/checks";
import { SELFCHECK_JOB } from "./summary";

export async function recordSelfCheckRun(db: Client, report: SelfCheckReport): Promise<void> {
  const startedAt = nowIso();
  const id = await startRun(db, {
    job: SELFCHECK_JOB,
    concurrencyKey: `${SELFCHECK_JOB}:${startedAt}`,
    commitSha: report.commit ?? undefined,
    now: startedAt,
  });
  await finishRun(db, id, {
    status: report.failed === 0 ? "success" : "failed",
    itemsProcessed: report.results.length,
    errorSummary: report.failed === 0 ? undefined : `${report.failed} check(s) failed`,
    details: report.results.map((r) => ({
      name: r.name,
      ok: r.ok,
      pending: r.pending === true,
      detail: r.detail,
    })),
  });
}
