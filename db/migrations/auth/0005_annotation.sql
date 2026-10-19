-- +up
-- KB-051, ROL-102b, UX-071a, docs/M6_design.md section 3 (D-110): Editor/Owner annotations on
-- lessons, decision cards and hypotheses. Kept in the auth DB with the user (ROL-101a); the LLM
-- context builder has no import path to this database (LLM-036, KB-051), so annotation text never
-- reaches a prompt.
--
-- Rules the triggers enforce (the service checks who the caller is; the database cannot know):
--   - an annotation is never hard-deleted; a delete sets deleted_at once (soft delete, final);
--   - subject, author and created_at never change; the text changes only while not deleted;
--   - every edit or delete is preceded by an annotation_history row that holds the text before and
--     after and whose instant equals the new edited_at / deleted_at (D-111), so no version is lost;
--   - history is append-only and its before_text must equal the annotation's current text.
-- No secrets (SEC-103). The text is user content, at most 1,000 characters (ROL-102b).
CREATE TABLE annotation (
  id INTEGER PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('lesson','card','hypothesis')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
  author_id INTEGER NOT NULL REFERENCES app_user (id),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT
) STRICT;
CREATE INDEX idx_annotation_subject ON annotation (subject_kind, subject_id);

CREATE TABLE annotation_history (
  id INTEGER PRIMARY KEY,
  annotation_id INTEGER NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('edit','delete')),
  at TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES app_user (id),
  before_text TEXT NOT NULL,
  after_text TEXT,
  CHECK ((op = 'edit') = (after_text IS NOT NULL)),
  CHECK (after_text IS NULL OR length(after_text) BETWEEN 1 AND 1000)
) STRICT;
CREATE INDEX idx_annotation_history_annotation ON annotation_history (annotation_id, id);

CREATE TRIGGER annotation_history_insert_guard BEFORE INSERT ON annotation_history
WHEN NOT EXISTS (SELECT 1 FROM annotation a WHERE a.id = NEW.annotation_id
    AND a.deleted_at IS NULL AND a.text = NEW.before_text)
BEGIN
  SELECT RAISE(ABORT, 'annotation_history: needs a live annotation whose text is before_text');
END;
CREATE TRIGGER annotation_history_no_update BEFORE UPDATE ON annotation_history
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER annotation_history_no_delete BEFORE DELETE ON annotation_history
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER annotation_guard_update BEFORE UPDATE ON annotation
WHEN NOT (NEW.id IS OLD.id AND NEW.subject_kind IS OLD.subject_kind
  AND NEW.subject_id IS OLD.subject_id AND NEW.author_id IS OLD.author_id
  AND NEW.created_at IS OLD.created_at
  AND OLD.deleted_at IS NULL
  AND (
    -- an edit: new text, edited_at moves forward, backed by its history row
    (NEW.deleted_at IS NULL AND NEW.text IS NOT OLD.text AND NEW.edited_at IS NOT NULL
      AND (OLD.edited_at IS NULL OR NEW.edited_at > OLD.edited_at)
      AND EXISTS (SELECT 1 FROM annotation_history h WHERE h.annotation_id = NEW.id
        AND h.op = 'edit' AND h.at = NEW.edited_at AND h.before_text = OLD.text
        AND h.after_text = NEW.text))
    OR
    -- a delete: text and edited_at unchanged, deleted_at set once, backed by its history row
    (NEW.deleted_at IS NOT NULL AND NEW.text IS OLD.text AND NEW.edited_at IS OLD.edited_at
      AND EXISTS (SELECT 1 FROM annotation_history h WHERE h.annotation_id = NEW.id
        AND h.op = 'delete' AND h.at = NEW.deleted_at AND h.before_text = OLD.text))
  ))
BEGIN
  SELECT RAISE(ABORT, 'annotation: edit or soft-delete once, each with its history row');
END;
CREATE TRIGGER annotation_no_delete BEFORE DELETE ON annotation
BEGIN
  SELECT RAISE(ABORT, 'forever table (soft delete only)');
END;

-- +down
DROP TABLE annotation_history;
DROP TABLE annotation;
