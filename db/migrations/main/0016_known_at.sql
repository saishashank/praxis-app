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
-- NO backfill (Opus review): existing rows stay NULL, which the readers treat as "known since before
-- this column existed", so the 2020-26 history replays byte-identically. Only confirmations made
-- after this migration are stamped (engine settle / Owner resolve).

-- +down
DROP TRIGGER corporate_action_no_update;
CREATE TRIGGER corporate_action_no_update BEFORE UPDATE ON corporate_action
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
ALTER TABLE corporate_action DROP COLUMN known_at;
