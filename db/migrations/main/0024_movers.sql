-- +up
-- V2 movers gap additions (D-740…D-759; change requests CR-MOV-A1…A8 in the private design-freeze record).
-- Five small, additive tables; nothing here touches an order, fill, book, ledger, lesson or card table.
-- Dates are session dates (GLOB), times are ISO UTC text, money is not stored. Every table is STRICT.
--
-- 1. announcement_archive (A7): every announcement the Sentinel ingests, forever (the `announcement`
--    table is pruned beyond 400 days). Append-only; known_at is the instant this system first stored
--    the row, so a calibration that reads it later cannot see an announcement before the app did.
CREATE TABLE announcement_archive (
  id INTEGER PRIMARY KEY,
  market TEXT NOT NULL CHECK (length(market) > 0),
  code TEXT NOT NULL CHECK (length(code) > 0),
  source TEXT NOT NULL CHECK (length(source) > 0),
  ann_id TEXT NOT NULL CHECK (length(ann_id) > 0),
  published_at TEXT NOT NULL CHECK (length(published_at) > 0),
  known_at TEXT NOT NULL CHECK (length(known_at) > 0),
  session_d TEXT NOT NULL CHECK (session_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  timing TEXT NOT NULL CHECK (timing IN ('pre_open','intraday','post_close')),
  type TEXT,
  price_sensitive INTEGER NOT NULL CHECK (price_sensitive IN (0,1)),
  halt_kind TEXT CHECK (halt_kind IS NULL OR halt_kind IN ('halt','suspension','reinstatement')),
  title TEXT NOT NULL,
  UNIQUE (source, ann_id)
) STRICT;
CREATE INDEX idx_announcement_archive_code ON announcement_archive (market, code, published_at);
CREATE INDEX idx_announcement_archive_session ON announcement_archive (market, session_d);
CREATE TRIGGER announcement_archive_no_update BEFORE UPDATE ON announcement_archive
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER announcement_archive_no_delete BEFORE DELETE ON announcement_archive
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 2. halt_watch (A1): one row per transition of a halt or suspension watch, current state = max(seq)
--    of (market, code, since_d). 'open' when the notice is known, 'resumed' when the code trades again.
CREATE TABLE halt_watch (
  id INTEGER PRIMARY KEY,
  market TEXT NOT NULL CHECK (length(market) > 0),
  code TEXT NOT NULL CHECK (length(code) > 0),
  since_d TEXT NOT NULL CHECK (since_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  status TEXT NOT NULL CHECK (status IN ('open','resumed')),
  reason_class TEXT NOT NULL CHECK (reason_class IN
    ('capital_raise','takeover','material_announcement','regulatory','unknown')),
  expected_sign INTEGER NOT NULL CHECK (expected_sign IN (-1,0,1)),
  notice_source TEXT,
  notice_ann_id TEXT,
  resume_d TEXT CHECK (resume_d IS NULL OR resume_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  known_at TEXT NOT NULL CHECK (length(known_at) > 0),
  UNIQUE (market, code, since_d, seq),
  CHECK ((status = 'resumed') = (resume_d IS NOT NULL))
) STRICT;
CREATE INDEX idx_halt_watch_code ON halt_watch (market, code, since_d, seq);
CREATE TRIGGER halt_watch_no_update BEFORE UPDATE ON halt_watch
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER halt_watch_no_delete BEFORE DELETE ON halt_watch
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 3. intraday_arm (A1, A3): codes the M17 scan quotes on a session although no Sentinel catalyst of
--    the day exists yet (a resume after a halt, a volume-creep name). The first writer for a
--    (market, session, code) wins. Append-only.
CREATE TABLE intraday_arm (
  market TEXT NOT NULL CHECK (length(market) > 0),
  session_d TEXT NOT NULL CHECK (session_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  code TEXT NOT NULL CHECK (length(code) > 0),
  reason TEXT NOT NULL CHECK (reason IN ('halt_resume','volume_creep')),
  expected_sign INTEGER NOT NULL DEFAULT 0 CHECK (expected_sign IN (-1,0,1)),
  armed_from TEXT NOT NULL CHECK (armed_from GLOB '[0-2][0-9]:[0-5][0-9]'),
  ref TEXT NOT NULL CHECK (length(ref) > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  PRIMARY KEY (market, session_d, code)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER intraday_arm_no_update BEFORE UPDATE ON intraday_arm
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER intraday_arm_no_delete BEFORE DELETE ON intraday_arm
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 4. sector_composite_daily (A8): equal-weight daily return per industry over the liquid universe,
--    from the CURRENT sector map (map_as_of labels it, D-271). Append-only, one row per industry-day.
CREATE TABLE sector_composite_daily (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  industry TEXT NOT NULL CHECK (length(industry) > 0),
  ret_ppm INTEGER NOT NULL,
  n_members INTEGER NOT NULL CHECK (n_members >= 1),
  map_as_of TEXT NOT NULL CHECK (map_as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  PRIMARY KEY (market, d, industry)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER sector_composite_daily_no_update BEFORE UPDATE ON sector_composite_daily
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER sector_composite_daily_no_delete BEFORE DELETE ON sector_composite_daily
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 5. angle_forward_flag (A3): the nightly live measurement of an angle that has no history (A-D2-07):
--    one row per flagged code, night and grid point. Sparse by design (only flagged names); the
--    universe of the night is in cortex_feature_daily / price_bar. Append-only.
CREATE TABLE angle_forward_flag (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  code TEXT NOT NULL CHECK (length(code) > 0),
  angle_id TEXT NOT NULL CHECK (angle_id GLOB 'A-D[0-9]*-[0-9][0-9]'),
  grid_key TEXT NOT NULL CHECK (length(grid_key) > 0),
  angle_version INTEGER NOT NULL CHECK (angle_version >= 1),
  known_at TEXT NOT NULL CHECK (length(known_at) > 0),
  PRIMARY KEY (market, d, code, angle_id, grid_key)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER angle_forward_flag_no_update BEFORE UPDATE ON angle_forward_flag
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER angle_forward_flag_no_delete BEFORE DELETE ON angle_forward_flag
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- +down
DROP TABLE angle_forward_flag;
DROP TABLE sector_composite_daily;
DROP TABLE intraday_arm;
DROP TABLE halt_watch;
DROP TABLE announcement_archive;
