-- +up
-- GL-02 (D-207 item 2): a confirmed corporate action carries `known_at`, the instant it was first
-- confirmed (announcement-backed auto-confirm, Owner resolve, or the 5-session auto-apply). Replays
-- and the decision view use an action only when known_at <= the decision cut-off of the session
-- being decided, so an action confirmed on D+5 changes nothing for D..D+4 (DAT-001, DAT-126).
-- `corporate_action` stays append-only except for this one step: known_at may be set ONCE, from NULL
-- to a value, and nothing else on the row may change. NULL means "known since before this column
-- existed" to the readers (no filter), so legacy fixtures keep working.
ALTER TABLE corporate_action ADD COLUMN known_at TEXT;
DROP TRIGGER corporate_action_no_update;
CREATE TRIGGER corporate_action_no_update BEFORE UPDATE ON corporate_action
WHEN NOT (OLD.known_at IS NULL AND NEW.known_at IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.market IS OLD.market AND NEW.code IS OLD.code
  AND NEW.type IS OLD.type AND NEW.ex_date IS OLD.ex_date AND NEW.record_date IS OLD.record_date
  AND NEW.payload_json IS OLD.payload_json AND NEW.evidence_json IS OLD.evidence_json)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
-- Backfill: every action that already left the queue (its newest event is not 'queued') takes
-- known_at = the start of its ex-date in Melbourne, written as UTC ISO text. 13:00Z of the day before
-- is Melbourne midnight in summer time (the earliest it can be), so the history of 2020-26 is
-- visible to every replay exactly as before (it used ex_date <= D). Actions still queued stay NULL
-- and get their instant when they are confirmed.
UPDATE corporate_action SET known_at = date(ex_date, '-1 day') || 'T13:00:00.000Z'
WHERE (SELECT e.status FROM corporate_action_event e WHERE e.action_id = corporate_action.id
         ORDER BY e.id DESC LIMIT 1) IS NOT NULL
  AND (SELECT e.status FROM corporate_action_event e WHERE e.action_id = corporate_action.id
         ORDER BY e.id DESC LIMIT 1) <> 'queued';

-- +down
DROP TRIGGER corporate_action_no_update;
CREATE TRIGGER corporate_action_no_update BEFORE UPDATE ON corporate_action
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
ALTER TABLE corporate_action DROP COLUMN known_at;
