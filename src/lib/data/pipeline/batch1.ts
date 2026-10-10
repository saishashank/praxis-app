// Batch 1 end-of-day ingest, typed facade (M2 T6). The code is plain ESM so the Actions CLI runs it
// without a build: ./rules.mjs (pure rules) and ./batch1-core.mjs (database side). This file holds
// the quoted requirements, the stage list and the types, and re-exports both modules.
// Verbatim quotes (grep -n; spec/ and docs/M2_design.md):
//
// docs/M2_design.md:94 (Batch 1 stage list, AU slot table):
//   "| 17:30 | Batch 1, stages 1..9 (DAT-020) | Actions `ingest-batch1` | complete by 18:10 (DAT-021) |"
// spec/06_data_layer.md:78 (DAT-020 stages):
//   "1. Calendar check. 2. Universe snapshot (codes, status, tier, market-cap estimate, ADV)
//   (DAT-130). 3. EOD bars for **every listed code** (tiers are ranked from these bars; first-seen,
//   DAT-002). 4. Corporate actions (§6.6). 5. Announcements metadata of the day collected so far by
//   the Sentinel (...). 6. Macro, FX, short interest, insider notices on their schedules. 7. Weekly
//   fundamentals snapshot. 8. Quality checks (§6.5). 9. Data completion marker."
// spec/06_data_layer.md:9 DAT-001:
//   "Every market-data row carries `source`, `published_at` and `ingested_at`."
// spec/06_data_layer.md:10 DAT-002:
//   "Each day's bar is stored as **first-seen and immutable**; batch 1 of the next session
//   re-fetches the previous session's bars; a difference > 0.1% on any field flags the bar and
//   every decision made on it (...) — a flag only, since the resulting order has already been
//   placed. Prices are stored raw;"
// spec/06_data_layer.md:11 DAT-003:
//   "**Idempotent, resumable ingestion** (PLT-016); re-runs never duplicate."
// spec/06_data_layer.md:77 DAT-020:
//   "Stages on trading days, each writing a run record and independently re-runnable:"
// spec/06_data_layer.md:82 DAT-021:
//   "AU stages 1–9 complete by 18:10 Melbourne (batch 2 start)."
// spec/06_data_layer.md:83 DAT-022:
//   "**Non-trading days:** a reduced pipeline (announcement sweep, macro, learning summaries,
//   scheduled replays) writes a `non-trading` completion marker by 19:45"
// spec/06_data_layer.md:102 DAT-140:
//   "Backfills are staged to ≤ 50% of a month's write quota."
// spec/06_data_layer.md:103 DAT-141:
//   "Ceilings: storage ≤ 3 GB; writes ≤ 6M/month (staging ≤ 15% of that); reads ≤ 300M/month."
//   and "each job records rows read/written;"
// spec/02_platform_hosting_auth.md:27 PLT-016:
//   "Every job MUST be **idempotent** (safe to run twice), **short** (respect platform time
//   limits), and MUST support **catch-up** of missed periods."
// spec/02_platform_hosting_auth.md:28 PLT-017:
//   "Every scheduled run MUST write a run record: job name, scheduled time, start/end, status,
//   items processed, duration, token usage, error summary."
// spec/02_platform_hosting_auth.md:83 PLT-072:
//   "Batch/backtest jobs in Actions MAY be Python."
// spec/02_platform_hosting_auth.md:106 PLT-076:
//   "Every workflow declares a concurrency key (job, market, local date) without cancelling
//   in-progress runs, and exits in its first step if a success run record already exists for
//   that key."
// spec/12_build_plan.md:62 BLD-024:
//   "From M2 the production deployment runs the real nightly data pipeline and universe snapshots
//   (DAT-130) with the Arena, emails and decision agents (A2–A8) disabled"
// spec/10_nfr_testing.md:115 SEC-108 (c):
//   "**Every `production` workflow checks out the commit of the latest approved
//   `deploy-production` deployment** (read via the GitHub API), not the `release` head,"
// docs/M2_design.md:82 (concurrency):
//   "Concurrency key is `<job>:<market>:<local date>` in `run_record.concurrency_key`."
// docs/M2_design.md:84 (catch-up):
//   "Catch-up: each stage reads `ingest_cursor` and the last marker and processes all missing
//   trading dates (bounded, for example 5), oldest first. Cursors advance only after commit."
// docs/M2_design.md:150 decision 2:
//   "**Batch 1:** Python/yfinance (PLT-072) runs in the GitHub Actions job and only **fetches**
//   into a JSON file in the runner; a Node writer in the same job, using the shared, tested DB
//   library, validates and writes Turso directly with run-record row accounting."
// docs/M2_design.md:152 decision 4:
//   "**`bar_refetch`:** store only re-fetches that differ, plus a nightly hash per session."
// docs/M2_design.md:161 decision 13:
//   "**Backfill cap:** 2M writes/month (stricter than the spec's 50 %)."
//
// Choices made where the spec is silent (see the T6 report): one run record per processed date
// (stage results in details_json); a re-fetch "differs" above refetch_diff_flag 0.1 %; published_at
// = ingested_at for live bars; a past day's universe snapshot is not reconstructed; the live target
// date is never blocked by the backfill cap; a source must be `enabled` in source_register.
export {
  BACKFILL_WRITE_CAP_MONTH,
  LOOKBACK_DAYS,
  MARKET,
  MAX_DATES_PER_RUN,
  REFETCH_DIFF_PCT,
  SOURCE,
  addDays,
  compareBar,
  isTradingDay,
  monthBoundsUtc,
  parseBars,
  parseBarsText,
  planDates,
  previousTradingDay,
  refetchHash,
  rejectSummary,
  sydneyDate,
  throttleFrom,
  tradingDaysBetween,
  validateBar,
  BarsFormatError,
} from "./rules.mjs";
export {
  JOB,
  STAGE_NAMES,
  StageError,
  assess,
  noopQualityHook,
  prepareBatch1,
  readThrottle,
  runBatch1,
} from "./batch1-core.mjs";
export type { QualityHook, QualityHookContext, RunOptions, RunResult } from "./batch1-core.mjs";

/** The nine stages of DAT-020 in order (stages 4..7 are stubs in M2 T6). */
export type StageName =
  | "calendar"
  | "universe"
  | "bars"
  | "corporate_actions"
  | "announcements"
  | "macro_and_other"
  | "fundamentals"
  | "quality"
  | "marker";
