-- +up
-- D-950 (Owner 2026-11-11): "My portfolio" replaces the D-913 "Follow the picks" portfolio. Three
-- practice portfolios, one per risk profile, that buy from the picks of every strategy and split the
-- money between the strategies by their evidence (src/lib/picks/portfolio.ts, allocation.ts). The
-- 0029 tables are reused by name, keyed by profile; their rows are derived data rebuilt from scratch
-- every night (delete and insert in one batch), so the trade table is recreated in its new shape (one
-- row per buy, sale or trim, with its strategy and plain-words reason), the day table gains the fall
-- from the peak, and two tables are added: the open holdings of the night and the strategy split each
-- time it changes. History restarts at the new seed. Nothing in the books, the Cortex or the
-- strategies reads them.
DROP TABLE pick_portfolio_trade;
DROP TABLE pick_portfolio_day;

CREATE TABLE pick_portfolio_trade (
  market TEXT NOT NULL CHECK (length(market) > 0),
  profile TEXT NOT NULL CHECK (length(profile) > 0),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  code TEXT NOT NULL CHECK (length(code) > 0),
  strategy TEXT NOT NULL CHECK (strategy IN ('F1','F2','F3','F4','F5','F6','SL')),
  pub_d TEXT NOT NULL CHECK (pub_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 10),
  pos INTEGER NOT NULL CHECK (pos >= 1 AND pos <= seq),
  qty INTEGER NOT NULL CHECK (qty >= 0),
  price_micro INTEGER NOT NULL CHECK (price_micro > 0),
  fee_micro INTEGER NOT NULL CHECK (fee_micro >= 0),
  net_micro INTEGER,
  reason TEXT NOT NULL CHECK (reason IN
    ('pick','stop','gap','aim','time_frame','weak','strategy_exit','rebalance')),
  closes INTEGER NOT NULL CHECK (closes IN (0,1)),
  words TEXT NOT NULL CHECK (length(words) > 0),
  CHECK ((side = 'buy') = (reason = 'pick')),
  CHECK ((side = 'buy') = (net_micro IS NULL)),
  CHECK (side = 'sell' OR (closes = 0 AND pos = seq)),
  PRIMARY KEY (market, profile, seq)
) STRICT, WITHOUT ROWID;

CREATE TABLE pick_portfolio_day (
  market TEXT NOT NULL CHECK (length(market) > 0),
  profile TEXT NOT NULL CHECK (length(profile) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  cash_micro INTEGER NOT NULL CHECK (cash_micro >= 0),
  holdings_micro INTEGER NOT NULL CHECK (holdings_micro >= 0),
  value_micro INTEGER NOT NULL CHECK (value_micro = cash_micro + holdings_micro),
  holdings INTEGER NOT NULL CHECK (holdings >= 0),
  fall_ppm INTEGER NOT NULL CHECK (fall_ppm BETWEEN -1000000 AND 0),
  PRIMARY KEY (market, profile, d)
) STRICT, WITHOUT ROWID;

-- the holdings open after the newest night (one row per stock)
CREATE TABLE pick_portfolio_hold (
  market TEXT NOT NULL CHECK (length(market) > 0),
  profile TEXT NOT NULL CHECK (length(profile) > 0),
  code TEXT NOT NULL CHECK (length(code) > 0),
  pos INTEGER NOT NULL CHECK (pos >= 1),
  strategy TEXT NOT NULL CHECK (strategy IN ('F1','F2','F3','F4','F5','F6','SL')),
  pub_d TEXT NOT NULL CHECK (pub_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  entry_d TEXT NOT NULL CHECK (entry_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  entry_micro INTEGER NOT NULL CHECK (entry_micro > 0),
  qty INTEGER NOT NULL CHECK (qty >= 0),
  cost_micro INTEGER NOT NULL CHECK (cost_micro >= 0),
  PRIMARY KEY (market, profile, code)
) STRICT, WITHOUT ROWID;

-- the strategy split each session it changed: shares_json [{"strategy","target_ppm"}], words in
-- plain words (line = the split, why = what changed)
CREATE TABLE pick_portfolio_split (
  market TEXT NOT NULL CHECK (length(market) > 0),
  profile TEXT NOT NULL CHECK (length(profile) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  shares_json TEXT NOT NULL CHECK (json_valid(shares_json)),
  cash_ppm INTEGER NOT NULL CHECK (cash_ppm BETWEEN 0 AND 1000000),
  words TEXT NOT NULL CHECK (length(words) > 0),
  PRIMARY KEY (market, profile, d)
) STRICT, WITHOUT ROWID;

-- +down
-- Back to the 0029 shapes (their rows were derived; the next 0029-era night rebuilds them).
DROP TABLE pick_portfolio_split;
DROP TABLE pick_portfolio_hold;
DROP TABLE pick_portfolio_day;
DROP TABLE pick_portfolio_trade;

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
