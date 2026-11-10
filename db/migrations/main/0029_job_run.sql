-- +up
-- Self-hosted job runner lease (INFRA T3, REQ\infra\INFRA_REQUIREMENT.md §5.3). One row per local job
-- run of praxis-clock (the replacement for a GitHub Actions run). A job starts only if no `running`
-- row of its concurrency group has a heartbeat newer than 2 minutes; the runner updates `heartbeat_at`
-- every 30 s, so the lease survives a clock restart (a crashed run simply stops heartbeating).
-- `status`: running -> success | failed | timeout; `skipped` = queued but never started (lease never
-- free within the wait limit); `standby` = a guard refused and nothing was done (no alert). Rows older than 30 days are pruned by the clock. `log_path` is a file on the host volume, shown by `praxis logs <id>`.
-- Nothing in the app reads this table; the cloud runtime never writes it.
CREATE TABLE job_run (
  id INTEGER PRIMARY KEY,
  job TEXT NOT NULL CHECK (length(job) BETWEEN 1 AND 64 AND job NOT GLOB '*[^a-z0-9-]*'),
  slot_id TEXT CHECK (slot_id IS NULL OR length(slot_id) BETWEEN 1 AND 64),
  local_date TEXT NOT NULL CHECK (length(local_date) = 10),
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'timeout', 'skipped', 'standby')),
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  exit_code INTEGER,
  log_path TEXT CHECK (log_path IS NULL OR length(log_path) <= 300)
) STRICT;
CREATE INDEX idx_job_run_status ON job_run (status, heartbeat_at);
CREATE INDEX idx_job_run_job ON job_run (job, started_at);

-- +down
DROP INDEX idx_job_run_job;
DROP INDEX idx_job_run_status;
DROP TABLE job_run;
