-- +up
-- M18 ops and metering (docs/M18_design.md stream C; D-954, D-958, D-960, D-971).
--
-- 1. usage_sample (OPS-104, PLT-080, D-958/D-963): one row a day from the Turso platform API, written by
--    scripts/usage/turso-sample.mjs inside the turso-usage workflow. source 'platform' = the figures
--    come from the platform API; 'unavailable' = the token is absent or the call failed, and every
--    figure is NULL (the Usage page then labels the meter an estimate, it never invents a number).
--    plan_name is the organization's plan id as the API returns it (PLT-080 reads it).
CREATE TABLE usage_sample (
  sampled_at TEXT PRIMARY KEY CHECK (length(sampled_at) > 0),
  rows_read_month INTEGER CHECK (rows_read_month IS NULL OR rows_read_month >= 0),
  rows_written_month INTEGER CHECK (rows_written_month IS NULL OR rows_written_month >= 0),
  storage_bytes INTEGER CHECK (storage_bytes IS NULL OR storage_bytes >= 0),
  plan_name TEXT,
  source TEXT NOT NULL CHECK (source IN ('platform','unavailable')),
  CHECK (source = 'platform' OR (rows_read_month IS NULL AND rows_written_month IS NULL
                                  AND storage_bytes IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER usage_sample_no_update BEFORE UPDATE ON usage_sample
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER usage_sample_no_delete BEFORE DELETE ON usage_sample
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 2. market_row_count (OPS-104 e, D-960): the nightly row-by-market invariant. One row per day, table and
--    market with the number of rows of that market in that table. A re-run of the same night replaces
--    its rows (the maintenance route is idempotent), so this table has no update trigger.
CREATE TABLE market_row_count (
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  tbl TEXT NOT NULL CHECK (length(tbl) > 0),
  market TEXT NOT NULL CHECK (length(market) > 0),
  n INTEGER NOT NULL CHECK (n >= 0),
  PRIMARY KEY (d, tbl, market)
) STRICT, WITHOUT ROWID;

-- 3. quote_run (OPS-109 c, D-971; DDL handed over by stream A): how many codes the slot's plan left out
--    for lack of budget, and the plan itself as {armed, watch, held} counts. quote_run is append-only
--    but ADD COLUMN is not an UPDATE; existing rows read skipped 0 and no plan.
ALTER TABLE quote_run ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0);
ALTER TABLE quote_run ADD COLUMN plan TEXT CHECK (plan IS NULL OR json_valid(plan));

-- 4. Config key rename (D-954): sentinel_max_items_per_run becomes news_assess_per_run (bounds 20 to 200).
--    config_version is append-only, so the rename is a new row per scope carrying the latest stored value
--    (raised to the new floor of 20), written once; the old rows stay as history and nothing reads them.
INSERT INTO config_version (key, scope, value_json, previous_json, changed_by_user_id, changed_at, reason)
SELECT 'news_assess_per_run', c.scope,
       CAST(MAX(20, CAST(c.value_json AS INTEGER)) AS TEXT), NULL, NULL,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       'renamed from sentinel_max_items_per_run (D-954)'
FROM config_version c
WHERE c.key = 'sentinel_max_items_per_run'
  AND c.id = (SELECT MAX(id) FROM config_version WHERE key = c.key AND scope = c.scope);

-- +down
-- The rename rows are the only config_version rows a down section may remove: the delete trigger is
-- dropped for that one statement and put back exactly as 0001 defines it.
DROP TRIGGER config_version_no_delete;
DELETE FROM config_version WHERE reason = 'renamed from sentinel_max_items_per_run (D-954)';
CREATE TRIGGER config_version_no_delete BEFORE DELETE ON config_version
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
ALTER TABLE quote_run DROP COLUMN plan;
ALTER TABLE quote_run DROP COLUMN skipped;
DROP TABLE market_row_count;
DROP TRIGGER usage_sample_no_delete;
DROP TRIGGER usage_sample_no_update;
DROP TABLE usage_sample;
