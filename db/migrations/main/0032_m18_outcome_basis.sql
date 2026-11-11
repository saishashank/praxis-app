-- +up
-- D-956 (ARN-123, M18 stream B3): the money basis of a settled pick. Until now a pick's net result was
-- price-only (qty x exit - brokerage - cost) while its market comparison was total-return, so "vs market"
-- was biased against the pick. From the deploy on, `trackPicks` credits the confirmed cash and special
-- dividends that went ex while the position was held and writes 'total_return' in the SAME update that
-- closes the row. Every row that exists today keeps 'price_only' (the column default), and a closed row's
-- basis can never change afterwards (the trigger below), so no settled number is rewritten.
-- No CHECK on the column, so the down path can drop it (SQLite refuses DROP COLUMN on a checked column);
-- the two triggers hold the value set instead.
ALTER TABLE pick_outcome ADD COLUMN outcome_basis TEXT NOT NULL DEFAULT 'price_only';
CREATE TRIGGER pick_outcome_basis_insert_guard BEFORE INSERT ON pick_outcome
WHEN NEW.outcome_basis NOT IN ('price_only','total_return')
BEGIN
  SELECT RAISE(ABORT, 'pick_outcome: outcome_basis is price_only or total_return');
END;
CREATE TRIGGER pick_outcome_basis_guard BEFORE UPDATE ON pick_outcome
WHEN NEW.outcome_basis NOT IN ('price_only','total_return')
  OR (OLD.state = 'closed' AND NEW.outcome_basis IS NOT OLD.outcome_basis)
BEGIN
  SELECT RAISE(ABORT, 'pick_outcome: outcome_basis is fixed with the settlement');
END;

-- +down
DROP TRIGGER pick_outcome_basis_guard;
DROP TRIGGER pick_outcome_basis_insert_guard;
ALTER TABLE pick_outcome DROP COLUMN outcome_basis;
