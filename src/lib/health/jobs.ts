// Known jobs for System Health (PLT-017, PLT-061). expectedIntervalSec = null means the job runs
// on demand and is never flagged stale. A job is stale when now - last success > 2 x interval.
import {
  HEARTBEAT_EVENING_JOB,
  HEARTBEAT_MORNING_JOB,
  WORKER_CLOCK_JOB,
} from "@/lib/heartbeat/state";
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
    // M2 T3: the Worker writes one rollup record per Sydney day on its first tick (decision 10).
    job: WORKER_CLOCK_JOB,
    label: "Worker clock (daily rollup)",
    expectedIntervalSec: 86_400,
    noDataNote: "Production only; first record after the Worker is deployed",
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
    // PLT-074: Vercel Cron in the 00:xx UTC hour; a no-op outside production.
    job: HEARTBEAT_MORNING_JOB,
    label: "Morning heartbeat (Worker and Sentinel)",
    expectedIntervalSec: 86_400,
    noDataNote: "Production only; first run after the next production deploy",
  },
  {
    // PLT-074: Vercel Cron in the 11:xx UTC hour; a no-op outside production.
    job: HEARTBEAT_EVENING_JOB,
    label: "Evening heartbeat (Worker, Sentinel and Batch 1 marker)",
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
  {
    // M2 T11 (D-067): the Worker imports the ASX listed-companies file once per trading day at
    // 07:30 Sydney. Same gap logic as ingest-batch1: stale only after 6 days without a success.
    job: "universe-import",
    label: "Instrument universe import (AU)",
    expectedIntervalSec: 3 * 86_400,
    noDataNote:
      "Not run yet (production, trading days at 07:30 Sydney once ASX contact and the listed-companies source are accepted)",
  },
  {
    // M3 T10 (D-077, ARN-060): batch 2a "close the books", one run per trading day after Batch 1.
    // Same gap logic as ingest-batch1: stale only after 6 days without a success. The slot is off
    // until the Owner enables the arena; in data_only production the run is a skipped record.
    job: "arena-close",
    label: "Arena close the books (AU, batch 2a)",
    expectedIntervalSec: 3 * 86_400,
    noDataNote:
      "Not run yet (off until the Owner enables the arena; records a skip while the market is data-only)",
  },
  {
    // M4 T8 (D-087, ARN-060): batch 2b "signals and orders", one run per trading day after 2a.
    // Same gap logic as arena-close; the slot is off until the Owner enables the arena, and in
    // data_only production the run is a skipped record.
    job: "arena-signals",
    label: "Arena signals and orders (AU, batch 2b)",
    expectedIntervalSec: 3 * 86_400,
    noDataNote:
      "Not run yet (off until the Owner enables the arena; records a skip while the market is data-only)",
  },
  {
    // M4 T15 (D-093, ARN-093, ARN-101, VAL-102): batch 3 "deterministic review numbers", run back-to-back
    // after 2b in the same job (scripts/arena/signals.mjs). Same gap logic as arena-signals; in
    // data_only production no run is attempted (batch 2b is skipped first).
    job: "arena-review",
    label: "Arena review numbers (AU, batch 3)",
    expectedIntervalSec: 3 * 86_400,
    noDataNote: "Not run yet (follows batch 2b; off until the Owner enables the arena)",
  },
  {
    // M2 T9 (DAT-125, DAT-125a): runs on demand; the Worker slot is off until the Owner enables the
    // backfill, and a paused_cap or empty plan still ends in a success record or none at all.
    job: "backfill-history",
    label: "History backfill (AU)",
    expectedIntervalSec: null,
    noDataNote:
      "Not run yet (off until the Owner enables the backfill; capped at 2M writes a month)",
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
