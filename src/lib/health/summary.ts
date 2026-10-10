// System Health data (PLT-017, PLT-061, UX-090/092/117). Owner-only fields are ABSENT (not null)
// for other roles: error summaries, per-secret results and details (SEC-101, ROL-102a).
import type { Client } from "@libsql/client";
import type { Role } from "@/lib/auth/permissions";
import { latestPerJob, type RunStatus } from "@/lib/runs/runRecord";
import { getMeters, usageEnvironment, worstMeter, type MeterLevel } from "@/lib/usage/meters";
import { listOpenS1, type IncidentRow } from "@/lib/watchdog/incidents";
import {
  parseWatchdogDetails,
  shortSha,
  WATCHDOG_JOB,
  type WatchdogStatus,
} from "@/lib/watchdog/state";
import { marketDate, type CalendarSummary } from "@/lib/data/calendar";
import { calendarYearSummary } from "@/lib/data/calendarAdmin";
import { isStale, JOBS } from "./jobs";

export const SELFCHECK_JOB = "credential-selfcheck-vercel";
export const WORKER_SELFCHECK_JOB = "worker-selfcheck";

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

// Quota usage (PLT-061, PLT-050): the worst level for every role; the meter name and ratio are
// Owner-only (absent for others, like the Usage page itself, ROL-102a).
export type QuotaSummary = { level: MeterLevel; meter?: string; ratio?: number };

// Production code approval (SEC-108 d). The state line is for every role; the short commit ids
// and open S1 incidents are Owner-only (absent for others, UX-092, ROL-102a).
export type WatchdogSummary = {
  status: WatchdogStatus | "no data";
  checkedAt: string | null;
  approvedShort?: string | null; // Owner only
  deployedShort?: string | null; // Owner only
};

export type HealthSummary = {
  jobs: JobSummary[];
  calendar?: CalendarSummary[] | null; // AU trading calendar per year (DAT-160); null = unreadable
  quota: QuotaSummary;
  watchdog: WatchdogSummary;
  openIncidents?: IncidentRow[] | null; // Owner only; null = could not be read
  secrets?: { lastVerifiedAt: string | null; results: SecretResult[] }; // Owner only (Vercel)
  workerSecrets?: { lastVerifiedAt: string | null; results: SecretResult[] }; // Owner only (Worker)
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

async function getQuota(
  mainDb: Client,
  now: Date,
  owner: boolean,
  env: Record<string, string | undefined>,
): Promise<QuotaSummary> {
  try {
    const worst = worstMeter(await getMeters(mainDb, now, usageEnvironment(env)));
    const q: QuotaSummary = { level: worst.level };
    if (owner && worst.meter && worst.meter.ratio !== null) {
      q.meter = worst.meter.label;
      q.ratio = worst.meter.ratio;
    }
    return q;
  } catch {
    return { level: "no data" }; // quota trouble never hides job status
  }
}

// AU trading calendar status for the current Sydney year and the next one (only years with rows).
async function getCalendar(mainDb: Client, now: Date): Promise<CalendarSummary[] | null> {
  try {
    const year = Number(marketDate(now, "Australia/Sydney").slice(0, 4));
    const out: CalendarSummary[] = [];
    for (const y of [year, year + 1]) {
      const s = await calendarYearSummary(mainDb, "AU", y);
      if (s.total > 0) out.push(s);
    }
    return out;
  } catch {
    return null; // calendar trouble never hides job status
  }
}

export async function getHealthSummary(
  mainDb: Client,
  now: Date,
  role: Role,
  env: Record<string, string | undefined> = process.env,
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

  const wd = byJob.get(WATCHDOG_JOB);
  const watchdog: WatchdogSummary = wd
    ? { status: parseWatchdogDetails(wd.last.details).status, checkedAt: wd.last.endedAt }
    : { status: "no data", checkedAt: null };
  if (owner) {
    const p = parseWatchdogDetails(wd?.last.details);
    watchdog.approvedShort = shortSha(p.approvedSha);
    watchdog.deployedShort = shortSha(p.deployedSha);
  }

  const summary: HealthSummary = {
    jobs,
    quota: await getQuota(mainDb, now, owner, env),
    watchdog,
    calendar: await getCalendar(mainDb, now),
  };
  if (owner) {
    try {
      summary.openIncidents = await listOpenS1(mainDb);
    } catch {
      summary.openIncidents = null; // incident trouble never hides job status
    }
    const sc = byJob.get(SELFCHECK_JOB);
    summary.secrets = {
      lastVerifiedAt: sc?.last.endedAt ?? null,
      results: parseResults(sc?.last.details),
    };
    const ws = byJob.get(WORKER_SELFCHECK_JOB);
    summary.workerSecrets = {
      lastVerifiedAt: ws?.last.endedAt ?? null,
      results: parseResults(ws?.last.details),
    };
  }
  return summary;
}
