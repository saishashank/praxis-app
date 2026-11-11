-- +up
-- M19 A1 (docs/M19_design.md stream A1; D-992, D-994, D-998, D-999). GENERATED from src/lib/market/seed/*.mjs
-- by scripts/market/gen-seed-sql.mjs; tests/db/0034_m19_market_profile.test.ts asserts every seeded row equals
-- the seed modules. Do not edit by hand: change the seed and regenerate (before the first production apply).
--
-- 1. market_profile: one row per market, the stored MKT-106/MKT-114 work status, its dates and the profile
--    version (DAT-241). Configuration, never deleted.
-- 2. market_profile_field: one row per field of the ch. 20 profile table: the value as JSON ("<n>n" is a
--    bigint), the [VERIFY] flag, the date and evidence of its verification (DAT-242). 'null' = set at M20.
-- 3. market_profile_change: the append-only change ledger of profile edits (NFR-023), with the counted-trial
--    flag for a cost, tick, slippage, settlement or parcel change (VAL-112).
-- 4. market gains `enabled` (the markets_enabled set, production AU only, D-994) and `slots_json` (the Worker's
--    projection of the profile's batch, cut-off, pre-open and quote anchors, D-996). A market that is not
--    enabled must be mode 'off' (two triggers: SQLite cannot add a row CHECK that refers to another column
--    to a table that already has rows). AU is enabled; IN and US are inserted enabled 0, mode 'off'.

CREATE TABLE market_profile (
  code TEXT PRIMARY KEY REFERENCES market (code),
  work_status TEXT NOT NULL CHECK (work_status IN
    ('not_started','in_build','testing','built','active','paused')),
  status_changed_at TEXT,
  built_at TEXT,
  evidence_recorded_at TEXT,
  profile_version INTEGER NOT NULL DEFAULT 1 CHECK (profile_version >= 1),
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TRIGGER market_profile_no_delete BEFORE DELETE ON market_profile
BEGIN
  SELECT RAISE(ABORT, 'market profile rows are never deleted');
END;

CREATE TABLE market_profile_field (
  code TEXT NOT NULL REFERENCES market_profile (code),
  field TEXT NOT NULL CHECK (length(field) BETWEEN 1 AND 48),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  verify INTEGER NOT NULL CHECK (verify IN (0,1)),
  verified_at TEXT,
  evidence_ref TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (code, field)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER market_profile_field_no_delete BEFORE DELETE ON market_profile_field
BEGIN
  SELECT RAISE(ABORT, 'market profile fields are never deleted');
END;

CREATE TABLE market_profile_change (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  field TEXT NOT NULL,
  old_json TEXT,
  new_json TEXT,
  changed_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  counted_trial INTEGER NOT NULL DEFAULT 0 CHECK (counted_trial IN (0,1)),
  trial_ref TEXT
) STRICT;
CREATE INDEX idx_market_profile_change_code ON market_profile_change (code, id DESC);
CREATE TRIGGER market_profile_change_no_update BEFORE UPDATE ON market_profile_change
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER market_profile_change_no_delete BEFORE DELETE ON market_profile_change
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

ALTER TABLE market ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1));
ALTER TABLE market ADD COLUMN slots_json TEXT CHECK (slots_json IS NULL OR json_valid(slots_json));
CREATE TRIGGER market_enabled_mode_ins BEFORE INSERT ON market
WHEN NEW.enabled = 0 AND NEW.mode <> 'off'
BEGIN
  SELECT RAISE(ABORT, 'a market that is not enabled must be off');
END;
CREATE TRIGGER market_enabled_mode_upd BEFORE UPDATE ON market
WHEN NEW.enabled = 0 AND NEW.mode <> 'off'
BEGIN
  SELECT RAISE(ABORT, 'a market that is not enabled must be off');
END;

-- 5. The seed. AU is already a market row (0004): it becomes enabled with its projection. IN and US are new.
UPDATE market SET enabled = 1, slots_json = '{"b1":"17:30","b2a":"17:50","b2b":"18:10","late_2a_after":"18:40","cutoff":"18:10","cutoff_poll":"18:10","preopen_recheck":["09:54","09:58"],"quote_from":"10:00","quote_until":"16:00","intraday_scan_from":"10:32","intraday_scan_until":"15:32"}' WHERE code = 'AU';
INSERT INTO market (code, tz, open_time, close_time, cutoff_time, currency, mode, enabled, slots_json)
VALUES ('IN', 'Asia/Kolkata', '09:15', '15:30', '17:30', 'INR', 'off', 0, '{"b1":"16:30","b2a":"16:50","b2b":"17:10","late_2a_after":"17:40","cutoff":"17:30","cutoff_poll":"17:30","preopen_recheck":["09:09","09:13"],"quote_from":"09:15","quote_until":"15:30","intraday_scan_from":"09:47","intraday_scan_until":"15:02"}');
INSERT INTO market (code, tz, open_time, close_time, cutoff_time, currency, mode, enabled, slots_json)
VALUES ('US', 'America/New_York', '09:30', '16:00', '18:00', 'USD', 'off', 0, '{"b1":"17:00","b2a":"17:20","b2b":"17:40","late_2a_after":"18:10","cutoff":"18:00","cutoff_poll":"18:00","preopen_recheck":["09:24","09:28"],"quote_from":"09:30","quote_until":"16:00","intraday_scan_from":"10:02","intraday_scan_until":"15:32"}');

INSERT INTO market_profile (code, work_status, status_changed_at, built_at, evidence_recorded_at, profile_version, updated_at)
VALUES ('AU', 'active', '2026-11-12', NULL, NULL, 1, '2026-11-12T00:00:00.000Z');
INSERT INTO market_profile (code, work_status, status_changed_at, built_at, evidence_recorded_at, profile_version, updated_at)
VALUES ('IN', 'built', '2026-11-12', '2026-11-12', NULL, 1, '2026-11-12T00:00:00.000Z');
INSERT INTO market_profile (code, work_status, status_changed_at, built_at, evidence_recorded_at, profile_version, updated_at)
VALUES ('US', 'built', '2026-11-12', '2026-11-12', NULL, 1, '2026-11-12T00:00:00.000Z');

-- AU fields
INSERT INTO market_profile_field (code, field, value_json, verify, verified_at, evidence_ref, updated_at) VALUES
  ('AU', 'exchange', '"ASX"', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'tz', '"Australia/Sydney"', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'session_open', '"10:00"', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'session_close', '"16:00"', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'closing_auction', '{"kind":"auction","at":"16:10"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'opening_auction_window', '{"kind":"staggered","from":"10:00","to":"10:09"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'announcement_hours', '{"from":"07:00","to":"19:30","tz":"Australia/Sydney"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'decision_cutoff', '{"time":"18:10","zone":"Australia/Melbourne"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'known_time_rules', '{"filings":"publication_time","bars":"at_cutoff","index_global":{"local":"09:00","zone":"Australia/Melbourne","lag_days":1}}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'batch_schedule', '{"kind":"fixed","zone":"Australia/Melbourne","b1":"17:30","b2a":"17:50","b2b":"18:10","late_2a_after":"18:40"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'review_date_rule', '{"kind":"session_d"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'currency', '"AUD"', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'seed_amount', '{"kind":"fixed","amount":600}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'parcel_floor', '"500000000n"', 0, NULL, 'D-710 go-live sign-off', '2026-11-12T00:00:00.000Z'),
  ('AU', 'settlement_days', '2', 0, NULL, 'D-710 go-live sign-off', '2026-11-12T00:00:00.000Z'),
  ('AU', 'tick_table', '[{"fromMicro":"0n","tickMicro":"1000n"},{"fromMicro":"100000n","tickMicro":"5000n"},{"fromMicro":"2000000n","tickMicro":"10000n"}]', 0, NULL, 'D-710 go-live sign-off', '2026-11-12T00:00:00.000Z'),
  ('AU', 'slippage_buckets', '{"buckets":[{"fromAdvMicro":"5000000000000n","bps":10},{"fromAdvMicro":"1000000000000n","bps":25},{"fromAdvMicro":"250000000000n","bps":60},{"fromAdvMicro":"100000000000n","bps":120}],"tick_cross_factor":1,"stall_floor_bps":10,"untradeable_adv_fraction":{"num":1,"den":200},"half_spread_ppm_by_tier":{"U1":"500n","U2":"2500n","U3":"7500n"}}', 0, NULL, 'D-710 go-live sign-off', '2026-11-12T00:00:00.000Z'),
  ('AU', 'tiers', '{"windowSessions":60,"u1":{"advMicro":"1000000000000n","priceMicro":"500000n","top":300,"minSessions":54},"u2":{"advMicro":"250000000000n","priceMicro":"200000n","listedDays":365,"mcapMicro":"30000000000000n"},"u3":{"advMicro":"100000000000n","priceMicro":"100000n"}}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'cost_formula', '"P5"', 0, NULL, 'D-710 go-live sign-off', '2026-11-12T00:00:00.000Z'),
  ('AU', 'benchmark_index', '{"code":"AXJO","yahoo":"^AXJO","name":"S&P/ASX 200"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'regime_index', '{"code":"GSPC","yahoo":"^GSPC","name":"S&P 500"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'volatility_index', '{"code":"VIX","yahoo":"^VIX","name":"VIX"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'control_instrument', '{"kind":"broad_index_etf","index":"AXJO"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'classification_scheme', '"gics_group"', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'short_data_kind', '"asic_daily_short_positions"', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'insider_notice_kind', '"appendix_3y_forms_603_605"', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'halt_model', '"cx16"', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'index_change_source', '"sp_asx_notices_manual_csv"', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'forward_results_dates', '{"kind":"none"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'fundamentals_source', '{"kind":"blocked","ref":"FAM-102"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'macro_series', '["RBA","ABS","GSPC","VIX"]', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'dividend_imputation', 'true', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'sleeve_reality_cap', '{"multiple":5,"basis":"ASIC"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'calendar_source', '"asx_published_holidays"', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'fx_source', '"rba_daily"', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'yahoo_suffix', '".AX"', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'bar_latency_p95_min', '{"kind":"at_cutoff"}', 0, NULL, 'D-263 interim: a bar is known at the cut-off of its date', '2026-11-12T00:00:00.000Z'),
  ('AU', 'preopen_recheck_min', '5', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'category_map', '{"kind":"none"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z'),
  ('AU', 'universe_max', '{"kind":"none"}', 0, NULL, 'AU live since go-live (v1)', '2026-11-12T00:00:00.000Z');

-- IN fields
INSERT INTO market_profile_field (code, field, value_json, verify, verified_at, evidence_ref, updated_at) VALUES
  ('IN', 'exchange', '"NSE"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'tz', '"Asia/Kolkata"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'session_open', '"09:15"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'session_close', '"15:30"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'closing_auction', '{"kind":"none"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'opening_auction_window', '{"kind":"single","at":"09:15","call_auction":{"from":"09:00","to":"09:08"}}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'announcement_hours', '{"kind":"continuous","note":"NSE/BSE filings 24 h, bulk after close"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'decision_cutoff', '{"time":"17:30","zone":"Asia/Kolkata"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'known_time_rules', '{"filings":"publication_time","bars":"close_plus_latency","index_global":{"local":"09:00","zone":"Australia/Melbourne","lag_days":1}}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'batch_schedule', '{"kind":"after_close","b1":60,"b2a":80,"b2b":100,"late_2a_after":130}', 1, NULL, 'spec 20.1 close + 60 / + 100 / + 130 min; b2a = b1 + 20 [PROPOSED] as in AU', '2026-11-12T00:00:00.000Z'),
  ('IN', 'review_date_rule', '{"kind":"latest_session_with_marker","by":"au_review_time","offset_days":-1}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'currency', '"INR"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'seed_amount', '{"kind":"fx_rounded","from_amount":600,"from_currency":"AUD","fx_source":"rba_daily","round_to":1000}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'parcel_floor', '"25000000000n"', 1, NULL, 'D-947 [PROPOSED]', '2026-11-12T00:00:00.000Z'),
  ('IN', 'settlement_days', '1', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'tick_table', '[{"fromMicro":"0n","tickMicro":"50000n"}]', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'slippage_buckets', 'null', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'tiers', 'null', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'cost_formula', '"IN-P1"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'benchmark_index', '{"code":"NSEI","yahoo":"^NSEI","name":"Nifty 50"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'regime_index', '{"code":"NSEI","yahoo":"^NSEI","name":"Nifty 50"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'volatility_index', '{"code":"INDIAVIX","yahoo":"^INDIAVIX","name":"India VIX"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'control_instrument', '{"kind":"broad_index_etf","index":"NSEI"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'classification_scheme', '"nse_level2"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'short_data_kind', '"fo_open_interest_slb_proxy"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'insider_notice_kind', '"sebi_pit_sast"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'halt_model', '"in_bands"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'index_change_source', '"nse_indices_rebalance_notices"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'forward_results_dates', '{"kind":"board_meeting_intimations","min_working_days_ahead":2}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'fundamentals_source', '{"kind":"nse_bse_xbrl_or_yahoo_ns"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'macro_series', '["RBI","MOSPI","NSEI","INDIAVIX"]', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'dividend_imputation', 'false', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'sleeve_reality_cap', 'null', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'calendar_source', '"nse_holiday_list"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'fx_source', '"rba_daily"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'yahoo_suffix', '".NS"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'bar_latency_p95_min', 'null', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'preopen_recheck_min', '5', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'category_map', '{"kind":"headline_categories"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('IN', 'universe_max', '2000', 1, NULL, NULL, '2026-11-12T00:00:00.000Z');

-- US fields
INSERT INTO market_profile_field (code, field, value_json, verify, verified_at, evidence_ref, updated_at) VALUES
  ('US', 'exchange', '"NYSE+Nasdaq"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'tz', '"America/New_York"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'session_open', '"09:30"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'session_close', '"16:00"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'closing_auction', '{"kind":"cross","at":"16:00"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'opening_auction_window', '{"kind":"single","at":"09:30"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'announcement_hours', '{"from":"06:00","to":"22:00","tz":"America/New_York"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'decision_cutoff', '{"time":"18:00","zone":"America/New_York"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'known_time_rules', '{"filings":"edgar_acceptance_time","bars":"close_plus_latency","index_global":{"kind":"own_bars"}}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'batch_schedule', '{"kind":"after_close","b1":60,"b2a":80,"b2b":100,"late_2a_after":130}', 1, NULL, 'spec 20.1 close + 60 / + 100 / + 130 min; b2a = b1 + 20 [PROPOSED] as in AU', '2026-11-12T00:00:00.000Z'),
  ('US', 'review_date_rule', '{"kind":"latest_session_with_marker","by":"au_review_time","offset_days":-1}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'currency', '"USD"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'seed_amount', '{"kind":"fx_rounded","from_amount":600,"from_currency":"AUD","fx_source":"rba_daily","round_to":10}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'parcel_floor', '"300000000n"', 1, NULL, 'D-947 [PROPOSED]', '2026-11-12T00:00:00.000Z'),
  ('US', 'settlement_days', '1', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'tick_table', '[{"fromMicro":"0n","tickMicro":"10000n"}]', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'slippage_buckets', 'null', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'tiers', 'null', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'cost_formula', '"US-P1"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'benchmark_index', '{"code":"GSPC","yahoo":"^GSPC","name":"S&P 500"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'regime_index', '{"code":"GSPC","yahoo":"^GSPC","name":"S&P 500"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'volatility_index', '{"code":"VIX","yahoo":"^VIX","name":"VIX"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'control_instrument', '{"kind":"broad_index_etf","index":"GSPC"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'classification_scheme', '"sic_2digit"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'short_data_kind', '"finra_short_interest_and_daily_volume"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'insider_notice_kind', '"sec_form4_13d_13g"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'halt_model', '"us_luld"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'index_change_source', '"sp_dji_announcements_russell"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'forward_results_dates', '{"kind":"edgar_filing_cadence"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'fundamentals_source', '{"kind":"edgar_company_facts"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'macro_series', '["FRED","FED","GSPC","VIX"]', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'dividend_imputation', 'false', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'sleeve_reality_cap', 'null', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'calendar_source', '"nyse_holiday_list"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'fx_source', '"rba_daily"', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'yahoo_suffix', '""', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'bar_latency_p95_min', 'null', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'preopen_recheck_min', '5', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'category_map', '{"kind":"edgar_8k_items"}', 1, NULL, NULL, '2026-11-12T00:00:00.000Z'),
  ('US', 'universe_max', '2500', 1, NULL, NULL, '2026-11-12T00:00:00.000Z');

-- +down
-- The new tables go first (they reference market), then the IN and US rows: market_no_delete is lifted for that
-- one statement and restored exactly as 0004 defines it. The two enabled/mode triggers go before the columns
-- (DROP COLUMN refuses a referenced column).
DROP TABLE market_profile_change;
DROP TABLE market_profile_field;
DROP TABLE market_profile;
DROP TRIGGER market_enabled_mode_ins;
DROP TRIGGER market_enabled_mode_upd;
DROP TRIGGER market_no_delete;
DELETE FROM market WHERE code <> 'AU';
CREATE TRIGGER market_no_delete BEFORE DELETE ON market
BEGIN
  SELECT RAISE(ABORT, 'market rows are never deleted');
END;
ALTER TABLE market DROP COLUMN slots_json;
ALTER TABLE market DROP COLUMN enabled;
