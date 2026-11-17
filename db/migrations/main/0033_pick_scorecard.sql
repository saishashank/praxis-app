-- +up
-- D-1060 (Owner O-84, 2026-11-16): "Replay the last 40 sessions night by night" as a REPORT. One run
-- table (write-once) and one day table (write-once) hold the scorecard; nothing reads them but the
-- Track record page. The run is logged once in the trial ledger as a report-only look: the ledger's
-- kind list gains `report_look`, which never counts toward a trial budget, a holdout use or the
-- challenger's disagreement nights (src/lib/stats/splits.ts trialCounts). SQLite cannot change a CHECK,
-- so trial_ledger is rebuilt (copied aside, dropped, created, copied back) with its rows, index and
-- append-only triggers.
CREATE TABLE trial_ledger_keep AS SELECT * FROM trial_ledger;
DROP TABLE trial_ledger;
CREATE TABLE trial_ledger (
  id TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  split_version INTEGER NOT NULL CHECK (split_version >= 0),
  kind TEXT NOT NULL CHECK (kind IN
    ('validation_access','holdout_access','pattern_test','challenger','new_lineage','report_look')),
  rule_version TEXT,
  variant TEXT,
  run_id TEXT,
  d TEXT NOT NULL
) STRICT, WITHOUT ROWID;
INSERT INTO trial_ledger (id, market, lineage_id, split_version, kind, rule_version, variant, run_id, d)
  SELECT id, market, lineage_id, split_version, kind, rule_version, variant, run_id, d FROM trial_ledger_keep;
DROP TABLE trial_ledger_keep;
CREATE INDEX idx_trial_ledger_lineage ON trial_ledger (lineage_id, split_version, kind);
CREATE TRIGGER trial_ledger_no_update BEFORE UPDATE ON trial_ledger
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER trial_ledger_no_delete BEFORE DELETE ON trial_ledger
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TABLE pick_scorecard_run (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  market TEXT NOT NULL CHECK (length(market) > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) > 0),
  sessions INTEGER NOT NULL CHECK (sessions BETWEEN 1 AND 60),
  first_d TEXT NOT NULL CHECK (first_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  last_d TEXT NOT NULL CHECK (last_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('complete','partial')),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_pick_scorecard_run_market ON pick_scorecard_run (market, created_at);
CREATE TRIGGER pick_scorecard_run_no_update BEFORE UPDATE ON pick_scorecard_run
BEGIN
  SELECT RAISE(ABORT, 'write-once');
END;
CREATE TRIGGER pick_scorecard_run_no_delete BEFORE DELETE ON pick_scorecard_run
BEGIN
  SELECT RAISE(ABORT, 'write-once');
END;

CREATE TABLE pick_scorecard_day (
  run_id TEXT NOT NULL CHECK (length(run_id) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  next_d TEXT NOT NULL CHECK (next_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  picks_n INTEGER NOT NULL CHECK (picks_n >= 0),
  gainers_n INTEGER NOT NULL CHECK (gainers_n BETWEEN 0 AND 5),
  gainer_hits INTEGER NOT NULL CHECK (gainer_hits BETWEEN 0 AND 5),
  losers_n INTEGER NOT NULL CHECK (losers_n BETWEEN 0 AND 5),
  loser_hits INTEGER NOT NULL CHECK (loser_hits BETWEEN 0 AND 5),
  liquid_n INTEGER NOT NULL CHECK (liquid_n >= 0),
  named_n INTEGER NOT NULL CHECK (named_n >= 0),
  chance_ppm INTEGER NOT NULL CHECK (chance_ppm BETWEEN 0 AND 5000000),
  cortex_scored INTEGER NOT NULL CHECK (cortex_scored >= 0),
  cortex_gainers_in_top INTEGER CHECK (cortex_gainers_in_top IS NULL OR cortex_gainers_in_top BETWEEN 0 AND 5),
  cortex_losers_in_bottom INTEGER CHECK (cortex_losers_in_bottom IS NULL OR cortex_losers_in_bottom BETWEEN 0 AND 5),
  cortex_gap_ppm INTEGER,
  profiles_json TEXT NOT NULL CHECK (json_valid(profiles_json)),
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  PRIMARY KEY (run_id, d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER pick_scorecard_day_no_update BEFORE UPDATE ON pick_scorecard_day
BEGIN
  SELECT RAISE(ABORT, 'write-once');
END;
CREATE TRIGGER pick_scorecard_day_no_delete BEFORE DELETE ON pick_scorecard_day
BEGIN
  SELECT RAISE(ABORT, 'write-once');
END;

-- +down
-- Reverse order of creation. The report-only look rows go with the report; the older ledger shape
-- comes back with every other row (copied, not deleted, so the append-only triggers stay out of it).
DROP TABLE pick_scorecard_day;
DROP TABLE pick_scorecard_run;
CREATE TABLE trial_ledger_keep AS SELECT * FROM trial_ledger WHERE kind <> 'report_look';
DROP TABLE trial_ledger;
CREATE TABLE trial_ledger (
  id TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  split_version INTEGER NOT NULL CHECK (split_version >= 0),
  kind TEXT NOT NULL CHECK (kind IN
    ('validation_access','holdout_access','pattern_test','challenger','new_lineage')),
  rule_version TEXT,
  variant TEXT,
  run_id TEXT,
  d TEXT NOT NULL
) STRICT, WITHOUT ROWID;
INSERT INTO trial_ledger (id, market, lineage_id, split_version, kind, rule_version, variant, run_id, d)
  SELECT id, market, lineage_id, split_version, kind, rule_version, variant, run_id, d FROM trial_ledger_keep;
DROP TABLE trial_ledger_keep;
CREATE INDEX idx_trial_ledger_lineage ON trial_ledger (lineage_id, split_version, kind);
CREATE TRIGGER trial_ledger_no_update BEFORE UPDATE ON trial_ledger
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER trial_ledger_no_delete BEFORE DELETE ON trial_ledger
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
