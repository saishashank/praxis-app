-- +up
-- The learning loop feeds the Cortex (D-923…): six additive tables, no change to an existing table.
-- Same conventions as 0019: STRICT, WITHOUT ROWID, append-only (UPDATE and DELETE abort), session dates
-- by GLOB, JSON columns json_valid, returns in integer parts per million. Every row is the output of a
-- pure function over rows written earlier, so a re-run of a night inserts nothing new (insert-or-ignore).
-- Nothing in the fixed Cortex reads these tables; the learner rule versions live in cortex_map (0019).

-- 1. Nightly scorecard (src/lib/cortex/learn/scorecard.ts): one row per scored angle, horizon and night.
-- feature_d is the evening the feature was known: session d-1 for horizon 1 (return to d's close) and
-- session d-21 for horizon 20 (return over 20 sessions to the close of d-1, a one-session embargo).
-- Every liquid share is scored, never only the picks (D-930).
CREATE TABLE cortex_angle_day (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  angle_id TEXT NOT NULL CHECK (length(angle_id) > 0),
  angle_version INTEGER NOT NULL CHECK (angle_version >= 1),
  horizon INTEGER NOT NULL CHECK (horizon IN (1, 20)),
  feature_d TEXT NOT NULL CHECK (feature_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  n INTEGER NOT NULL CHECK (n >= 0),
  ic REAL CHECK (ic IS NULL OR (ic >= -1 AND ic <= 1)),
  top_excess_ppm INTEGER,
  bottom_excess_ppm INTEGER,
  base_ppm INTEGER,
  regime TEXT NOT NULL CHECK (length(regime) > 0),
  results_season INTEGER NOT NULL CHECK (results_season IN (0, 1)),
  psi_ppm INTEGER CHECK (psi_ppm IS NULL OR psi_ppm >= 0),
  excluded_news INTEGER NOT NULL CHECK (excluded_news >= 0),
  active_set_hash TEXT NOT NULL CHECK (length(active_set_hash) > 0),
  manifest_id TEXT NOT NULL CHECK (length(manifest_id) > 0),
  PRIMARY KEY (market, d, angle_id, horizon),
  CHECK (feature_d < d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cortex_angle_day_no_update BEFORE UPDATE ON cortex_angle_day
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cortex_angle_day_no_delete BEFORE DELETE ON cortex_angle_day
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 2. Paired comparison of the fixed and the learning rule per family and decision night, written once
-- the 20-session leg has matured. Hold-length net comes from cortex_outcome (book_id#learn vs book_id).
CREATE TABLE cortex_learn_compare (
  market TEXT NOT NULL CHECK (length(market) > 0),
  decision_d TEXT NOT NULL CHECK (decision_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  family TEXT NOT NULL CHECK (family IN ('F1','F2','F3','F4','F5','F6','F7')),
  book_id TEXT NOT NULL CHECK (length(book_id) > 0),
  fixed_rule_version TEXT NOT NULL CHECK (length(fixed_rule_version) > 0),
  learner_rule_version TEXT NOT NULL CHECK (length(learner_rule_version) > 0),
  learner_generation INTEGER NOT NULL CHECK (learner_generation >= 0),
  fixed_code TEXT CHECK (fixed_code IS NULL OR length(fixed_code) > 0),
  learner_code TEXT CHECK (learner_code IS NULL OR length(learner_code) > 0),
  agree INTEGER NOT NULL CHECK (agree IN (0, 1)),
  fixed_ret1_ppm INTEGER,
  learner_ret1_ppm INTEGER,
  fixed_ret20_ppm INTEGER,
  learner_ret20_ppm INTEGER,
  matured_d TEXT NOT NULL CHECK (matured_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  regime TEXT NOT NULL CHECK (length(regime) > 0),
  PRIMARY KEY (market, decision_d, family, book_id),
  CHECK (matured_d > decision_d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cortex_learn_compare_no_update BEFORE UPDATE ON cortex_learn_compare
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cortex_learn_compare_no_delete BEFORE DELETE ON cortex_learn_compare
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 3. Every learning action, logged before its effect and reversible by reference: a rollback is a new
-- row naming the seq it undoes (reverses_seq; the night it belongs to is in evidence_json as 'd:seq').
-- words is the Evening Review line, built from the phrase table only.
CREATE TABLE cortex_learn_event (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('scorecard','checkpoint','watch','cap','escalate','reweight',
    'no_change','bench','unbench','probe_open','probe_close','platt_refit','switch','fallback',
    'rollback','placebo','base_change')),
  family TEXT CHECK (family IS NULL OR family IN ('F1','F2','F3','F4','F5','F6','F7')),
  angle_id TEXT CHECK (angle_id IS NULL OR length(angle_id) > 0),
  generation INTEGER CHECK (generation IS NULL OR generation >= 0),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  words TEXT NOT NULL,
  reverses_seq INTEGER CHECK (reverses_seq IS NULL OR reverses_seq >= 0),
  expires_d TEXT CHECK (expires_d IS NULL OR expires_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  PRIMARY KEY (market, d, seq),
  CHECK (kind <> 'rollback' OR reverses_seq IS NOT NULL),
  CHECK (kind <> 'cap' OR expires_d IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cortex_learn_event_no_update BEFORE UPDATE ON cortex_learn_event
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cortex_learn_event_no_delete BEFORE DELETE ON cortex_learn_event
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
-- The probe and base readers (learn/baseStore.ts) scan only their own kinds (a few rows a month)
-- instead of every event of the market: (market, kind, d) prefix, never OFFSET.
CREATE INDEX cortex_learn_event_kind ON cortex_learn_event (market, kind, d);

-- 4. Who leads each family: history rows, the latest since_d wins, no row = the fixed rule. Leading never
-- changes family_status (CTX-053 permission is unchanged); an Owner kill can only hand back to the fixed
-- rule, never promote the learner.
CREATE TABLE cortex_leader (
  market TEXT NOT NULL CHECK (length(market) > 0),
  family TEXT NOT NULL CHECK (family IN ('F1','F2','F3','F4','F5','F6','F7')),
  since_d TEXT NOT NULL CHECK (since_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  leader TEXT NOT NULL CHECK (leader IN ('fixed','learner')),
  learner_rule_version TEXT CHECK (learner_rule_version IS NULL OR length(learner_rule_version) > 0),
  learner_generation INTEGER CHECK (learner_generation IS NULL OR learner_generation >= 0),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  set_by TEXT NOT NULL CHECK (set_by IN ('evaluator','fallback','owner_kill')),
  PRIMARY KEY (market, family, since_d),
  CHECK (leader <> 'learner' OR (learner_rule_version IS NOT NULL AND learner_generation IS NOT NULL)),
  CHECK (set_by = 'evaluator' OR leader = 'fixed')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cortex_leader_no_update BEFORE UPDATE ON cortex_leader
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cortex_leader_no_delete BEFORE DELETE ON cortex_leader
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 5. Sparse nightly values of the open probe angles (candidate measures, design C.6 table 5): angles a
-- family is trying that are NOT in the night's global scored set, so cortex_feature_daily keeps its
-- "active set only" contract. One row per code, angle and night; written by the Cortex stage only for
-- the probes open the night before (learn/baseStage.ts), never read by S or eligibility. value is the
-- rank-standardised number (null when undefined or a flag), flag the flag or bucket word. Prunable
-- beyond the same 400-day floor as cortex_feature_daily (0023): deterministic from the bars.
CREATE TABLE cortex_feature_probe (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  code TEXT NOT NULL CHECK (length(code) > 0),
  angle_id TEXT NOT NULL CHECK (length(angle_id) > 0),
  value REAL CHECK (value IS NULL OR (value >= -1 AND value <= 1)),
  flag TEXT CHECK (flag IS NULL OR length(flag) > 0),
  angle_version INTEGER NOT NULL CHECK (angle_version >= 1),
  manifest_id TEXT NOT NULL CHECK (length(manifest_id) > 0),
  PRIMARY KEY (market, d, code, angle_id),
  CHECK (value IS NULL OR flag IS NULL)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cortex_feature_probe_no_update BEFORE UPDATE ON cortex_feature_probe
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cortex_feature_probe_no_delete BEFORE DELETE ON cortex_feature_probe
WHEN OLD.d >= date('now', '-400 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- 6. The numbered versions of each family's BASE (Owner O-81): the measures the fixed Cortex scores.
-- Version 1 is the fixed rule's scored set as it stood when the loop first saw it ('initial'); a
-- candidate measure that passes the strictest evidence is added ('promote'), a base measure that stays
-- broken under the same evidence is taken out ('retire'), each as a new version with a new
-- system-written cortex_map row (rule_version, used from since_d, the night after it is written). An
-- Owner import of a new fixed rule re-bases the family ('owner_import'). System-written, append-only;
-- the evidence is the promotion test's numbers.
CREATE TABLE cortex_base_version (
  market TEXT NOT NULL CHECK (length(market) > 0),
  family TEXT NOT NULL CHECK (family IN ('F1','F2','F3','F4','F5','F6','F7')),
  version INTEGER NOT NULL CHECK (version >= 1),
  since_d TEXT NOT NULL CHECK (since_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  reason TEXT NOT NULL CHECK (reason IN ('initial','promote','retire','owner_import')),
  rule_version TEXT NOT NULL CHECK (length(rule_version) > 0),
  angles_json TEXT NOT NULL CHECK (json_valid(angles_json) AND json_type(angles_json) = 'array'),
  added_json TEXT NOT NULL CHECK (json_valid(added_json) AND json_type(added_json) = 'array'),
  removed_json TEXT NOT NULL CHECK (json_valid(removed_json) AND json_type(removed_json) = 'array'),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  PRIMARY KEY (market, family, version),
  CHECK ((version = 1) = (reason = 'initial')),
  CHECK (reason <> 'promote' OR json_array_length(added_json) = 1),
  CHECK (reason <> 'retire' OR json_array_length(removed_json) = 1)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cortex_base_version_no_update BEFORE UPDATE ON cortex_base_version
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cortex_base_version_no_delete BEFORE DELETE ON cortex_base_version
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- +down
-- Dropping a table drops its triggers and indexes; reverse order of creation.
DROP TABLE cortex_base_version;
DROP TABLE cortex_feature_probe;
DROP TABLE cortex_leader;
DROP TABLE cortex_learn_event;
DROP TABLE cortex_learn_compare;
DROP TABLE cortex_angle_day;
