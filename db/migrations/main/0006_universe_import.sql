-- +up
-- AU instrument universe import (M2 T11, D-067). The listed-companies file gives each code a name
-- and a GICS industry group; `missing_count` counts consecutive successful imports in which an
-- active code was absent (a code is marked delisted only at 2, so one bad file cannot delist
-- anything). Both columns are status fields: the instrument update guard (0004) only protects id,
-- market and code. Delisted rows are kept forever (DAT-130).
ALTER TABLE instrument ADD COLUMN industry TEXT;
ALTER TABLE instrument ADD COLUMN missing_count INTEGER NOT NULL DEFAULT 0;

-- The listed-companies file is a second ASX request type. It is covered by the same Owner risk
-- acceptance as the announcements (O-23 / DAT-120): accepting O-23 in the Data controls enables
-- both rows together. The Worker fetches the file only when BOTH rows are `enabled`.
INSERT INTO source_register (source, permitted_use, risk, status, owner_ref, summarisation_permitted)
VALUES ('asx_listed_companies', 'personal use only (DAT-124); covered by the ASX entry O-23', 'high', 'pending', 'O-23', 0);

-- +down
-- source_register and its history refuse DELETE (forever / append-only): the guards are lifted for
-- the statements below and restored with the identical definitions from migration 0004.
DROP TRIGGER source_register_no_delete;
DROP TRIGGER source_register_history_no_delete;
DELETE FROM source_register_history WHERE source = 'asx_listed_companies';
DELETE FROM source_register WHERE source = 'asx_listed_companies';
CREATE TRIGGER source_register_no_delete BEFORE DELETE ON source_register
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;
CREATE TRIGGER source_register_history_no_delete BEFORE DELETE ON source_register_history
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
ALTER TABLE instrument DROP COLUMN missing_count;
ALTER TABLE instrument DROP COLUMN industry;
