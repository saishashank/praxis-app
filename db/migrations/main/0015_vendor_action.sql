-- +up
-- Vendor split and dividend rows (DAT-231, D-207 item 12). The nightly Yahoo request asks for the
-- price bars and the corporate actions in the same call (no extra request); the Python step writes
-- the actions to actions.json and the Node writer stores them here. They are evidence, not a
-- decision: a later task reads them as a veto against a price-only inferred split (GL-01) and for a
-- total-return benchmark (GL-10). A split carries `ratio` (new shares per old share: 2 = two-for-one,
-- 0.1 = ten-to-one consolidation); a dividend carries `amount_micro` (cash per share in micro units
-- of `currency`). The vendor can revise a figure, so a re-fetch of the same (code, ex_date, kind)
-- updates the row and its fetched_at; it never duplicates.
CREATE TABLE vendor_action (
  market TEXT NOT NULL CHECK (length(market) > 0),
  code TEXT NOT NULL CHECK (length(code) > 0),
  ex_date TEXT NOT NULL CHECK (ex_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kind TEXT NOT NULL CHECK (kind IN ('split','dividend')),
  ratio REAL CHECK (ratio IS NULL OR ratio > 0),
  amount_micro INTEGER CHECK (amount_micro IS NULL OR amount_micro > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  source TEXT NOT NULL CHECK (length(source) > 0),
  fetched_at TEXT NOT NULL CHECK (length(fetched_at) > 0),
  PRIMARY KEY (market, code, ex_date, kind, source),
  CHECK ((kind = 'split' AND ratio IS NOT NULL AND amount_micro IS NULL)
      OR (kind = 'dividend' AND amount_micro IS NOT NULL AND ratio IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_vendor_action_ex ON vendor_action (market, ex_date);

-- +down
DROP TABLE vendor_action;
