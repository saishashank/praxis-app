-- +up
-- M23 A1 (docs/M23_design.md section A "Migration 0043"; D-1602, D-1603, D-1611, D-1650).
-- Eight STRICT, append-only tables for the research registry, the forward meters, the residual monitors, the sector index
-- series, the model-written proposals and the SHOCK comparator, two insert triggers on the existing `holdout_look`, and NOT
-- ONE data row. No table of an earlier migration is changed or rebuilt, so the AT-32 identity baseline, the schemaSha of
-- STAGE_TABLES (D-1116) and every AU hash are unchanged. Every table is a record or an opinion: none is read by a trading,
-- sizing, breaker or rule writer (PRD-033).
--
--  1. research_prereg       the frozen pre-registration of a look, one row per lineage and market (D-1603).
--  2. holdout_look_refusal  every refused second look, with its caller (D-1604).
--  3. research_result       the numbers of a finished look (D-1605).
--  4. research_meter        the forward n of an item that waits for sample (D-1623).
--  5. residual_monitor      one reading of one of the eight background watches (D-1614).
--  6. sector_index          the daily industry-group index series (D-1632).
--  7. angle_proposal        a model-written proposal, stored or refused (D-1636).
--  8. shock_stop_outcome    the SHOCK comparator's paired outcomes (D-1638).
-- All eight carry a `market` column and get the two guard triggers (D-1810, D-1820; generated region below,
-- scripts/db/gen-market-guard.mjs; `--check` derives the table list from the schema).

