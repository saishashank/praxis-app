-- +up
-- Agents, families and replay engine tables (M4 T1, docs/M4_design.md section 3, D-078).
-- Conventions as 0004 and 0007: instants are ISO-8601 UTC text with milliseconds and Z (D-031);
-- `d` is the Sydney trading date YYYY-MM-DD; booleans are 0/1 with CHECK; writers use
-- INSERT ... ON CONFLICT DO NOTHING and never the REPLACE write forms (REPLACE deletes the old row
-- without firing delete triggers; D-058, tests/data/noReplaceWrites.test.ts). Every table is STRICT.
--
-- Money (prices, fills, stops, costs, ledger amounts) is INTEGER micro-AUD in `*_micro` columns.
-- Exact rationals are INTEGER numerator / denominator pairs (`*_num`, `*_den`), except the day-0
-- abnormal return of `event`, whose pair can pass 64 bits and is therefore decimal TEXT. Ratios in
-- parts per million are INTEGER `*_ppm`. REAL is used only for the quantities the design names as
-- floating point: Wilder RSI, log-return volatilities, bootstrap statistics, p-values and levels
-- (docs/M4_design.md 2.1). Rule comparisons never read a REAL column.
--
-- No wall-clock column is stored on engine rows (signals, cards, ledger rows): `decided_at` is the
-- decision cut-off instant of the session (decision 22), so a replay is byte-identical (ARN-102).
--
-- Retention (DAT-142). FOREVER tables refuse DELETE outright. Append-only tables refuse UPDATE.
-- Pruned tables allow DELETE only for rows older than their floor, evaluated by the trigger against
-- the current clock (the 0004 pattern; 500 sessions is about 724 days, so the floor is 730 days):
--   short_interest, indicator_daily, pattern_daily, insider_flow_score   d / as_of < today - 730 d
--   replay_stat                                                          d < today - 730 d (2 years)
--   llm_call                                                             d < today - 180 d
--   llm_cache                                                            expires_at in the past
-- One-way tables: event (category_llm / polarity_llm go NULL -> value once, AGT-011a) and
-- ledger_row (the close sets exit_d and the other exit columns together, once).
--
-- Deviations from the design table (docs/M4_design.md section 3), all additive or renames:
--   replay_run.commit is `commit_sha` (COMMIT is an SQL keyword); replay_stat, killswitch_look get a
--   `d` column (the as-of date, needed for retention and for the look history); ledger_row gets
--   `stress_in_micro` (the stressed cost basis, so a stressed return can be recomputed, 2.7).

-- ---------------------------------------------------------------------------------------------
-- Inputs: benchmark index, short interest, insider notices

