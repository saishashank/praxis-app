-- +up
-- D-890 (O-79): the rule version a Cortex decision was made under, so the would-have scorer walks the
-- plan of that rule version (a time_hold rule's plan is not the family's v1 plan) even after a later
-- import makes another rule version the family's newest. NULL on rows written before this migration:
-- those are scored with the family's v1 plan, as before. No CHECK on the column, so the down path can
-- drop it (SQLite refuses DROP COLUMN on a checked column); the writer takes the value from the map.
ALTER TABLE cortex_decision ADD COLUMN rule_version TEXT;

-- +down
ALTER TABLE cortex_decision DROP COLUMN rule_version;
