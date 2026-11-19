-- +up
-- M22 A1 (docs/M22_design.md section A "Migration 0042"; D-1444, D-1426, D-1419, D-1420, D-1435, D-1437, D-1439).
-- Thirteen STRICT, append-only tables for the Committee trial, the expert library's sources and call proposals, the
-- cluster re-screen, the MiniLM shadow and the alternative regime inputs, and NOT ONE data row. No table of an earlier
-- migration is changed or rebuilt, so the AT-32 identity baseline, the schemaSha of STAGE_TABLES (D-1116) and every AU
-- hash are unchanged. Every table is an opinion or a record: none is read by a trading, sizing, breaker or rule writer.
--
--  1. committee_prereg          the frozen pre-registration of a trial (VAL-111, D-1420), one row per version.
--  2. committee_rating          the judge's rating of a signal (D-1418); hidden everywhere but the trial page (D-1423).
--  3. committee_call            one stored model call (D-1419); the only table deletable, and only after expires_d.
--  4. committee_trial_result    interim and final verdicts of a trial (D-1421).
--  5. opinion_promotion_request one request per market and kind, ever (D-1428).
--  6. expert_source_licence     the licence check per expert and source (D-1430).
--  7. expert_poll_run           one row per poll, discovery or licence job and day.
--  8. expert_call_proposal      a proposed expert call, complete or not (D-1435).
--  9. expert_call_confirm       the audited confirmation of one proposal (D-1435).
-- 10. cluster_expression        a parked cluster's expression or park reason (D-1437, D-1438).
-- 11. minilm_shadow             the local classifier's shadow reading (D-1416).
-- 12. regime_alt_reading        the shadow regime reading from alt inputs (D-1440).
-- 13. alt_input_point           one prediction-market probability per source, event and day (D-1439).
-- Eight of the thirteen carry a `market` column and get the two guard triggers (D-1810, D-1820; generated region below,
-- scripts/db/gen-market-guard.mjs; `--check` derives the table list from the schema).

