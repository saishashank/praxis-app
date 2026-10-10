-- +up
-- AU data layer (M2, docs/M2_design.md section 2, D-057). Timestamps are ISO-8601 UTC text with
-- milliseconds and Z (D-031); `d` is the Sydney local trading date YYYY-MM-DD; booleans are 0/1
-- with CHECK. Writers use INSERT ... ON CONFLICT DO NOTHING so a re-run never duplicates (DAT-003).
-- Do NOT use INSERT OR REPLACE / REPLACE INTO on a protected table: REPLACE deletes the old row
-- without firing delete triggers (recursive triggers are off); price_bar has a BEFORE INSERT guard
-- that turns a duplicate key into a no-op, the other append-only tables rely on the writer.
--
-- Pruning rule (DAT-142): a retention-pruned table allows DELETE only for rows older than its
-- retention floor, evaluated by the trigger itself against the current clock:
--   price_bar, bar_refetch  d < today - 730 days   (500 sessions is about 724 days, so the floor
--                                                   is never below the retention)
--   announcement            published_at < now - 400 days  (news class)
--   data_quality_flag       raised_at < now - 180 days AND blocks_entries = 0 (D-057 #5)
-- Everything else tagged "forever" refuses DELETE outright. The maintenance wiring is a later task.

-- Markets (config only: updatable, never deleted).
CREATE TABLE market (
  code TEXT PRIMARY KEY,
  tz TEXT NOT NULL,
  open_time TEXT NOT NULL,
  close_time TEXT NOT NULL,
  cutoff_time TEXT NOT NULL,
  currency TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off','data_only','full'))
);
-- AU: ASX session 10:00..16:00 Sydney local, decision cut-off 18:10 (DAT-001). `mode` mirrors the
-- market_mode config key (D-057 #3); the config key is the authority at run time.
INSERT INTO market (code, tz, open_time, close_time, cutoff_time, currency, mode)
VALUES ('AU', 'Australia/Sydney', '10:00', '16:00', '18:10', 'AUD', 'data_only');
CREATE TRIGGER market_no_delete BEFORE DELETE ON market
BEGIN
  SELECT RAISE(ABORT, 'market rows are never deleted');
END;

-- Trading calendar (DAT-160): insert; `confirmed` may go 0 -> 1 once (the Owner's confirmation).
CREATE TABLE trading_calendar (
  market TEXT NOT NULL,
  d TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('session','holiday','early_close')),
  close_time TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0,1)),
  source TEXT NOT NULL,
  PRIMARY KEY (market, d)
) WITHOUT ROWID;
CREATE TRIGGER trading_calendar_guard_update BEFORE UPDATE ON trading_calendar
WHEN NOT (OLD.confirmed = 0 AND NEW.confirmed = 1
  AND NEW.market IS OLD.market AND NEW.d IS OLD.d AND NEW.kind IS OLD.kind
  AND NEW.close_time IS OLD.close_time AND NEW.source IS OLD.source)
BEGIN
  SELECT RAISE(ABORT, 'only confirmed 0 to 1 may change');
END;
CREATE TRIGGER trading_calendar_no_delete BEFORE DELETE ON trading_calendar
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- Instruments (forever; delisted rows are kept, DAT-130). Status fields only may change.
CREATE TABLE instrument (
  id INTEGER PRIMARY KEY,
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  listed_on TEXT,
  delisted_on TEXT,
  delist_reason TEXT,
  last_price REAL,
  last_price_d TEXT,
  UNIQUE (market, code)
);
CREATE INDEX idx_instrument_delisted ON instrument (market, delisted_on);
CREATE TRIGGER instrument_guard_update BEFORE UPDATE ON instrument
WHEN NEW.id IS NOT OLD.id OR NEW.market IS NOT OLD.market OR NEW.code IS NOT OLD.code
BEGIN
  SELECT RAISE(ABORT, 'identity columns are immutable');
