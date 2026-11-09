-- +up
-- D-900 (O-80): the newest delayed quote seen for each code, so the site can show a live (delayed)
-- price for held trades and the watchlist during the session. Written by the two M17 routes
-- (quote-poll, intraday-scan) after their fetch, from quotes they already requested: no extra
-- request. One row per code, replaced only by a quote with a later quote time. A display cache:
-- nothing in the books, the Cortex or the exits reads it (exits stay at the close, ARN-021).
CREATE TABLE quote_latest (
  market TEXT NOT NULL CHECK (length(market) > 0),
  code TEXT NOT NULL CHECK (length(code) > 0),
  last_micro INTEGER NOT NULL CHECK (last_micro > 0),
  prev_close_micro INTEGER CHECK (prev_close_micro IS NULL OR prev_close_micro > 0),
  quote_at TEXT NOT NULL CHECK (length(quote_at) > 0),
  fetched_at TEXT NOT NULL CHECK (length(fetched_at) > 0),
  PRIMARY KEY (market, code)
) STRICT, WITHOUT ROWID;

-- +down
DROP TABLE quote_latest;
