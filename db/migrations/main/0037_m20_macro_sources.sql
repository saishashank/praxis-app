-- +up
-- M20 integration (docs/M20_design.md, D-1147; closes the hand-offs of D-1171 and D-1189). `macro_series.source` was
-- CHECK-limited to ('rba','abs') by migration 0033, so the India macro rows (RBI, MOSPI) were parsed and counted but
-- not stored (D-1171) and the FRED observations had no storage (D-1189). This migration widens the list to the three
-- M20 sources. SQLite cannot alter a CHECK, so the table is rebuilt: the same five columns, STRICT, WITHOUT ROWID,
-- the same primary key, the rows copied, the old table dropped, the new one renamed. 0033 created no index or trigger
-- on the table, so nothing else is carried over. AU is unaffected: the `rba` and `abs` rows and their upsert
-- (scripts/macro/lib.mjs) are byte-identical, and the AT-32 baseline hashes rows, not the CREATE statement.
--
-- `macro_series` has no `market` column, so the 0035/0036 write guard (`<table>_market_guard_ins/_upd`, derived from
-- the market column) does not reach it. The market of a row is a function of its source: rbi, mospi -> IN; fred -> US;
-- rba, abs -> the home market (no market row is required: AU writes them today). The two SOURCE-guard triggers below
-- give the table the same protection as the market-keyed tables (MKT-110 b, D-995): a row of a source whose market is
-- not enabled is refused with the guard's text `MarketNotEnabled macro_series`, also for INSERT OR IGNORE / OR REPLACE
-- and for the upsert form (BEFORE INSERT runs before conflict resolution). The code guard (`assertMarketEnabled` first
-- in the India day stage and in the FRED client, `writeMacroSeries` in src/lib/data/sources/macroStore.mjs) is the
-- first line; these triggers are the second, so a planted or mistaken statement cannot store an IN or US macro row in
-- production while those markets are off (markets_enabled ["AU"]).
CREATE TABLE macro_series_new (
  source TEXT NOT NULL CHECK (source IN ('rba','abs','rbi','mospi','fred')),
  series_id TEXT NOT NULL CHECK (length(series_id) BETWEEN 1 AND 64),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  value_micro INTEGER NOT NULL,
  fetched_at TEXT NOT NULL CHECK (length(fetched_at) > 0),
  PRIMARY KEY (source, series_id, d)
) STRICT, WITHOUT ROWID;
INSERT INTO macro_series_new (source, series_id, d, value_micro, fetched_at)
  SELECT source, series_id, d, value_micro, fetched_at FROM macro_series;
DROP TABLE macro_series;
ALTER TABLE macro_series_new RENAME TO macro_series;

CREATE TRIGGER macro_series_source_guard_ins BEFORE INSERT ON macro_series
WHEN NEW.source IN ('rbi','mospi','fred') AND NOT EXISTS (
  SELECT 1 FROM market
  WHERE code = CASE NEW.source WHEN 'rbi' THEN 'IN' WHEN 'mospi' THEN 'IN' WHEN 'fred' THEN 'US' END
    AND enabled = 1
)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled macro_series');
END;
CREATE TRIGGER macro_series_source_guard_upd BEFORE UPDATE OF source ON macro_series
WHEN NEW.source IN ('rbi','mospi','fred') AND NOT EXISTS (
  SELECT 1 FROM market
  WHERE code = CASE NEW.source WHEN 'rbi' THEN 'IN' WHEN 'mospi' THEN 'IN' WHEN 'fred' THEN 'US' END
    AND enabled = 1
)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled macro_series');
END;

-- +down
-- Back to the 0033 list. The rows of the three M20 sources cannot satisfy the narrower CHECK and are dropped with the
-- step (they are IN and US macro numbers, re-fetched by the next India day or FRED run; none exists in production
-- while those markets are off). The home rows are copied.
DROP TRIGGER macro_series_source_guard_upd;
DROP TRIGGER macro_series_source_guard_ins;
CREATE TABLE macro_series_old (
  source TEXT NOT NULL CHECK (source IN ('rba','abs')),
  series_id TEXT NOT NULL CHECK (length(series_id) BETWEEN 1 AND 64),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  value_micro INTEGER NOT NULL,
  fetched_at TEXT NOT NULL CHECK (length(fetched_at) > 0),
  PRIMARY KEY (source, series_id, d)
) STRICT, WITHOUT ROWID;
INSERT INTO macro_series_old (source, series_id, d, value_micro, fetched_at)
  SELECT source, series_id, d, value_micro, fetched_at FROM macro_series WHERE source IN ('rba','abs');
DROP TABLE macro_series;
ALTER TABLE macro_series_old RENAME TO macro_series;