-- 1. Pre-registration (hash first): a look without a row here with the same sha is refused (trigger in section 9).
CREATE TABLE research_prereg (
  lineage TEXT NOT NULL CHECK (length(lineage) BETWEEN 1 AND 64),
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  item TEXT NOT NULL CHECK (item IN ('CXA-003','CXA-004','CXA-008','CXA-009','CXA-011','CXA-014','VAL-118','DAT-248','VAL-121','VAL-111','M15')),
  frozen_json TEXT NOT NULL CHECK (json_valid(frozen_json) AND length(frozen_json) <= 8000),
  sha TEXT NOT NULL CHECK (length(sha) = 64 AND sha NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  PRIMARY KEY (lineage, market)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER research_prereg_no_update BEFORE UPDATE ON research_prereg
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER research_prereg_no_delete BEFORE DELETE ON research_prereg
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 2. A second look at a finished test, refused and audited (the refusal itself is the row).
CREATE TABLE holdout_look_refusal (
  lineage TEXT NOT NULL CHECK (length(lineage) BETWEEN 1 AND 64),
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  at TEXT NOT NULL CHECK (at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  prereg_sha TEXT NOT NULL CHECK (length(prereg_sha) BETWEEN 7 AND 64),
  caller TEXT NOT NULL CHECK (length(caller) BETWEEN 1 AND 64),
  PRIMARY KEY (lineage, market, at)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER holdout_look_refusal_no_update BEFORE UPDATE ON holdout_look_refusal
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER holdout_look_refusal_no_delete BEFORE DELETE ON holdout_look_refusal
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 3. The numbers of a finished look (one per lineage and market, like the look itself).
CREATE TABLE research_result (
  lineage TEXT NOT NULL CHECK (length(lineage) BETWEEN 1 AND 64),
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  looked_at TEXT NOT NULL CHECK (looked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  prereg_sha TEXT NOT NULL CHECK (length(prereg_sha) BETWEEN 7 AND 64),
  n_setups INTEGER NOT NULL CHECK (n_setups >= 0),
  n_blocks INTEGER NOT NULL CHECK (n_blocks >= 0),
  stats_json TEXT NOT NULL CHECK (json_valid(stats_json) AND length(stats_json) <= 4000),
  PRIMARY KEY (lineage, market)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER research_result_no_update BEFORE UPDATE ON research_result
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER research_result_no_delete BEFORE DELETE ON research_result
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 4. The forward n of an item that waits for sample: one row per lineage and day.
CREATE TABLE research_meter (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  lineage TEXT NOT NULL CHECK (length(lineage) BETWEEN 1 AND 64),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  n INTEGER NOT NULL CHECK (n >= 0),
  target INTEGER NOT NULL CHECK (target >= 1),
  projected_d TEXT CHECK (projected_d IS NULL OR projected_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('collecting','met','looked','blocked')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  PRIMARY KEY (market, lineage, d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER research_meter_no_update BEFORE UPDATE ON research_meter
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER research_meter_no_delete BEFORE DELETE ON research_meter
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 5. One reading of one of the eight residual monitors, per market and period (a quarter or a calendar window).
CREATE TABLE residual_monitor (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  monitor INTEGER NOT NULL CHECK (monitor BETWEEN 1 AND 8),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-Q[1-4]' OR period GLOB 'cal-*'),
  value_json TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 4000),
  alarm INTEGER NOT NULL CHECK (alarm IN (0,1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  PRIMARY KEY (market, monitor, period)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER residual_monitor_no_update BEFORE UPDATE ON residual_monitor
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER residual_monitor_no_delete BEFORE DELETE ON residual_monitor
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 6. The industry-group index series, equal and value weighted, in parts per million.
CREATE TABLE sector_index (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  group_code TEXT NOT NULL CHECK (length(group_code) BETWEEN 1 AND 32),
  weighting TEXT NOT NULL CHECK (weighting IN ('equal','value')),
  ret_ppm INTEGER NOT NULL,
  level_ppm INTEGER NOT NULL,
  n_members INTEGER NOT NULL CHECK (n_members >= 0),
  map_as_of TEXT NOT NULL CHECK (map_as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  PRIMARY KEY (market, d, group_code, weighting)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER sector_index_no_update BEFORE UPDATE ON sector_index
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER sector_index_no_delete BEFORE DELETE ON sector_index
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 7. A model-written proposal, stored or refused with its reason; a stored one carries its rule, a refused one never does.
CREATE TABLE angle_proposal (
  proposal_id TEXT NOT NULL PRIMARY KEY CHECK (length(proposal_id) = 64 AND proposal_id NOT GLOB '*[^0-9a-f]*'),
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  kind TEXT NOT NULL CHECK (kind IN ('angle','challenger')),
  state TEXT NOT NULL CHECK (state IN ('stored','refused_schema','refused_duplicate','refused_weight','refused_hostile')),
  rule_json TEXT CHECK (rule_json IS NULL OR (json_valid(rule_json) AND length(rule_json) <= 4000)),
  orientation TEXT CHECK (orientation IS NULL OR orientation IN ('long','avoid')),
  cluster TEXT CHECK (cluster IS NULL OR length(cluster) BETWEEN 1 AND 64),
  evidence_json TEXT CHECK (evidence_json IS NULL OR (json_valid(evidence_json) AND length(evidence_json) <= 4000)),
  model_id TEXT CHECK (model_id IS NULL OR length(model_id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  CHECK ((state = 'stored') = (rule_json IS NOT NULL))
) STRICT;
CREATE INDEX idx_angle_proposal_month ON angle_proposal (market, month);
CREATE TRIGGER angle_proposal_no_update BEFORE UPDATE ON angle_proposal
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER angle_proposal_no_delete BEFORE DELETE ON angle_proposal
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 8. The SHOCK comparator: the base stop and the tighter stop on the same entry, in parts per million net.
CREATE TABLE shock_stop_outcome (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  family TEXT NOT NULL CHECK (length(family) BETWEEN 1 AND 32),
  origin TEXT NOT NULL CHECK (length(origin) BETWEEN 1 AND 64),
  d_entry TEXT NOT NULL CHECK (d_entry GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  d_shock TEXT NOT NULL CHECK (d_shock GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  base_net_ppm INTEGER NOT NULL,
  tight_net_ppm INTEGER NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  PRIMARY KEY (market, family, origin)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER shock_stop_outcome_no_update BEFORE UPDATE ON shock_stop_outcome
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER shock_stop_outcome_no_delete BEFORE DELETE ON shock_stop_outcome
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 9. The two registry triggers on the existing `holdout_look` (the table is not changed; D-1602, D-1603, D-1650).
--    The three M20 to M22 writers (short shadow, alternative regime, Committee trial) write the legacy words and no
--    pre-registration row until task A2 moves them onto the registry, so their three lineages are exempt: a row of any
--    other lineage needs a research_prereg row with the same sha and the verdict PASS, NULL or INCONCLUSIVE.
--    Each probe is one primary-key read of research_prereg (lineage, market).
CREATE TRIGGER holdout_look_prereg_ins BEFORE INSERT ON holdout_look
WHEN NEW.lineage NOT IN ('short_shadow', 'regime_altinputs', 'committee_trial')
  AND NOT EXISTS (SELECT 1 FROM research_prereg WHERE lineage = NEW.lineage AND market = NEW.market AND sha = NEW.prereg_sha)
BEGIN
  SELECT RAISE(ABORT, 'PreregistrationMissing holdout_look');
END;
CREATE TRIGGER holdout_look_verdict_ins BEFORE INSERT ON holdout_look
WHEN NEW.lineage NOT IN ('short_shadow', 'regime_altinputs', 'committee_trial')
  AND NEW.verdict NOT IN ('PASS', 'NULL', 'INCONCLUSIVE')
BEGIN
  SELECT RAISE(ABORT, 'VerdictVocabulary holdout_look');
END;

-- BEGIN GENERATED guard triggers (scripts/db/gen-market-guard.mjs; do not edit by hand)
-- angle_proposal
CREATE TRIGGER angle_proposal_market_guard_ins BEFORE INSERT ON angle_proposal
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled angle_proposal');
END;
CREATE TRIGGER angle_proposal_market_guard_upd BEFORE UPDATE OF market ON angle_proposal
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled angle_proposal');
END;

-- holdout_look_refusal
CREATE TRIGGER holdout_look_refusal_market_guard_ins BEFORE INSERT ON holdout_look_refusal
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled holdout_look_refusal');
END;
CREATE TRIGGER holdout_look_refusal_market_guard_upd BEFORE UPDATE OF market ON holdout_look_refusal
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled holdout_look_refusal');
END;

-- research_meter
CREATE TRIGGER research_meter_market_guard_ins BEFORE INSERT ON research_meter
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled research_meter');
END;
CREATE TRIGGER research_meter_market_guard_upd BEFORE UPDATE OF market ON research_meter
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled research_meter');
END;

-- research_prereg
CREATE TRIGGER research_prereg_market_guard_ins BEFORE INSERT ON research_prereg
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled research_prereg');
END;
CREATE TRIGGER research_prereg_market_guard_upd BEFORE UPDATE OF market ON research_prereg
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled research_prereg');
END;

-- research_result
CREATE TRIGGER research_result_market_guard_ins BEFORE INSERT ON research_result
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled research_result');
END;
CREATE TRIGGER research_result_market_guard_upd BEFORE UPDATE OF market ON research_result
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled research_result');
END;

-- residual_monitor
CREATE TRIGGER residual_monitor_market_guard_ins BEFORE INSERT ON residual_monitor
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled residual_monitor');
END;
CREATE TRIGGER residual_monitor_market_guard_upd BEFORE UPDATE OF market ON residual_monitor
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled residual_monitor');
END;

-- sector_index
CREATE TRIGGER sector_index_market_guard_ins BEFORE INSERT ON sector_index
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled sector_index');
END;
CREATE TRIGGER sector_index_market_guard_upd BEFORE UPDATE OF market ON sector_index
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled sector_index');
END;

-- shock_stop_outcome
CREATE TRIGGER shock_stop_outcome_market_guard_ins BEFORE INSERT ON shock_stop_outcome
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled shock_stop_outcome');
END;
CREATE TRIGGER shock_stop_outcome_market_guard_upd BEFORE UPDATE OF market ON shock_stop_outcome
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled shock_stop_outcome');
END;

-- END GENERATED guard triggers

-- +down
-- The eight tables go with their triggers (the guard triggers are dropped with their tables); the two registry triggers
-- sit on holdout_look and are dropped first. Rows written to holdout_look stay (the table is not touched).
DROP TRIGGER holdout_look_verdict_ins;
DROP TRIGGER holdout_look_prereg_ins;
DROP TABLE shock_stop_outcome;
DROP TABLE angle_proposal;
DROP TABLE sector_index;
DROP TABLE residual_monitor;
DROP TABLE research_meter;
DROP TABLE research_result;
DROP TABLE holdout_look_refusal;
DROP TABLE research_prereg;