-- Daily benchmark index bars (S&P/ASX 200, decision 12): first-seen, append-only, kept forever.
CREATE TABLE index_bar (
  market TEXT NOT NULL,
  index_code TEXT NOT NULL,
  d TEXT NOT NULL,
  o_micro INTEGER NOT NULL CHECK (o_micro >= 0),
  h_micro INTEGER NOT NULL CHECK (h_micro >= 0),
  l_micro INTEGER NOT NULL CHECK (l_micro >= 0),
  c_micro INTEGER NOT NULL CHECK (c_micro >= 0),
  source TEXT NOT NULL,
  published_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (market, index_code, d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER index_bar_no_update BEFORE UPDATE ON index_bar
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER index_bar_no_delete BEFORE DELETE ON index_bar
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- ASIC daily aggregate short positions (DAT-125a, F6 class (d)). `short_ppm` is the share of issued
-- shares in parts per million. Backfilled rows carry an assumed publication time (D-065).
CREATE TABLE short_interest (
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  as_of TEXT NOT NULL,
  short_ppm INTEGER NOT NULL CHECK (short_ppm BETWEEN 0 AND 1000000),
  published_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  assumed_time INTEGER NOT NULL DEFAULT 0 CHECK (assumed_time IN (0,1)),
  source TEXT NOT NULL,
  PRIMARY KEY (market, code, as_of)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER short_interest_no_update BEFORE UPDATE ON short_interest
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER short_interest_prune_only BEFORE DELETE ON short_interest
WHEN OLD.as_of >= date('now', '-730 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- Insider and substantial-holder notices (AGT-105). Filled from M5; forever.
CREATE TABLE insider_notice (
  market TEXT NOT NULL,
  ann_id TEXT NOT NULL,
  code TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('director_buy','director_sell','sh_new','sh_increase','sh_decrease')),
  value_micro INTEGER CHECK (value_micro IS NULL OR value_micro >= 0),
  published_at TEXT NOT NULL,
  parser_version TEXT NOT NULL CHECK (length(parser_version) > 0),
  PRIMARY KEY (market, ann_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_insider_notice_code ON insider_notice (market, code, published_at);
CREATE TRIGGER insider_notice_no_update BEFORE UPDATE ON insider_notice
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER insider_notice_no_delete BEFORE DELETE ON insider_notice
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- A4 indicators, A3 regime, A2 events and scores

-- Indicators on adjusted series (AGT-030). Price-domain values are micro integers; RSI and the
-- log-return volatility are REAL (Wilder / float64, decision 8). A NULL value is a warm-up gap and
-- is never filled. `ret126_pct_tier` is the tier percentile in ppm, FLOORED, so a threshold that is
-- a whole number of ppm (0.80 -> 800000) is exact. Recomputable, so pruned after 500 sessions.
CREATE TABLE indicator_daily (
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  d TEXT NOT NULL,
  ind_version INTEGER NOT NULL CHECK (ind_version >= 1),
  close_adj_micro INTEGER NOT NULL CHECK (close_adj_micro >= 0),
  sma5_micro INTEGER CHECK (sma5_micro IS NULL OR sma5_micro >= 0),
  sma50_micro INTEGER CHECK (sma50_micro IS NULL OR sma50_micro >= 0),
  sma200_micro INTEGER CHECK (sma200_micro IS NULL OR sma200_micro >= 0),
  atr20_micro INTEGER CHECK (atr20_micro IS NULL OR atr20_micro >= 0),
  rsi2 REAL CHECK (rsi2 IS NULL OR (rsi2 >= 0 AND rsi2 <= 100)),
  rsi14 REAL CHECK (rsi14 IS NULL OR (rsi14 >= 0 AND rsi14 <= 100)),
  ret126_ppm INTEGER,
  ret126_pct_tier INTEGER CHECK (ret126_pct_tier IS NULL OR ret126_pct_tier BETWEEN 0 AND 1000000),
  high250 INTEGER CHECK (high250 IS NULL OR high250 IN (0,1)),
  vol_ratio_ppm INTEGER CHECK (vol_ratio_ppm IS NULL OR vol_ratio_ppm >= 0),
  adv20_micro INTEGER CHECK (adv20_micro IS NULL OR adv20_micro >= 0),
  range_pos_ppm INTEGER CHECK (range_pos_ppm IS NULL OR range_pos_ppm BETWEEN 0 AND 1000000),
  vol20 REAL CHECK (vol20 IS NULL OR vol20 >= 0),
  vol_decile INTEGER CHECK (vol_decile IS NULL OR vol_decile BETWEEN 1 AND 10),
  PRIMARY KEY (market, code, d, ind_version)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_indicator_daily_d ON indicator_daily (market, d);
CREATE TRIGGER indicator_daily_no_update BEFORE UPDATE ON indicator_daily
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER indicator_daily_prune_only BEFORE DELETE ON indicator_daily
WHEN OLD.d >= date('now', '-730 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- Candle patterns (AGT-031), informational until ARN-074 passes. `hit` is the boolean per
-- (code, d, pattern); a writer may store only the hits.
CREATE TABLE pattern_daily (
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  d TEXT NOT NULL,
  pattern TEXT NOT NULL CHECK (pattern IN
    ('bullish_engulfing','hammer','morning_star','piercing_line')),
  version INTEGER NOT NULL CHECK (version >= 1),
  hit INTEGER NOT NULL CHECK (hit IN (0,1)),
  PRIMARY KEY (market, code, d, pattern, version)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_pattern_daily_d ON pattern_daily (market, d);
CREATE TRIGGER pattern_daily_no_update BEFORE UPDATE ON pattern_daily
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER pattern_daily_prune_only BEFORE DELETE ON pattern_daily
WHEN OLD.d >= date('now', '-730 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- Regime (AGT-101): one row per (market, d, version); `state` is after hysteresis, `raw_state`
-- before it, `unknown` during the 1,260 + 20 session warm-up. `exit_streak` counts the
-- consecutive sessions whose raw state differs from the current state (0..2). Forever.
CREATE TABLE regime_daily (
  market TEXT NOT NULL,
  d TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  close_micro INTEGER NOT NULL CHECK (close_micro >= 0),
  sma200_micro INTEGER CHECK (sma200_micro IS NULL OR sma200_micro >= 0),
  vol20 REAL CHECK (vol20 IS NULL OR vol20 >= 0),
  vol_pct REAL CHECK (vol_pct IS NULL OR (vol_pct >= 0 AND vol_pct <= 100)),
  fall5_ppm INTEGER,
  raw_state TEXT NOT NULL CHECK (raw_state IN ('SHOCK','RISK-OFF','RISK-ON','NEUTRAL','unknown')),
  state TEXT NOT NULL CHECK (state IN ('SHOCK','RISK-OFF','RISK-ON','NEUTRAL','unknown')),
  exit_streak INTEGER NOT NULL DEFAULT 0 CHECK (exit_streak >= 0),
  PRIMARY KEY (market, d, version)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER regime_daily_no_update BEFORE UPDATE ON regime_daily
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER regime_daily_no_delete BEFORE DELETE ON regime_daily
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Event records (AGT-020), one per announcement, kept after the 400-day announcement prune. The
-- day-0 abnormal return is the exact rational ar_num/ar_den (decimal TEXT: a product of micro
-- prices can pass 64 bits) plus the rounded ppm for display. Only the LLM fields may change, once,
-- NULL -> value (AGT-011a): A5 reads the rule-derived columns only.
CREATE TABLE event (
  market TEXT NOT NULL,
  source TEXT NOT NULL,
  ann_id TEXT NOT NULL,
  code TEXT NOT NULL,
  published_at TEXT NOT NULL,
  timed INTEGER NOT NULL CHECK (timed IN (0,1)),
  day0_d TEXT NOT NULL,
  group_key TEXT NOT NULL CHECK (length(group_key) > 0),
  category TEXT NOT NULL CHECK (category IN
    ('results','guidance_up','guidance_down','contract_win','capital_raising','director_trade',
     'substantial_holder','takeover_target','takeover_bidder','halt_suspension','exchange_query',
     'dividend_change','management_change','other')),
  price_sensitive INTEGER NOT NULL CHECK (price_sensitive IN (0,1)),
  ar_ppm INTEGER,
  ar_num TEXT CHECK (ar_num IS NULL OR (ar_num NOT GLOB '*[^0-9-]*' AND length(ar_num) > 0)),
  ar_den TEXT CHECK (ar_den IS NULL OR (ar_den NOT GLOB '*[^0-9]*' AND ar_den GLOB '[1-9]*')),
  vol_ratio_ppm INTEGER CHECK (vol_ratio_ppm IS NULL OR vol_ratio_ppm >= 0),
  polarity INTEGER NOT NULL CHECK (polarity IN (-1,0,1)),
  rule_version TEXT NOT NULL CHECK (length(rule_version) > 0),
  category_llm TEXT CHECK (category_llm IS NULL OR length(category_llm) > 0),
  polarity_llm INTEGER CHECK (polarity_llm IS NULL OR polarity_llm IN (-1,0,1)),
  CHECK ((ar_num IS NULL) = (ar_den IS NULL) AND (ar_num IS NULL) = (ar_ppm IS NULL)),
  PRIMARY KEY (market, source, ann_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_event_code_day0 ON event (market, code, day0_d);
CREATE INDEX idx_event_group ON event (market, group_key);
CREATE TRIGGER event_guard_update BEFORE UPDATE ON event
WHEN NOT (NEW.market IS OLD.market AND NEW.source IS OLD.source AND NEW.ann_id IS OLD.ann_id
  AND NEW.code IS OLD.code AND NEW.published_at IS OLD.published_at AND NEW.timed IS OLD.timed
  AND NEW.day0_d IS OLD.day0_d AND NEW.group_key IS OLD.group_key
  AND NEW.category IS OLD.category AND NEW.price_sensitive IS OLD.price_sensitive
  AND NEW.ar_ppm IS OLD.ar_ppm AND NEW.ar_num IS OLD.ar_num AND NEW.ar_den IS OLD.ar_den
  AND NEW.vol_ratio_ppm IS OLD.vol_ratio_ppm AND NEW.polarity IS OLD.polarity
  AND NEW.rule_version IS OLD.rule_version
  AND (OLD.category_llm IS NULL OR NEW.category_llm IS OLD.category_llm)
  AND (OLD.polarity_llm IS NULL OR NEW.polarity_llm IS OLD.polarity_llm))
BEGIN
  SELECT RAISE(ABORT, 'event: only category_llm and polarity_llm may go from NULL to a value');
END;
CREATE TRIGGER event_no_delete BEFORE DELETE ON event
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- Insider / flow score (AGT-105) in quarter units, -4..+4; NULL = unknown (never 0).
CREATE TABLE insider_flow_score (
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  d TEXT NOT NULL,
  score_q INTEGER CHECK (score_q IS NULL OR score_q BETWEEN -4 AND 4),
  inputs_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(inputs_json)),
  PRIMARY KEY (market, code, d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER insider_flow_score_no_update BEFORE UPDATE ON insider_flow_score
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER insider_flow_score_prune_only BEFORE DELETE ON insider_flow_score
WHEN OLD.d >= date('now', '-730 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- ---------------------------------------------------------------------------------------------
-- A5 signals, Decision Cards, stops, controls

-- Signals (DAT-150 `signal`): one row per (session, family, rule version, variant, code). The id is
-- deterministic: sig:<market>:<d>:<family>:<rv>:<variant>:<code>. `rank_score` is exact text.
CREATE TABLE signal (
  id TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  d TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('F1','F2','F3','F4','F5','F6')),
  rule_version TEXT NOT NULL CHECK (length(rule_version) > 0),
  variant TEXT NOT NULL CHECK (length(variant) > 0),
  code TEXT NOT NULL,
  regime TEXT NOT NULL CHECK (regime IN ('SHOCK','RISK-OFF','RISK-ON','NEUTRAL','unknown')),
  rank_score TEXT NOT NULL,
  rules_json TEXT NOT NULL CHECK (json_valid(rules_json)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  classes TEXT CHECK (classes IS NULL OR json_valid(classes)),
  group_key TEXT,
  partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0,1)),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  agent_version TEXT NOT NULL CHECK (length(agent_version) > 0),
  inputs_ref TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  UNIQUE (market, d, family, rule_version, variant, code)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_signal_d ON signal (market, d, family);
CREATE TRIGGER signal_no_update BEFORE UPDATE ON signal
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER signal_no_delete BEFORE DELETE ON signal
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Decision Cards (AGT-110, AT-16): taken and not-taken. `card_json` is canonical JSON with no free
-- text; the LLM wording lives in card_note. A taken card carries the id of the order written in the
-- same transaction (the order row holds card_id back); a not-taken card has a reason and no order.
CREATE TABLE decision_card (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  cohort_id TEXT,
  taken INTEGER NOT NULL CHECK (taken IN (0,1)),
  not_taken_reason TEXT CHECK (not_taken_reason IS NULL OR length(not_taken_reason) > 0),
  order_id TEXT,
  card_json TEXT NOT NULL CHECK (json_valid(card_json)),
  card_sha TEXT NOT NULL CHECK (length(card_sha) = 64 AND card_sha NOT GLOB '*[^0-9a-f]*'),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  decided_at TEXT NOT NULL,
  UNIQUE (signal_id, execution_id),
  CHECK ((taken = 1) = (order_id IS NOT NULL)),
  CHECK ((taken = 0) = (not_taken_reason IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_decision_card_signal ON decision_card (signal_id);
CREATE TRIGGER decision_card_insert_guard BEFORE INSERT ON decision_card
WHEN NOT EXISTS (SELECT 1 FROM signal s WHERE s.id = NEW.signal_id)
BEGIN
  SELECT RAISE(ABORT, 'decision_card: needs its signal');
END;
CREATE TRIGGER decision_card_no_update BEFORE UPDATE ON decision_card
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER decision_card_no_delete BEFORE DELETE ON decision_card
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Card wording (LLM or template). Never read by A5 (AGT-011a). `fallback_depth` is '0', '1', ...
-- or 'rules-only' (AGT-002); provider and model are NULL for the template.
CREATE TABLE card_note (
  card_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  text TEXT NOT NULL,
  provider TEXT,
  model_id TEXT,
  fallback_depth TEXT NOT NULL CHECK (fallback_depth = 'rules-only'
    OR (length(fallback_depth) > 0 AND fallback_depth NOT GLOB '*[^0-9]*')),
  tokens_in INTEGER NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out INTEGER NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  prompt_sha TEXT,
  PRIMARY KEY (card_id, kind)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER card_note_insert_guard BEFORE INSERT ON card_note
WHEN NOT EXISTS (SELECT 1 FROM decision_card c WHERE c.id = NEW.card_id)
BEGIN
  SELECT RAISE(ABORT, 'card_note: needs its decision card');
END;
CREATE TRIGGER card_note_no_update BEFORE UPDATE ON card_note
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER card_note_no_delete BEFORE DELETE ON card_note
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Stop levels (decision 7): trade.stop_micro is immutable, so every recomputed in-session stop is
-- a new row; the effective level is the max of the initial stop and the latest session's levels.
CREATE TABLE stop_level (
  trade_id TEXT NOT NULL,
  d TEXT NOT NULL,
  rule TEXT NOT NULL CHECK (length(rule) > 0),
  cohort_id TEXT NOT NULL,
  level_micro INTEGER NOT NULL CHECK (level_micro > 0),
  PRIMARY KEY (trade_id, d, rule)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_stop_level_cohort ON stop_level (cohort_id, d);
CREATE TRIGGER stop_level_insert_guard BEFORE INSERT ON stop_level
WHEN NOT EXISTS (SELECT 1 FROM trade t WHERE t.id = NEW.trade_id AND t.cohort_id = NEW.cohort_id)
BEGIN
  SELECT RAISE(ABORT, 'stop_level: needs a trade of the same cohort');
END;
CREATE TRIGGER stop_level_no_update BEFORE UPDATE ON stop_level
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER stop_level_no_delete BEFORE DELETE ON stop_level
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- C2/C3 random-entry selection (ARN-004, decision 33): one row per (cohort, session, matched
-- signal), including the skips. `rng_draw` is the PRNG output used for the draw.
CREATE TABLE c2_selection (
  cohort_id TEXT NOT NULL,
  d TEXT NOT NULL,
  matched_signal_id TEXT NOT NULL,
  code TEXT,
  skipped INTEGER NOT NULL CHECK (skipped IN (0,1)),
  skip_reason TEXT CHECK (skip_reason IS NULL OR length(skip_reason) > 0),
  pool_size INTEGER NOT NULL CHECK (pool_size >= 0),
  rng_draw INTEGER,
  PRIMARY KEY (cohort_id, d, matched_signal_id),
  CHECK ((skipped = 1) = (skip_reason IS NOT NULL)),
  CHECK (skipped = 1 OR code IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER c2_selection_no_update BEFORE UPDATE ON c2_selection
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER c2_selection_no_delete BEFORE DELETE ON c2_selection
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- Lineage, splits, trial ledger, forward signal ledger

-- Lineage = a family's tree of rule versions (ch.05 5.1); id is <market>:<family>. Insert only.
CREATE TABLE lineage (
  id TEXT PRIMARY KEY,
  created_d TEXT NOT NULL,
  parent TEXT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER lineage_no_update BEFORE UPDATE ON lineage
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER lineage_no_delete BEFORE DELETE ON lineage
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Split record (ARN-082), versioned, frozen at creation and re-measured only at a roll. A deferred
-- split (development < 252 sessions) has no dates, only `deferred_until_d`.
CREATE TABLE lineage_split (
  lineage_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  block_sessions INTEGER NOT NULL CHECK (block_sessions >= 1),
  holdout_len INTEGER NOT NULL CHECK (holdout_len >= 1),
  validation_len INTEGER NOT NULL CHECK (validation_len >= 1),
  purge INTEGER NOT NULL CHECK (purge >= 0),
  data_end_d TEXT NOT NULL,
  holdout_start_d TEXT,
  holdout_end_d TEXT,
  validation_start_d TEXT,
  validation_end_d TEXT,
  dev_end_d TEXT,
  deferred_until_d TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('create','roll')),
  measured_on_run TEXT,
  PRIMARY KEY (lineage_id, version),
  CHECK ((deferred_until_d IS NULL) = (dev_end_d IS NOT NULL)),
  CHECK ((dev_end_d IS NOT NULL) = (holdout_start_d IS NOT NULL)
     AND (dev_end_d IS NOT NULL) = (holdout_end_d IS NOT NULL)
     AND (dev_end_d IS NOT NULL) = (validation_start_d IS NOT NULL)
     AND (dev_end_d IS NOT NULL) = (validation_end_d IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER lineage_split_insert_guard BEFORE INSERT ON lineage_split
WHEN NOT EXISTS (SELECT 1 FROM lineage l WHERE l.id = NEW.lineage_id)
BEGIN
  SELECT RAISE(ABORT, 'lineage_split: needs its lineage');
END;
CREATE TRIGGER lineage_split_no_update BEFORE UPDATE ON lineage_split
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER lineage_split_no_delete BEFORE DELETE ON lineage_split
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Market-level trial ledger (ARN-085): every validation / holdout access, pattern test,
-- challenger and new lineage. A validation access is written BEFORE the test reads the rows.
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
CREATE INDEX idx_trial_ledger_lineage ON trial_ledger (lineage_id, split_version, kind);
CREATE TRIGGER trial_ledger_no_update BEFORE UPDATE ON trial_ledger
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER trial_ledger_no_delete BEFORE DELETE ON trial_ledger
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Forward signal-ledger rows only (decision 30: replay rows live in data-repo files). Amounts are
-- micro integers: cost = qty x fill_in + brok_in; proceeds = qty x fill_out - brok_out; the stressed
-- pair is the same under P3 + 50 % slippage. The row opens without any exit column; the close is ONE
-- update that sets exit_d, exit_tag and the exit amounts together (CHECK), then never changes.
CREATE TABLE ledger_row (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL,
  group_key TEXT,
  entry_d TEXT NOT NULL,
  exit_d TEXT,
  exit_tag TEXT CHECK (exit_tag IS NULL OR exit_tag IN ('IS','CS')),
  qty INTEGER NOT NULL CHECK (qty > 0),
  fill_in_micro INTEGER NOT NULL CHECK (fill_in_micro > 0),
  fill_out_micro INTEGER CHECK (fill_out_micro IS NULL OR fill_out_micro > 0),
  brok_in_micro INTEGER NOT NULL CHECK (brok_in_micro >= 0),
  brok_out_micro INTEGER CHECK (brok_out_micro IS NULL OR brok_out_micro >= 0),
  stress_in_micro INTEGER NOT NULL CHECK (stress_in_micro > 0),
  stress_out_micro INTEGER CHECK (stress_out_micro IS NULL OR stress_out_micro >= 0),
  gross_num INTEGER,
  gross_den INTEGER CHECK (gross_den IS NULL OR gross_den > 0),
  timed INTEGER NOT NULL CHECK (timed IN (0,1)),
  forward INTEGER NOT NULL CHECK (forward IN (0,1)),
  CHECK ((exit_d IS NULL AND exit_tag IS NULL AND fill_out_micro IS NULL
          AND brok_out_micro IS NULL AND stress_out_micro IS NULL
          AND gross_num IS NULL AND gross_den IS NULL)
      OR (exit_d IS NOT NULL AND exit_tag IS NOT NULL AND fill_out_micro IS NOT NULL
          AND brok_out_micro IS NOT NULL AND stress_out_micro IS NOT NULL
          AND gross_num IS NOT NULL AND gross_den IS NOT NULL AND exit_d >= entry_d))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_ledger_row_signal ON ledger_row (signal_id);
CREATE INDEX idx_ledger_row_entry ON ledger_row (entry_d);
CREATE TRIGGER ledger_row_insert_guard BEFORE INSERT ON ledger_row
WHEN NEW.exit_d IS NOT NULL OR NOT EXISTS (SELECT 1 FROM signal s WHERE s.id = NEW.signal_id)
BEGIN
  SELECT RAISE(ABORT, 'ledger_row: opens without an exit, for an existing signal');
END;
CREATE TRIGGER ledger_row_guard_update BEFORE UPDATE ON ledger_row
WHEN NOT (OLD.exit_d IS NULL AND NEW.exit_d IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.signal_id IS OLD.signal_id AND NEW.group_key IS OLD.group_key
  AND NEW.entry_d IS OLD.entry_d AND NEW.qty IS OLD.qty
  AND NEW.fill_in_micro IS OLD.fill_in_micro AND NEW.brok_in_micro IS OLD.brok_in_micro
  AND NEW.stress_in_micro IS OLD.stress_in_micro AND NEW.timed IS OLD.timed
  AND NEW.forward IS OLD.forward)
BEGIN
  SELECT RAISE(ABORT, 'ledger_row: only the one-way close (exit_d NULL to value) may change');
END;
CREATE TRIGGER ledger_row_no_delete BEFORE DELETE ON ledger_row
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- The matched C2 controls of a forward row (c2_controls_per_row, default 20): net and stressed
-- returns as exact rationals of micro amounts.
CREATE TABLE ledger_control (
  row_id TEXT NOT NULL,
  idx INTEGER NOT NULL CHECK (idx >= 1),
  code TEXT NOT NULL,
  entry_d TEXT NOT NULL,
  exit_d TEXT NOT NULL,
  net_num INTEGER NOT NULL,
  net_den INTEGER NOT NULL CHECK (net_den > 0),
  stress_num INTEGER NOT NULL,
  stress_den INTEGER NOT NULL CHECK (stress_den > 0),
  PRIMARY KEY (row_id, idx),
  CHECK (exit_d >= entry_d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER ledger_control_insert_guard BEFORE INSERT ON ledger_control
WHEN NOT EXISTS (SELECT 1 FROM ledger_row r WHERE r.id = NEW.row_id)
BEGIN
  SELECT RAISE(ABORT, 'ledger_control: needs its ledger row');
END;
CREATE TRIGGER ledger_control_no_update BEFORE UPDATE ON ledger_control
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER ledger_control_no_delete BEFORE DELETE ON ledger_control
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- Replay runs, validation results, labels, summaries, kill switch

-- One row per replay / null / injected / evidence run: enough to reproduce it (ARN-102).
CREATE TABLE replay_run (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('light','full','null','injected','evidence')),
  market TEXT NOT NULL,
  snapshot_sha TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  params_sha TEXT NOT NULL,
  seed INTEGER NOT NULL,
  node_version TEXT NOT NULL,
  files_json TEXT NOT NULL CHECK (json_valid(files_json)),
  minutes REAL NOT NULL CHECK (minutes >= 0)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER replay_run_no_update BEFORE UPDATE ON replay_run
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER replay_run_no_delete BEFORE DELETE ON replay_run
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Validation results (ARN-081..087): every result stores the level, B, n, blocks, L and m it used.
-- Statistics are REAL (float64, deterministic, 2.1); NULL = not estimable.
CREATE TABLE validation_result (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  variant TEXT NOT NULL,
  split_version INTEGER NOT NULL CHECK (split_version >= 0),
  test TEXT NOT NULL CHECK (test IN
    ('i','ii','iii','iv','iv-b','v','vi','holdout','ks','size','leverage')),
  level REAL NOT NULL CHECK (level > 0 AND level <= 1),
  B INTEGER NOT NULL CHECK (B >= 0),
  n INTEGER NOT NULL CHECK (n >= 0),
  blocks INTEGER NOT NULL CHECK (blocks >= 0),
  stat REAL,
  p REAL CHECK (p IS NULL OR (p >= 0 AND p <= 1)),
  mde REAL,
  lower REAL,
  upper REAL,
  L_used INTEGER NOT NULL CHECK (L_used >= 1),
  m_used INTEGER NOT NULL CHECK (m_used >= 1),
  outcome TEXT NOT NULL CHECK (length(outcome) > 0),
  reachable_d TEXT
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_validation_result_lineage ON validation_result (lineage_id, split_version, test);
CREATE TRIGGER validation_result_no_update BEFORE UPDATE ON validation_result
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER validation_result_no_delete BEFORE DELETE ON validation_result
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Labels per (execution, rule version, variant), ARN-086; the current label is the latest row.
-- `label` is the ARN-086 set plus the two stated outcomes "insufficient evidence" and "possible
-- luck". cost_infeasible is a flag beside the label, not a label (decision 29).
CREATE TABLE label (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  variant TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN
    ('UNVALIDATED','PASSED-BACKTEST','CONSISTENT-FORWARD','FAILED','NOT-DEMONSTRATED',
     'UNVALIDATABLE','insufficient evidence','possible luck')),
  qualifiers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(qualifiers_json)),
  cost_infeasible INTEGER NOT NULL DEFAULT 0 CHECK (cost_infeasible IN (0,1)),
  n INTEGER NOT NULL CHECK (n >= 0),
  mde REAL,
  d TEXT NOT NULL,
  result_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(result_ids))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_label_exec ON label (execution_id, rule_version, variant, d);
CREATE TRIGGER label_no_update BEFORE UPDATE ON label
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER label_no_delete BEFORE DELETE ON label
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Replay summaries (scenario percentiles, CIFs, effective N, progress, scorecards, zero-edge,
-- sleeve figures, evidence timeline); 2 years.
CREATE TABLE replay_stat (
  run_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  metric TEXT NOT NULL,
  d TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  PRIMARY KEY (run_id, scope, metric)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER replay_stat_no_update BEFORE UPDATE ON replay_stat
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER replay_stat_prune_only BEFORE DELETE ON replay_stat
WHEN OLD.d >= date('now', '-730 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- Kill-switch looks (ARN-093), one per (lineage, rule version, criterion, look k); a trigger also
-- writes arena_control (killed, family) in the same job. Forever.
CREATE TABLE killswitch_look (
  lineage_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  criterion TEXT NOT NULL CHECK (criterion IN ('expectancy','win_rate','cif')),
  look_k INTEGER NOT NULL CHECK (look_k >= 1),
  d TEXT NOT NULL,
  trades INTEGER NOT NULL CHECK (trades >= 0),
  stat REAL,
  p REAL CHECK (p IS NULL OR (p >= 0 AND p <= 1)),
  alpha_k REAL NOT NULL CHECK (alpha_k > 0 AND alpha_k <= 1),
  triggered INTEGER NOT NULL CHECK (triggered IN (0,1)),
  PRIMARY KEY (lineage_id, rule_version, criterion, look_k)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER killswitch_look_no_update BEFORE UPDATE ON killswitch_look
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER killswitch_look_no_delete BEFORE DELETE ON killswitch_look
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- LLM router (LLM-030..037, 050)

-- Response cache keyed by (role, model, prompt hash, knowledge-base version); a row is deletable
-- only once expired. Nothing here is ever updated: a refresh deletes the expired row, then inserts.
CREATE TABLE llm_cache (
  role TEXT NOT NULL CHECK (length(role) > 0),
  model_id TEXT NOT NULL,
  prompt_sha TEXT NOT NULL,
  kb_version TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (role, model_id, prompt_sha, kb_version)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER llm_cache_no_update BEFORE UPDATE ON llm_cache
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER llm_cache_prune_only BEFORE DELETE ON llm_cache
WHEN OLD.expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only after expiry)');
END;

-- One row per router call, including cache hits and rules-only answers; 180 days like run records.
CREATE TABLE llm_call (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (length(role) > 0),
  provider TEXT NOT NULL,
  model_id TEXT,
  fallback_depth TEXT NOT NULL CHECK (fallback_depth = 'rules-only'
    OR (length(fallback_depth) > 0 AND fallback_depth NOT GLOB '*[^0-9]*')),
  tokens_in INTEGER NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out INTEGER NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  cached INTEGER NOT NULL DEFAULT 0 CHECK (cached IN (0,1)),
  outcome TEXT NOT NULL CHECK (length(outcome) > 0),
  injection_filtered INTEGER NOT NULL DEFAULT 0 CHECK (injection_filtered IN (0,1)),
  market TEXT NOT NULL,
  d TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_llm_call_d ON llm_call (market, d, role);
CREATE TRIGGER llm_call_no_update BEFORE UPDATE ON llm_call
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER llm_call_prune_only BEFORE DELETE ON llm_call
WHEN OLD.d >= date('now', '-180 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- +down
-- Dropping a table drops its triggers and indexes with it (DROP does not fire delete triggers).
-- The arena_order columns of M4 live in 0007 and go with it. Rolling back discards agent data;
-- this is meant for development only.
DROP TABLE llm_call;
DROP TABLE llm_cache;
DROP TABLE killswitch_look;
DROP TABLE replay_stat;
DROP TABLE label;
DROP TABLE validation_result;
DROP TABLE replay_run;
DROP TABLE ledger_control;
DROP TABLE ledger_row;
DROP TABLE trial_ledger;
DROP TABLE lineage_split;
DROP TABLE lineage;
DROP TABLE c2_selection;
DROP TABLE stop_level;
DROP TABLE card_note;
DROP TABLE decision_card;
DROP TABLE signal;
DROP TABLE insider_flow_score;
DROP TABLE event;
DROP TABLE regime_daily;
DROP TABLE pattern_daily;
DROP TABLE indicator_daily;
DROP TABLE insider_notice;
DROP TABLE short_interest;
DROP TABLE index_bar;
