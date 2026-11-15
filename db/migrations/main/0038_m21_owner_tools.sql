-- +up
-- M21 A1 (docs/M21_design.md section A "Migration 0038"; D-1221, D-1227, D-1228, D-1236, D-1237).
-- Six STRICT, append-only tables for the Owner tools and the shadow short stream, and NOT ONE data row. No table of an
-- earlier migration is changed or rebuilt (email_message and pick_alert stay as they are, D-1226), so the AT-32
-- identity baseline, the schemaSha of STAGE_TABLES (D-1116) and every AU hash are unchanged.
--
-- 1. owner_trade, owner_trade_void   the Owner's own trade log (ARN-121, D-1221); a mistyped row is voided, never edited.
-- 2. owner_holding                   the Owner's holdings uploads (UXN-316, D-1220); the current set is the newest
--                                    upload_id of a market.
-- 3. golden_label                    the CTX-040 golden-set labels (UXN-318, D-1227); label_item (0036) stays the
--                                    DAT-245 category store. The value lists equal LABEL_ENUMS (src/lib/llm/textLabels.ts).
-- 4. short_shadow_decision, _outcome the shadow short stream (VAL-121, D-1228); written by one batch-3 step, read by
--                                    nothing that trades, learns or feeds Cortex.
-- Five of the six carry a `market` column and get the two guard triggers (D-995, D-1022; generated region below,
-- scripts/db/gen-market-guard.mjs; `--check` derives the table list from the schema). owner_trade_void has none: its
-- trade_id points at a guarded owner_trade row.

