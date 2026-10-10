// Known jobs for System Health (PLT-017, PLT-061). expectedIntervalSec = null means the job runs
// on demand and is never flagged stale. A job is stale when now - last success > 2 x interval.
import { WATCHDOG_JOB } from "@/lib/watchdog/state";

export type JobDef = {
  job: string;
  label: string;
  expectedIntervalSec: number | null;
  /** Shown while no run exists yet. */
  noDataNote: string;
};

export const STALE_FACTOR = 2;

export const JOBS: readonly JobDef[] = [
  {
    job: "credential-selfcheck-vercel",
    label: "Credential self-check (Vercel)",
    expectedIntervalSec: null,
    noDataNote: "Not run yet",
  },
  {
    job: "worker-heartbeat",
    label: "Worker heartbeat",
    expectedIntervalSec: 60,
    noDataNote: "Not reporting yet (M2)",
  },
  {
    job: "worker-selfcheck",
    label: "Worker self-check",
    expectedIntervalSec: 86_400,
    noDataNote: "Not reported yet (runs after each Worker deploy and daily at 02:15 UTC)",
  },
  {
    job: WATCHDOG_JOB,
    label: "Production code approval check",
    expectedIntervalSec: 86_400,
    noDataNote: "Production only; first run after the next production deploy",
  },
  {
    job: "nightly-backup",
    label: "Nightly backup",
    expectedIntervalSec: 86_400,
    noDataNote: "Not run yet (manual until the Worker dispatches it, M2)",
  },
  {
    // Trading-day job (M2 T6, DAT-020): the longest normal gap between runs is a four-day weekend
    // (Thursday to Tuesday, five days); an interval of 3 days flags it stale only after 6 days.
    // The 19:50 marker check (T10) is the daily detector; this row shows freshness.
    job: "ingest-batch1",
    label: "Batch 1 end-of-day ingest (AU)",
    expectedIntervalSec: 3 * 86_400,
    noDataNote:
      "Not run yet (production, trading days at 17:30 Sydney once the Owner enables dispatch)",
  },
];

export function isStale(
  intervalSec: number | null,
  lastSuccessAt: string | null,
  now: Date,
): boolean {
  if (intervalSec === null || lastSuccessAt === null) return false;
  const t = Date.parse(lastSuccessAt);
  if (Number.isNaN(t)) return false;
  return now.getTime() - t > STALE_FACTOR * intervalSec * 1000;
}
