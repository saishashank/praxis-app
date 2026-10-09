-- +up
-- SEC-103: no secret columns in any table.
CREATE TABLE app_user (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,            -- stored lower-case
  name TEXT,
  google_sub TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','editor','viewer')),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','revoked')),
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  pii_hashed_at TEXT
);
-- ROL-101: the Owner is exactly one address (at most one non-revoked owner row).
CREATE UNIQUE INDEX uq_app_user_one_owner ON app_user (role)
  WHERE role = 'owner' AND status <> 'revoked';

-- Audit events (NFR-023, ROL-104). Append-only hash chain.
-- ip and user_agent are NOT part of the HMAC content so that nulling them (NFR-030) never breaks
-- the chain; the UPDATE trigger allows exactly that change and nothing else.
CREATE TABLE audit_event (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail_json TEXT,
  ip TEXT,
  user_agent TEXT,
  prev_hmac TEXT NOT NULL,
  row_hmac TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_audit_event_at ON audit_event (at);
CREATE INDEX idx_audit_event_actor ON audit_event (actor_user_id);
CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event
WHEN NEW.id IS NOT OLD.id
  OR NEW.at IS NOT OLD.at
  OR NEW.actor_user_id IS NOT OLD.actor_user_id
  OR NEW.action IS NOT OLD.action
  OR NEW.target_type IS NOT OLD.target_type
  OR NEW.target_id IS NOT OLD.target_id
  OR NEW.detail_json IS NOT OLD.detail_json
  OR NEW.prev_hmac IS NOT OLD.prev_hmac
  OR NEW.row_hmac IS NOT OLD.row_hmac
  OR (NEW.ip IS NOT NULL AND NEW.ip IS NOT OLD.ip)
  OR (NEW.user_agent IS NOT NULL AND NEW.user_agent IS NOT OLD.user_agent)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Rate-limit buckets (SEC-014); logic comes with auth.
CREATE TABLE rate_limit (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

-- +down
DROP TABLE rate_limit;
DROP TRIGGER audit_event_no_update;
DROP TRIGGER audit_event_no_delete;
DROP TABLE audit_event;
DROP TABLE app_user;
