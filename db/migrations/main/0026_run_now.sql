-- +up
-- Run now (D-840..D-849): the Owner asks for a scheduled job to run at once instead of waiting for its
-- time. One generic row per request: `job_id` is an id of the job registry (src/lib/jobs/registry.mjs),
-- `params_json` holds the job's own parameters (validated per job by the registry, e.g. {"d":"2026-11-02"}),
-- so a future job needs no new column. The Worker reads `pending` rows on its per-minute tick, runs each
-- through the same dispatch path the slot uses on schedule, and moves the row forward:
--   pending -> dispatched -> done | refused | expired   (or pending -> refused | expired).
-- The status only ever moves forward and the request itself never changes (trigger). Rows are never
-- deleted inside the 90-day floor; older rows may be pruned.
CREATE TABLE run_now_request (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL CHECK (length(job_id) BETWEEN 1 AND 64 AND job_id NOT GLOB '*[^a-z0-9-]*'),
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  params_json TEXT NOT NULL CHECK (json_valid(params_json) AND length(params_json) <= 500),
  requested_by_hmac TEXT NOT NULL CHECK (length(requested_by_hmac) = 64),
  requested_at TEXT NOT NULL,
  audit_ref TEXT NOT NULL CHECK (length(audit_ref) <= 40),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dispatched', 'done', 'refused', 'expired')),
  result TEXT CHECK (result IS NULL OR length(result) <= 200),
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_run_now_request_status ON run_now_request (status, requested_at);
CREATE INDEX idx_run_now_request_job ON run_now_request (job_id, requested_at);
CREATE TRIGGER run_now_request_forward BEFORE UPDATE ON run_now_request
WHEN NEW.id <> OLD.id
  OR NEW.job_id <> OLD.job_id
  OR NEW.market <> OLD.market
  OR NEW.params_json <> OLD.params_json
  OR NEW.requested_by_hmac <> OLD.requested_by_hmac
  OR NEW.requested_at <> OLD.requested_at
  OR NEW.audit_ref <> OLD.audit_ref
  OR (CASE NEW.status WHEN 'pending' THEN 0 WHEN 'dispatched' THEN 1 ELSE 2 END)
     <= (CASE OLD.status WHEN 'pending' THEN 0 WHEN 'dispatched' THEN 1 ELSE 2 END)
BEGIN
  SELECT RAISE(ABORT, 'run_now_request: the status only moves forward');
END;
CREATE TRIGGER run_now_request_no_delete BEFORE DELETE ON run_now_request
WHEN OLD.requested_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- +down
DROP TRIGGER run_now_request_no_delete;
DROP TRIGGER run_now_request_forward;
DROP INDEX idx_run_now_request_job;
DROP INDEX idx_run_now_request_status;
DROP TABLE run_now_request;
