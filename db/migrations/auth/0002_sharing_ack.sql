-- +up
-- ROL-107: the Owner's sharing acknowledgement, one row per recording, per market. Append-only.
-- No secrets and no personal data here (SEC-103); acknowledged_by is the Owner's app_user id.
CREATE TABLE sharing_ack (
  id INTEGER PRIMARY KEY,
  market TEXT NOT NULL,
  acknowledged_by INTEGER NOT NULL,
  acknowledged_at TEXT NOT NULL,
  text_version TEXT NOT NULL
);
CREATE INDEX idx_sharing_ack_market ON sharing_ack (market);
CREATE TRIGGER sharing_ack_no_update BEFORE UPDATE ON sharing_ack
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER sharing_ack_no_delete BEFORE DELETE ON sharing_ack
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- +down
DROP TRIGGER sharing_ack_no_delete;
DROP TRIGGER sharing_ack_no_update;
DROP TABLE sharing_ack;