END;
CREATE TRIGGER instrument_no_delete BEFORE DELETE ON instrument
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- Daily universe snapshot (DAT-130): append-only, forever.
CREATE TABLE universe_snapshot (
  market TEXT NOT NULL,
  d TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('U1','U2','U3')),
  mcap_est REAL,
  adv REAL,
  halted INTEGER NOT NULL DEFAULT 0 CHECK (halted IN (0,1)),
  PRIMARY KEY (market, d, code)
) WITHOUT ROWID;
CREATE TRIGGER universe_snapshot_no_update BEFORE UPDATE ON universe_snapshot
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER universe_snapshot_no_delete BEFORE DELETE ON universe_snapshot
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Raw EOD bars, first-seen immutable (DAT-001, DAT-002). Prices are stored raw (no value CHECK:
-- a bad bar is stored and flagged, not dropped). 500 sessions in Turso (DAT-142).
CREATE TABLE price_bar (
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  d TEXT NOT NULL,
  o REAL NOT NULL,
  h REAL NOT NULL,
  l REAL NOT NULL,
  c REAL NOT NULL,
  volume INTEGER NOT NULL,
  source TEXT NOT NULL,
  published_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (market, code, d)
) WITHOUT ROWID;
CREATE INDEX idx_price_bar_market_d ON price_bar (market, d);
CREATE TRIGGER price_bar_first_seen BEFORE INSERT ON price_bar
WHEN EXISTS (SELECT 1 FROM price_bar WHERE market = NEW.market AND code = NEW.code AND d = NEW.d)
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER price_bar_no_update BEFORE UPDATE ON price_bar
BEGIN
  SELECT RAISE(ABORT, 'immutable');
END;
CREATE TRIGGER price_bar_prune_only BEFORE DELETE ON price_bar
WHEN OLD.d >= date('now', '-730 days')
BEGIN
  SELECT RAISE(ABORT, 'immutable (delete only beyond retention)');
END;

