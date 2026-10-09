// System Health data (PLT-017, PLT-061, UX-090/092/117). Owner-only fields are ABSENT (not null)
// for other roles: error summaries, per-secret results and details (SEC-101, ROL-102a).
import type { Client } from "@libsql/client";
import type { Role } from "@/lib/auth/permissions";
import { latestPerJob, type RunStatus } from "@/lib/runs/runRecord";
import { isStale, JOBS } from "./jobs";

export const SELFCHECK_JOB = "credential-selfcheck-vercel";

export type JobState = "ok" | "stale" | "failed" | "no data";

export type JobSummary = {
  job: string;
  label: string;
  lastRun: { status: RunStatus; endedAt: string | null } | null;
  lastSuccessAt: string | null;
  stale: boolean;
  state: JobState;
  note?: string; // shown when there is no data
  errorSummary?: string | null; // Owner only
};

export type SecretResult = { name: string; ok: boolean; pending: boolean; detail?: string };

export type HealthSummary = {
  jobs: JobSummary[];
  secrets?: { lastVerifiedAt: string | null; results: SecretResult[] }; // Owner only
};

function parseResults(details: unknown): SecretResult[] {
  if (!Array.isArray(details)) return [];
  const out: SecretResult[] = [];
  for (const d of details) {
    if (typeof d !== "object" || d === null) continue;
    const r = d as Record<string, unknown>;
    if (typeof r.name !== "string") continue;
    out.push({
      name: r.name,
      ok: r.ok === true,
      pending: r.pending === true,
      detail: typeof r.detail === "string" ? r.detail : "",
    });
  }
  return out;
}

export async function getHealthSummary(
  mainDb: Client,
  now: Date,
  role: Role,
): Promise<HealthSummary> {
  const rows = await latestPerJob(mainDb); // throws on DB failure
  const byJob = new Map(rows.map((r) => [r.job, r]));
  const owner = role === "owner";

  const jobs: JobSummary[] = JOBS.map((def) => {
    const row = byJob.get(def.job);
    const lastRun = row ? { status: row.last.status, endedAt: row.last.endedAt } : null;
    const lastSuccessAt = row?.lastSuccess?.endedAt ?? null;
    const stale = isStale(def.expectedIntervalSec, lastSuccessAt, now);
    let state: JobState;
    if (!row) state = "no data";
    else if (row.last.status === "failed") state = "failed";
    else if (stale) state = "stale";
    else if (lastSuccessAt === null) state = "no data";
    else state = "ok";
    const s: JobSummary = { job: def.job, label: def.label, lastRun, lastSuccessAt, stale, state };
    if (state === "no data") s.note = def.noDataNote;
    if (owner) s.errorSummary = row?.last.errorSummary ?? null;
    return s;
  });

  const summary: HealthSummary = { jobs };
  if (owner) {
    const sc = byJob.get(SELFCHECK_JOB);
    summary.secrets = {
      lastVerifiedAt: sc?.last.endedAt ?? null,
      results: parseResults(sc?.last.details),
    };
  }
  return summary;
}
