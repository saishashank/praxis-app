-- +up
-- M17 (WP2, D-381..D-400): intraday watch and pick alerts. New tables plus ONE rebuild: the
-- email_message.kind CHECK lists the kinds, so the five pick-mail kinds need it widened (SQLite cannot
-- alter a CHECK). The rebuild copies every row unchanged and recreates the indexes and triggers
-- identically to 0009. Nothing here touches an order, fill, book, ledger or lesson table (ARN-111).
-- Dates are session dates (GLOB), JSON columns are json_valid, money is integer micro-dollars, times
-- are ISO UTC text. Every table is STRICT.

-- 1. email_message: widen kind (rebuild). The insert guard on email_attempt names email_message, so it
-- is dropped for the swap and recreated.
DROP TRIGGER email_attempt_insert_guard;
CREATE TABLE email_message_new (
  email_key TEXT PRIMARY KEY CHECK (length(email_key) > 0),
  env TEXT NOT NULL CHECK (env IN ('production','staging','development','test')),
  kind TEXT NOT NULL CHECK (kind IN ('review','p0','p0_batch','incident_open','incident_s1',
    'tokens','unread7','reminder','brief','test','dbdown',
    'pick_hit','pick_cleared','pick_candidate','pick_batch','pick_digest')),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  slot TEXT NOT NULL CHECK (slot IN
    ('reserved_review','reserved_incident','reserved_reminder','pool','p0')),
  status TEXT NOT NULL CHECK (status IN ('claimed','sent','failed','suppressed_cap',
    'suppressed_off','suppressed_paused','no_recipient')),
  subject TEXT NOT NULL DEFAULT '',
  size_html INTEGER NOT NULL DEFAULT 0 CHECK (size_html >= 0),
  size_text INTEGER NOT NULL DEFAULT 0 CHECK (size_text >= 0),
  provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) > 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  recipient_sha TEXT CHECK (recipient_sha IS NULL
    OR (length(recipient_sha) = 64 AND recipient_sha NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  ref_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ref_json)),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  CHECK (slot <> 'reserved_review' OR kind = 'review'),
  CHECK (slot <> 'reserved_reminder' OR kind = 'reminder'),
  CHECK (slot <> 'reserved_incident' OR kind IN ('incident_open','incident_s1')),
  CHECK ((slot = 'p0') = (kind IN ('p0','p0_batch')))
) STRICT, WITHOUT ROWID;
INSERT INTO email_message_new SELECT email_key, env, kind, d, slot, status, subject, size_html,
  size_text, provider_id, attempts, recipient_sha, created_at, sent_at, ref_json FROM email_message;
DROP TABLE email_message;
ALTER TABLE email_message_new RENAME TO email_message;
CREATE INDEX idx_email_message_d ON email_message (env, d, status);
CREATE INDEX idx_email_message_created ON email_message (created_at);
CREATE TRIGGER email_message_guard_update BEFORE UPDATE ON email_message
WHEN NOT (OLD.status = 'claimed'
  AND NEW.email_key IS OLD.email_key AND NEW.env IS OLD.env AND NEW.kind IS OLD.kind
  AND NEW.d IS OLD.d AND NEW.slot IS OLD.slot AND NEW.created_at IS OLD.created_at
  AND NEW.attempts >= OLD.attempts
  AND (OLD.recipient_sha IS NULL OR NEW.recipient_sha IS OLD.recipient_sha))
BEGIN
  SELECT RAISE(ABORT, 'email_message: a claimed row moves once to a terminal status; terminal rows are frozen');
END;
CREATE TRIGGER email_message_prune_only BEFORE DELETE ON email_message
WHEN OLD.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-400 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;
CREATE TRIGGER email_attempt_insert_guard BEFORE INSERT ON email_attempt
WHEN NOT EXISTS (SELECT 1 FROM email_message m WHERE m.email_key = NEW.email_key)
BEGIN
  SELECT RAISE(ABORT, 'email_attempt: needs its email_message');
END;

