-- +up
-- UX-110, DAT-150, ROL-102a: one row of personal preferences per user (theme, default market, time
-- format, alert display). Kept in the auth DB with the user (ROL-101a). No secrets and no personal
-- data: prefs_json holds only the validated preference values (SEC-103).
CREATE TABLE user_preference (
  user_id INTEGER PRIMARY KEY REFERENCES app_user (id),
  prefs_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- +down
DROP TABLE user_preference;