-- Re-fetches that differ from the stored bar (D-057 #4). Append-only; lives and dies with its bar.
-- The nightly hash per session is kept in ingest_cursor (job 'refetch_hash'), not here.
CREATE TABLE bar_refetch (
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  d TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  ohlcv_json TEXT NOT NULL,
  max_diff_pct REAL NOT NULL,
  PRIMARY KEY (market, code, d, fetched_at)
) WITHOUT ROWID;
CREATE TRIGGER bar_refetch_no_update BEFORE UPDATE ON bar_refetch
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER bar_refetch_prune_only BEFORE DELETE ON bar_refetch
WHEN OLD.d >= date('now', '-730 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- Corporate actions (DAT-220). Payload and evidence are JSON. Append-only, forever.
CREATE TABLE corporate_action (
  id INTEGER PRIMARY KEY,
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  type TEXT NOT NULL,
  ex_date TEXT NOT NULL,
  record_date TEXT,
  payload_json TEXT NOT NULL,
  evidence_json TEXT
);
CREATE INDEX idx_corporate_action_code ON corporate_action (market, code, ex_date);
CREATE TRIGGER corporate_action_no_update BEFORE UPDATE ON corporate_action
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER corporate_action_no_delete BEFORE DELETE ON corporate_action
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Status history of an action (no UPDATE; the newest row is the current status).
CREATE TABLE corporate_action_event (
  id INTEGER PRIMARY KEY,
  action_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('auto_confirmed','queued','applied_best_evidence','resolved')),
  by TEXT NOT NULL,
  note TEXT
);
CREATE INDEX idx_corporate_action_event_action ON corporate_action_event (action_id);
CREATE TRIGGER corporate_action_event_no_update BEFORE UPDATE ON corporate_action_event
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER corporate_action_event_no_delete BEFORE DELETE ON corporate_action_event
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Adjustment factors derived only from recorded actions (DAT-002); a recompute adds rows (DAT-222),
-- so computed_at is part of the key (the design key plus computed_at).
CREATE TABLE adjustment_factor (
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  ex_date TEXT NOT NULL,
  factor REAL NOT NULL,
  corporate_action_id INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (market, code, ex_date, corporate_action_id, computed_at)
) WITHOUT ROWID;
CREATE TRIGGER adjustment_factor_no_update BEFORE UPDATE ON adjustment_factor
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER adjustment_factor_no_delete BEFORE DELETE ON adjustment_factor
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Announcements (DAT-001 columns source / published_at / ingested_at). News class: 400 days.
CREATE TABLE announcement (
  id INTEGER PRIMARY KEY,
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  ann_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  type TEXT,
  price_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (price_sensitive IN (0,1)),
  title TEXT NOT NULL,
  url TEXT,
  source TEXT NOT NULL,
  UNIQUE (source, ann_id)
);
CREATE INDEX idx_announcement_code ON announcement (market, code, published_at);
CREATE INDEX idx_announcement_published ON announcement (published_at);
CREATE TRIGGER announcement_no_update BEFORE UPDATE ON announcement
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER announcement_prune_only BEFORE DELETE ON announcement
WHEN OLD.published_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-400 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- Source register (DAT-120): updatable, every insert and change is logged in the history table.
CREATE TABLE source_register (
  source TEXT PRIMARY KEY,
  terms_url TEXT,
  permitted_use TEXT,
  rate_limits TEXT,
  last_checked TEXT,
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  status TEXT NOT NULL CHECK (status IN ('pending','enabled','disabled')),
  owner_ref TEXT,
  summarisation_permitted INTEGER NOT NULL DEFAULT 0 CHECK (summarisation_permitted IN (0,1))
);
CREATE TABLE source_register_history (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('insert','update')),
  terms_url TEXT,
  permitted_use TEXT,
  rate_limits TEXT,
  last_checked TEXT,
  risk TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_ref TEXT,
  summarisation_permitted INTEGER NOT NULL
);
CREATE INDEX idx_source_register_history_source ON source_register_history (source, id);
CREATE TRIGGER source_register_log_insert AFTER INSERT ON source_register
BEGIN
  INSERT INTO source_register_history (source, changed_at, op, terms_url, permitted_use, rate_limits,
    last_checked, risk, status, owner_ref, summarisation_permitted)
  VALUES (NEW.source, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'insert', NEW.terms_url,
    NEW.permitted_use, NEW.rate_limits, NEW.last_checked, NEW.risk, NEW.status, NEW.owner_ref,
    NEW.summarisation_permitted);
END;
CREATE TRIGGER source_register_log_update AFTER UPDATE ON source_register
BEGIN
  INSERT INTO source_register_history (source, changed_at, op, terms_url, permitted_use, rate_limits,
    last_checked, risk, status, owner_ref, summarisation_permitted)
  VALUES (NEW.source, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'update', NEW.terms_url,
    NEW.permitted_use, NEW.rate_limits, NEW.last_checked, NEW.risk, NEW.status, NEW.owner_ref,
    NEW.summarisation_permitted);
END;
CREATE TRIGGER source_register_no_delete BEFORE DELETE ON source_register
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;
CREATE TRIGGER source_register_history_no_update BEFORE UPDATE ON source_register_history
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER source_register_history_no_delete BEFORE DELETE ON source_register_history
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Source kill switch state (DAT-123). A change must raise an audit event / incident in the app.
CREATE TABLE source_status (
  source TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('on','off','tripped')),
  since TEXT NOT NULL,
  reason TEXT,
  tripped_by TEXT
);
CREATE TRIGGER source_status_no_delete BEFORE DELETE ON source_status
BEGIN
  SELECT RAISE(ABORT, 'state rows are never deleted');
END;

