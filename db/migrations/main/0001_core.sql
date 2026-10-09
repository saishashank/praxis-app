-- +up
-- Replay-protection nonces (SEC-017). Moved here from lazy creation (D-029); IF NOT EXISTS keeps
-- existing deployments working.
CREATE TABLE IF NOT EXISTS request_nonce (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_nonce_expires_at ON request_nonce (expires_at);

-- Run records (PLT-017, DAT-141). Retention 180 days (DAT-142).
CREATE TABLE run_record (
  id INTEGER PRIMARY KEY,
  job TEXT NOT NULL,
  market TEXT,
  concurrency_key TEXT NOT NULL,
  scheduled_for TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','success','failed','skipped','degraded')),
  items_processed INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  llm_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error_summary TEXT,
  details_json TEXT,
  commit_sha TEXT
);
CREATE INDEX idx_run_record_job_started ON run_record (job, started_at DESC);
-- PLT-076: at most one success per concurrency key.
CREATE UNIQUE INDEX uq_run_record_success_key ON run_record (concurrency_key) WHERE status = 'success';

-- Configuration versions (ch.15). Append-only.
CREATE TABLE config_version (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  value_json TEXT NOT NULL,
  previous_json TEXT,
  changed_by_user_id INTEGER,
  changed_at TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX idx_config_version_key_scope ON config_version (key, scope, id DESC);
CREATE TRIGGER config_version_no_update BEFORE UPDATE ON config_version
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER config_version_no_delete BEFORE DELETE ON config_version
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Application log (PLT-060). Retention 30 days.
CREATE TABLE app_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  run_id INTEGER
);
CREATE INDEX idx_app_log_at ON app_log (at);

-- +down
DROP TABLE app_log;
DROP TRIGGER config_version_no_delete;
DROP TRIGGER config_version_no_update;
DROP TABLE config_version;
DROP TABLE run_record;
-- request_nonce is left in place: it may pre-exist this migration (lazy creation, D-029) and
-- dropping it would break signed-call replay protection.