-- 1. Pre-registration: version 1 is written before any rating; a later version marks the trial INVALID (D-1420).
CREATE TABLE committee_prereg (
  trial_id TEXT NOT NULL CHECK (length(trial_id) BETWEEN 1 AND 64),
  version INTEGER NOT NULL CHECK (version >= 1),
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  frozen_json TEXT NOT NULL CHECK (json_valid(frozen_json) AND json_type(frozen_json) = 'object' AND length(frozen_json) <= 4000),
  sha TEXT NOT NULL CHECK (length(sha) = 64 AND sha NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  PRIMARY KEY (trial_id, version)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER committee_prereg_no_update BEFORE UPDATE ON committee_prereg
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER committee_prereg_no_delete BEFORE DELETE ON committee_prereg
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 2. The rating of one signal on one night. A rating that was not produced carries its reason as the rating value.
CREATE TABLE committee_rating (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  signal_id TEXT NOT NULL CHECK (length(signal_id) BETWEEN 1 AND 64),
  trial_id TEXT NOT NULL CHECK (length(trial_id) BETWEEN 1 AND 64),
  pack_id TEXT NOT NULL CHECK (length(pack_id) BETWEEN 1 AND 64),
  rating TEXT NOT NULL CHECK (rating IN ('approve','neutral','reject','skipped_budget','skipped_time','skipped_models','failed')),
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json) AND json_type(reasons_json) = 'array' AND json_array_length(reasons_json) <= 5 AND length(reasons_json) <= 2000),
  bull_model TEXT CHECK (bull_model IS NULL OR length(bull_model) BETWEEN 1 AND 128),
  bear_model TEXT CHECK (bear_model IS NULL OR length(bear_model) BETWEEN 1 AND 128),
  risk_model TEXT CHECK (risk_model IS NULL OR length(risk_model) BETWEEN 1 AND 128),
  judge_model TEXT CHECK (judge_model IS NULL OR length(judge_model) BETWEEN 1 AND 128),
  same_family INTEGER NOT NULL CHECK (same_family IN (0,1)),
  timings_json TEXT NOT NULL CHECK (json_valid(timings_json) AND length(timings_json) <= 2000),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  PRIMARY KEY (market, d, signal_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_committee_rating_trial ON committee_rating (trial_id, d);
CREATE TRIGGER committee_rating_no_update BEFORE UPDATE ON committee_rating
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER committee_rating_no_delete BEFORE DELETE ON committee_rating
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 3. One row per stored model call (id = the llm_call id). Never updated; a row is deletable only once expires_d is
--    in the past (the llm_cache prune pattern, 0008_agents.sql), so the maintenance job can prune it (D-1419).
CREATE TABLE committee_call (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  signal_id TEXT NOT NULL CHECK (length(signal_id) BETWEEN 1 AND 64),
  stage TEXT NOT NULL CHECK (stage IN ('bull','bear','risk','judge')),
  prompt_sha TEXT NOT NULL CHECK (length(prompt_sha) BETWEEN 1 AND 128),
  pack_id TEXT NOT NULL CHECK (length(pack_id) BETWEEN 1 AND 64),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 128),
  model_version TEXT NOT NULL CHECK (length(model_version) BETWEEN 1 AND 128),
  params_json TEXT NOT NULL CHECK (json_valid(params_json) AND length(params_json) <= 2000),
  raw_response TEXT NOT NULL CHECK (length(raw_response) <= 8000),
  parsed_json TEXT CHECK (parsed_json IS NULL OR (json_valid(parsed_json) AND length(parsed_json) <= 8000)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  expires_d TEXT NOT NULL CHECK (expires_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_committee_call_signal ON committee_call (market, d, signal_id, stage);
CREATE INDEX idx_committee_call_expires ON committee_call (expires_d);
CREATE TRIGGER committee_call_no_update BEFORE UPDATE ON committee_call
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER committee_call_prune_only BEFORE DELETE ON committee_call
WHEN OLD.expires_d >= strftime('%Y-%m-%d', 'now')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only after expiry)');
END;

-- 4. Interim rows are labelled "interim, not a result" in the app; the final row is written once (D-1421).
CREATE TABLE committee_trial_result (
  trial_id TEXT NOT NULL CHECK (length(trial_id) BETWEEN 1 AND 64),
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kind TEXT NOT NULL CHECK (kind IN ('interim','final')),
  verdict TEXT NOT NULL CHECK (verdict IN ('running','PASS','FAIL','INCONCLUSIVE','INVALID')),
  stats_json TEXT NOT NULL CHECK (json_valid(stats_json) AND json_type(stats_json) = 'object' AND length(stats_json) <= 4000),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  PRIMARY KEY (trial_id, market, d, kind)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER committee_trial_result_no_update BEFORE UPDATE ON committee_trial_result
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER committee_trial_result_no_delete BEFORE DELETE ON committee_trial_result
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 5. One request per market and kind, ever (D-1428). There is no approve action anywhere.
CREATE TABLE opinion_promotion_request (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  kind TEXT NOT NULL CHECK (kind IN ('steelman','committee')),
  requested_d TEXT NOT NULL CHECK (requested_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object' AND length(evidence_json) <= 4000),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  PRIMARY KEY (market, kind)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER opinion_promotion_request_no_update BEFORE UPDATE ON opinion_promotion_request
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER opinion_promotion_request_no_delete BEFORE DELETE ON opinion_promotion_request
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 6. The licence check of one source for one expert; a re-check is a new row (a later checked_at) (D-1430).
CREATE TABLE expert_source_licence (
  expert_id TEXT NOT NULL CHECK (length(expert_id) BETWEEN 1 AND 32),
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 64),
  checked_at TEXT NOT NULL CHECK (checked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  terms_url TEXT CHECK (terms_url IS NULL OR length(terms_url) <= 500),
  robots TEXT NOT NULL CHECK (robots IN ('allows','disallows','absent','unreachable')),
  summarisation TEXT NOT NULL CHECK (summarisation IN ('yes','no','unknown')),
  status TEXT NOT NULL CHECK (status IN ('unchecked','enabled','owner-accepted-risk','no')),
  actor TEXT NOT NULL CHECK (actor IN ('job','owner','import')),
  note TEXT CHECK (note IS NULL OR length(note) <= 200),
  PRIMARY KEY (expert_id, source_key, checked_at)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_expert_source_licence_source ON expert_source_licence (source_key, checked_at);
CREATE TRIGGER expert_source_licence_insert_guard BEFORE INSERT ON expert_source_licence
WHEN NOT EXISTS (SELECT 1 FROM expert e WHERE e.id = NEW.expert_id)
BEGIN
  SELECT RAISE(ABORT, 'expert_source_licence: expert must exist');
END;
CREATE TRIGGER expert_source_licence_no_update BEFORE UPDATE ON expert_source_licence
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER expert_source_licence_no_delete BEFORE DELETE ON expert_source_licence
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 7. One row per job kind and day (D-1429); the counts are plain numbers.
CREATE TABLE expert_poll_run (
  kind TEXT NOT NULL CHECK (kind IN ('poll','discovery','licence')),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  counts_json TEXT NOT NULL CHECK (json_valid(counts_json) AND json_type(counts_json) = 'object' AND length(counts_json) <= 2000),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  PRIMARY KEY (kind, d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER expert_poll_run_no_update BEFORE UPDATE ON expert_poll_run
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER expert_poll_run_no_delete BEFORE DELETE ON expert_poll_run
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 8. A proposed call. 'complete' needs the code, direction, date and horizon (CHECK); an incomplete or untrackable
--    proposal keeps its reason and can never be confirmed (see expert_call_confirm).
CREATE TABLE expert_call_proposal (
  proposal_id TEXT PRIMARY KEY CHECK (length(proposal_id) = 64 AND proposal_id NOT GLOB '*[^0-9a-f]*'),
  claim_id TEXT NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 32),
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  code TEXT CHECK (code IS NULL OR length(code) BETWEEN 1 AND 32),
  direction TEXT CHECK (direction IS NULL OR direction IN ('long','short')),
  call_d TEXT CHECK (call_d IS NULL OR call_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  horizon_sessions INTEGER CHECK (horizon_sessions IS NULL OR horizon_sessions >= 1),
  price_basis TEXT NOT NULL CHECK (price_basis IN ('close','open','unspecified')),
  target_micro INTEGER CHECK (target_micro IS NULL OR target_micro > 0),
  stop_micro INTEGER CHECK (stop_micro IS NULL OR stop_micro > 0),
  state TEXT NOT NULL CHECK (state IN ('complete','incomplete','not_trackable')),
  reason TEXT NOT NULL CHECK (length(reason) <= 200),
  source TEXT NOT NULL CHECK (source IN ('rules','model','owner')),
  model_id TEXT CHECK (model_id IS NULL OR length(model_id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  CHECK (state <> 'complete' OR (code IS NOT NULL AND direction IS NOT NULL AND call_d IS NOT NULL AND horizon_sessions IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_expert_call_proposal_claim ON expert_call_proposal (claim_id);
CREATE TRIGGER expert_call_proposal_insert_guard BEFORE INSERT ON expert_call_proposal
WHEN NOT EXISTS (SELECT 1 FROM claim c WHERE c.id = NEW.claim_id AND c.type = 'call')
BEGIN
  SELECT RAISE(ABORT, 'expert_call_proposal: needs a claim of type call');
END;
CREATE TRIGGER expert_call_proposal_no_update BEFORE UPDATE ON expert_call_proposal
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER expert_call_proposal_no_delete BEFORE DELETE ON expert_call_proposal
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 9. The confirmation: one per claim; the proposal exists, is complete and names the claim. No market column: the
--    proposal it points at is guarded.
CREATE TABLE expert_call_confirm (
  claim_id TEXT PRIMARY KEY CHECK (length(claim_id) BETWEEN 1 AND 32),
  proposal_id TEXT NOT NULL CHECK (length(proposal_id) = 64 AND proposal_id NOT GLOB '*[^0-9a-f]*'),
  price_basis TEXT NOT NULL CHECK (price_basis IN ('close','open')),
  confirmed_by TEXT NOT NULL CHECK (length(confirmed_by) BETWEEN 1 AND 64),
  confirmed_at TEXT NOT NULL CHECK (confirmed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER expert_call_confirm_insert_guard BEFORE INSERT ON expert_call_confirm
WHEN NOT EXISTS (
  SELECT 1 FROM expert_call_proposal p
  WHERE p.proposal_id = NEW.proposal_id AND p.claim_id = NEW.claim_id AND p.state = 'complete'
)
BEGIN
  SELECT RAISE(ABORT, 'expert_call_confirm: needs a complete proposal of this claim');
END;
CREATE TRIGGER expert_call_confirm_no_update BEFORE UPDATE ON expert_call_confirm
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER expert_call_confirm_no_delete BEFORE DELETE ON expert_call_confirm
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 10. One expression per parked cluster and version (D-1437): either an expressed rule with its exit and the sha of
--     its pre-registration text, or a park reason (D-1438). No market column: clusters belong to no market.
CREATE TABLE cluster_expression (
  cluster_id TEXT NOT NULL CHECK (length(cluster_id) BETWEEN 1 AND 32),
  version INTEGER NOT NULL CHECK (version >= 1),
  outcome TEXT NOT NULL CHECK (outcome IN ('expressed','parked')),
  rule_json TEXT CHECK (rule_json IS NULL OR (json_valid(rule_json) AND length(rule_json) <= 4000)),
  exit_json TEXT CHECK (exit_json IS NULL OR (json_valid(exit_json) AND length(exit_json) <= 2000)),
  park_reason TEXT CHECK (park_reason IS NULL OR park_reason IN ('blocked_data','needs_intraday','discretionary','overlay_only','duplicate','not_testable')),
  reason_text TEXT NOT NULL CHECK (length(reason_text) <= 200),
  prereg_sha TEXT CHECK (prereg_sha IS NULL OR (length(prereg_sha) = 64 AND prereg_sha NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  PRIMARY KEY (cluster_id, version),
  CHECK ((outcome = 'expressed') = (rule_json IS NOT NULL AND exit_json IS NOT NULL AND prereg_sha IS NOT NULL)),
  CHECK ((outcome = 'parked') = (park_reason IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cluster_expression_insert_guard BEFORE INSERT ON cluster_expression
WHEN NOT EXISTS (SELECT 1 FROM cluster c WHERE c.id = NEW.cluster_id)
BEGIN
  SELECT RAISE(ABORT, 'cluster_expression: cluster must exist');
END;
CREATE TRIGGER cluster_expression_no_update BEFORE UPDATE ON cluster_expression
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cluster_expression_no_delete BEFORE DELETE ON cluster_expression
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 11. The local classifier's shadow reading next to the rule classifier's (D-1416). Nothing reads it.
CREATE TABLE minilm_shadow (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  ann_id TEXT NOT NULL CHECK (length(ann_id) BETWEEN 1 AND 128),
  rule_category TEXT NOT NULL CHECK (length(rule_category) BETWEEN 1 AND 64),
  model_category TEXT NOT NULL CHECK (length(model_category) BETWEEN 1 AND 64),
  rule_material INTEGER NOT NULL CHECK (rule_material IN (0,1)),
  model_material INTEGER NOT NULL CHECK (model_material IN (0,1)),
  model_sha TEXT NOT NULL CHECK (length(model_sha) = 64 AND model_sha NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  PRIMARY KEY (market, d, source, ann_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER minilm_shadow_no_update BEFORE UPDATE ON minilm_shadow
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER minilm_shadow_no_delete BEFORE DELETE ON minilm_shadow
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 12. The shadow regime reading from the alternative inputs, next to the base state (D-1440, D-1441).
CREATE TABLE regime_alt_reading (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  base_state TEXT NOT NULL CHECK (length(base_state) BETWEEN 1 AND 32),
  alt_state TEXT NOT NULL CHECK (length(alt_state) BETWEEN 1 AND 32),
  inputs_status TEXT NOT NULL CHECK (inputs_status IN ('ok','partial','unavailable')),
  inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json) AND length(inputs_json) <= 4000),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  PRIMARY KEY (market, d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER regime_alt_reading_no_update BEFORE UPDATE ON regime_alt_reading
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER regime_alt_reading_no_delete BEFORE DELETE ON regime_alt_reading
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 13. One probability per source, event and day, in parts per million. No market column: the events are global, and a
--     write needs the register row enabled (D-1439), which the writer checks.
CREATE TABLE alt_input_point (
  source TEXT NOT NULL CHECK (source IN ('polymarket','kalshi')),
  event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 128),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  prob_ppm INTEGER NOT NULL CHECK (prob_ppm BETWEEN 0 AND 1000000),
  fetched_at TEXT NOT NULL CHECK (fetched_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  PRIMARY KEY (source, event_key, d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER alt_input_point_no_update BEFORE UPDATE ON alt_input_point
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER alt_input_point_no_delete BEFORE DELETE ON alt_input_point
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- BEGIN GENERATED guard triggers (scripts/db/gen-market-guard.mjs; do not edit by hand)
-- committee_call
CREATE TRIGGER committee_call_market_guard_ins BEFORE INSERT ON committee_call
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled committee_call');
END;
CREATE TRIGGER committee_call_market_guard_upd BEFORE UPDATE OF market ON committee_call
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled committee_call');
END;

-- committee_prereg
CREATE TRIGGER committee_prereg_market_guard_ins BEFORE INSERT ON committee_prereg
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled committee_prereg');
END;
CREATE TRIGGER committee_prereg_market_guard_upd BEFORE UPDATE OF market ON committee_prereg
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled committee_prereg');
END;

-- committee_rating
CREATE TRIGGER committee_rating_market_guard_ins BEFORE INSERT ON committee_rating
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled committee_rating');
END;
CREATE TRIGGER committee_rating_market_guard_upd BEFORE UPDATE OF market ON committee_rating
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled committee_rating');
END;

-- committee_trial_result
CREATE TRIGGER committee_trial_result_market_guard_ins BEFORE INSERT ON committee_trial_result
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled committee_trial_result');
END;
CREATE TRIGGER committee_trial_result_market_guard_upd BEFORE UPDATE OF market ON committee_trial_result
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled committee_trial_result');
END;

-- expert_call_proposal
CREATE TRIGGER expert_call_proposal_market_guard_ins BEFORE INSERT ON expert_call_proposal
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled expert_call_proposal');
END;
CREATE TRIGGER expert_call_proposal_market_guard_upd BEFORE UPDATE OF market ON expert_call_proposal
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled expert_call_proposal');
END;

-- minilm_shadow
CREATE TRIGGER minilm_shadow_market_guard_ins BEFORE INSERT ON minilm_shadow
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled minilm_shadow');
END;
CREATE TRIGGER minilm_shadow_market_guard_upd BEFORE UPDATE OF market ON minilm_shadow
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled minilm_shadow');
END;

-- opinion_promotion_request
CREATE TRIGGER opinion_promotion_request_market_guard_ins BEFORE INSERT ON opinion_promotion_request
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled opinion_promotion_request');
END;
CREATE TRIGGER opinion_promotion_request_market_guard_upd BEFORE UPDATE OF market ON opinion_promotion_request
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled opinion_promotion_request');
END;

-- regime_alt_reading
CREATE TRIGGER regime_alt_reading_market_guard_ins BEFORE INSERT ON regime_alt_reading
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled regime_alt_reading');
END;
CREATE TRIGGER regime_alt_reading_market_guard_upd BEFORE UPDATE OF market ON regime_alt_reading
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled regime_alt_reading');
END;

-- END GENERATED guard triggers

-- +down
-- The thirteen tables go with their triggers (the guard triggers are dropped with their tables). Children first.
DROP TABLE alt_input_point;
DROP TABLE regime_alt_reading;
DROP TABLE minilm_shadow;
DROP TABLE cluster_expression;
DROP TABLE expert_call_confirm;
DROP TABLE expert_call_proposal;
DROP TABLE expert_poll_run;
DROP TABLE expert_source_licence;
DROP TABLE opinion_promotion_request;
DROP TABLE committee_trial_result;
DROP TABLE committee_call;
DROP TABLE committee_rating;
DROP TABLE committee_prereg;
