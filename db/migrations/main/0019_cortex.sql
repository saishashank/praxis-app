-- +up
-- M15 (P1, D-257..D-306): the Cortex tables. Additive only: new tables, one nullable column on
-- arena_order, one register row. No table rebuild and no change to an existing CHECK, so the v1
-- history replays byte-identically (same rule as 0016/0018). Every table is STRICT, WITHOUT ROWID
-- and append-only (UPDATE and DELETE abort) except the two once-only result columns noted below.
-- Dates are session dates (GLOB), JSON columns are json_valid, money is integer micro-dollars,
-- times are ISO UTC text. Numbers in these tables come from the private import (D-267); this file
-- holds structure only.

-- 1. Angle passports (CTX-030, D-304): one row per (angle, version); a status change is a new version.
CREATE TABLE angle_passport (
  market TEXT NOT NULL CHECK (length(market) > 0),
  angle_id TEXT NOT NULL CHECK (length(angle_id) > 0),
  version INTEGER NOT NULL CHECK (version >= 1),
  domain INTEGER NOT NULL CHECK (domain BETWEEN 1 AND 10),
  cluster TEXT NOT NULL CHECK (cluster IN
    ('momentum','low_volatility','liquidity','event','quality','sentiment','regime','risk','calendar','meta')),
  orientation INTEGER NOT NULL CHECK (orientation IN (1,-1)),
  kind TEXT NOT NULL CHECK (kind IN ('score','gate','meta')),
  inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),
  history_fields_json TEXT NOT NULL CHECK (json_valid(history_fields_json)),
  status TEXT NOT NULL CHECK (status IN ('candidate','measured','active','watch','retired')),
  horizon_sessions INTEGER NOT NULL CHECK (horizon_sessions > 0),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  measured_json TEXT CHECK (measured_json IS NULL OR json_valid(measured_json)),
  frozen_at TEXT NOT NULL CHECK (length(frozen_at) > 0),
  PRIMARY KEY (market, angle_id, version)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER angle_passport_no_update BEFORE UPDATE ON angle_passport
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER angle_passport_no_delete BEFORE DELETE ON angle_passport
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 2. Nightly features (CTX-050, D-293): ONE row per code per night; features_json = {angle_id: value|null}
-- for the active set only, flags_json = {angle_id: flag}. The PK starts (market, d), so a night scan
-- needs no extra index.
CREATE TABLE cortex_feature_daily (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  code TEXT NOT NULL CHECK (length(code) > 0),
  features_json TEXT NOT NULL CHECK (json_valid(features_json)),
  flags_json TEXT NOT NULL CHECK (json_valid(flags_json)),
  active_set_hash TEXT NOT NULL CHECK (length(active_set_hash) > 0),
  manifest_id TEXT NOT NULL CHECK (length(manifest_id) > 0),
  PRIMARY KEY (market, d, code)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cortex_feature_daily_no_update BEFORE UPDATE ON cortex_feature_daily
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cortex_feature_daily_no_delete BEFORE DELETE ON cortex_feature_daily
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 3. Ledger cells (CTX-031, CTX-034): logged BEFORE the result (CHECK), and the result goes in ONCE:
-- result_at / result_json may go from NULL to a value together, nothing else on the row may change
-- (the pattern of corporate_action.known_at in 0016). Activation trials are charged to trial_ledger
-- with kind 'challenger' and a 'cortex:' rule_version (its kind CHECK cannot change); the per-cell
-- log is this table. family 'all' marks a cell that is not about one family (an Owner key edit).
CREATE TABLE cortex_ledger_cell (
  cell_id TEXT PRIMARY KEY CHECK (length(cell_id) > 0),
  market TEXT NOT NULL CHECK (length(market) > 0),
  family TEXT NOT NULL CHECK (family IN ('F1','F2','F3','F4','F5','F6','F7','all')),
  angle_id TEXT CHECK (angle_id IS NULL OR length(angle_id) > 0),
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json)),
  logged_at TEXT NOT NULL CHECK (length(logged_at) > 0),
  result_at TEXT CHECK (result_at IS NULL OR length(result_at) > 0),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  split TEXT NOT NULL CHECK (split IN ('development','validation')),
  lineage_id TEXT CHECK (lineage_id IS NULL OR length(lineage_id) > 0),
  CHECK (result_at IS NULL OR logged_at < result_at),
  CHECK ((result_at IS NULL) = (result_json IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_cortex_ledger_cell_family ON cortex_ledger_cell (market, family, kind);
CREATE TRIGGER cortex_ledger_cell_guard_update BEFORE UPDATE ON cortex_ledger_cell
WHEN NOT (OLD.result_at IS NULL AND NEW.result_at IS NOT NULL
  AND NEW.cell_id IS OLD.cell_id AND NEW.market IS OLD.market AND NEW.family IS OLD.family
  AND NEW.angle_id IS OLD.angle_id AND NEW.kind IS OLD.kind AND NEW.spec_json IS OLD.spec_json
  AND NEW.logged_at IS OLD.logged_at AND NEW.split IS OLD.split AND NEW.lineage_id IS OLD.lineage_id)
BEGIN
  SELECT RAISE(ABORT, 'cortex_ledger_cell: the result may be set once, from NULL; nothing else may change');
END;
CREATE TRIGGER cortex_ledger_cell_no_delete BEFORE DELETE ON cortex_ledger_cell
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 4. Calibration maps (CTX-012, D-281): the latest fitted_at per (family, rule_version) wins.
CREATE TABLE cortex_map (
  market TEXT NOT NULL CHECK (length(market) > 0),
  family TEXT NOT NULL CHECK (family IN ('F1','F2','F3','F4','F5','F6','F7')),
  rule_version TEXT NOT NULL CHECK (length(rule_version) > 0),
  fitted_at TEXT NOT NULL CHECK (length(fitted_at) > 0),
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  active_set_hash TEXT NOT NULL CHECK (length(active_set_hash) > 0),
  n_eff REAL NOT NULL CHECK (n_eff >= 0),
  pool TEXT NOT NULL CHECK (length(pool) > 0),
  fit_split TEXT NOT NULL CHECK (length(fit_split) > 0),
  PRIMARY KEY (market, family, rule_version, fitted_at)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cortex_map_no_update BEFORE UPDATE ON cortex_map
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cortex_map_no_delete BEFORE DELETE ON cortex_map
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 5. Night record (CTX-010, CTX-050, D-289): one row per night, including the abstain-all nights.
CREATE TABLE cortex_night (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('ran','abstain_all')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('late_bar','quota','map_missing','universe_incomplete')),
  manifest_id TEXT NOT NULL CHECK (length(manifest_id) > 0),
  universe_n INTEGER NOT NULL CHECK (universe_n >= 0),
  bars_n INTEGER NOT NULL CHECK (bars_n >= 0),
  feature_rows INTEGER NOT NULL CHECK (feature_rows >= 0),
  runtime_ms INTEGER NOT NULL CHECK (runtime_ms >= 0),
  active_set_hash TEXT NOT NULL CHECK (length(active_set_hash) > 0),
  map_fitted_at TEXT CHECK (map_fitted_at IS NULL OR length(map_fitted_at) > 0),
  PRIMARY KEY (market, d),
  CHECK ((status = 'abstain_all') = (reason IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cortex_night_no_update BEFORE UPDATE ON cortex_night
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cortex_night_no_delete BEFORE DELETE ON cortex_night
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 6. Decisions (CTX-013, CTX-023): live arm, shadow arm and blocked candidates. A live-arm order also
-- has a signal row (decision_card_insert_guard needs one; signal.family stays F1..F6, so F7 never
-- reaches an order). book_id is the E cohort id.
CREATE TABLE cortex_decision (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  book_id TEXT NOT NULL CHECK (length(book_id) > 0),
  code TEXT NOT NULL CHECK (length(code) > 0),
  arm TEXT NOT NULL CHECK (arm IN ('live','shadow')),
  family TEXT NOT NULL CHECK (family IN ('F1','F2','F3','F4','F5','F6','F7')),
  s REAL,
  p REAL CHECK (p IS NULL OR (p >= 0 AND p <= 1)),
  expected_net_micro INTEGER,
  rank_key TEXT CHECK (rank_key IS NULL OR length(rank_key) > 0),
  limit_micro INTEGER CHECK (limit_micro IS NULL OR limit_micro > 0),
  stop_micro INTEGER CHECK (stop_micro IS NULL OR stop_micro > 0),
  qty INTEGER CHECK (qty IS NULL OR qty >= 0),
  gate_trace_json TEXT NOT NULL CHECK (json_valid(gate_trace_json)),
  first_fail_gate TEXT CHECK (first_fail_gate IS NULL OR length(first_fail_gate) > 0),
  signal_id TEXT CHECK (signal_id IS NULL OR length(signal_id) > 0),
  order_id TEXT CHECK (order_id IS NULL OR length(order_id) > 0),
  card_id TEXT CHECK (card_id IS NULL OR length(card_id) > 0),
  sector_tilt_json TEXT CHECK (sector_tilt_json IS NULL OR json_valid(sector_tilt_json)),
  manifest_id TEXT NOT NULL CHECK (length(manifest_id) > 0),
  PRIMARY KEY (market, d, book_id, code, arm),
  CHECK (arm = 'shadow' OR family <> 'F7')
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_cortex_decision_family ON cortex_decision (market, d, family, arm);
CREATE TRIGGER cortex_decision_no_update BEFORE UPDATE ON cortex_decision
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cortex_decision_no_delete BEFORE DELETE ON cortex_decision
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 7. Would-have outcomes (CTX-023, CTX-054): written by batch 3 when the hold closes, insert-or-ignore.
CREATE TABLE cortex_outcome (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  book_id TEXT NOT NULL CHECK (length(book_id) > 0),
  code TEXT NOT NULL CHECK (length(code) > 0),
  arm TEXT NOT NULL CHECK (arm IN ('live','shadow')),
  fill_status TEXT NOT NULL CHECK (fill_status IN ('filled','unfilled','cancelled')),
  fill_micro INTEGER CHECK (fill_micro IS NULL OR fill_micro > 0),
  fill_d TEXT CHECK (fill_d IS NULL OR fill_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  exit_d TEXT CHECK (exit_d IS NULL OR exit_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  exit_rule TEXT CHECK (exit_rule IS NULL OR length(exit_rule) > 0),
  gross_micro INTEGER,
  net_micro INTEGER,
  outcome_class TEXT CHECK (outcome_class IS NULL OR length(outcome_class) > 0),
  scored_at TEXT NOT NULL CHECK (length(scored_at) > 0),
  PRIMARY KEY (market, d, book_id, code, arm),
  CHECK (fill_status <> 'filled' OR (fill_micro IS NOT NULL AND fill_d IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cortex_outcome_no_update BEFORE UPDATE ON cortex_outcome
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cortex_outcome_no_delete BEFORE DELETE ON cortex_outcome
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 8. Abstains (CTX-013, CTX-055): one per cash-holding book per night; gate_id from the design 3b table.
CREATE TABLE cortex_abstain (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  book_id TEXT NOT NULL CHECK (length(book_id) > 0),
  gate_id TEXT NOT NULL CHECK (length(gate_id) > 0),
  label TEXT NOT NULL CHECK (length(label) > 0),
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  PRIMARY KEY (market, d, book_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cortex_abstain_no_update BEFORE UPDATE ON cortex_abstain
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cortex_abstain_no_delete BEFORE DELETE ON cortex_abstain
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 9. Family status (CTX-053, CTX-072): history rows, the latest since_d wins. An Owner kill can only
-- suspend: no leaving shadow by hand (CTX-072). F7 is shadow only (never an order).
CREATE TABLE family_status (
  market TEXT NOT NULL CHECK (length(market) > 0),
  family TEXT NOT NULL CHECK (family IN ('F1','F2','F3','F4','F5','F6','F7')),
  since_d TEXT NOT NULL CHECK (since_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('shadow','allowed','suspended')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  statement_id TEXT CHECK (statement_id IS NULL OR length(statement_id) > 0),
  set_by TEXT NOT NULL CHECK (set_by IN ('import','evaluator','owner_kill')),
  PRIMARY KEY (market, family, since_d),
  CHECK (set_by <> 'owner_kill' OR status = 'suspended'),
  CHECK (family <> 'F7' OR status <> 'allowed')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER family_status_no_update BEFORE UPDATE ON family_status
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER family_status_no_delete BEFORE DELETE ON family_status
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 10. State machines (CTX-015, CTX-016, CTX-044): one table for corporate action, halt and promotion
-- flag. A state ends with a new row whose state is 'none' (no to_d, so the table stays append-only).
CREATE TABLE cortex_state (
  market TEXT NOT NULL CHECK (length(market) > 0),
  code TEXT NOT NULL CHECK (length(code) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('corp_action','halt','promotion')),
  from_d TEXT NOT NULL CHECK (from_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  state TEXT NOT NULL CHECK (length(state) > 0),
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json)),
  source_ref TEXT CHECK (source_ref IS NULL OR length(source_ref) > 0),
  PRIMARY KEY (market, code, kind, from_d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cortex_state_no_update BEFORE UPDATE ON cortex_state
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cortex_state_no_delete BEFORE DELETE ON cortex_state
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 11. Input manifests (CTX-010, CTX-050): manifest_id = sha256 of the canonical JSON of the rest
-- (computed by the writer, not by SQL).
CREATE TABLE input_manifest (
  manifest_id TEXT PRIMARY KEY CHECK (length(manifest_id) > 0),
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  sources_json TEXT NOT NULL CHECK (json_valid(sources_json)),
  schema_sha TEXT NOT NULL CHECK (length(schema_sha) > 0),
  row_counts_json TEXT NOT NULL CHECK (json_valid(row_counts_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_input_manifest_d ON input_manifest (market, d);
CREATE TRIGGER input_manifest_no_update BEFORE UPDATE ON input_manifest
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER input_manifest_no_delete BEFORE DELETE ON input_manifest
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 12. Label validation (CTX-040): written in the same transaction as the label it validates.
CREATE TABLE label_validation (
  validation_id TEXT PRIMARY KEY CHECK (length(validation_id) > 0),
  market TEXT NOT NULL CHECK (length(market) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('paraphrase','ar_sign','golden','incremental')),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER label_validation_no_update BEFORE UPDATE ON label_validation
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER label_validation_no_delete BEFORE DELETE ON label_validation
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 13. Text labels (CTX-040, staging only by config): manifest_id and validation_id are NOT NULL, and
-- the validation row must exist (AT-50).
CREATE TABLE text_label (
  market TEXT NOT NULL CHECK (length(market) > 0),
  announcement_id TEXT NOT NULL CHECK (length(announcement_id) > 0),
  label_kind TEXT NOT NULL CHECK (label_kind IN ('guidance','event_confirm','tone')),
  model_id TEXT NOT NULL CHECK (length(model_id) > 0),
  produced_at TEXT NOT NULL CHECK (length(produced_at) > 0),
  value TEXT NOT NULL CHECK (length(value) > 0),
  cited_span TEXT CHECK (cited_span IS NULL OR length(cited_span) > 0),
  manifest_id TEXT NOT NULL CHECK (length(manifest_id) > 0),
  validation_id TEXT NOT NULL CHECK (length(validation_id) > 0),
  PRIMARY KEY (market, announcement_id, label_kind, model_id, produced_at)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER text_label_insert_guard BEFORE INSERT ON text_label
WHEN NOT EXISTS (SELECT 1 FROM label_validation v WHERE v.validation_id = NEW.validation_id)
BEGIN
  SELECT RAISE(ABORT, 'text_label: needs its label_validation row');
END;
CREATE TRIGGER text_label_no_update BEFORE UPDATE ON text_label
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER text_label_no_delete BEFORE DELETE ON text_label
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 14. Opinion tracking (CTX-041, hook only, D-270): batch 3 fills settled_d and outcome_json ONCE.
CREATE TABLE opinion_track (
  market TEXT NOT NULL CHECK (length(market) > 0),
  opinion_id TEXT NOT NULL CHECK (length(opinion_id) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('committee','steelman')),
  code TEXT NOT NULL CHECK (length(code) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  settled_d TEXT CHECK (settled_d IS NULL OR settled_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
  PRIMARY KEY (market, opinion_id),
  CHECK ((settled_d IS NULL) = (outcome_json IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER opinion_track_guard_update BEFORE UPDATE ON opinion_track
WHEN NOT (OLD.settled_d IS NULL AND NEW.settled_d IS NOT NULL
  AND NEW.market IS OLD.market AND NEW.opinion_id IS OLD.opinion_id AND NEW.kind IS OLD.kind
  AND NEW.code IS OLD.code AND NEW.d IS OLD.d AND NEW.value_json IS OLD.value_json)
BEGIN
  SELECT RAISE(ABORT, 'opinion_track: settlement may be set once, from NULL; nothing else may change');
END;
CREATE TRIGGER opinion_track_no_delete BEFORE DELETE ON opinion_track
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 15. Statements (CTX-053, CTX-072, CTX-082): the text comes from the statement templates only.
CREATE TABLE cortex_statement (
  statement_id TEXT PRIMARY KEY CHECK (length(statement_id) > 0),
  market TEXT NOT NULL CHECK (length(market) > 0),
  family TEXT NOT NULL CHECK (family IN ('F1','F2','F3','F4','F5','F6','F7')),
  kind TEXT NOT NULL CHECK (kind IN ('allowed_weak','live_tested')),
  text TEXT NOT NULL CHECK (length(text) > 0),
  numbers_json TEXT NOT NULL CHECK (json_valid(numbers_json)),
  n_eff_live REAL CHECK (n_eff_live IS NULL OR n_eff_live >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cortex_statement_no_update BEFORE UPDATE ON cortex_statement
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cortex_statement_no_delete BEFORE DELETE ON cortex_statement
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 16. Limit orders (CTX-028, D-288): NULL = a v1 order (fills at the open, F3 keeps max_open_micro);
-- set only for Cortex-governed orders. The immutability guard of 0007 is redefined with the new
-- column added to its list.
ALTER TABLE arena_order ADD COLUMN limit_micro INTEGER
  CHECK (limit_micro IS NULL OR limit_micro > 0);
DROP TRIGGER arena_order_guard_update;
CREATE TRIGGER arena_order_guard_update BEFORE UPDATE ON arena_order
WHEN NOT (OLD.status = 'pending' AND NEW.status <> 'pending'
  AND NEW.id IS OLD.id AND NEW.cohort_id IS OLD.cohort_id AND NEW.decided_d IS OLD.decided_d
  AND NEW.code IS OLD.code AND NEW.side IS OLD.side AND NEW.kind IS OLD.kind
  AND NEW.qty IS OLD.qty AND NEW.ref_stop_micro IS OLD.ref_stop_micro
  AND NEW.tier IS OLD.tier AND NEW.untradeable_flag IS OLD.untradeable_flag
  AND NEW.signal_id IS OLD.signal_id AND NEW.card_id IS OLD.card_id
  AND NEW.max_open_micro IS OLD.max_open_micro AND NEW.stop_spec IS OLD.stop_spec
  AND NEW.limit_micro IS OLD.limit_micro)
BEGIN
  SELECT RAISE(ABORT, 'order: only pending to one terminal status; other columns are immutable');
END;

-- 17. Licence register (DAT-101, D-291): FRED is recorded as pending; no fetcher exists. The US index
-- closes (^GSPC, ^VIX) ride the existing Yahoo row (D-290): no new source and no new terms. The
-- insert also writes its history row through the trigger from 0004.
INSERT INTO source_register (source, permitted_use, risk, status, owner_ref, summarisation_permitted)
VALUES
  ('fred', 'FRED series carry their own terms, checked per series before any use; no fetcher (DAT-101)', 'low', 'pending', NULL, 0);

-- +down
-- source_register and its history refuse DELETE: the guards are lifted for the statements below and
-- restored with the identical definitions from migration 0004 (same approach as 0018).
DROP TRIGGER source_register_no_delete;
DROP TRIGGER source_register_history_no_delete;
DELETE FROM source_register_history WHERE source = 'fred';
DELETE FROM source_register WHERE source = 'fred';
CREATE TRIGGER source_register_no_delete BEFORE DELETE ON source_register
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;
CREATE TRIGGER source_register_history_no_delete BEFORE DELETE ON source_register_history
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

DROP TRIGGER arena_order_guard_update;
CREATE TRIGGER arena_order_guard_update BEFORE UPDATE ON arena_order
WHEN NOT (OLD.status = 'pending' AND NEW.status <> 'pending'
  AND NEW.id IS OLD.id AND NEW.cohort_id IS OLD.cohort_id AND NEW.decided_d IS OLD.decided_d
  AND NEW.code IS OLD.code AND NEW.side IS OLD.side AND NEW.kind IS OLD.kind
  AND NEW.qty IS OLD.qty AND NEW.ref_stop_micro IS OLD.ref_stop_micro
  AND NEW.tier IS OLD.tier AND NEW.untradeable_flag IS OLD.untradeable_flag
  AND NEW.signal_id IS OLD.signal_id AND NEW.card_id IS OLD.card_id
  AND NEW.max_open_micro IS OLD.max_open_micro AND NEW.stop_spec IS OLD.stop_spec)
BEGIN
  SELECT RAISE(ABORT, 'order: only pending to one terminal status; other columns are immutable');
END;
ALTER TABLE arena_order DROP COLUMN limit_micro;
-- Dropping a table drops its indexes and triggers; reverse order of creation.
DROP TABLE cortex_statement;
DROP TABLE opinion_track;
DROP TABLE text_label;
DROP TABLE label_validation;
DROP TABLE input_manifest;
DROP TABLE cortex_state;
DROP TABLE family_status;
DROP TABLE cortex_abstain;
DROP TABLE cortex_outcome;
DROP TABLE cortex_decision;
DROP TABLE cortex_night;
DROP TABLE cortex_map;
DROP TABLE cortex_ledger_cell;
DROP TABLE cortex_feature_daily;
DROP TABLE angle_passport;
