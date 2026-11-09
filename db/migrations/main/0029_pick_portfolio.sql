-- +up
-- D-913 (Owner 2026-11-10): the "Follow the picks" practice portfolio, the trades and daily value of
-- trading exactly the published picks of one risk profile as if it were the Owner's own money
-- (src/lib/picks/portfolio.ts). Derived data: rebuilt from the picks, their tracked buys and the bars
-- every night (delete and insert in one batch), so a re-run gives the same rows. Nothing in the books,
-- the Cortex or the strategies reads it.
CREATE TABLE pick_portfolio_trade (
  market TEXT NOT NULL CHECK (length(market) > 0),
  profile TEXT NOT NULL CHECK (length(profile) > 0),
  pub_d TEXT NOT NULL CHECK (pub_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 10),
  code TEXT NOT NULL CHECK (length(code) > 0),
  entry_d TEXT NOT NULL CHECK (entry_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  entry_micro INTEGER NOT NULL CHECK (entry_micro > 0),
  qty INTEGER NOT NULL CHECK (qty >= 0),
  cost_micro INTEGER NOT NULL CHECK (cost_micro > 0),
  exit_d TEXT CHECK (exit_d IS NULL OR exit_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  exit_micro INTEGER CHECK (exit_micro IS NULL OR exit_micro > 0),
  exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN ('stop','gap','aim','time_frame','weak')),
  net_micro INTEGER,
  CHECK ((exit_d IS NULL) = (exit_micro IS NULL) AND (exit_d IS NULL) = (exit_reason IS NULL)
         AND (exit_d IS NULL) = (net_micro IS NULL)),
  PRIMARY KEY (market, profile, pub_d, rank)
) STRICT, WITHOUT ROWID;

CREATE TABLE pick_portfolio_day (
  market TEXT NOT NULL CHECK (length(market) > 0),
  profile TEXT NOT NULL CHECK (length(profile) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  cash_micro INTEGER NOT NULL CHECK (cash_micro >= 0),
  holdings_micro INTEGER NOT NULL CHECK (holdings_micro >= 0),
  value_micro INTEGER NOT NULL CHECK (value_micro = cash_micro + holdings_micro),
  holdings INTEGER NOT NULL CHECK (holdings >= 0),
  PRIMARY KEY (market, profile, d)
) STRICT, WITHOUT ROWID;

-- +down
DROP TABLE pick_portfolio_day;
DROP TABLE pick_portfolio_trade;
