-- +up
-- M14 (D-250): returns and validation. Additive or nullable only; no table rebuild, no backfill, so
-- the 2020-26 history replays byte-identically (same rule as known_at in 0016, D-211).
--
-- 1. DAT-233 (D-237): an adjustment factor says what kind it is and which raw close it was derived
-- from. NULL kind = a legacy row; the readers take the kind from the corporate action's type.
ALTER TABLE adjustment_factor ADD COLUMN factor_kind TEXT
  CHECK (factor_kind IS NULL OR factor_kind IN ('price','split'));
ALTER TABLE adjustment_factor ADD COLUMN ref_close_micro INTEGER
  CHECK (ref_close_micro IS NULL OR ref_close_micro > 0);

-- 2. AGT-135 / AGT-138 (D-241): an event carries a finer detail beside its category. The guard now
-- freezes the column too (only the two LLM fields may still go from NULL to a value).
ALTER TABLE event ADD COLUMN category_detail TEXT
  CHECK (category_detail IS NULL OR category_detail IN ('query_response','guidance_maintained'));
DROP TRIGGER event_guard_update;
CREATE TRIGGER event_guard_update BEFORE UPDATE ON event
WHEN NOT (NEW.market IS OLD.market AND NEW.source IS OLD.source AND NEW.ann_id IS OLD.ann_id
  AND NEW.code IS OLD.code AND NEW.published_at IS OLD.published_at AND NEW.timed IS OLD.timed
  AND NEW.day0_d IS OLD.day0_d AND NEW.group_key IS OLD.group_key
  AND NEW.category IS OLD.category AND NEW.price_sensitive IS OLD.price_sensitive
  AND NEW.ar_ppm IS OLD.ar_ppm AND NEW.ar_num IS OLD.ar_num AND NEW.ar_den IS OLD.ar_den
  AND NEW.vol_ratio_ppm IS OLD.vol_ratio_ppm AND NEW.polarity IS OLD.polarity
  AND NEW.rule_version IS OLD.rule_version AND NEW.category_detail IS OLD.category_detail
  AND (OLD.category_llm IS NULL OR NEW.category_llm IS OLD.category_llm)
  AND (OLD.polarity_llm IS NULL OR NEW.polarity_llm IS OLD.polarity_llm))
BEGIN
  SELECT RAISE(ABORT, 'event: only category_llm and polarity_llm may go from NULL to a value');
END;

-- 3. DAT-237 (D-240): exact-duplicate hash of an announcement, written at the ingest route.
-- `announcement` stays append-only (no UPDATE is added); NULL = stored before this column existed.
ALTER TABLE announcement ADD COLUMN content_hash TEXT;
CREATE INDEX idx_announcement_content_hash ON announcement (market, code, content_hash);

