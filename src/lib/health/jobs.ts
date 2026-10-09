// Known jobs for System Health (PLT-017, PLT-061). expectedIntervalSec = null means the job runs
// on demand and is never flagged stale. A job is stale when now - last success > 2 x interval.
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
    job: "nightly-backup",
    label: "Nightly backup",
    expectedIntervalSec: 86_400,
    noDataNote: "Not built yet",
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