-- Seeds: one register row and one status row per AU source. ASX (O-23) and Yahoo (O-26) stay
-- 'pending' until the Owner records the risk acceptance (DAT-120). No terms URL or check date is
-- invented here (the source evaluation fills them). Status rows start 'on'. The register inserts
-- also write their 'insert' history rows through the trigger.
INSERT INTO source_register (source, permitted_use, risk, status, owner_ref, summarisation_permitted)
VALUES
  ('asx_announcements', 'personal use only (DAT-124)', 'high', 'pending', 'O-23', 0),
  ('yahoo_eod', 'personal use only (DAT-124)', 'high', 'pending', 'O-26', 0),
  ('rba', 'public data', 'low', 'enabled', NULL, 1),
  ('abs', 'public data', 'low', 'enabled', NULL, 1),
  ('asic_short', 'public data', 'low', 'enabled', NULL, 1);
INSERT INTO source_status (source, mode, since)
VALUES
  ('asx_announcements', 'on', '2026-10-11T00:00:00.000Z'),
  ('yahoo_eod', 'on', '2026-10-11T00:00:00.000Z'),
  ('rba', 'on', '2026-10-11T00:00:00.000Z'),
  ('abs', 'on', '2026-10-11T00:00:00.000Z'),
  ('asic_short', 'on', '2026-10-11T00:00:00.000Z');

-- Quality flags (DAT-200..211). Append; `cleared_at` may go NULL -> value once, nothing else
-- changes (D-057 #6). Flags older than 180 days are pruned unless they blocked entries (#5).
CREATE TABLE data_quality_flag (
  id INTEGER PRIMARY KEY,
  market TEXT NOT NULL,
  code TEXT,
  d TEXT NOT NULL,
  check_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  detail_json TEXT,
  raised_at TEXT NOT NULL,
  cleared_at TEXT,
  blocks_entries INTEGER NOT NULL DEFAULT 0 CHECK (blocks_entries IN (0,1))
);
CREATE INDEX idx_dqf_market_d ON data_quality_flag (market, d);
CREATE INDEX idx_dqf_code_d ON data_quality_flag (market, code, d);
CREATE INDEX idx_dqf_open ON data_quality_flag (market, d, code) WHERE cleared_at IS NULL;
CREATE TRIGGER data_quality_flag_guard_update BEFORE UPDATE ON data_quality_flag
WHEN NOT (OLD.cleared_at IS NULL AND NEW.cleared_at IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.market IS OLD.market AND NEW.code IS OLD.code AND NEW.d IS OLD.d
  AND NEW.check_id IS OLD.check_id AND NEW.severity IS OLD.severity
  AND NEW.detail_json IS OLD.detail_json AND NEW.raised_at IS OLD.raised_at
  AND NEW.blocks_entries IS OLD.blocks_entries)
BEGIN
  SELECT RAISE(ABORT, 'only cleared_at NULL to value may change');
END;
CREATE TRIGGER data_quality_flag_prune_only BEFORE DELETE ON data_quality_flag
WHEN OLD.blocks_entries = 1 OR OLD.raised_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-180 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only unblocking flags beyond retention)');
END;

-- Daily quality score, 3 rows per day (U1/U2/U3). Append-only, forever.
CREATE TABLE quality_score (
  market TEXT NOT NULL,
  d TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('U1','U2','U3')),
  valid INTEGER NOT NULL,
  expected INTEGER NOT NULL,
  score REAL NOT NULL,
  gate_pass INTEGER NOT NULL CHECK (gate_pass IN (0,1)),
  PRIMARY KEY (market, d, tier)
) WITHOUT ROWID;
CREATE TRIGGER quality_score_no_update BEFORE UPDATE ON quality_score
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER quality_score_no_delete BEFORE DELETE ON quality_score
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Pipeline state (updatable): cursors, worker keys, backfill jobs, the single ASX rate token row.
CREATE TABLE ingest_cursor (
  job TEXT NOT NULL,
  market TEXT NOT NULL,
  source TEXT NOT NULL,
  cursor_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job, market, source)
) WITHOUT ROWID;

