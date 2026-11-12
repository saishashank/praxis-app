-- +up
-- M20 A2 (docs/M20_design.md section A "Migration 0036"; D-1096, D-1097, D-1100, D-1101, D-1114, D-1121, D-1122).
-- India and the US are built and off in production: this migration adds the tables their rule sets and readers
-- need, and NOT ONE data row of either market (no calendar, price, announcement or fact row: D-1097, MKT-110 b).
--
-- 1. Nine market-keyed tables, each with its two guard triggers (D-995: a row of a market that is not enabled is
--    refused with `MarketNotEnabled <table>`). The triggers sit in the generated region below
--    (scripts/db/gen-market-guard.mjs; `--check` derives the table list from the schema).
-- 2. market gains `data_only_since` (D-1100: the date the market entered data_only, the five-day rule's start)
--    and `rollback_at` (D-1101: the instant of a full -> off switch, the kill at the next open reads it).
-- 3. The source_register rows of the IN and US candidate sources (D-1096) are NOT inserted here (D-1128): the
--    AT-32 identity baseline hashes source_register, its history and source_status, so the rows would move AU's
--    own hashes. They are defined in src/lib/market/seed/{in,us}/sources.mjs and written on enable.
-- 4. The IN and US profile rows move to the M20 seed (generated regions below, scripts/market/gen-seed-sql.mjs
--    --delta 0034): the four "set at M20" fields, recorded evidence, profile_version 2.

-- 1a. IN daily price-band file (DAT-243 f, ARN-117). band_pct NULL = no band (F&O stocks).
CREATE TABLE price_band (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 32),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  band_pct INTEGER CHECK (band_pct IS NULL OR band_pct BETWEEN 1 AND 100),
  lower_micro INTEGER CHECK (lower_micro IS NULL OR lower_micro >= 0),
  upper_micro INTEGER CHECK (upper_micro IS NULL OR upper_micro >= 0),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  PRIMARY KEY (market, code, d)
) STRICT, WITHOUT ROWID;

-- 1b. IN additional / graded surveillance lists (ASM, GSM; DAT-243 g).
CREATE TABLE surveillance_list (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 32),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  list TEXT NOT NULL CHECK (list IN ('ASM','GSM')),
  stage INTEGER CHECK (stage IS NULL OR stage >= 0),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  PRIMARY KEY (market, code, d, list)
) STRICT, WITHOUT ROWID;

-- 1c. US limit-up/limit-down pauses, exchange halts and SEC suspensions (DAT-244). Append-only; the one change
--     an existing row may take is `resumed_at` from NULL to a value (the halt ended).
CREATE TABLE trading_halt (
  id INTEGER PRIMARY KEY,
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 32),
  kind TEXT NOT NULL CHECK (kind IN ('luld','suspension','halt')),
  halted_at TEXT NOT NULL,
  resumed_at TEXT,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  UNIQUE (market, code, halted_at, kind)
) STRICT;
CREATE INDEX idx_trading_halt_code ON trading_halt (market, code, halted_at);
CREATE TRIGGER trading_halt_resume_only BEFORE UPDATE ON trading_halt
WHEN NOT (
  OLD.resumed_at IS NULL AND NEW.resumed_at IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.market IS OLD.market AND NEW.code IS OLD.code AND NEW.kind IS OLD.kind
  AND NEW.halted_at IS OLD.halted_at AND NEW.reason IS OLD.reason AND NEW.source IS OLD.source
)
BEGIN
  SELECT RAISE(ABORT, 'append-only (only resumed_at may be set, once)');
END;
CREATE TRIGGER trading_halt_no_delete BEFORE DELETE ON trading_halt
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 1d. The category an announcement of a market was classified into (DAT-245/246, D-1108). The append-only
--     `announcement` table is not altered; AU writes no row here.
CREATE TABLE announcement_category (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  ann_id TEXT NOT NULL CHECK (length(ann_id) BETWEEN 1 AND 128),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 64),
  materiality INTEGER NOT NULL CHECK (materiality BETWEEN 0 AND 3),
  verifiable INTEGER NOT NULL CHECK (verifiable IN (0,1)),
  map_version TEXT NOT NULL CHECK (length(map_version) BETWEEN 1 AND 32),
  PRIMARY KEY (market, source, ann_id)
) STRICT, WITHOUT ROWID;

