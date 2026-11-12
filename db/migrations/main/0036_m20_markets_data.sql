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
--    own hashes. They are kept below as a comment, with their statuses, for the stream that settles that scope.
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

-- 3. DEFERRED (D-1128): the IN and US candidate sources of D-1096. The AT-32 identity baseline hashes
--    source_register, source_register_history and source_status, so rows added here would move AU's own
--    hashes; the rows below are kept as comments, ready to enable together with the replayHash scope decision.
-- | 3. The IN and US candidate sources (D-1096). enabled: public statistics, EDGAR (free, fair-access terms),
-- |    SEC suspensions, holiday lists, manual CSV uploads. pending: Yahoo (O-26 basis), exchange archives and
-- |    files, SEBI, XBRL, FINRA, Stooq, Nasdaq halts, FRED (Owner key). disabled: NSE and BSE announcements until
-- |    the Owner accepts the terms risk (O-23 pattern; headline and link only when enabled, D-1125).
-- | INSERT INTO source_register (source, permitted_use, risk, status, owner_ref, summarisation_permitted)
-- | VALUES
-- |   ('in_yahoo_ns', 'personal use only (DAT-124); India end-of-day prices under the Yahoo risk basis O-26', 'high', 'pending', 'O-26', 0),
-- |   ('in_nse_bhavcopy', 'NSE daily bhavcopy file; off until its terms are checked (DAT-121)', 'high', 'pending', NULL, 0),
-- |   ('in_nse_announcements', 'NSE corporate announcements: headline and link only, never a body (D-1125); off until the Owner accepts the terms', 'high', 'disabled', NULL, 0),
-- |   ('in_bse_announcements', 'BSE corporate announcements: headline and link only, never a body (D-1125); off until the Owner accepts the terms', 'high', 'disabled', NULL, 0),
-- |   ('in_nse_classification', 'NSE industry classification file', 'medium', 'pending', NULL, 0),
-- |   ('in_nse_fo_oi', 'NSE futures and options open-interest file', 'medium', 'pending', NULL, 0),
-- |   ('in_nse_slb', 'NSE securities lending and borrowing file', 'medium', 'pending', NULL, 0),
-- |   ('in_sebi_pit_sast', 'SEBI insider-trading (PIT) and takeover (SAST) disclosures', 'medium', 'pending', NULL, 0),
-- |   ('in_nse_bands', 'NSE daily price-band file', 'medium', 'pending', NULL, 0),
-- |   ('in_nse_asm_gsm', 'NSE additional and graded surveillance lists', 'medium', 'pending', NULL, 0),
-- |   ('in_nse_indices_manual', 'manual CSV upload by the Owner (Nifty index membership)', 'low', 'enabled', NULL, 0),
-- |   ('in_nse_board_meetings', 'NSE board-meeting calendar', 'medium', 'pending', NULL, 0),
-- |   ('in_nse_bse_xbrl', 'NSE and BSE XBRL financial results', 'medium', 'pending', NULL, 0),
-- |   ('in_rbi', 'public statistics of the Reserve Bank of India: derived numbers only, source named', 'low', 'enabled', NULL, 0),
-- |   ('in_mospi', 'public statistics of the Ministry of Statistics (MoSPI): derived numbers only, source named', 'low', 'enabled', NULL, 0),
-- |   ('in_nse_holidays', 'public NSE trading-holiday list', 'low', 'enabled', NULL, 0),
-- |   ('us_yahoo', 'personal use only (DAT-124); US end-of-day prices under the Yahoo risk basis O-26', 'high', 'pending', 'O-26', 0),
-- |   ('us_stooq', 'Stooq daily price files; off until its terms are checked', 'medium', 'pending', NULL, 0),
-- |   ('us_edgar', 'SEC EDGAR public filings, company facts and Form 4: free, fair-access terms, declared User-Agent required, at most 2 requests a second (D-1094)', 'low', 'enabled', NULL, 1),
-- |   ('us_finra_short', 'FINRA short-interest and short-volume files; licence to be verified', 'medium', 'pending', NULL, 0),
-- |   ('us_nasdaq_halts', 'Nasdaq Trader trading-halt feed', 'medium', 'pending', NULL, 0),
-- |   ('us_sec_suspensions', 'public SEC trading suspensions', 'low', 'enabled', NULL, 1),
-- |   ('us_sp_dji_russell_manual', 'manual CSV upload by the Owner (S&P, Dow Jones and Russell index membership)', 'low', 'enabled', NULL, 0),
-- |   ('us_fred', 'FRED macro series: needs the Owner key; off until it is stored', 'low', 'pending', NULL, 0),
-- |   ('us_nyse_holidays', 'public NYSE trading-holiday list', 'low', 'enabled', NULL, 0);
-- | INSERT INTO source_status (source, mode, since)
-- | VALUES
-- |   ('in_yahoo_ns', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_nse_bhavcopy', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_nse_announcements', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_bse_announcements', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_nse_classification', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_nse_fo_oi', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_nse_slb', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_sebi_pit_sast', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_nse_bands', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_nse_asm_gsm', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_nse_indices_manual', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_nse_board_meetings', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_nse_bse_xbrl', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_rbi', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_mospi', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('in_nse_holidays', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('us_yahoo', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('us_stooq', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('us_edgar', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('us_finra_short', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('us_nasdaq_halts', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('us_sec_suspensions', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('us_sp_dji_russell_manual', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('us_fred', 'on', '2026-11-12T00:00:00.000Z'),
-- |   ('us_nyse_holidays', 'on', '2026-11-12T00:00:00.000Z');
--
-- 4. The IN and US profile rows move to the M20 seed (generated from src/lib/market/seed/*.mjs).
-- BEGIN GENERATED seed delta 0034 up (scripts/market/gen-seed-sql.mjs --delta 0034; do not edit by hand)
UPDATE market_profile SET profile_version = 2 WHERE code = 'IN';
UPDATE market_profile_field SET value_json = '[{"fromMicro":"0n","tickMicro":"10000n"},{"fromMicro":"250000000n","tickMicro":"50000n"}]', verify = 1, verified_at = NULL, evidence_ref = 'M20 A4 (D-1104, D-1118): [VERIFY], see seed/in/tickTable.mjs', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'tick_table';
UPDATE market_profile_field SET value_json = '{"buckets":[{"fromAdvMicro":"791700000000000n","bps":10},{"fromAdvMicro":"271500000000000n","bps":25},{"fromAdvMicro":"122000000000000n","bps":60},{"fromAdvMicro":"66500000000000n","bps":120}],"tick_cross_factor":1,"stall_floor_bps":10,"untradeable_adv_fraction":{"num":1,"den":200},"half_spread_ppm_by_tier":{"U1":"500n","U2":"2500n","U3":"7500n"}}', verify = 1, verified_at = NULL, evidence_ref = 'M20 A4 (D-1104, D-1118): [VERIFY], see seed/in/tickTable.mjs', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'slippage_buckets';
UPDATE market_profile_field SET value_json = '{"windowSessions":60,"u1":{"advMicro":"189200000000000n","priceMicro":"27500000n","top":514,"minSessions":54},"u2":{"advMicro":"88700000000000n","priceMicro":"11000000n","listedDays":365,"mcapMicro":"1650000000000000n"},"u3":{"advMicro":"48100000000000n","priceMicro":"5500000n"}}', verify = 1, verified_at = NULL, evidence_ref = 'M20 A4 (D-1104, D-1118): [VERIFY], see seed/in/tickTable.mjs', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'tiers';
UPDATE market_profile_field SET value_json = '{"multiple":1,"basis":"SEBI cash-segment delivery (IN-P1 is a delivery formula; no MTF assumed)"}', verify = 1, verified_at = NULL, evidence_ref = 'D-1106: listed for the Owner', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'sleeve_reality_cap';
UPDATE market_profile_field SET value_json = '{"kind":"assumed","minutes":60,"basis":"batch b1 = close + 60","measured_nights":0}', verify = 1, verified_at = NULL, evidence_ref = 'D-1105: measured in production data_only', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'bar_latency_p95_min';
UPDATE market_profile SET profile_version = 2 WHERE code = 'US';
UPDATE market_profile_field SET value_json = '[{"fromMicro":"0n","tickMicro":"100n"},{"fromMicro":"1000000n","tickMicro":"10000n"}]', verify = 1, verified_at = NULL, evidence_ref = 'M20 A4 (D-1104, D-1118): [VERIFY], see seed/us/tickTable.mjs', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'tick_table';
UPDATE market_profile_field SET value_json = '{"buckets":[{"fromAdvMicro":"3250000000000n","bps":10},{"fromAdvMicro":"650000000000n","bps":25},{"fromAdvMicro":"160000000000n","bps":60},{"fromAdvMicro":"70000000000n","bps":120}],"tick_cross_factor":1,"stall_floor_bps":10,"untradeable_adv_fraction":{"num":1,"den":200},"half_spread_ppm_by_tier":{"U1":"500n","U2":"2500n","U3":"7500n"}}', verify = 1, verified_at = NULL, evidence_ref = 'M20 A4 (D-1104, D-1118): [VERIFY], see seed/us/tickTable.mjs', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'slippage_buckets';
UPDATE market_profile_field SET value_json = '{"windowSessions":60,"u1":{"advMicro":"650000000000n","priceMicro":"330000n","top":300,"minSessions":54},"u2":{"advMicro":"160000000000n","priceMicro":"130000n","listedDays":365,"mcapMicro":"19500000000000n"},"u3":{"advMicro":"70000000000n","priceMicro":"70000n"}}', verify = 1, verified_at = NULL, evidence_ref = 'M20 A4 (D-1104, D-1118): [VERIFY], see seed/us/tickTable.mjs', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'tiers';
UPDATE market_profile_field SET value_json = '{"multiple":2,"basis":"Reg T 50 % initial margin"}', verify = 1, verified_at = NULL, evidence_ref = 'D-1106: listed for the Owner', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'sleeve_reality_cap';
UPDATE market_profile_field SET value_json = '{"kind":"assumed","minutes":60,"basis":"batch b1 = close + 60","measured_nights":0}', verify = 1, verified_at = NULL, evidence_ref = 'D-1105: measured in production data_only', updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'bar_latency_p95_min';
INSERT INTO market_profile_change (code, field, old_json, new_json, changed_at, actor, reason, counted_trial) VALUES ('IN', 'tick_table', '[{"fromMicro":"0n","tickMicro":"50000n"}]', '[{"fromMicro":"0n","tickMicro":"10000n"},{"fromMicro":"250000000n","tickMicro":"50000n"}]', '2026-11-12T00:00:00.000Z', 'migration', 'M20 profile completion (migration 0036, D-1122)', 1);
INSERT INTO market_profile_change (code, field, old_json, new_json, changed_at, actor, reason, counted_trial) VALUES ('IN', 'slippage_buckets', 'null', '{"buckets":[{"fromAdvMicro":"791700000000000n","bps":10},{"fromAdvMicro":"271500000000000n","bps":25},{"fromAdvMicro":"122000000000000n","bps":60},{"fromAdvMicro":"66500000000000n","bps":120}],"tick_cross_factor":1,"stall_floor_bps":10,"untradeable_adv_fraction":{"num":1,"den":200},"half_spread_ppm_by_tier":{"U1":"500n","U2":"2500n","U3":"7500n"}}', '2026-11-12T00:00:00.000Z', 'migration', 'M20 profile completion (migration 0036, D-1122)', 1);
INSERT INTO market_profile_change (code, field, old_json, new_json, changed_at, actor, reason, counted_trial) VALUES ('IN', 'tiers', 'null', '{"windowSessions":60,"u1":{"advMicro":"189200000000000n","priceMicro":"27500000n","top":514,"minSessions":54},"u2":{"advMicro":"88700000000000n","priceMicro":"11000000n","listedDays":365,"mcapMicro":"1650000000000000n"},"u3":{"advMicro":"48100000000000n","priceMicro":"5500000n"}}', '2026-11-12T00:00:00.000Z', 'migration', 'M20 profile completion (migration 0036, D-1122)', 0);
INSERT INTO market_profile_change (code, field, old_json, new_json, changed_at, actor, reason, counted_trial) VALUES ('IN', 'sleeve_reality_cap', 'null', '{"multiple":1,"basis":"SEBI cash-segment delivery (IN-P1 is a delivery formula; no MTF assumed)"}', '2026-11-12T00:00:00.000Z', 'migration', 'M20 profile completion (migration 0036, D-1122)', 0);
INSERT INTO market_profile_change (code, field, old_json, new_json, changed_at, actor, reason, counted_trial) VALUES ('IN', 'bar_latency_p95_min', 'null', '{"kind":"assumed","minutes":60,"basis":"batch b1 = close + 60","measured_nights":0}', '2026-11-12T00:00:00.000Z', 'migration', 'M20 profile completion (migration 0036, D-1122)', 0);
INSERT INTO market_profile_change (code, field, old_json, new_json, changed_at, actor, reason, counted_trial) VALUES ('US', 'tick_table', '[{"fromMicro":"0n","tickMicro":"10000n"}]', '[{"fromMicro":"0n","tickMicro":"100n"},{"fromMicro":"1000000n","tickMicro":"10000n"}]', '2026-11-12T00:00:00.000Z', 'migration', 'M20 profile completion (migration 0036, D-1122)', 1);
INSERT INTO market_profile_change (code, field, old_json, new_json, changed_at, actor, reason, counted_trial) VALUES ('US', 'slippage_buckets', 'null', '{"buckets":[{"fromAdvMicro":"3250000000000n","bps":10},{"fromAdvMicro":"650000000000n","bps":25},{"fromAdvMicro":"160000000000n","bps":60},{"fromAdvMicro":"70000000000n","bps":120}],"tick_cross_factor":1,"stall_floor_bps":10,"untradeable_adv_fraction":{"num":1,"den":200},"half_spread_ppm_by_tier":{"U1":"500n","U2":"2500n","U3":"7500n"}}', '2026-11-12T00:00:00.000Z', 'migration', 'M20 profile completion (migration 0036, D-1122)', 1);
INSERT INTO market_profile_change (code, field, old_json, new_json, changed_at, actor, reason, counted_trial) VALUES ('US', 'tiers', 'null', '{"windowSessions":60,"u1":{"advMicro":"650000000000n","priceMicro":"330000n","top":300,"minSessions":54},"u2":{"advMicro":"160000000000n","priceMicro":"130000n","listedDays":365,"mcapMicro":"19500000000000n"},"u3":{"advMicro":"70000000000n","priceMicro":"70000n"}}', '2026-11-12T00:00:00.000Z', 'migration', 'M20 profile completion (migration 0036, D-1122)', 0);
INSERT INTO market_profile_change (code, field, old_json, new_json, changed_at, actor, reason, counted_trial) VALUES ('US', 'sleeve_reality_cap', 'null', '{"multiple":2,"basis":"Reg T 50 % initial margin"}', '2026-11-12T00:00:00.000Z', 'migration', 'M20 profile completion (migration 0036, D-1122)', 0);
INSERT INTO market_profile_change (code, field, old_json, new_json, changed_at, actor, reason, counted_trial) VALUES ('US', 'bar_latency_p95_min', 'null', '{"kind":"assumed","minutes":60,"basis":"batch b1 = close + 60","measured_nights":0}', '2026-11-12T00:00:00.000Z', 'migration', 'M20 profile completion (migration 0036, D-1122)', 0);
-- END GENERATED seed delta 0034 up

-- +down
-- The profile rows go back to what 0034 wrote (generated).
-- BEGIN GENERATED seed delta 0034 down (scripts/market/gen-seed-sql.mjs --delta 0034; do not edit by hand)
UPDATE market_profile SET profile_version = 1 WHERE code = 'IN';
UPDATE market_profile_field SET value_json = '[{"fromMicro":"0n","tickMicro":"50000n"}]', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'tick_table';
UPDATE market_profile_field SET value_json = 'null', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'slippage_buckets';
UPDATE market_profile_field SET value_json = 'null', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'tiers';
UPDATE market_profile_field SET value_json = 'null', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'sleeve_reality_cap';
UPDATE market_profile_field SET value_json = 'null', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'IN' AND field = 'bar_latency_p95_min';
UPDATE market_profile SET profile_version = 1 WHERE code = 'US';
UPDATE market_profile_field SET value_json = '[{"fromMicro":"0n","tickMicro":"10000n"}]', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'tick_table';
UPDATE market_profile_field SET value_json = 'null', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'slippage_buckets';
UPDATE market_profile_field SET value_json = 'null', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'tiers';
UPDATE market_profile_field SET value_json = 'null', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'sleeve_reality_cap';
UPDATE market_profile_field SET value_json = 'null', verify = 1, verified_at = NULL, evidence_ref = NULL, updated_at = '2026-11-12T00:00:00.000Z' WHERE code = 'US' AND field = 'bar_latency_p95_min';
DROP TRIGGER market_profile_change_no_delete;
DELETE FROM market_profile_change WHERE actor = 'migration' AND reason = 'M20 profile completion (migration 0036, D-1122)';
CREATE TRIGGER market_profile_change_no_delete BEFORE DELETE ON market_profile_change
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
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
