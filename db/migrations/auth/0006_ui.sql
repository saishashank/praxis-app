-- +up
-- M7 T2 (docs/M7_design.md 2.4 and 2.11, D-128): unmask grants and the personal watchlist.
--
-- unmask_grant (UX-009, ROL-107): the Owner lets one non-Owner see real stock codes for a limited
-- time (`unmask_expiry`, 30 days by default). A grant is never edited and never deleted; the only
-- allowed change is one revocation (revoked_at + revoked_by set together, once). A grant is live
-- while revoked_at IS NULL and expires_at is in the future; the masking module reads it that way.
-- The grant and its audit event commit together (the service, ROL-104).
-- user_watchlist (decision 56): a personal list of (market, code) per Owner or Editor; its size cap
-- (`watchlist_max`) is enforced in code, the table only keeps rows unique per user.
-- No secrets (SEC-103).
CREATE TABLE unmask_grant (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES app_user (id),
  granted_by INTEGER NOT NULL REFERENCES app_user (id),
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by INTEGER REFERENCES app_user (id),
  CHECK (expires_at > granted_at),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
) STRICT;
CREATE INDEX idx_unmask_grant_user ON unmask_grant (user_id, expires_at);

CREATE TRIGGER unmask_grant_guard_update BEFORE UPDATE ON unmask_grant
WHEN NOT (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.revoked_by IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.user_id IS OLD.user_id AND NEW.granted_by IS OLD.granted_by
  AND NEW.granted_at IS OLD.granted_at AND NEW.expires_at IS OLD.expires_at)
BEGIN
  SELECT RAISE(ABORT, 'unmask_grant: one revocation only, nothing else changes');
END;
CREATE TRIGGER unmask_grant_no_delete BEFORE DELETE ON unmask_grant
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

CREATE TABLE user_watchlist (
  user_id INTEGER NOT NULL REFERENCES app_user (id),
  market TEXT NOT NULL CHECK (length(market) > 0),
  code TEXT NOT NULL CHECK (length(code) > 0),
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, market, code)
) STRICT, WITHOUT ROWID;

-- +down
DROP TABLE user_watchlist;
DROP TABLE unmask_grant;
