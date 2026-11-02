-- +up
-- GL-05 (D-207 item 5): an announcement carries `first_ingested_at`, the instant this system first
-- stored it. Live ingest stamps it at insert; a backfill (ASX by-date fetch, history fetch) stamps the
-- time of the backfill. A decision (and a replay) on session D uses an announcement only when
-- first_ingested_at is NULL or <= the ingest bound of D (the "first completed poll after 18:10"
-- marker, or cut-off + 4 minutes when it is missing), so a row filled in days later is invisible to
-- the replay of the days before it, exactly as it was to the live run.
-- NULL means "stored before this column existed": the readers apply no filter, so every existing
-- row and the 2020-26 history replay stay byte-identical (same rule as corporate_action.known_at,
-- D-211). NO backfill of the column. `announcement` stays append-only (no UPDATE is added).
ALTER TABLE announcement ADD COLUMN first_ingested_at TEXT;

-- +down
ALTER TABLE announcement DROP COLUMN first_ingested_at;
