-- +up
-- Pick validity by information, not by a number of sessions (D-187, Owner 2026-10-25). Every night a
-- pick that has not been bought yet is checked again against that night's information (price
-- against its stop, aim and reward-to-risk; the market regime; negative announcement events; the
-- family's validation label; data faults and halts; the typical holding time of past similar
-- trades). Each night's verdict is one row here, written that night and never changed, so a later
-- recomputation can never re-decide a past night with hindsight. A pick can be bought at the next
-- open only after a passing check; the first failing check withdraws it (pick_outcome 'missed'),
-- and `reason` says why. The luck-check twin follows its pick's verdicts.
CREATE TABLE pick_check (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  profile TEXT NOT NULL CHECK (length(profile) > 0),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 10),
  night_d TEXT NOT NULL CHECK (night_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  valid INTEGER NOT NULL CHECK (valid IN (0,1)),
  reason TEXT CHECK (reason IS NULL OR reason IN ('below_stop','aim_reached','edge_eroded',
    'regime','negative_news','evidence','data','horizon')),
  checked_at TEXT NOT NULL,
  PRIMARY KEY (market, d, profile, rank, night_d),
  CHECK ((valid = 1) = (reason IS NULL)),
  CHECK (night_d > d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER pick_check_needs_pick BEFORE INSERT ON pick_check
WHEN NOT EXISTS (SELECT 1 FROM pick p WHERE p.market = NEW.market AND p.d = NEW.d
  AND p.profile = NEW.profile AND p.rank = NEW.rank)
BEGIN
  SELECT RAISE(ABORT, 'pick_check: needs its published pick');
END;
CREATE TRIGGER pick_check_no_update BEFORE UPDATE ON pick_check
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER pick_check_no_delete BEFORE DELETE ON pick_check
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- +down
DROP TABLE pick_check;