-- Insert once per (market, d, kind): UPDATE and DELETE are refused. Forever.
CREATE TABLE completion_marker (
  market TEXT NOT NULL,
  d TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('data','non-trading','late_sweep')),
  at TEXT NOT NULL,
  run_id INTEGER,
  outcome TEXT NOT NULL,
  PRIMARY KEY (market, d, kind)
) WITHOUT ROWID;
CREATE TRIGGER completion_marker_no_update BEFORE UPDATE ON completion_marker
BEGIN
  SELECT RAISE(ABORT, 'insert once');
END;
CREATE TRIGGER completion_marker_no_delete BEFORE DELETE ON completion_marker
BEGIN
  SELECT RAISE(ABORT, 'insert once');
END;

-- ASX rate token (DAT-122): exactly one row, updated by compare-and-set on last_request_at.
-- Backed up like any other table (the row is state, not ephemeral).
CREATE TABLE asx_rate_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_request_at TEXT,
  day_count_date TEXT,
  day_count INTEGER NOT NULL DEFAULT 0
);
INSERT INTO asx_rate_token (id, last_request_at, day_count_date, day_count) VALUES (1, NULL, NULL, 0);
CREATE TRIGGER asx_rate_token_no_delete BEFORE DELETE ON asx_rate_token
BEGIN
  SELECT RAISE(ABORT, 'single row');
END;

CREATE TABLE worker_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE backfill_job (
  name TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  next_date TEXT,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  rows_written_month INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- +down
DROP TABLE backfill_job;
DROP TABLE worker_state;
DROP TRIGGER asx_rate_token_no_delete;
DROP TABLE asx_rate_token;
DROP TRIGGER completion_marker_no_delete;
DROP TRIGGER completion_marker_no_update;
DROP TABLE completion_marker;
DROP TABLE ingest_cursor;
DROP TRIGGER quality_score_no_delete;
DROP TRIGGER quality_score_no_update;
DROP TABLE quality_score;
DROP TRIGGER data_quality_flag_prune_only;
DROP TRIGGER data_quality_flag_guard_update;
DROP TABLE data_quality_flag;
DROP TRIGGER source_status_no_delete;
DROP TABLE source_status;
DROP TRIGGER source_register_history_no_delete;
DROP TRIGGER source_register_history_no_update;
DROP TRIGGER source_register_no_delete;
DROP TRIGGER source_register_log_update;
DROP TRIGGER source_register_log_insert;
DROP TABLE source_register_history;
DROP TABLE source_register;
DROP TRIGGER announcement_prune_only;
DROP TRIGGER announcement_no_update;
DROP TABLE announcement;
DROP TRIGGER adjustment_factor_no_delete;
DROP TRIGGER adjustment_factor_no_update;
DROP TABLE adjustment_factor;
DROP TRIGGER corporate_action_event_no_delete;
DROP TRIGGER corporate_action_event_no_update;
DROP TABLE corporate_action_event;
DROP TRIGGER corporate_action_no_delete;
DROP TRIGGER corporate_action_no_update;
DROP TABLE corporate_action;
DROP TRIGGER bar_refetch_prune_only;
DROP TRIGGER bar_refetch_no_update;
DROP TABLE bar_refetch;
DROP TRIGGER price_bar_prune_only;
DROP TRIGGER price_bar_no_update;
DROP TRIGGER price_bar_first_seen;
DROP TABLE price_bar;
DROP TRIGGER universe_snapshot_no_delete;
DROP TRIGGER universe_snapshot_no_update;
DROP TABLE universe_snapshot;
DROP TRIGGER instrument_no_delete;
DROP TRIGGER instrument_guard_update;
DROP TABLE instrument;
DROP TRIGGER trading_calendar_no_delete;
DROP TRIGGER trading_calendar_guard_update;
DROP TABLE trading_calendar;
DROP TRIGGER market_no_delete;
DROP TABLE market;
