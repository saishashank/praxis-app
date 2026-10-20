-- +up
-- M7 T2 (docs/M7_design.md 2.11, D-128): the sector column and the Ops task ticks.
--
-- instrument.sector (decision 53): the industry group of the company, filled by the universe import
-- when the source carries it; NULL until then. The Market tab groups by it (the heat grid).
-- The `price_bar (market, d)` index the movers query needs already exists (idx_price_bar_market_d,
-- migration 0004), so none is added here.
-- ops_task_done: the Owner ticks a dated Ops task as done. One row per (task, due date); append-only
-- and forever. done_by is an auth-DB user id (no foreign key across databases); audit_ref is the id
-- of the auth audit event written first (audit-first, D-047/D-125).
ALTER TABLE instrument ADD COLUMN sector TEXT;

CREATE TABLE ops_task_done (
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 100),
  due_d TEXT NOT NULL CHECK (due_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  done_by INTEGER NOT NULL CHECK (done_by >= 1),
  done_at TEXT NOT NULL,
  audit_ref TEXT NOT NULL CHECK (length(audit_ref) > 0),
  PRIMARY KEY (task_id, due_d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER ops_task_done_no_update BEFORE UPDATE ON ops_task_done
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER ops_task_done_no_delete BEFORE DELETE ON ops_task_done
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- +down
DROP TABLE ops_task_done;
ALTER TABLE instrument DROP COLUMN sector;
