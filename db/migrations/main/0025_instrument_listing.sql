-- +up
-- V1-S7 (should-fix batch A, D-760..D-764): code reuse. `instrument` is one row per (market, code) and every
-- price history is keyed by it, so a code that a different company takes over after a delisting would
-- inherit the old company's bars (ADV, tiers, indicators, corporate-action evidence). A LISTING row records
-- "from this session on, the history of this code is a new entity's". Readers that look back over
-- price_bar / universe_snapshot stop at the newest listing's listed_on (see src/lib/data/listing.ts for
-- the one SQL fragment); with no row (every code today, every replay world) nothing is bounded.
-- Rows are written only by the Owner decision `confirmCodeReuse` (audited) at the import that reactivates
-- the code, and are append-only. DAT-130 holds: old bars and the old delisting stay, forever.
CREATE TABLE instrument_listing (
  id INTEGER PRIMARY KEY,
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  listed_on TEXT NOT NULL CHECK (listed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  name TEXT NOT NULL CHECK (length(name) <= 200),
  prior_name TEXT CHECK (prior_name IS NULL OR length(prior_name) <= 200),
  prior_delisted_on TEXT,
  decided_by TEXT NOT NULL CHECK (length(decided_by) <= 80),
  created_at TEXT NOT NULL,
  UNIQUE (market, code, listed_on)
) STRICT;
CREATE INDEX idx_instrument_listing_code ON instrument_listing (market, code, listed_on);
CREATE TRIGGER instrument_listing_no_update BEFORE UPDATE ON instrument_listing
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER instrument_listing_no_delete BEFORE DELETE ON instrument_listing
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
-- A delisted instrument may not silently come back (V1-S7 fix part 3): delisted_on returns to NULL only
-- for a code the universe import delisted itself (absent from the file) or one the Owner has decided on.
-- A quarantined code (`code_reuse_suspected:...`), a NULL reason or anything else is refused.
CREATE TRIGGER instrument_no_revive BEFORE UPDATE OF delisted_on ON instrument
WHEN OLD.delisted_on IS NOT NULL AND NEW.delisted_on IS NULL
  AND COALESCE(OLD.delist_reason, '') <> 'absent_from_listed_companies'
  AND COALESCE(OLD.delist_reason, '') NOT LIKE 'relist_confirmed%'
  AND COALESCE(OLD.delist_reason, '') NOT LIKE 'reuse_confirmed%'
BEGIN
  SELECT RAISE(ABORT, 'delisted instrument: only an auto-delisted or Owner-confirmed code may be reactivated');
END;

-- +down
DROP TRIGGER instrument_no_revive;
DROP TRIGGER instrument_listing_no_delete;
DROP TRIGGER instrument_listing_no_update;
DROP TABLE instrument_listing;
