-- +up
-- D-921 (Owner 2026-11-10): the nightly learning loop (src/lib/learning/daily.ts). One row per market
-- and session: the night's explained top movers, the feature lessons of the last 40 sessions, the
-- improvement list and the hypotheses opened, as one JSON document, so tomorrow can compare its lessons
-- with today's and the Evening Review can read the night back. Derived data: a re-run of the same night
-- gives the same document and updates the row. Nothing in the books, the Cortex, the strategies or the
-- shortlist reads it; a strong finding reaches the learning system only as a proposed expert-claim
-- cluster that the Owner has to confirm (src/lib/learning/dailyHypothesis.ts).
CREATE TABLE daily_learning (
  market TEXT NOT NULL CHECK (length(market) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  PRIMARY KEY (market, d)
) STRICT, WITHOUT ROWID;

-- +down
DROP TABLE daily_learning;