-- 2. Pick alerts (ARN-115): one row per transition, current state = max(seq). alert_id is a sha of
-- user|market|d_pick|profile|rank. Append-only.
CREATE TABLE pick_alert (
  id INTEGER PRIMARY KEY,
  alert_id TEXT NOT NULL CHECK (length(alert_id) > 0),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  user_id TEXT NOT NULL CHECK (length(user_id) > 0),
  market TEXT NOT NULL CHECK (length(market) > 0),
  pick_d TEXT NOT NULL CHECK (pick_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  profile TEXT NOT NULL CHECK (length(profile) > 0),
  rank INTEGER NOT NULL CHECK (rank >= 1),
  code TEXT NOT NULL CHECK (length(code) > 0),
  session_d TEXT NOT NULL CHECK (session_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  state TEXT NOT NULL CHECK (state IN ('armed','hit','cleared')),
  limit_micro INTEGER NOT NULL CHECK (limit_micro > 0),
  stop_micro INTEGER NOT NULL CHECK (stop_micro > 0),
  at TEXT NOT NULL CHECK (length(at) > 0),
  hit_micro INTEGER CHECK (hit_micro IS NULL OR hit_micro > 0),
  quote_at TEXT CHECK (quote_at IS NULL OR length(quote_at) > 0),
  clear_reason TEXT CHECK (clear_reason IS NULL OR clear_reason IN
    ('left_list','below_stop','above_chase_cap','halted','expired','muted','filled')),
  UNIQUE (alert_id, seq),
  CHECK ((state = 'cleared') = (clear_reason IS NOT NULL)),
  CHECK ((state = 'hit') = (hit_micro IS NOT NULL))
) STRICT;
CREATE INDEX idx_pick_alert_session ON pick_alert (market, session_d, alert_id);
CREATE TRIGGER pick_alert_no_update BEFORE UPDATE ON pick_alert
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER pick_alert_no_delete BEFORE DELETE ON pick_alert
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 3. Pick-mail outcome per alert (EML-041): what became of the mail, so suppressed and held mail
-- shows in My alerts and Evening Review section 9. Append-only.
CREATE TABLE pick_alert_mail (
  id INTEGER PRIMARY KEY,
  alert_id TEXT NOT NULL CHECK (length(alert_id) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('pick_hit','pick_cleared','pick_candidate','pick_batch','pick_digest')),
  email_key TEXT CHECK (email_key IS NULL OR length(email_key) > 0),
  status TEXT NOT NULL CHECK (status IN ('sent','batched','suppressed_cap','held','held_to_review','off')),
  at TEXT NOT NULL CHECK (length(at) > 0)
) STRICT;
CREATE INDEX idx_pick_alert_mail_alert ON pick_alert_mail (alert_id, id);
CREATE TRIGGER pick_alert_mail_no_update BEFORE UPDATE ON pick_alert_mail
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER pick_alert_mail_no_delete BEFORE DELETE ON pick_alert_mail
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 4. Intraday candidates (DAT-240): one row per code per session. Point-in-time: only the
-- follow-up columns (latest quote, e-mail key, outcome, measurement) may change after insert.
CREATE TABLE intraday_candidate (
  market TEXT NOT NULL CHECK (length(market) > 0),
  session_d TEXT NOT NULL CHECK (session_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  code TEXT NOT NULL CHECK (length(code) > 0),
  found_slot TEXT NOT NULL CHECK (length(found_slot) > 0),
  found_at TEXT NOT NULL CHECK (length(found_at) > 0),
  item_source TEXT NOT NULL CHECK (length(item_source) > 0),
  item_ann_id TEXT NOT NULL CHECK (length(item_ann_id) > 0),
  item_category TEXT,
  materiality INTEGER NOT NULL CHECK (materiality >= 2),
  polarity TEXT,
  move_ppm INTEGER NOT NULL,
  sector_adj_ppm INTEGER,
  rel_volume_ppm INTEGER CHECK (rel_volume_ppm IS NULL OR rel_volume_ppm >= 0),
  gates_json TEXT NOT NULL CHECK (json_valid(gates_json)),
  indicative_limit_micro INTEGER CHECK (indicative_limit_micro IS NULL OR indicative_limit_micro > 0),
  indicative_stop_micro INTEGER CHECK (indicative_stop_micro IS NULL OR indicative_stop_micro > 0),
  email_key TEXT CHECK (email_key IS NULL OR length(email_key) > 0),
  latest_quote_at TEXT,
  latest_move_ppm INTEGER,
  decision_outcome TEXT,
  excess_open_1_ppm INTEGER,
  excess_open_3_ppm INTEGER,
  excess_open_5_ppm INTEGER,
  excess_found_1_ppm INTEGER,
  excess_found_3_ppm INTEGER,
  excess_found_5_ppm INTEGER,
  measured_at TEXT,
  PRIMARY KEY (market, session_d, code)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER intraday_candidate_guard_update BEFORE UPDATE ON intraday_candidate
WHEN NOT (NEW.market IS OLD.market AND NEW.session_d IS OLD.session_d AND NEW.code IS OLD.code
  AND NEW.found_slot IS OLD.found_slot AND NEW.found_at IS OLD.found_at
  AND NEW.item_source IS OLD.item_source AND NEW.item_ann_id IS OLD.item_ann_id
  AND NEW.item_category IS OLD.item_category AND NEW.materiality IS OLD.materiality
  AND NEW.polarity IS OLD.polarity AND NEW.move_ppm IS OLD.move_ppm
  AND NEW.sector_adj_ppm IS OLD.sector_adj_ppm AND NEW.rel_volume_ppm IS OLD.rel_volume_ppm
  AND NEW.gates_json IS OLD.gates_json
  AND NEW.indicative_limit_micro IS OLD.indicative_limit_micro
  AND NEW.indicative_stop_micro IS OLD.indicative_stop_micro)
BEGIN
  SELECT RAISE(ABORT, 'intraday_candidate: only the follow-up columns (latest quote, e-mail key, outcome, measurement) may change');
END;
CREATE TRIGGER intraday_candidate_no_delete BEFORE DELETE ON intraday_candidate
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 5. Quote runs, claim-first (D-442): the row is inserted BEFORE any request, with requests = the
-- allowed number (an upper-bound reservation, the safe direction); a second POST of the same slot finds
-- the row and returns already_done. session_d is the Melbourne market date. paused holds the cause of
-- a pause (the routes honour quote_pause_cooldown_min), NULL when not paused. Append-only.
CREATE TABLE quote_run (
  market TEXT NOT NULL CHECK (length(market) > 0),
  session_d TEXT NOT NULL CHECK (session_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  slot_minute TEXT NOT NULL CHECK (length(slot_minute) > 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('poll','scan')),
  started_at TEXT NOT NULL CHECK (length(started_at) > 0),
  requests INTEGER NOT NULL CHECK (requests >= 0),
  rejected INTEGER NOT NULL DEFAULT 0 CHECK (rejected >= 0),
  paused TEXT CHECK (paused IS NULL OR paused IN ('rate_limited','server_error','network')),
  narrowed INTEGER NOT NULL DEFAULT 0 CHECK (narrowed IN (0,1)),
  codes INTEGER NOT NULL DEFAULT 0 CHECK (codes >= 0),
  PRIMARY KEY (market, session_d, slot_minute, purpose)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER quote_run_no_update BEFORE UPDATE ON quote_run
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER quote_run_no_delete BEFORE DELETE ON quote_run
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 6. Licence register (D-398): the delayed-quote host as its own row, PENDING until the Owner accepts
-- it in Settings, Data sources. Unofficial, personal use, may be blocked, far more requests than
-- end-of-day (O-26 risk text extended). Until it is enabled, on, and dispatch is enabled, both M17
-- routes skip and make no request. The inserts write their history row through the 0004 trigger.
INSERT INTO source_register (source, permitted_use, rate_limits, risk, status, owner_ref, summarisation_permitted)
VALUES
  ('yahoo_delayed', 'personal use only (DAT-124); intraday delayed quotes, chart endpoint per code',
   'own budget 2000/day, 40 per scan run, 150 per poll tick, concurrency 4', 'high', 'pending', 'O-26', 0);
INSERT INTO source_status (source, mode, since)
VALUES ('yahoo_delayed', 'on', '2026-10-31T00:00:00.000Z');

-- +down
-- The register, its history and the status table refuse DELETE: the guards are lifted for the
-- statements below and restored with the identical definitions from migration 0004.
DROP TRIGGER source_register_no_delete;
DROP TRIGGER source_register_history_no_delete;
DELETE FROM source_register_history WHERE source = 'yahoo_delayed';
DELETE FROM source_register WHERE source = 'yahoo_delayed';
CREATE TRIGGER source_register_no_delete BEFORE DELETE ON source_register
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;
CREATE TRIGGER source_register_history_no_delete BEFORE DELETE ON source_register_history
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
DROP TRIGGER source_status_no_delete;
DELETE FROM source_status WHERE source = 'yahoo_delayed';
CREATE TRIGGER source_status_no_delete BEFORE DELETE ON source_status
BEGIN
  SELECT RAISE(ABORT, 'state rows are never deleted');
END;

DROP TABLE quote_run;
DROP TABLE intraday_candidate;
DROP TABLE pick_alert_mail;
DROP TABLE pick_alert;

-- Rebuild email_message with the 0009 kind list. Rows of the new kinds (and their attempts) are
-- removed first, because the 0009 CHECK cannot hold them; the prune guards are lifted for that.
DROP TRIGGER email_attempt_insert_guard;
DROP TRIGGER email_attempt_prune_only;
DELETE FROM email_attempt WHERE email_key IN (SELECT email_key FROM email_message
  WHERE kind IN ('pick_hit','pick_cleared','pick_candidate','pick_batch','pick_digest'));
CREATE TRIGGER email_attempt_prune_only BEFORE DELETE ON email_attempt
WHEN OLD.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-400 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;
DROP TRIGGER email_message_prune_only;
DELETE FROM email_message WHERE kind IN ('pick_hit','pick_cleared','pick_candidate','pick_batch','pick_digest');
CREATE TABLE email_message_old (
  email_key TEXT PRIMARY KEY CHECK (length(email_key) > 0),
  env TEXT NOT NULL CHECK (env IN ('production','staging','development','test')),
  kind TEXT NOT NULL CHECK (kind IN ('review','p0','p0_batch','incident_open','incident_s1',
    'tokens','unread7','reminder','brief','test','dbdown')),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  slot TEXT NOT NULL CHECK (slot IN
    ('reserved_review','reserved_incident','reserved_reminder','pool','p0')),
  status TEXT NOT NULL CHECK (status IN ('claimed','sent','failed','suppressed_cap',
    'suppressed_off','suppressed_paused','no_recipient')),
  subject TEXT NOT NULL DEFAULT '',
  size_html INTEGER NOT NULL DEFAULT 0 CHECK (size_html >= 0),
  size_text INTEGER NOT NULL DEFAULT 0 CHECK (size_text >= 0),
  provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) > 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  recipient_sha TEXT CHECK (recipient_sha IS NULL
    OR (length(recipient_sha) = 64 AND recipient_sha NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  ref_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ref_json)),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  CHECK (slot <> 'reserved_review' OR kind = 'review'),
  CHECK (slot <> 'reserved_reminder' OR kind = 'reminder'),
  CHECK (slot <> 'reserved_incident' OR kind IN ('incident_open','incident_s1')),
  CHECK ((slot = 'p0') = (kind IN ('p0','p0_batch')))
) STRICT, WITHOUT ROWID;
INSERT INTO email_message_old SELECT email_key, env, kind, d, slot, status, subject, size_html,
  size_text, provider_id, attempts, recipient_sha, created_at, sent_at, ref_json FROM email_message;
DROP TABLE email_message;
ALTER TABLE email_message_old RENAME TO email_message;
CREATE INDEX idx_email_message_d ON email_message (env, d, status);
CREATE INDEX idx_email_message_created ON email_message (created_at);
CREATE TRIGGER email_message_guard_update BEFORE UPDATE ON email_message
WHEN NOT (OLD.status = 'claimed'
  AND NEW.email_key IS OLD.email_key AND NEW.env IS OLD.env AND NEW.kind IS OLD.kind
  AND NEW.d IS OLD.d AND NEW.slot IS OLD.slot AND NEW.created_at IS OLD.created_at
  AND NEW.attempts >= OLD.attempts
  AND (OLD.recipient_sha IS NULL OR NEW.recipient_sha IS OLD.recipient_sha))
BEGIN
  SELECT RAISE(ABORT, 'email_message: a claimed row moves once to a terminal status; terminal rows are frozen');
END;
CREATE TRIGGER email_message_prune_only BEFORE DELETE ON email_message
WHEN OLD.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-400 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;
CREATE TRIGGER email_attempt_insert_guard BEFORE INSERT ON email_attempt
WHEN NOT EXISTS (SELECT 1 FROM email_message m WHERE m.email_key = NEW.email_key)
BEGIN
  SELECT RAISE(ABORT, 'email_attempt: needs its email_message');
END;
