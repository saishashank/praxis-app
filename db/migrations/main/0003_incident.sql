-- +up
-- Incidents (NFR-006, OPS-011). First writer: the nightly approved-commit watchdog (SEC-108 d),
-- which opens an S1 `unapproved_production_code`. detail_json holds short facts only (never a
-- secret). resolved_at is set when the Owner closes the incident; open = resolved_at IS NULL.
CREATE TABLE incident (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('S1','S2','S3')),
  kind TEXT NOT NULL,
  detail_json TEXT,
  resolved_at TEXT
);
CREATE INDEX idx_incident_open ON incident (resolved_at, severity, at DESC);

-- +down
DROP TABLE incident;
