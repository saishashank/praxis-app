-- +up
-- V2 should-fix batch E (V2-S2, D-700): cortex_feature_daily grows by one row per code per night
-- (about 1 GB a year) and its unconditional no_delete trigger made it unprunable. The trigger keeps
-- its name and its append-only message, but a DELETE is now allowed for rows older than the
-- 400-day floor (the same floor as email_attempt, DAT-142 class "recomputable": the features are
-- deterministic from the bars, D-278, and the per-night manifest keeps the hash for a replay).
-- Nothing else changes: UPDATE still aborts, rows inside the floor can never be deleted. The
-- trigger is part of the schema dump, so a backup restore recreates it as it is.
DROP TRIGGER cortex_feature_daily_no_delete;
CREATE TRIGGER cortex_feature_daily_no_delete BEFORE DELETE ON cortex_feature_daily
WHEN OLD.d >= date('now', '-400 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- +down
DROP TRIGGER cortex_feature_daily_no_delete;
CREATE TRIGGER cortex_feature_daily_no_delete BEFORE DELETE ON cortex_feature_daily
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
