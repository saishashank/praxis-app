-- +up
-- Learning and knowledge tables (M6 T1, docs/M6_design.md section 3, D-110; choices marked "D-111"
-- are the builder's and are recorded in the decision log).
-- Conventions as 0004 and 0007-0009: every table is STRICT; instants are ISO-8601 UTC text with
-- milliseconds and Z (D-031); `d` columns are Melbourne/Sydney local dates YYYY-MM-DD; booleans are
-- 0/1 with a CHECK; JSON columns are canonical JSON with json_valid; writers use
-- INSERT ... ON CONFLICT DO NOTHING and never the REPLACE write forms (REPLACE deletes without
-- firing delete triggers, D-058). Money columns are INTEGER micro-AUD (`*_micro`), ratios are ppm
-- INTEGERs; REAL is used only for float64 statistics (bootstrap, p-values, alpha wealth).
-- DAT-150 names are used where it names the entity.
--
-- Triggers. Append-only tables refuse UPDATE and DELETE. One-way tables allow only the documented
-- changes and refuse DELETE. Pruned tables (comparison_result, kb_archive_run) allow DELETE only
-- beyond their floor, evaluated against the current clock (the 0004 pattern). Insert guards refuse
-- a gap in a sequence (seq or version) but let a duplicate key fall through to the primary-key
-- conflict, so "ON CONFLICT DO NOTHING" stays idempotent.
-- NOTE: a trigger WHEN expression that evaluates to NULL does not fire; every guard below is written
-- with IS / IS NOT or null-safe terms so that it is never NULL.

-- ---------------------------------------------------------------------------------------------
-- Rule versions (KB-010..012)

-- Immutable (KB-011). id = '<family>.v<n>'; v1 per family is seeded from the registry (origin seed).
CREATE TABLE rule_version (
  id TEXT PRIMARY KEY,
  market TEXT NOT NULL CHECK (length(market) > 0),
  family TEXT NOT NULL CHECK (family IN ('F1','F2','F3','F4','F5','F6')),
  n INTEGER NOT NULL CHECK (n >= 1),
  parent TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('seed','challenger','owner','rollback','force')),
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  params_sha TEXT NOT NULL CHECK (length(params_sha) = 64 AND params_sha NOT GLOB '*[^0-9a-f]*'),
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json)),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  registered_d TEXT NOT NULL CHECK (registered_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_by TEXT NOT NULL CHECK (length(created_by) > 0),
  UNIQUE (market, family, n),
  CHECK (id = family || '.v' || n),
  CHECK (parent IS NULL OR parent <> id),
  CHECK ((origin = 'seed') = (parent IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER rule_version_no_update BEFORE UPDATE ON rule_version
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER rule_version_no_delete BEFORE DELETE ON rule_version
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Status history of a version. The first row is 'registered'; nothing follows 'retired'.
CREATE TABLE rule_version_status (
  rule_version_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  status TEXT NOT NULL CHECK (status IN ('registered','live','shadow','retired')),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  PRIMARY KEY (rule_version_id, seq),
  CHECK (seq > 1 OR status = 'registered')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER rule_version_status_insert_guard BEFORE INSERT ON rule_version_status
WHEN NOT EXISTS (SELECT 1 FROM rule_version r WHERE r.id = NEW.rule_version_id)
  OR NEW.seq > COALESCE((SELECT MAX(seq) FROM rule_version_status
       WHERE rule_version_id = NEW.rule_version_id), 0) + 1
  OR (NEW.seq = COALESCE((SELECT MAX(seq) FROM rule_version_status
       WHERE rule_version_id = NEW.rule_version_id), 0) + 1
     AND EXISTS (SELECT 1 FROM rule_version_status s
       WHERE s.rule_version_id = NEW.rule_version_id AND s.status = 'retired'))
BEGIN
  SELECT RAISE(ABORT, 'rule_version_status: needs its version, no gap in seq, nothing after retired');
END;
CREATE TRIGGER rule_version_status_no_update BEFORE UPDATE ON rule_version_status
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER rule_version_status_no_delete BEFORE DELETE ON rule_version_status
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- Lessons (ARN-063, KB-020)

-- L1 / L2 windows of a lineage split (frozen at creation or roll, re-frozen at each roll).
CREATE TABLE lesson_window (
  lineage_id TEXT NOT NULL,
  split_version INTEGER NOT NULL CHECK (split_version >= 1),
  l1_start_d TEXT NOT NULL CHECK (l1_start_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  l1_end_d TEXT NOT NULL CHECK (l1_end_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  purge INTEGER NOT NULL CHECK (purge >= 0),
  l2_start_d TEXT NOT NULL CHECK (l2_start_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  l2_end_d TEXT NOT NULL CHECK (l2_end_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  block INTEGER NOT NULL CHECK (block >= 1),
  frozen_run TEXT NOT NULL CHECK (length(frozen_run) > 0),
  PRIMARY KEY (lineage_id, split_version),
  CHECK (l1_start_d <= l1_end_d AND l1_end_d < l2_start_d AND l2_start_d <= l2_end_d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER lesson_window_no_update BEFORE UPDATE ON lesson_window
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER lesson_window_no_delete BEFORE DELETE ON lesson_window
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Identity: L-<market>-<template>-<subject_sha8>-<rule_version> (one lesson per template, subject
-- and rule version). Market-scope lessons have no lineage.
CREATE TABLE lesson (
  id TEXT PRIMARY KEY CHECK (id LIKE 'L-%'),
  market TEXT NOT NULL CHECK (length(market) > 0),
  scope TEXT NOT NULL CHECK (scope IN ('lineage','market')),
  lineage_id TEXT,
  template_id TEXT NOT NULL CHECK (length(template_id) > 0),
  template_version INTEGER NOT NULL CHECK (template_version >= 1),
  subject_json TEXT NOT NULL CHECK (json_valid(subject_json)),
  rule_version TEXT NOT NULL CHECK (length(rule_version) > 0),
  metric TEXT NOT NULL CHECK (length(metric) > 0),
  direction INTEGER NOT NULL CHECK (direction IN (-1,1)),
  param_hint TEXT CHECK (param_hint IS NULL OR length(param_hint) > 0),
  created_d TEXT NOT NULL CHECK (created_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_run TEXT NOT NULL CHECK (length(created_run) > 0),
  CHECK ((scope = 'lineage') = (lineage_id IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_lesson_lineage ON lesson (market, lineage_id);
CREATE TRIGGER lesson_no_update BEFORE UPDATE ON lesson
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER lesson_no_delete BEFORE DELETE ON lesson
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Grade history; the current grade is the latest seq. A correction is a new row (corrects_seq).
CREATE TABLE lesson_grade (
  lesson_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  grade TEXT NOT NULL CHECK (grade IN ('L0','L1','L2','L3','retired')),
  split_version INTEGER NOT NULL CHECK (split_version >= 0),
  window TEXT CHECK (window IS NULL OR window IN ('l1','l2')),
  n INTEGER NOT NULL CHECK (n >= 0),
  blocks INTEGER NOT NULL CHECK (blocks >= 0),
  estimate REAL,
  lower REAL,
  upper REAL,
  p REAL CHECK (p IS NULL OR (p >= 0 AND p <= 1)),
  alpha_j REAL CHECK (alpha_j IS NULL OR (alpha_j > 0 AND alpha_j <= 1)),
  B INTEGER NOT NULL CHECK (B >= 0),
  state_text TEXT NOT NULL DEFAULT '',
  reachable_d TEXT CHECK (reachable_d IS NULL
    OR reachable_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  run_id TEXT NOT NULL CHECK (length(run_id) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  corrects_seq INTEGER,
  PRIMARY KEY (lesson_id, seq),
  CHECK (corrects_seq IS NULL OR (corrects_seq >= 1 AND corrects_seq < seq))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER lesson_grade_insert_guard BEFORE INSERT ON lesson_grade
WHEN NOT EXISTS (SELECT 1 FROM lesson l WHERE l.id = NEW.lesson_id)
  OR NEW.seq > COALESCE((SELECT MAX(seq) FROM lesson_grade WHERE lesson_id = NEW.lesson_id), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'lesson_grade: needs its lesson and no gap in seq');
END;
CREATE TRIGGER lesson_grade_no_update BEFORE UPDATE ON lesson_grade
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER lesson_grade_no_delete BEFORE DELETE ON lesson_grade
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Alpha-investing ledger (ARN-063): the next test reads the last row of its pool. The chain is
-- enforced: seq n+1 starts from the w_after of seq n. A rejection earns (w_after >= w_before), a
-- non-rejection pays (w_after <= w_before); wealth never goes below 0.
CREATE TABLE alpha_wealth (
  pool TEXT NOT NULL CHECK (length(pool) > 0),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  lesson_id TEXT NOT NULL,
  window_key TEXT NOT NULL CHECK (length(window_key) > 0),
  w_before REAL NOT NULL CHECK (w_before >= 0),
  alpha_j REAL NOT NULL CHECK (alpha_j > 0 AND alpha_j <= 1),
  p REAL NOT NULL CHECK (p >= 0 AND p <= 1),
  rejected INTEGER NOT NULL CHECK (rejected IN (0,1)),
  w_after REAL NOT NULL CHECK (w_after >= 0),
  run_id TEXT NOT NULL CHECK (length(run_id) > 0),
  PRIMARY KEY (pool, seq),
  CHECK ((rejected = 1 AND w_after >= w_before) OR (rejected = 0 AND w_after <= w_before))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_alpha_wealth_lesson ON alpha_wealth (lesson_id);
CREATE TRIGGER alpha_wealth_insert_guard BEFORE INSERT ON alpha_wealth
WHEN NOT EXISTS (SELECT 1 FROM lesson l WHERE l.id = NEW.lesson_id)
  OR NEW.seq > COALESCE((SELECT MAX(seq) FROM alpha_wealth WHERE pool = NEW.pool), 0) + 1
  OR (NEW.seq > 1 AND NEW.seq = COALESCE((SELECT MAX(seq) FROM alpha_wealth WHERE pool = NEW.pool), 0) + 1
     AND NEW.w_before IS NOT (SELECT w_after FROM alpha_wealth
       WHERE pool = NEW.pool AND seq = NEW.seq - 1))
BEGIN
  SELECT RAISE(ABORT, 'alpha_wealth: needs its lesson, no gap in seq, w_before continues the pool');
END;
CREATE TRIGGER alpha_wealth_no_update BEFORE UPDATE ON alpha_wealth
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER alpha_wealth_no_delete BEFORE DELETE ON alpha_wealth
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- Attribution (ARN-061) and blocked trades

-- One canonical tag record per subject; open subjects get a new version nightly, a final row is
-- never followed by another version. Blocked subjects have no fill, so the trade-only columns are
-- NULL for them (D-111).
CREATE TABLE attribution (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('trade','ledger_row','blocked')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
  version INTEGER NOT NULL CHECK (version >= 1),
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  final INTEGER NOT NULL CHECK (final IN (0,1)),
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json)),
  mfe_ppm INTEGER,
  mae_ppm INTEGER,
  hold_sessions INTEGER CHECK (hold_sessions IS NULL OR hold_sessions >= 0),
  cost_micro INTEGER,
  slippage_micro INTEGER,
  net_micro INTEGER,
  excess_ppm INTEGER,
  stress_ppm INTEGER,
  PRIMARY KEY (subject_kind, subject_id, version),
  CHECK (subject_kind = 'blocked' OR (mfe_ppm IS NOT NULL AND mae_ppm IS NOT NULL
    AND hold_sessions IS NOT NULL AND cost_micro IS NOT NULL AND slippage_micro IS NOT NULL)),
  CHECK (mfe_ppm IS NULL OR mae_ppm IS NULL OR mae_ppm <= mfe_ppm)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_attribution_d ON attribution (market, d);
CREATE TRIGGER attribution_insert_guard BEFORE INSERT ON attribution
WHEN NEW.version > COALESCE((SELECT MAX(version) FROM attribution
       WHERE subject_kind = NEW.subject_kind AND subject_id = NEW.subject_id), 0) + 1
  OR (NEW.version = COALESCE((SELECT MAX(version) FROM attribution
       WHERE subject_kind = NEW.subject_kind AND subject_id = NEW.subject_id), 0) + 1
     AND EXISTS (SELECT 1 FROM attribution a WHERE a.subject_kind = NEW.subject_kind
       AND a.subject_id = NEW.subject_id AND a.final = 1))
BEGIN
  SELECT RAISE(ABORT, 'attribution: no gap in version and nothing after a final row');
END;
CREATE TRIGGER attribution_no_update BEFORE UPDATE ON attribution
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER attribution_no_delete BEFORE DELETE ON attribution
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- A signal that was blocked or not taken, with the counterfactual fixed-notional outcome of the
-- same family exits. counterfactual_* go NULL -> value once; final goes 0 -> 1 once.
CREATE TABLE blocked_trade (
  signal_id TEXT NOT NULL CHECK (length(signal_id) > 0),
  execution_id TEXT NOT NULL CHECK (length(execution_id) > 0),
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  card_id TEXT,
  counterfactual_row_id TEXT,
  counterfactual_net_ppm INTEGER,
  final INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0,1)),
  PRIMARY KEY (signal_id, execution_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_blocked_trade_d ON blocked_trade (market, d);
CREATE TRIGGER blocked_trade_guard_update BEFORE UPDATE ON blocked_trade
WHEN NOT (NEW.signal_id IS OLD.signal_id AND NEW.execution_id IS OLD.execution_id
  AND NEW.market IS OLD.market AND NEW.d IS OLD.d AND NEW.reason IS OLD.reason
  AND NEW.card_id IS OLD.card_id
  AND (OLD.counterfactual_row_id IS NULL OR NEW.counterfactual_row_id IS OLD.counterfactual_row_id)
  AND (OLD.counterfactual_net_ppm IS NULL OR NEW.counterfactual_net_ppm IS OLD.counterfactual_net_ppm)
  AND NEW.final >= OLD.final)
BEGIN
  SELECT RAISE(ABORT, 'blocked_trade: only the counterfactual may go from NULL to a value, final is one-way');
END;
CREATE TRIGGER blocked_trade_no_delete BEFORE DELETE ON blocked_trade
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- ---------------------------------------------------------------------------------------------
-- Comparisons (ARN-062)

-- Nightly descriptive rows, weekly tests and look results. Two years (as replay_stat).
CREATE TABLE comparison_result (
  market TEXT NOT NULL CHECK (length(market) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('nightly','weekly','look')),
  pair_id TEXT NOT NULL CHECK (length(pair_id) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  n_a INTEGER NOT NULL CHECK (n_a >= 0),
  n_b INTEGER NOT NULL CHECK (n_b >= 0),
  estimate REAL,
  lower REAL,
  upper REAL,
  p REAL CHECK (p IS NULL OR (p >= 0 AND p <= 1)),
  bh_rank INTEGER CHECK (bh_rank IS NULL OR bh_rank >= 1),
  discovery INTEGER NOT NULL DEFAULT 0 CHECK (discovery IN (0,1)),
  block INTEGER NOT NULL CHECK (block >= 0),
  B INTEGER NOT NULL CHECK (B >= 0),
  label TEXT NOT NULL CHECK (length(label) > 0),
  PRIMARY KEY (market, kind, pair_id, d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER comparison_result_no_update BEFORE UPDATE ON comparison_result
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER comparison_result_prune_only BEFORE DELETE ON comparison_result
WHEN OLD.d >= date('now', '-730 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- A BH discovery waiting for its one confirmation look. State candidate -> confirmed | discarded
-- once; the look result reference and (for a discard) the 60-session lockout are set with it.
CREATE TABLE comparison_finding (
  id TEXT PRIMARY KEY CHECK (id LIKE 'cf:%'),
  pair_id TEXT NOT NULL CHECK (length(pair_id) > 0),
  direction INTEGER NOT NULL CHECK (direction IN (-1,1)),
  detected_d TEXT NOT NULL CHECK (detected_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  look_due_d TEXT NOT NULL CHECK (look_due_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  state TEXT NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate','confirmed','discarded')),
  lockout_until_d TEXT CHECK (lockout_until_d IS NULL
    OR lockout_until_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  look_result_ref TEXT CHECK (look_result_ref IS NULL OR length(look_result_ref) > 0),
  CHECK (look_due_d >= detected_d),
  CHECK ((state = 'candidate') = (look_result_ref IS NULL)),
  CHECK ((state = 'discarded') = (lockout_until_d IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_comparison_finding_pair ON comparison_finding (pair_id, detected_d);
CREATE TRIGGER comparison_finding_guard_update BEFORE UPDATE ON comparison_finding
WHEN NOT (NEW.id IS OLD.id AND NEW.pair_id IS OLD.pair_id AND NEW.direction IS OLD.direction
  AND NEW.detected_d IS OLD.detected_d AND NEW.look_due_d IS OLD.look_due_d
  AND (NEW.state IS OLD.state OR (OLD.state = 'candidate' AND NEW.state IN ('confirmed','discarded')))
  AND (OLD.lockout_until_d IS NULL OR NEW.lockout_until_d IS OLD.lockout_until_d)
  AND (OLD.look_result_ref IS NULL OR NEW.look_result_ref IS OLD.look_result_ref))
BEGIN
  SELECT RAISE(ABORT, 'comparison_finding: candidate moves once to confirmed or discarded, nothing else changes');
END;
CREATE TRIGGER comparison_finding_no_delete BEFORE DELETE ON comparison_finding
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- ---------------------------------------------------------------------------------------------
-- Critic (AGT-041, AGT-042)

-- The six deterministic checks of a subject at a run, with every number and state.
CREATE TABLE critique (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('lesson','challenger')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
  run_id TEXT NOT NULL CHECK (length(run_id) > 0),
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
  passed INTEGER NOT NULL CHECK (passed IN (0,1)),
  access_trial_id TEXT,
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (subject_kind, subject_id, run_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_critique_subject ON critique (subject_kind, subject_id, d);
CREATE TRIGGER critique_no_update BEFORE UPDATE ON critique
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER critique_no_delete BEFORE DELETE ON critique
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Worded concerns / alternatives (R3 or template). Never read by any rule (AGT-011a).
CREATE TABLE critique_note (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('lesson','challenger')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
  run_id TEXT NOT NULL CHECK (length(run_id) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('concerns','alternatives')),
  text TEXT NOT NULL,
  provider TEXT,
  model_id TEXT,
  fallback_depth TEXT NOT NULL CHECK (length(fallback_depth) > 0),
  tokens_in INTEGER NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out INTEGER NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  prompt_sha TEXT CHECK (prompt_sha IS NULL
    OR (length(prompt_sha) = 64 AND prompt_sha NOT GLOB '*[^0-9a-f]*')),
  deferred INTEGER NOT NULL DEFAULT 0 CHECK (deferred IN (0,1)),
  PRIMARY KEY (subject_kind, subject_id, run_id, kind)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER critique_note_no_update BEFORE UPDATE ON critique_note
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER critique_note_no_delete BEFORE DELETE ON critique_note
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- Challengers and promotions (KB-040..043, ARN-065)

-- State machine of KB-040, one way. Edges (terminal: promoted, rejected, retired):
--   proposed -> replay | rejected | retired      replay   -> shakedown | rejected | retired
--   shakedown -> review | rejected | retired     review   -> approved | rejected | retired
--   approved -> promoted | rejected | retired
-- `ready` (D-111) is the mark of a challenger in review whose Critic checks all pass; it may flip
-- while in review and stays 0 before it. shakedown_ok_sessions only increases, except that an
-- operational error resets it to 0 while the state stays `shakedown` (design 2.8).
CREATE TABLE challenger (
  id TEXT PRIMARY KEY CHECK (id LIKE 'C-%'),
  lineage_id TEXT NOT NULL CHECK (length(lineage_id) > 0),
  rule_version_id TEXT NOT NULL CHECK (length(rule_version_id) > 0),
  incumbent_version_id TEXT NOT NULL CHECK (length(incumbent_version_id) > 0),
  origin TEXT NOT NULL CHECK (origin IN ('generator','owner')),
  lesson_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(lesson_ids_json)),
  state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN
    ('proposed','replay','shakedown','review','approved','promoted','rejected','retired')),
  state_d TEXT NOT NULL CHECK (state_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  trial_id TEXT NOT NULL CHECK (length(trial_id) > 0),
  shakedown_ok_sessions INTEGER NOT NULL DEFAULT 0 CHECK (shakedown_ok_sessions >= 0),
  shadow_viewed_d TEXT CHECK (shadow_viewed_d IS NULL
    OR shadow_viewed_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0,1)),
  CHECK (rule_version_id <> incumbent_version_id),
  CHECK (ready = 0 OR state IN ('review','approved','promoted'))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_challenger_lineage ON challenger (lineage_id, state);
CREATE TRIGGER challenger_insert_guard BEFORE INSERT ON challenger
WHEN NEW.state <> 'proposed' OR NEW.shakedown_ok_sessions <> 0 OR NEW.ready <> 0
BEGIN
  SELECT RAISE(ABORT, 'challenger: starts proposed with a zero counter');
END;
CREATE TRIGGER challenger_guard_update BEFORE UPDATE ON challenger
WHEN NOT (NEW.id IS OLD.id AND NEW.lineage_id IS OLD.lineage_id
  AND NEW.rule_version_id IS OLD.rule_version_id
  AND NEW.incumbent_version_id IS OLD.incumbent_version_id AND NEW.origin IS OLD.origin
  AND NEW.lesson_ids_json IS OLD.lesson_ids_json AND NEW.trial_id IS OLD.trial_id
  AND NEW.state_d >= OLD.state_d
  AND (NEW.state IS OLD.state OR (OLD.state || '>' || NEW.state) IN (
    'proposed>replay','proposed>rejected','proposed>retired',
    'replay>shakedown','replay>rejected','replay>retired',
    'shakedown>review','shakedown>rejected','shakedown>retired',
    'review>approved','review>rejected','review>retired',
    'approved>promoted','approved>rejected','approved>retired'))
  AND (NEW.shakedown_ok_sessions >= OLD.shakedown_ok_sessions
    OR (NEW.shakedown_ok_sessions = 0 AND OLD.state = 'shakedown' AND NEW.state = 'shakedown'))
  AND (OLD.shadow_viewed_d IS NULL
    OR (NEW.shadow_viewed_d IS NOT NULL AND NEW.shadow_viewed_d >= OLD.shadow_viewed_d))
  AND (NEW.ready IS OLD.ready OR NEW.state = 'review' OR OLD.state = 'review'))
BEGIN
  SELECT RAISE(ABORT, 'challenger: only the KB-040 edges, counters and the shadow-view date may change');
END;
CREATE TRIGGER challenger_no_delete BEFORE DELETE ON challenger
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- Every transition, append-only. The first event of a challenger is NULL -> proposed.
CREATE TABLE challenger_event (
  challenger_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  from_state TEXT,
  to_state TEXT NOT NULL,
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  actor TEXT NOT NULL CHECK (length(actor) > 0),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  ref_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ref_json)),
  PRIMARY KEY (challenger_id, seq),
  CHECK ((from_state IS NULL AND to_state = 'proposed') OR (from_state IS NOT NULL AND (from_state || '>' || to_state) IN (
    'proposed>replay','proposed>rejected','proposed>retired',
    'replay>shakedown','replay>rejected','replay>retired',
    'shakedown>review','shakedown>rejected','shakedown>retired',
    'review>approved','review>rejected','review>retired',
    'approved>promoted','approved>rejected','approved>retired')))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER challenger_event_insert_guard BEFORE INSERT ON challenger_event
WHEN NOT EXISTS (SELECT 1 FROM challenger c WHERE c.id = NEW.challenger_id)
  OR NEW.seq > COALESCE((SELECT MAX(seq) FROM challenger_event
       WHERE challenger_id = NEW.challenger_id), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'challenger_event: needs its challenger and no gap in seq');
END;
CREATE TRIGGER challenger_event_no_update BEFORE UPDATE ON challenger_event
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER challenger_event_no_delete BEFORE DELETE ON challenger_event
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- A pending change of a family's live version, applied at the twins' restart boundary. status
-- pending -> applied | cancelled once; applied_d is set with `applied` and only then.
CREATE TABLE promotion (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  market TEXT NOT NULL CHECK (length(market) > 0),
  family TEXT NOT NULL CHECK (family IN ('F1','F2','F3','F4','F5','F6')),
  kind TEXT NOT NULL CHECK (kind IN ('promotion','force_apply','rollback')),
  from_version TEXT NOT NULL CHECK (length(from_version) > 0),
  to_version TEXT NOT NULL CHECK (length(to_version) > 0),
  challenger_id TEXT,
  approved_at TEXT NOT NULL,
  approved_by TEXT NOT NULL CHECK (length(approved_by) > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','cancelled')),
  applied_d TEXT CHECK (applied_d IS NULL
    OR applied_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  group_id TEXT NOT NULL CHECK (length(group_id) > 0),
  CHECK (from_version <> to_version),
  CHECK ((status = 'applied') = (applied_d IS NOT NULL)),
  CHECK (kind <> 'promotion' OR challenger_id IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_promotion_family ON promotion (market, family, status);
CREATE TRIGGER promotion_insert_guard BEFORE INSERT ON promotion
WHEN NEW.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'promotion: starts pending');
END;
CREATE TRIGGER promotion_guard_update BEFORE UPDATE ON promotion
WHEN NOT (NEW.id IS OLD.id AND NEW.market IS OLD.market AND NEW.family IS OLD.family
  AND NEW.kind IS OLD.kind AND NEW.from_version IS OLD.from_version
  AND NEW.to_version IS OLD.to_version AND NEW.challenger_id IS OLD.challenger_id
  AND NEW.approved_at IS OLD.approved_at AND NEW.approved_by IS OLD.approved_by
  AND NEW.group_id IS OLD.group_id
  AND ((NEW.status IS OLD.status AND NEW.applied_d IS OLD.applied_d)
    OR (OLD.status = 'pending' AND NEW.status IN ('applied','cancelled'))))
BEGIN
  SELECT RAISE(ABORT, 'promotion: pending moves once to applied or cancelled, nothing else changes');
END;
CREATE TRIGGER promotion_no_delete BEFORE DELETE ON promotion
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- ---------------------------------------------------------------------------------------------
-- Change ledger, playbooks, plan (ARN-064, ARN-066, KB-030..032)

-- id is monotone and never reused (AUTOINCREMENT); the KB version is the id of the latest row that
-- changes LLM context (src/lib/learning/kbVersion.ts).
CREATE TABLE change_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL CHECK (length(market) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('lane_a_playbook','lane_a_note','lesson_force','promotion',
    'force_apply','rollback','owner_version','retire','kill_freeze')),
  target TEXT NOT NULL CHECK (length(target) > 0),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  diff_text TEXT,
  lesson_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(lesson_ids_json)),
  challenger_id TEXT,
  effective_d TEXT NOT NULL CHECK (effective_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  actor TEXT NOT NULL CHECK (length(actor) > 0),
  audit_ref TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_change_ledger_kind ON change_ledger (market, kind, id);
CREATE TRIGGER change_ledger_no_update BEFORE UPDATE ON change_ledger
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER change_ledger_no_delete BEFORE DELETE ON change_ledger
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Agent playbook versions (Lane A, KB-001). Agents are the LLM agents with a playbook: A1 (R1),
-- A2 and A3 (R2), A6 and A7 (R3), A8 (R5).
CREATE TABLE playbook_version (
  market TEXT NOT NULL CHECK (length(market) > 0),
  agent TEXT NOT NULL CHECK (agent IN ('A1','A2','A3','A6','A7','A8')),
  n INTEGER NOT NULL CHECK (n >= 1),
  content TEXT NOT NULL,
  content_sha TEXT NOT NULL CHECK (length(content_sha) = 64 AND content_sha NOT GLOB '*[^0-9a-f]*'),
  tokens_est INTEGER NOT NULL CHECK (tokens_est >= 0),
  change_id INTEGER NOT NULL CHECK (change_id >= 1),
  effective_d TEXT NOT NULL CHECK (effective_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (market, agent, n)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER playbook_version_insert_guard BEFORE INSERT ON playbook_version
WHEN NEW.n > COALESCE((SELECT MAX(n) FROM playbook_version
       WHERE market = NEW.market AND agent = NEW.agent), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'playbook_version: no gap in n');
END;
CREATE TRIGGER playbook_version_no_update BEFORE UPDATE ON playbook_version
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER playbook_version_no_delete BEFORE DELETE ON playbook_version
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- The nightly plan of at most five items (rank 1-5) and its review the next night.
CREATE TABLE plan_item (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 5),
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  lesson_id TEXT,
  lane TEXT NOT NULL CHECK (lane IN ('A','B','ops')),
  measure_json TEXT NOT NULL CHECK (json_valid(measure_json)),
  PRIMARY KEY (market, d, rank),
  CHECK (lesson_id IS NOT NULL OR reason LIKE 'no-lesson:%')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER plan_item_no_update BEFORE UPDATE ON plan_item
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER plan_item_no_delete BEFORE DELETE ON plan_item
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TABLE plan_review (
  market TEXT NOT NULL CHECK (length(market) > 0),
  plan_d TEXT NOT NULL CHECK (plan_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 5),
  reviewed_d TEXT NOT NULL CHECK (reviewed_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  outcome TEXT NOT NULL CHECK (outcome IN ('done','not_done','met','not_met','not_yet_due')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  PRIMARY KEY (market, plan_d, rank),
  CHECK (reviewed_d >= plan_d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER plan_review_insert_guard BEFORE INSERT ON plan_review
WHEN NOT EXISTS (SELECT 1 FROM plan_item p
  WHERE p.market = NEW.market AND p.d = NEW.plan_d AND p.rank = NEW.rank)
BEGIN
  SELECT RAISE(ABORT, 'plan_review: needs its plan item');
END;
CREATE TRIGGER plan_review_no_update BEFORE UPDATE ON plan_review
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER plan_review_no_delete BEFORE DELETE ON plan_review
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- Knowledge base documents and archive runs (KB-001..003, EML-015)

-- DB-authoritative documents; a new version only when the rendered bytes change. The path is under
-- knowledge/, markdown, without '..' (the archive allow-list is stricter).
CREATE TABLE document (
  path TEXT NOT NULL CHECK (path LIKE 'knowledge/%' AND path LIKE '%.md' AND path NOT LIKE '%..%'),
  version INTEGER NOT NULL CHECK (version >= 1),
  market TEXT NOT NULL CHECK (length(market) > 0),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('family','playbook','lesson','challenger','review',
    'hypothesis','source_register')),
  front_json TEXT NOT NULL CHECK (json_valid(front_json)),
  body TEXT NOT NULL,
  body_sha TEXT NOT NULL CHECK (length(body_sha) = 64 AND body_sha NOT GLOB '*[^0-9a-f]*'),
  source_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_ids_json)),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (path, version)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_document_d ON document (d);
CREATE TRIGGER document_insert_guard BEFORE INSERT ON document
WHEN NEW.version > COALESCE((SELECT MAX(version) FROM document WHERE path = NEW.path), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'document: no gap in version');
END;
CREATE TRIGGER document_no_update BEFORE UPDATE ON document
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER document_no_delete BEFORE DELETE ON document
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- One row per archive run. `running` (D-111) moves once to ok | partial | failed | skipped;
-- finished_at, commit_sha go NULL -> value once and files_changed only grows. 180 days.
CREATE TABLE kb_archive_run (
  run_id TEXT PRIMARY KEY CHECK (length(run_id) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('running','ok','partial','failed','skipped')),
  files_changed INTEGER NOT NULL DEFAULT 0 CHECK (files_changed >= 0),
  commit_sha TEXT CHECK (commit_sha IS NULL OR (length(commit_sha) = 40 AND commit_sha NOT GLOB '*[^0-9a-f]*')),
  started_at TEXT NOT NULL,
  finished_at TEXT
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_kb_archive_run_d ON kb_archive_run (d);
CREATE TRIGGER kb_archive_run_guard_update BEFORE UPDATE ON kb_archive_run
WHEN NOT (NEW.run_id IS OLD.run_id AND NEW.d IS OLD.d AND NEW.started_at IS OLD.started_at
  AND (NEW.status IS OLD.status OR (OLD.status = 'running' AND NEW.status <> 'running'))
  AND NEW.files_changed >= OLD.files_changed
  AND (OLD.commit_sha IS NULL OR NEW.commit_sha IS OLD.commit_sha)
  AND (OLD.finished_at IS NULL OR NEW.finished_at IS OLD.finished_at))
BEGIN
  SELECT RAISE(ABORT, 'kb_archive_run: running moves once to a final status, nothing else changes');
END;
CREATE TRIGGER kb_archive_run_prune_only BEFORE DELETE ON kb_archive_run
WHEN OLD.started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-180 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- ---------------------------------------------------------------------------------------------
-- Ch.16 back-end: factor buckets (AGT-112), picks (AGT-113), pick tracking (ARN-095)

CREATE TABLE factor_bucket_stat (
  market TEXT NOT NULL CHECK (length(market) > 0),
  family TEXT NOT NULL CHECK (family IN ('F1','F2','F3','F4','F5','F6')),
  rule_version TEXT NOT NULL CHECK (length(rule_version) > 0),
  split_version INTEGER NOT NULL CHECK (split_version >= 0),
  factor TEXT NOT NULL CHECK (length(factor) > 0),
  bucket INTEGER NOT NULL CHECK (bucket >= 1),
  edges_json TEXT NOT NULL CHECK (json_valid(edges_json)),
  n INTEGER NOT NULL CHECK (n >= 0),
  median_net_ppm INTEGER,
  family_median_ppm INTEGER,
  PRIMARY KEY (market, family, rule_version, split_version, factor, bucket)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER factor_bucket_stat_no_update BEFORE UPDATE ON factor_bucket_stat
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER factor_bucket_stat_no_delete BEFORE DELETE ON factor_bucket_stat
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- A published pick, with the numbers shown at publication (never edited, ARN-095). The profile
-- name is editable by the Owner, so it is not enumerated. All prices are micro-AUD.
CREATE TABLE pick (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  profile TEXT NOT NULL CHECK (length(profile) > 0),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 10),
  code TEXT NOT NULL CHECK (length(code) > 0),
  family TEXT NOT NULL CHECK (family IN ('F1','F2','F3','F4','F5','F6')),
  tier TEXT NOT NULL CHECK (tier IN ('U1','U2','U3')),
  rule_version TEXT NOT NULL CHECK (length(rule_version) > 0),
  signal_id TEXT NOT NULL CHECK (length(signal_id) > 0),
  card_id TEXT,
  label TEXT NOT NULL CHECK (length(label) > 0),
  reference_micro INTEGER NOT NULL CHECK (reference_micro > 0),
  buy_max_micro INTEGER NOT NULL CHECK (buy_max_micro >= reference_micro),
  valid_until_d TEXT NOT NULL CHECK (valid_until_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  stop_micro INTEGER NOT NULL CHECK (stop_micro > 0 AND stop_micro < reference_micro),
  aim_micro INTEGER NOT NULL CHECK (aim_micro > reference_micro),
  aim_reach_ppm INTEGER CHECK (aim_reach_ppm IS NULL OR aim_reach_ppm BETWEEN 0 AND 1000000),
  n_similar INTEGER NOT NULL CHECK (n_similar >= 0),
  bad_ppm INTEGER,
  typical_ppm INTEGER,
  good_ppm INTEGER,
  time_frame_sessions INTEGER CHECK (time_frame_sessions IS NULL OR time_frame_sessions >= 1),
  size_micro INTEGER NOT NULL CHECK (size_micro >= 0),
  risk_micro INTEGER NOT NULL CHECK (risk_micro >= 0),
  factors_json TEXT NOT NULL CHECK (json_valid(factors_json)),
  based_on_json TEXT NOT NULL CHECK (json_valid(based_on_json)),
  pick_sha TEXT NOT NULL CHECK (length(pick_sha) = 64 AND pick_sha NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (market, d, profile, rank),
  CHECK (valid_until_d >= d)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_pick_code ON pick (market, code, d);
CREATE TRIGGER pick_no_update BEFORE UPDATE ON pick
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER pick_no_delete BEFORE DELETE ON pick
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Tracking of a pick (kind 'pick') and of its luck-check twin (kind 'luck', a random company of the
-- same profile universe). State waiting -> bought | missed, bought -> closed; fields go NULL ->
-- value once; the identity and the published hash never change.
CREATE TABLE pick_outcome (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  profile TEXT NOT NULL CHECK (length(profile) > 0),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 10),
  kind TEXT NOT NULL CHECK (kind IN ('pick','luck')),
  code TEXT NOT NULL CHECK (length(code) > 0),
  published_sha TEXT NOT NULL CHECK (length(published_sha) = 64 AND published_sha NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','bought','missed','closed')),
  entry_d TEXT CHECK (entry_d IS NULL OR entry_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  entry_micro INTEGER CHECK (entry_micro IS NULL OR entry_micro > 0),
  exit_d TEXT CHECK (exit_d IS NULL OR exit_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  exit_micro INTEGER CHECK (exit_micro IS NULL OR exit_micro > 0),
  exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN ('stop','gap','aim','time_frame')),
  net_micro INTEGER,
  net_ppm INTEGER,
  updated_d TEXT NOT NULL CHECK (updated_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (market, d, profile, rank, kind),
  CHECK ((state IN ('bought','closed')) = (entry_d IS NOT NULL AND entry_micro IS NOT NULL)),
  CHECK ((state = 'closed') = (exit_d IS NOT NULL AND exit_micro IS NOT NULL
    AND exit_reason IS NOT NULL AND net_micro IS NOT NULL AND net_ppm IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER pick_outcome_insert_guard BEFORE INSERT ON pick_outcome
WHEN NEW.state <> 'waiting'
  OR (NEW.kind = 'pick' AND NOT EXISTS (SELECT 1 FROM pick p WHERE p.market = NEW.market
    AND p.d = NEW.d AND p.profile = NEW.profile AND p.rank = NEW.rank
    AND p.pick_sha = NEW.published_sha AND p.code = NEW.code))
  OR (NEW.kind = 'luck' AND NOT EXISTS (SELECT 1 FROM pick p WHERE p.market = NEW.market
    AND p.d = NEW.d AND p.profile = NEW.profile AND p.rank = NEW.rank
    AND p.pick_sha = NEW.published_sha))
BEGIN
  SELECT RAISE(ABORT, 'pick_outcome: starts waiting and needs its published pick');
END;
CREATE TRIGGER pick_outcome_guard_update BEFORE UPDATE ON pick_outcome
WHEN NOT (NEW.market IS OLD.market AND NEW.d IS OLD.d AND NEW.profile IS OLD.profile
  AND NEW.rank IS OLD.rank AND NEW.kind IS OLD.kind AND NEW.code IS OLD.code
  AND NEW.published_sha IS OLD.published_sha
  AND (NEW.state IS OLD.state OR (OLD.state || '>' || NEW.state) IN
    ('waiting>bought','waiting>missed','bought>closed'))
  AND (OLD.entry_d IS NULL OR NEW.entry_d IS OLD.entry_d)
  AND (OLD.entry_micro IS NULL OR NEW.entry_micro IS OLD.entry_micro)
  AND (OLD.exit_d IS NULL OR NEW.exit_d IS OLD.exit_d)
  AND (OLD.exit_micro IS NULL OR NEW.exit_micro IS OLD.exit_micro)
  AND (OLD.exit_reason IS NULL OR NEW.exit_reason IS OLD.exit_reason)
  AND (OLD.net_micro IS NULL OR NEW.net_micro IS OLD.net_micro)
  AND (OLD.net_ppm IS NULL OR NEW.net_ppm IS OLD.net_ppm)
  AND NEW.updated_d >= OLD.updated_d)
BEGIN
  SELECT RAISE(ABORT, 'pick_outcome: only the KB state edges, filled once');
END;
CREATE TRIGGER pick_outcome_no_delete BEFORE DELETE ON pick_outcome
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- ---------------------------------------------------------------------------------------------
-- Bake-off report rows (LLM-040..042). `passes` needs a dated trains_on_prompts check.

CREATE TABLE bakeoff_result (
  run_id TEXT NOT NULL CHECK (length(run_id) > 0),
  model_id TEXT NOT NULL CHECK (length(model_id) > 0),
  category TEXT NOT NULL CHECK (length(category) > 0),
  items INTEGER NOT NULL CHECK (items >= 0),
  json_valid_pct REAL NOT NULL CHECK (json_valid_pct >= 0 AND json_valid_pct <= 100),
  invented_numbers INTEGER NOT NULL CHECK (invented_numbers >= 0),
  injection_resistance_pct REAL NOT NULL
    CHECK (injection_resistance_pct >= 0 AND injection_resistance_pct <= 100),
  detection_pct REAL CHECK (detection_pct IS NULL OR (detection_pct >= 0 AND detection_pct <= 100)),
  triage_agreement_pct REAL
    CHECK (triage_agreement_pct IS NULL OR (triage_agreement_pct >= 0 AND triage_agreement_pct <= 100)),
  passes INTEGER NOT NULL CHECK (passes IN (0,1)),
  report_sha TEXT NOT NULL CHECK (length(report_sha) = 64 AND report_sha NOT GLOB '*[^0-9a-f]*'),
  trains_on_prompts_checked_d TEXT CHECK (trains_on_prompts_checked_d IS NULL
    OR trains_on_prompts_checked_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (run_id, model_id, category),
  CHECK (passes = 0 OR trains_on_prompts_checked_d IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER bakeoff_result_no_update BEFORE UPDATE ON bakeoff_result
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER bakeoff_result_no_delete BEFORE DELETE ON bakeoff_result
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- +down
-- Dropping a table drops its triggers and indexes with it (DROP does not fire delete triggers).
-- Rolling back discards learning data; this is meant for development only.
DROP TABLE bakeoff_result;
DROP TABLE pick_outcome;
DROP TABLE pick;
DROP TABLE factor_bucket_stat;
DROP TABLE kb_archive_run;
DROP TABLE document;
DROP TABLE plan_review;
DROP TABLE plan_item;
DROP TABLE playbook_version;
DROP TABLE change_ledger;
DROP TABLE promotion;
DROP TABLE challenger_event;
DROP TABLE challenger;
DROP TABLE critique_note;
DROP TABLE critique;
DROP TABLE comparison_finding;
DROP TABLE comparison_result;
DROP TABLE blocked_trade;
DROP TABLE attribution;
DROP TABLE alpha_wealth;
DROP TABLE lesson_grade;
DROP TABLE lesson;
DROP TABLE lesson_window;
DROP TABLE rule_version_status;
DROP TABLE rule_version;
