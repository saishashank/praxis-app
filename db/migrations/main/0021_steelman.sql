-- +up
-- M11-lite (WP2, D-480..D-498): steelman and picks vs market. New tables only; nothing here touches an
-- order, fill, book, ledger, rule or breaker table (PRD-033). Dates are session dates (GLOB), JSON columns
-- are json_valid, money is integer micro, ratios are integer ppm, times are ISO UTC text. Every table is
-- STRICT. The steelman tables are append-only; steelman_suggestion moves once (open to closed).

-- 1. Evidence pack: one per subject (order card or pick) and night. pack_id = sha256 of the canonical items.
CREATE TABLE steelman_pack (
  pack_id TEXT PRIMARY KEY CHECK (length(pack_id) = 64 AND pack_id NOT GLOB '*[^0-9a-f]*'),
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('order','pick')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
  code TEXT NOT NULL CHECK (length(code) > 0),
  card_id TEXT CHECK (card_id IS NULL OR length(card_id) > 0),
  cutoff_at TEXT NOT NULL CHECK (length(cutoff_at) > 0),
  items_json TEXT NOT NULL CHECK (json_valid(items_json) AND json_type(items_json) = 'array'),
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  UNIQUE (market, d, subject_kind, subject_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER steelman_pack_no_update BEFORE UPDATE ON steelman_pack
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER steelman_pack_no_delete BEFORE DELETE ON steelman_pack
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 2. Points: every point is stored with its state (the log); only 'shown' renders.
CREATE TABLE steelman_point (
  point_id TEXT PRIMARY KEY CHECK (length(point_id) > 0),
  pack_id TEXT NOT NULL CHECK (length(pack_id) > 0),
  side TEXT NOT NULL CHECK (side IN ('bull','bear')),
  n INTEGER NOT NULL CHECK (n >= 1),
  text TEXT NOT NULL CHECK (length(text) > 0),
  citations_json TEXT NOT NULL CHECK (json_valid(citations_json) AND json_type(citations_json) = 'array'
    AND json_array_length(citations_json) >= 1),
  monitorable INTEGER NOT NULL CHECK (monitorable IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('shown','hidden_critic','dropped_citation','dropped_number','dropped_unsafe')),
  author_provider TEXT NOT NULL CHECK (length(author_provider) > 0),
  author_model TEXT NOT NULL CHECK (length(author_model) > 0),
  critic_provider TEXT CHECK (critic_provider IS NULL OR length(critic_provider) > 0),
  critic_model TEXT CHECK (critic_model IS NULL OR length(critic_model) > 0),
  critic_note TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  CHECK (side = 'bear' OR monitorable = 0)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER steelman_point_insert_guard BEFORE INSERT ON steelman_point
WHEN NOT EXISTS (SELECT 1 FROM steelman_pack p WHERE p.pack_id = NEW.pack_id)
BEGIN
  SELECT RAISE(ABORT, 'steelman_point: needs its steelman_pack');
END;
CREATE TRIGGER steelman_point_no_update BEFORE UPDATE ON steelman_point
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER steelman_point_no_delete BEFORE DELETE ON steelman_point
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 3. Night row: insert-once, the BLD-041 evidence (validity = claims_valid / claims_total).
CREATE TABLE steelman_night (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  requested INTEGER NOT NULL CHECK (requested >= 0),
  written INTEGER NOT NULL CHECK (written >= 0),
  not_written_limit INTEGER NOT NULL CHECK (not_written_limit >= 0),
  not_written_budget INTEGER NOT NULL CHECK (not_written_budget >= 0),
  not_written_no_model INTEGER NOT NULL CHECK (not_written_no_model >= 0),
  not_written_critic INTEGER NOT NULL CHECK (not_written_critic >= 0),
  claims_total INTEGER NOT NULL CHECK (claims_total >= 0),
  claims_valid INTEGER NOT NULL CHECK (claims_valid >= 0 AND claims_valid <= claims_total),
  validity_ppm INTEGER NOT NULL CHECK (validity_ppm BETWEEN 0 AND 1000000),
  critic_hidden INTEGER NOT NULL CHECK (critic_hidden >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  PRIMARY KEY (market, d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER steelman_night_no_update BEFORE UPDATE ON steelman_night
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER steelman_night_no_delete BEFORE DELETE ON steelman_night
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 4. Owner suggestions (AGT-133a): one per shown monitorable bear point; open moves once to a closed status.
CREATE TABLE steelman_suggestion (
  suggestion_id TEXT PRIMARY KEY CHECK (length(suggestion_id) > 0),
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  point_id TEXT NOT NULL CHECK (length(point_id) > 0),
  card_id TEXT CHECK (card_id IS NULL OR length(card_id) > 0),
  code TEXT NOT NULL CHECK (length(code) > 0),
  family TEXT NOT NULL CHECK (length(family) > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','expired')),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  closed_at TEXT,
  closed_by TEXT CHECK (closed_by IS NULL OR length(closed_by) > 0),
  CHECK (suggestion_id = point_id),
  CHECK ((status = 'open') = (closed_at IS NULL AND closed_by IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_steelman_suggestion_open ON steelman_suggestion (market, status, d);
CREATE TRIGGER steelman_suggestion_insert_guard BEFORE INSERT ON steelman_suggestion
WHEN NOT EXISTS (SELECT 1 FROM steelman_point p WHERE p.point_id = NEW.point_id
  AND p.side = 'bear' AND p.monitorable = 1 AND p.state = 'shown')
BEGIN
  SELECT RAISE(ABORT, 'steelman_suggestion: needs a shown monitorable bear point');
END;
CREATE TRIGGER steelman_suggestion_guard_update BEFORE UPDATE ON steelman_suggestion
WHEN NOT (OLD.status = 'open'
  AND NEW.suggestion_id IS OLD.suggestion_id AND NEW.market IS OLD.market AND NEW.d IS OLD.d
  AND NEW.point_id IS OLD.point_id AND NEW.card_id IS OLD.card_id AND NEW.code IS OLD.code
  AND NEW.family IS OLD.family AND NEW.created_at IS OLD.created_at)
BEGIN
  SELECT RAISE(ABORT, 'steelman_suggestion: an open row moves once to dismissed or expired');
END;
CREATE TRIGGER steelman_suggestion_no_delete BEFORE DELETE ON steelman_suggestion
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 5. Picks vs market (PRD-030, ARN-103/104): written with the settlement, immutable.
CREATE TABLE pick_market (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  profile TEXT NOT NULL CHECK (length(profile) > 0),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 10),
  kind TEXT NOT NULL CHECK (kind IN ('pick','luck')),
  window_from_d TEXT NOT NULL CHECK (window_from_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  window_to_d TEXT NOT NULL CHECK (window_to_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  index_code TEXT NOT NULL CHECK (length(index_code) > 0),
  basis TEXT NOT NULL CHECK (basis IN ('price_only','total_return')),
  index_from_micro INTEGER NOT NULL CHECK (index_from_micro > 0),
  index_to_micro INTEGER NOT NULL CHECK (index_to_micro > 0),
  market_ret_ppm INTEGER NOT NULL,
  pick_net_ppm INTEGER,
  vs_market_ppm INTEGER,
  missed INTEGER NOT NULL CHECK (missed IN (0,1)),
  settled_d TEXT NOT NULL CHECK (settled_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (market, d, profile, rank, kind),
  CHECK ((missed = 1) = (pick_net_ppm IS NULL AND vs_market_ppm IS NULL)),
  CHECK (missed = 1 OR (pick_net_ppm IS NOT NULL AND vs_market_ppm IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER pick_market_insert_guard BEFORE INSERT ON pick_market
WHEN NOT EXISTS (SELECT 1 FROM pick_outcome o WHERE o.market = NEW.market AND o.d = NEW.d
  AND o.profile = NEW.profile AND o.rank = NEW.rank AND o.kind = NEW.kind
  AND o.state IN ('closed','missed'))
BEGIN
  SELECT RAISE(ABORT, 'pick_market: needs a closed or missed pick_outcome');
END;
CREATE TRIGGER pick_market_no_update BEFORE UPDATE ON pick_market
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER pick_market_no_delete BEFORE DELETE ON pick_market
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 6. Reflection (optional WP8; harmless if unused).
CREATE TABLE pick_reflection (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  profile TEXT NOT NULL CHECK (length(profile) > 0),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 10),
  text TEXT NOT NULL,
  agreed_point_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(agreed_point_ids_json)),
  provider TEXT,
  model TEXT,
  state TEXT NOT NULL CHECK (state IN ('written','not_written')),
  reason TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  PRIMARY KEY (market, d, profile, rank),
  CHECK (state <> 'written' OR length(text) > 0)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER pick_reflection_no_update BEFORE UPDATE ON pick_reflection
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER pick_reflection_no_delete BEFORE DELETE ON pick_reflection
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- +down
DROP TABLE pick_reflection;
DROP TABLE pick_market;
DROP TABLE steelman_suggestion;
DROP TABLE steelman_night;
DROP TABLE steelman_point;
DROP TABLE steelman_pack;