-- 1a. The Owner's trades. Prices and fees are micro units of the market's currency; d is the trade date.
CREATE TABLE owner_trade (
  id INTEGER PRIMARY KEY,
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 32),
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  qty INTEGER NOT NULL CHECK (qty > 0),
  price_micro INTEGER NOT NULL CHECK (price_micro > 0),
  fees_micro INTEGER NOT NULL CHECK (fees_micro >= 0),
  note TEXT CHECK (note IS NULL OR length(note) <= 200),
  source TEXT NOT NULL CHECK (source IN ('typed','csv')),
  upload_id TEXT CHECK (upload_id IS NULL OR length(upload_id) BETWEEN 1 AND 64),
  entered_at TEXT NOT NULL,
  entered_by TEXT NOT NULL CHECK (length(entered_by) BETWEEN 1 AND 64)
) STRICT;
CREATE INDEX idx_owner_trade_code ON owner_trade (market, code, d, id);
CREATE TRIGGER owner_trade_no_update BEFORE UPDATE ON owner_trade
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER owner_trade_no_delete BEFORE DELETE ON owner_trade
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 1b. A void of one trade (a mistyped row): once per trade, with a reason; the trade row itself stays.
CREATE TABLE owner_trade_void (
  trade_id INTEGER PRIMARY KEY REFERENCES owner_trade (id),
  voided_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200)
) STRICT;
CREATE TRIGGER owner_trade_void_no_update BEFORE UPDATE ON owner_trade_void
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER owner_trade_void_no_delete BEFORE DELETE ON owner_trade_void
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 2. The Owner's holdings: one upload is a set of rows sharing an upload_id; the newest upload of a market is current.
CREATE TABLE owner_holding (
  upload_id TEXT NOT NULL CHECK (length(upload_id) BETWEEN 1 AND 64),
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 32),
  qty INTEGER NOT NULL CHECK (qty > 0),
  avg_cost_micro INTEGER NOT NULL CHECK (avg_cost_micro > 0),
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (upload_id, market, code)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER owner_holding_no_update BEFORE UPDATE ON owner_holding
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER owner_holding_no_delete BEFORE DELETE ON owner_holding
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 3. The golden-set labels (CTX-040: guidance, event confirmation, tone). A skip or unclear answer carries no label; a
--    labelled answer carries all three. A relabel is a new row (a later labelled_at).
CREATE TABLE golden_label (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  ann_id TEXT NOT NULL CHECK (length(ann_id) BETWEEN 1 AND 128),
  labelled_at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  answer TEXT NOT NULL CHECK (answer IN ('labelled','skip','unclear')),
  guidance TEXT CHECK (guidance IS NULL OR guidance IN ('up','same','down','none')),
  event_confirm TEXT CHECK (event_confirm IS NULL OR event_confirm IN ('confirmed','contradicted','unclear')),
  tone TEXT CHECK (tone IS NULL OR tone IN ('negative','neutral','positive')),
  span TEXT CHECK (span IS NULL OR length(span) BETWEEN 1 AND 300),
  CHECK ((answer = 'labelled') = (guidance IS NOT NULL AND event_confirm IS NOT NULL AND tone IS NOT NULL)),
  PRIMARY KEY (market, source, ann_id, labelled_at)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER golden_label_no_update BEFORE UPDATE ON golden_label
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER golden_label_no_delete BEFORE DELETE ON golden_label
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 4a. The shadow short stream's selection (VAL-121, D-1228): which names were picked as shorts, by which origin.
CREATE TABLE short_shadow_decision (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 32),
  origin TEXT NOT NULL CHECK (origin IN ('lowest_rank','event_polarity')),
  book_id TEXT NOT NULL CHECK (length(book_id) BETWEEN 1 AND 64),
  rank_key TEXT CHECK (rank_key IS NULL OR length(rank_key) <= 200),
  family TEXT CHECK (family IS NULL OR length(family) <= 64),
  shortable INTEGER NOT NULL CHECK (shortable IN (0,1)),
  rule_id TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (market, d, code, origin)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER short_shadow_decision_no_update BEFORE UPDATE ON short_shadow_decision
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER short_shadow_decision_no_delete BEFORE DELETE ON short_shadow_decision
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 4b. The scored outcome of a shadow short. NULL prices and amounts mean the order never filled or the name was not shortable.
CREATE TABLE short_shadow_outcome (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 32),
  origin TEXT NOT NULL CHECK (origin IN ('lowest_rank','event_polarity')),
  status TEXT NOT NULL CHECK (status IN ('closed','unfilled','not_shortable')),
  entry_d TEXT CHECK (entry_d IS NULL OR entry_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  entry_micro INTEGER CHECK (entry_micro IS NULL OR entry_micro > 0),
  exit_d TEXT CHECK (exit_d IS NULL OR exit_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  exit_micro INTEGER CHECK (exit_micro IS NULL OR exit_micro > 0),
  exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN ('stop','gap','time')),
  fees_micro INTEGER CHECK (fees_micro IS NULL OR fees_micro >= 0),
  borrow_micro INTEGER CHECK (borrow_micro IS NULL OR borrow_micro >= 0),
  net_micro INTEGER,
  net_ppm INTEGER,
  scored_at TEXT NOT NULL,
  PRIMARY KEY (market, d, code, origin)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER short_shadow_outcome_no_update BEFORE UPDATE ON short_shadow_outcome
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER short_shadow_outcome_no_delete BEFORE DELETE ON short_shadow_outcome
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- BEGIN GENERATED guard triggers (scripts/db/gen-market-guard.mjs; do not edit by hand)
-- golden_label
CREATE TRIGGER golden_label_market_guard_ins BEFORE INSERT ON golden_label
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled golden_label');
END;
CREATE TRIGGER golden_label_market_guard_upd BEFORE UPDATE OF market ON golden_label
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled golden_label');
END;

-- owner_holding
CREATE TRIGGER owner_holding_market_guard_ins BEFORE INSERT ON owner_holding
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled owner_holding');
END;
CREATE TRIGGER owner_holding_market_guard_upd BEFORE UPDATE OF market ON owner_holding
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled owner_holding');
END;

-- owner_trade
CREATE TRIGGER owner_trade_market_guard_ins BEFORE INSERT ON owner_trade
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled owner_trade');
END;
CREATE TRIGGER owner_trade_market_guard_upd BEFORE UPDATE OF market ON owner_trade
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled owner_trade');
END;

-- short_shadow_decision
CREATE TRIGGER short_shadow_decision_market_guard_ins BEFORE INSERT ON short_shadow_decision
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled short_shadow_decision');
END;
CREATE TRIGGER short_shadow_decision_market_guard_upd BEFORE UPDATE OF market ON short_shadow_decision
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled short_shadow_decision');
END;

-- short_shadow_outcome
CREATE TRIGGER short_shadow_outcome_market_guard_ins BEFORE INSERT ON short_shadow_outcome
WHEN NEW.market IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled short_shadow_outcome');
END;
CREATE TRIGGER short_shadow_outcome_market_guard_upd BEFORE UPDATE OF market ON short_shadow_outcome
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled short_shadow_outcome');
END;

-- END GENERATED guard triggers

-- +down
-- The six tables go with their triggers (the guard triggers are dropped with their tables).
DROP TABLE short_shadow_outcome;
DROP TABLE short_shadow_decision;
DROP TABLE golden_label;
DROP TABLE owner_holding;
DROP TABLE owner_trade_void;
DROP TABLE owner_trade;