-- 1e. US company facts as filed (DAT-226, AT-38): one row per (concept, period, accession); never updated, so a
--     restatement is a second row with its own filing date and a read "as of" a day sees the first-filed one.
CREATE TABLE fundamental_fact (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 32),
  cik TEXT NOT NULL CHECK (length(cik) BETWEEN 1 AND 16),
  concept TEXT NOT NULL CHECK (length(concept) BETWEEN 1 AND 128),
  unit TEXT NOT NULL CHECK (length(unit) BETWEEN 1 AND 32),
  fy INTEGER,
  fp TEXT,
  period_end TEXT NOT NULL CHECK (period_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  value TEXT NOT NULL,
  form TEXT,
  accession TEXT NOT NULL CHECK (length(accession) BETWEEN 1 AND 32),
  filed_at TEXT NOT NULL,
  PRIMARY KEY (market, code, concept, period_end, accession)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER fundamental_fact_no_update BEFORE UPDATE ON fundamental_fact
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER fundamental_fact_no_delete BEFORE DELETE ON fundamental_fact
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 1f. When a market's end-of-day bar was first seen after its close (D-1105): the measured bar latency that
--     replaces the assumed profile value once five data_only nights exist.
CREATE TABLE bar_latency_sample (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  close_local TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  latency_min INTEGER NOT NULL CHECK (latency_min >= 0),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  PRIMARY KEY (market, d)
) STRICT, WITHOUT ROWID;

-- 1g. The audit trail of a market switch (MKT-111, AT-71): one row per mode/enabled change, with the checklist
--     as it stood. Append-only; mirrored by the auth `audit` row.
CREATE TABLE market_switch (
  id INTEGER PRIMARY KEY,
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  from_mode TEXT NOT NULL CHECK (from_mode IN ('off','data_only','full')),
  to_mode TEXT NOT NULL CHECK (to_mode IN ('off','data_only','full')),
  enabled_after INTEGER NOT NULL CHECK (enabled_after IN (0,1)),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  at TEXT NOT NULL,
  checklist_json TEXT CHECK (checklist_json IS NULL OR json_valid(checklist_json))
) STRICT;
CREATE INDEX idx_market_switch_market ON market_switch (market, id DESC);
CREATE TRIGGER market_switch_no_update BEFORE UPDATE ON market_switch
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER market_switch_no_delete BEFORE DELETE ON market_switch
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 1h. Hand labels of announcements per market (DAT-247, D-1121). Append-only; a relabel is a new row.
CREATE TABLE label_item (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  ann_id TEXT NOT NULL CHECK (length(ann_id) BETWEEN 1 AND 128),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  labelled_at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  PRIMARY KEY (market, source, ann_id, labelled_at)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER label_item_no_update BEFORE UPDATE ON label_item
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER label_item_no_delete BEFORE DELETE ON label_item
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 1i. The holdout-look registry (CXA-015, D-1114): one look per lineage and market, ever. Append-only. M20 writes
--     no row (the per-market calibration runs on the development split only).
CREATE TABLE holdout_look (
  lineage TEXT NOT NULL CHECK (length(lineage) BETWEEN 1 AND 64),
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  looked_at TEXT NOT NULL,
  prereg_sha TEXT NOT NULL CHECK (length(prereg_sha) BETWEEN 7 AND 64),
  verdict TEXT NOT NULL CHECK (length(verdict) BETWEEN 1 AND 32),
  PRIMARY KEY (lineage, market)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER holdout_look_no_update BEFORE UPDATE ON holdout_look
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER holdout_look_no_delete BEFORE DELETE ON holdout_look
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- BEGIN GENERATED guard triggers (scripts/db/gen-market-guard.mjs; do not edit by hand)
-- announcement_category
CREATE TRIGGER announcement_category_market_guard_ins BEFORE INSERT ON announcement_category
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled announcement_category');
END;
CREATE TRIGGER announcement_category_market_guard_upd BEFORE UPDATE OF market ON announcement_category
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled announcement_category');
END;

-- bar_latency_sample
CREATE TRIGGER bar_latency_sample_market_guard_ins BEFORE INSERT ON bar_latency_sample
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled bar_latency_sample');
END;
CREATE TRIGGER bar_latency_sample_market_guard_upd BEFORE UPDATE OF market ON bar_latency_sample
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled bar_latency_sample');
END;

-- fundamental_fact
CREATE TRIGGER fundamental_fact_market_guard_ins BEFORE INSERT ON fundamental_fact
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled fundamental_fact');
END;
CREATE TRIGGER fundamental_fact_market_guard_upd BEFORE UPDATE OF market ON fundamental_fact
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled fundamental_fact');
END;

-- holdout_look
CREATE TRIGGER holdout_look_market_guard_ins BEFORE INSERT ON holdout_look
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled holdout_look');
END;
CREATE TRIGGER holdout_look_market_guard_upd BEFORE UPDATE OF market ON holdout_look
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled holdout_look');
END;

-- label_item
CREATE TRIGGER label_item_market_guard_ins BEFORE INSERT ON label_item
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled label_item');
END;
CREATE TRIGGER label_item_market_guard_upd BEFORE UPDATE OF market ON label_item
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled label_item');
END;

-- market_switch
CREATE TRIGGER market_switch_market_guard_ins BEFORE INSERT ON market_switch
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled market_switch');
END;
CREATE TRIGGER market_switch_market_guard_upd BEFORE UPDATE OF market ON market_switch
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled market_switch');
END;

-- price_band
CREATE TRIGGER price_band_market_guard_ins BEFORE INSERT ON price_band
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled price_band');
END;
CREATE TRIGGER price_band_market_guard_upd BEFORE UPDATE OF market ON price_band
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled price_band');
END;

-- surveillance_list
CREATE TRIGGER surveillance_list_market_guard_ins BEFORE INSERT ON surveillance_list
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled surveillance_list');
END;
CREATE TRIGGER surveillance_list_market_guard_upd BEFORE UPDATE OF market ON surveillance_list
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled surveillance_list');
END;

-- trading_halt
CREATE TRIGGER trading_halt_market_guard_ins BEFORE INSERT ON trading_halt
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled trading_halt');
END;
CREATE TRIGGER trading_halt_market_guard_upd BEFORE UPDATE OF market ON trading_halt
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled trading_halt');
END;

-- END GENERATED guard triggers

-- 2. The switch-on dates (D-1100, D-1101).
ALTER TABLE market ADD COLUMN data_only_since TEXT;
ALTER TABLE market ADD COLUMN rollback_at TEXT;

-- 3. The IN and US source rows (D-1096) are not in this migration (D-1128): they are defined in
--    src/lib/market/seed/{in,us}/sources.mjs and written by ensureMarketSources when a market leaves `off`.
--
-- 4. The IN and US profile rows move to the M20 seed (generated from src/lib/market/seed/*.mjs).
-- BEGIN GENERATED seed delta 0034 up (scripts/market/gen-seed-sql.mjs --delta 0034; do not edit by hand)
UPDATE market_profile SET profile_version = 2 WHERE code = 'IN';
UPDATE market_profile_field SET value_json = '"NSE"', verify = 0, verified_at = '2026-11-13', evidence_ref = 'NSE market timings page: the National Stock Exchange of India equity segment', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'exchange';
UPDATE market_profile_field SET value_json = '"09:15"', verify = 0, verified_at = '2026-11-13', evidence_ref = 'NSE market timings page: normal market opens 09:15 IST', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'session_open';
UPDATE market_profile_field SET value_json = '"15:30"', verify = 0, verified_at = '2026-11-13', evidence_ref = 'NSE market timings page: normal market closes 15:30 IST', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'session_close';
UPDATE market_profile_field SET value_json = '{"kind":"single","at":"09:15","call_auction":{"from":"09:00","to":"09:08"}}', verify = 0, verified_at = '2026-11-13', evidence_ref = 'NSE pre-open session page: order entry 09:00 to 09:08, call auction ends before 09:15', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'opening_auction_window';
UPDATE market_profile_field SET value_json = '"nse_holiday_list"', verify = 0, verified_at = '2026-11-13', evidence_ref = 'NSE public holiday list read in the A3 verification pass (source report row in_nse_holidays)', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'calendar_source';
UPDATE market_profile SET profile_version = 2 WHERE code = 'US';
UPDATE market_profile_field SET value_json = '"09:30"', verify = 0, verified_at = '2026-11-13', evidence_ref = 'NYSE hours and calendars page: core trading session opens 09:30 ET', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'session_open';
UPDATE market_profile_field SET value_json = '"16:00"', verify = 0, verified_at = '2026-11-13', evidence_ref = 'NYSE hours and calendars page: core trading session closes 16:00 ET', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'session_close';
UPDATE market_profile_field SET value_json = '{"kind":"cross","at":"16:00"}', verify = 0, verified_at = '2026-11-13', evidence_ref = 'NYSE hours and calendars page: closing auction at 16:00 ET', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'closing_auction';
UPDATE market_profile_field SET value_json = '{"kind":"single","at":"09:30"}', verify = 0, verified_at = '2026-11-13', evidence_ref = 'NYSE hours and calendars page: core open auction at 09:30 ET', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'opening_auction_window';
UPDATE market_profile_field SET value_json = '"nyse_holiday_list"', verify = 0, verified_at = '2026-11-13', evidence_ref = 'NYSE holiday and early-close list read in the A3 verification pass (source report row us_nyse_holidays)', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'calendar_source';
-- END GENERATED seed delta 0034 up

-- +down
-- The profile rows go back to what 0034 wrote (generated).
-- BEGIN GENERATED seed delta 0034 down (scripts/market/gen-seed-sql.mjs --delta 0034; do not edit by hand)
UPDATE market_profile SET profile_version = 1 WHERE code = 'IN';
UPDATE market_profile_field SET value_json = '"NSE"', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'exchange';
UPDATE market_profile_field SET value_json = '"09:15"', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'session_open';
UPDATE market_profile_field SET value_json = '"15:30"', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'session_close';
UPDATE market_profile_field SET value_json = '{"kind":"single","at":"09:15","call_auction":{"from":"09:00","to":"09:08"}}', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'opening_auction_window';
UPDATE market_profile_field SET value_json = '"nse_holiday_list"', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'calendar_source';
UPDATE market_profile SET profile_version = 1 WHERE code = 'US';
UPDATE market_profile_field SET value_json = '"09:30"', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'session_open';
UPDATE market_profile_field SET value_json = '"16:00"', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'session_close';
UPDATE market_profile_field SET value_json = '{"kind":"cross","at":"16:00"}', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'closing_auction';
UPDATE market_profile_field SET value_json = '{"kind":"single","at":"09:30"}', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'opening_auction_window';
UPDATE market_profile_field SET value_json = '"nyse_holiday_list"', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'calendar_source';
-- END GENERATED seed delta 0034 down
ALTER TABLE market DROP COLUMN rollback_at;
ALTER TABLE market DROP COLUMN data_only_since;
-- The nine tables go with their triggers.
DROP TABLE holdout_look;
DROP TABLE label_item;
DROP TABLE market_switch;
DROP TABLE bar_latency_sample;
DROP TABLE fundamental_fact;
DROP TABLE announcement_category;
DROP TABLE trading_halt;
DROP TABLE surveillance_list;
DROP TABLE price_band;
