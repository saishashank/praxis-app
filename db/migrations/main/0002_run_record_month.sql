-- +up
-- Usage meters (PLT-050, DAT-141) sum run_record over a calendar month by started_at; this index
-- keeps those range scans from reading every row (rows scanned count as reads).
CREATE INDEX idx_run_record_started ON run_record (started_at);

-- +down
DROP INDEX idx_run_record_started;