-- 4. DAT-234 (D-238): index adds and deletes from a manual CSV. Append-only.
CREATE TABLE index_change (
  market TEXT NOT NULL CHECK (length(market) > 0),
  code TEXT NOT NULL CHECK (length(code) > 0),
  index_name TEXT NOT NULL CHECK (length(index_name) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('add','delete')),
  announced_d TEXT CHECK (announced_d IS NULL OR announced_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  effective_d TEXT NOT NULL CHECK (effective_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  source TEXT NOT NULL CHECK (length(source) > 0),
  loaded_at TEXT NOT NULL CHECK (length(loaded_at) > 0),
  PRIMARY KEY (market, code, index_name, kind, effective_d)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_index_change_effective ON index_change (market, effective_d);
CREATE TRIGGER index_change_no_update BEFORE UPDATE ON index_change
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER index_change_no_delete BEFORE DELETE ON index_change
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 5. FAM-006 (D-218): optional finer industry classes from a manual CSV. Append-only; the newest
-- as_of at or before the decision date applies.
CREATE TABLE instrument_class (
  market TEXT NOT NULL CHECK (length(market) > 0),
  code TEXT NOT NULL CHECK (length(code) > 0),
  industry TEXT NOT NULL CHECK (length(industry) > 0),
  source TEXT NOT NULL CHECK (length(source) > 0),
  as_of TEXT NOT NULL CHECK (as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  loaded_at TEXT NOT NULL CHECK (length(loaded_at) > 0),
  PRIMARY KEY (market, code, as_of)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER instrument_class_no_update BEFORE UPDATE ON instrument_class
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER instrument_class_no_delete BEFORE DELETE ON instrument_class
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 6. VAL-114 (D-232): daily rank quality, one row per (family, rank variant, session). Live rows
-- come from batch 3, replay rows from the weekly rankIc stage; insert-or-ignore, never revised.
CREATE TABLE rank_ic_daily (
  market TEXT NOT NULL CHECK (length(market) > 0),
  family TEXT NOT NULL CHECK (length(family) > 0),
  rank_variant TEXT NOT NULL CHECK (length(rank_variant) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  n INTEGER NOT NULL CHECK (n >= 0),
  ic REAL,
  source TEXT NOT NULL CHECK (source IN ('live','replay')),
  computed_at TEXT NOT NULL CHECK (length(computed_at) > 0),
  PRIMARY KEY (market, family, rank_variant, d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER rank_ic_daily_no_update BEFORE UPDATE ON rank_ic_daily
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER rank_ic_daily_no_delete BEFORE DELETE ON rank_ic_daily
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 7. DAT-236 (D-239): licence register. The ASX listed-companies file now cites O-23b and states its
-- own terms; RBA is copyrighted (derived numbers, source named). The enabling code keys on the
-- source id, not on owner_ref, so accepting the ASX source still enables both rows. Two alternative
-- universe sources are recorded as disabled (no fetcher; terms checked in M14); two manual files get
-- register rows. The history triggers log every change.
UPDATE source_register
SET owner_ref = 'O-23b',
    permitted_use = 'personal use only (DAT-124); the ASX listed-companies file under its own terms (O-23b); enabled together with the ASX entry O-23'
WHERE source = 'asx_listed_companies';
UPDATE source_register
SET permitted_use = 'copyrighted by the RBA: derived numbers only, source named (DAT-236)',
    summarisation_permitted = 0
WHERE source = 'rba';
INSERT INTO source_register (source, permitted_use, risk, status, owner_ref, summarisation_permitted)
VALUES
  ('wikidata_asx', 'CC0 universe alternative (structured data CC0, terms checked in M14); no fetcher (DAT-236)', 'low', 'disabled', NULL, 0),
  ('wikipedia_asx200', 'CC BY-SA 4.0 S&P/ASX 200 list (attribution, share-alike; terms checked in M14), about 200 codes; no fetcher (DAT-236)', 'low', 'disabled', NULL, 0),
  ('index_changes_manual', 'manual CSV upload by the Owner (DAT-234)', 'low', 'enabled', NULL, 0),
  ('industry_map_manual', 'manual CSV upload by the Owner (FAM-006)', 'low', 'enabled', NULL, 0);

-- +down
-- source_register and its history refuse DELETE (forever / append-only): the guards are lifted for
-- the statements below and restored with the identical definitions from migration 0004. The history
-- rows this migration wrote are removed, so up again leaves the same log.
DROP TRIGGER source_register_log_update;
DROP TRIGGER source_register_no_delete;
DROP TRIGGER source_register_history_no_delete;
DELETE FROM source_register_history WHERE source IN
  ('wikidata_asx','wikipedia_asx200','index_changes_manual','industry_map_manual');
DELETE FROM source_register WHERE source IN
  ('wikidata_asx','wikipedia_asx200','index_changes_manual','industry_map_manual');
DELETE FROM source_register_history WHERE op = 'update' AND (
  (source = 'asx_listed_companies' AND owner_ref = 'O-23b' AND permitted_use LIKE '%under its own terms (O-23b)%')
  OR (source = 'rba' AND permitted_use LIKE 'copyrighted by the RBA%'));
UPDATE source_register
SET owner_ref = 'O-23',
    permitted_use = 'personal use only (DAT-124); covered by the ASX entry O-23'
WHERE source = 'asx_listed_companies';
UPDATE source_register
SET permitted_use = 'public data', summarisation_permitted = 1
WHERE source = 'rba';
CREATE TRIGGER source_register_log_update AFTER UPDATE ON source_register
BEGIN
  INSERT INTO source_register_history (source, changed_at, op, terms_url, permitted_use, rate_limits,
    last_checked, risk, status, owner_ref, summarisation_permitted)
  VALUES (NEW.source, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'update', NEW.terms_url,
    NEW.permitted_use, NEW.rate_limits, NEW.last_checked, NEW.risk, NEW.status, NEW.owner_ref,
    NEW.summarisation_permitted);
END;
CREATE TRIGGER source_register_no_delete BEFORE DELETE ON source_register
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;
CREATE TRIGGER source_register_history_no_delete BEFORE DELETE ON source_register_history
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

DROP TRIGGER rank_ic_daily_no_delete;
DROP TRIGGER rank_ic_daily_no_update;
DROP TABLE rank_ic_daily;
DROP TRIGGER instrument_class_no_delete;
DROP TRIGGER instrument_class_no_update;
DROP TABLE instrument_class;
DROP TRIGGER index_change_no_delete;
DROP TRIGGER index_change_no_update;
DROP TABLE index_change;
DROP INDEX idx_announcement_content_hash;
ALTER TABLE announcement DROP COLUMN content_hash;
DROP TRIGGER event_guard_update;
CREATE TRIGGER event_guard_update BEFORE UPDATE ON event
WHEN NOT (NEW.market IS OLD.market AND NEW.source IS OLD.source AND NEW.ann_id IS OLD.ann_id
  AND NEW.code IS OLD.code AND NEW.published_at IS OLD.published_at AND NEW.timed IS OLD.timed
  AND NEW.day0_d IS OLD.day0_d AND NEW.group_key IS OLD.group_key
  AND NEW.category IS OLD.category AND NEW.price_sensitive IS OLD.price_sensitive
  AND NEW.ar_ppm IS OLD.ar_ppm AND NEW.ar_num IS OLD.ar_num AND NEW.ar_den IS OLD.ar_den
  AND NEW.vol_ratio_ppm IS OLD.vol_ratio_ppm AND NEW.polarity IS OLD.polarity
  AND NEW.rule_version IS OLD.rule_version
  AND (OLD.category_llm IS NULL OR NEW.category_llm IS OLD.category_llm)
  AND (OLD.polarity_llm IS NULL OR NEW.polarity_llm IS OLD.polarity_llm))
BEGIN
  SELECT RAISE(ABORT, 'event: only category_llm and polarity_llm may go from NULL to a value');
END;
ALTER TABLE event DROP COLUMN category_detail;
ALTER TABLE adjustment_factor DROP COLUMN ref_close_micro;
ALTER TABLE adjustment_factor DROP COLUMN factor_kind;
