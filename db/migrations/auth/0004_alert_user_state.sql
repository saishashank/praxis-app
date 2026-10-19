-- +up
-- UXN-157/160/161, ROL-102a, docs/M5_design.md decision 32 (D-096): per-user state of an alert.
-- The alert itself lives in the main DB (`alert`); this row says whether THIS user acknowledged it
-- and until when THIS user snoozed it. Kept in the auth DB with the user (ROL-101a), so revoking a
-- user keeps their state with their identity. `alert_key` is therefore not a foreign key (two
-- databases). Quiet hours are not here: they join the validated prefs_json of user_preference.
--
-- A user changes only their own rows (the service checks the session user; the database cannot know
-- who is calling). What the triggers enforce:
--   - the key never changes;
--   - an acknowledgement goes NULL -> value once and is never undone (the badge clears only on
--     acknowledge, UXN-161); writing the same time again is allowed;
--   - a snooze may be set, moved or cleared (UXN-160: snoozed items stay visible);
--   - updated_at only moves forward;
--   - rows are never deleted (a revoked user's state is kept with the user).
-- No secrets and no personal data (SEC-103).
CREATE TABLE alert_user_state (
  user_id INTEGER NOT NULL REFERENCES app_user (id),
  alert_key TEXT NOT NULL CHECK (length(alert_key) > 0),
  acked_at TEXT,
  snoozed_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, alert_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_alert_user_state_key ON alert_user_state (alert_key);
CREATE TRIGGER alert_user_state_guard_update BEFORE UPDATE ON alert_user_state
WHEN NOT (NEW.user_id IS OLD.user_id AND NEW.alert_key IS OLD.alert_key
  AND (OLD.acked_at IS NULL OR NEW.acked_at IS OLD.acked_at)
  AND NEW.updated_at >= OLD.updated_at)
BEGIN
  SELECT RAISE(ABORT, 'alert_user_state: the key is fixed, an acknowledgement is final, updated_at moves forward');
END;
CREATE TRIGGER alert_user_state_no_delete BEFORE DELETE ON alert_user_state
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- +down
DROP TABLE alert_user_state;
