-- +up
-- M18 data (docs/M18_design.md stream E1; D-972, D-973, D-974, D-975, D-978).
--
-- 1. code_history (DAT-251 a, D-972): what the ASX fetch learned about a code that did not answer. One open
--    row per (market, code, event, first_d): `runs` counts consecutive runs with that event, `last_d` is the
--    last day it was seen, `closed_d` is set when the code reappears in the listed-companies file. Three
--    consecutive `not_found` runs write a `delisted` row and the code leaves the history fetch list until it
--    reappears. The table is mutable (counters move), small (one row per code that ever failed, < 500) and
--    never read by a trading path. The spec's "code-history table (CTX-015)" is a mis-citation, see D-972.
CREATE TABLE code_history (
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 8),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 32),
  event TEXT NOT NULL CHECK (event IN ('not_found','renamed','delisted')),
  first_d TEXT NOT NULL CHECK (first_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  last_d TEXT NOT NULL CHECK (last_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  runs INTEGER NOT NULL CHECK (runs >= 1),
  closed_d TEXT CHECK (closed_d IS NULL OR closed_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- 1 once a `delisted` code has been missing from the ASX file: only then does its return close the row
  -- (a code the file still lists is merely skipped by the history fetch, never "reappeared").
  absent INTEGER NOT NULL DEFAULT 0 CHECK (absent IN (0,1)),
  PRIMARY KEY (market, code, event, first_d)
) STRICT, WITHOUT ROWID;

-- 2. source_fetch_status (DAT-252 (2), D-974): the consecutive-failure counter of one fetched source (here
--    the ASX listed-companies file). The Wikidata fallback engages at consecutive_failures >= 3 and only when
--    the `wikidata_asx` register row is enabled. One row per source, updated in place by scripts/asx/fetch.mjs.
CREATE TABLE source_fetch_status (
  source TEXT PRIMARY KEY CHECK (length(source) BETWEEN 1 AND 64),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_ok_at TEXT,
  last_failed_at TEXT,
  last_cause TEXT CHECK (last_cause IS NULL OR last_cause IN
    ('ok','not_found','rate_limited','server_error','network','parse'))
) STRICT, WITHOUT ROWID;

-- 3. macro_series (DAT-251 c, D-973): RBA and ABS numbers parsed from their CSV tables, value in micro
--    units, one row per (source, series, day). Written by scripts/macro/*.mjs (a Friday step gated by the
--    MACRO_FETCH repository variable; ships off). Derived numbers only, source named (DAT-236).
CREATE TABLE macro_series (
  source TEXT NOT NULL CHECK (source IN ('rba','abs')),
  series_id TEXT NOT NULL CHECK (length(series_id) BETWEEN 1 AND 64),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  value_micro INTEGER NOT NULL,
  fetched_at TEXT NOT NULL CHECK (length(fetched_at) > 0),
  PRIMARY KEY (source, series_id, d)
) STRICT, WITHOUT ROWID;

-- 4. expert_call_outcome.early (OPS-112 (1), D-978): 1 when the call closed on the weekly run that reached its
--    horizon session without that session's own bar (the call is then settled on the last bar before it and
--    marked early). Insert-once stays: ADD COLUMN is not an UPDATE; existing rows read 0.
ALTER TABLE expert_call_outcome ADD COLUMN early INTEGER NOT NULL DEFAULT 0 CHECK (early IN (0,1));

-- 5. Licence register rows for DAT-253 (D-975). Both are PENDING (terms [VERIFY]); nothing fetches in M18
--    and no document text is stored. Register rows only, like the other reference sources: no source_status
--    row (nothing fetches, so there is nothing to switch off). The inserts write their history rows through
--    the 0004 trigger.
INSERT INTO source_register (source, permitted_use, rate_limits, risk, status, owner_ref, summarisation_permitted)
VALUES
  ('asic_documents', 'public regulator documents: links and own summary only (DAT-253); terms [VERIFY]',
   'none set; nothing fetches in M18 (KB-082 is M22)', 'low', 'pending', NULL, 1),
  ('ssrn_papers', 'abstract page links only, no PDF fetch (DAT-253); terms [VERIFY]',
   'none set; nothing fetches in M18 (KB-082 is M22)', 'medium', 'pending', NULL, 0);

-- +down
-- The register and its history refuse DELETE: the guards are lifted for the statements
-- below and restored with the identical definitions from migration 0004.
DROP TRIGGER source_register_no_delete;
DROP TRIGGER source_register_history_no_delete;
DELETE FROM source_register_history WHERE source IN ('asic_documents','ssrn_papers');
DELETE FROM source_register WHERE source IN ('asic_documents','ssrn_papers');
CREATE TRIGGER source_register_no_delete BEFORE DELETE ON source_register
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;
CREATE TRIGGER source_register_history_no_delete BEFORE DELETE ON source_register_history
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
ALTER TABLE expert_call_outcome DROP COLUMN early;
DROP TABLE macro_series;
DROP TABLE source_fetch_status;
DROP TABLE code_history;
