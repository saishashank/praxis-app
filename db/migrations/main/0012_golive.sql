-- +up
-- Go-live sign-off (M8 T11, docs/M8_design.md decisions 33 and 34; D-047, D-125).
-- go_live_signoff: the Owner's in-app sign-off on /ops/go-live. A row says: on `signed_at` the Owner
-- (`signed_by`, an auth-DB user id; no foreign key across databases) ticked every go-live checklist
-- item for the release commit `release_commit` and wrote an optional note. Production `full` mode is
-- refused for a market that has no row here (src/lib/golive/interlock.ts). Append-only and forever:
-- a sign-off is a record, never edited or removed. It never holds a secret, a name or an email.
-- audit_ref is the id of the auth audit event written first ('audit:<id>').
-- Conventions as 0011: STRICT, instants are ISO-8601 UTC text, JSON columns are json_valid.
CREATE TABLE go_live_signoff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL CHECK (length(market) > 0),
  signed_by INTEGER NOT NULL CHECK (signed_by >= 1),
  signed_at TEXT NOT NULL CHECK (length(signed_at) > 0),
  release_commit TEXT NOT NULL
    CHECK (length(release_commit) BETWEEN 7 AND 64 AND release_commit NOT GLOB '*[^0-9a-f]*'),
  items_json TEXT NOT NULL CHECK (json_valid(items_json) AND json_type(items_json) = 'array'),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  audit_ref TEXT NOT NULL CHECK (length(audit_ref) > 0)
) STRICT;
CREATE INDEX idx_go_live_signoff_market ON go_live_signoff (market, id);
-- INSERT OR REPLACE with an existing id would delete the old row without firing the delete trigger,
-- so an insert that names an id already in use is refused too.
CREATE TRIGGER go_live_signoff_no_replace BEFORE INSERT ON go_live_signoff
WHEN EXISTS (SELECT 1 FROM go_live_signoff WHERE id IS NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER go_live_signoff_no_update BEFORE UPDATE ON go_live_signoff
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER go_live_signoff_no_delete BEFORE DELETE ON go_live_signoff
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- +down
DROP TABLE go_live_signoff;
