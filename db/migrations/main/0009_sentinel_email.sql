-- +up
-- Sentinel, alerts and email tables (M5 T1, docs/M5_design.md section 3, D-096; choices marked
-- "D-097" are the builder's and are recorded in the decision log).
-- Conventions as 0004, 0007 and 0008: every table is STRICT; instants are ISO-8601 UTC text with
-- milliseconds and Z (D-031); `d` columns are Melbourne/Sydney local dates YYYY-MM-DD (they share
-- one clock, D-059); booleans are 0/1 with a CHECK; writers use INSERT ... ON CONFLICT DO NOTHING
-- and never the REPLACE write forms (REPLACE deletes without firing delete triggers, D-058,
-- tests/data/noReplaceWrites.test.ts). The one exception is the NFR-002 counter table, whose writer
-- uses ON CONFLICT DO UPDATE SET n = n + 1, which the trigger only lets grow.
--
-- No secrets and no personal data here (SEC-103, EML-005): the recipient address is never stored
-- (email_message.recipient_sha is a keyed hash), credential_expiry holds secret NAMES and dates only.
--
-- Retention (DAT-142). FOREVER tables refuse DELETE outright. Append-only tables refuse UPDATE.
-- Pruned tables allow DELETE only for rows older than their floor, evaluated by the trigger against
-- the current clock (the 0004 pattern):
--   sentinel_poll_day  d < today - 400 d       (NFR-002 evidence)
--   sentinel_ingest    received_at < now - 180 d
--   item_assessment    assessed_at < now - 400 d (as announcements)
--   alert              detected_at < now - 730 d (2 years)
--   email_message      created_at < now - 400 d
--   email_attempt      at < now - 400 d          (EML-030)
--   health_snapshot    d < today - 400 d
-- One-way tables: sentinel_poll_day (counters only grow), sentinel_ingest (status moves on),
-- item_assessment and alert (the *_llm / email_key fields go NULL -> value once, AGT-011a),
-- watch_list_owner (removed_at once), preopen_run, email_message (status moves out of `claimed`
-- once), credential_expiry (Owner action only; every change is logged in the history table).

-- ---------------------------------------------------------------------------------------------
-- A1 Sentinel: NFR-002 counters, ingest log, item assessments

-- One row per (market, source, local date). Counters only increase; the writer uses
-- ON CONFLICT DO UPDATE SET ok = ok + 1. `scheduled` counts due polls, so the success share of a
-- session is (ok + not_modified) / scheduled (AT-18 part A).
CREATE TABLE sentinel_poll_day (
  market TEXT NOT NULL,
  source TEXT NOT NULL CHECK (length(source) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  scheduled INTEGER NOT NULL DEFAULT 0 CHECK (scheduled >= 0),
  ok INTEGER NOT NULL DEFAULT 0 CHECK (ok >= 0),
  not_modified INTEGER NOT NULL DEFAULT 0 CHECK (not_modified >= 0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked >= 0),
  max_gap_s INTEGER NOT NULL DEFAULT 0 CHECK (max_gap_s >= 0),
  last_ok_at TEXT,
  PRIMARY KEY (market, source, d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER sentinel_poll_day_guard_update BEFORE UPDATE ON sentinel_poll_day
WHEN NOT (NEW.market IS OLD.market AND NEW.source IS OLD.source AND NEW.d IS OLD.d
  AND NEW.scheduled >= OLD.scheduled AND NEW.ok >= OLD.ok
  AND NEW.not_modified >= OLD.not_modified AND NEW.failed >= OLD.failed
  AND NEW.blocked >= OLD.blocked AND NEW.max_gap_s >= OLD.max_gap_s
  AND (OLD.last_ok_at IS NULL OR (NEW.last_ok_at IS NOT NULL AND NEW.last_ok_at >= OLD.last_ok_at)))
BEGIN
  SELECT RAISE(ABORT, 'sentinel_poll_day: counters only increase');
END;
CREATE TRIGGER sentinel_poll_day_prune_only BEFORE DELETE ON sentinel_poll_day
WHEN OLD.d >= date('now', '-400 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- One row per fetched feed body (id = 'si:<source>:<body_sha>', AGT-010, PLT-012). A retry of the
-- same body updates the row: the attempt number and the counts grow, the status moves on and `ok`
-- is final. items_seen / items_new may still change while the status is error or timeout (the
-- failed attempt may not have got as far as counting them).
CREATE TABLE sentinel_ingest (
  id TEXT PRIMARY KEY CHECK (id LIKE 'si:%'),
  received_at TEXT NOT NULL,
  items_seen INTEGER NOT NULL CHECK (items_seen >= 0),
  items_new INTEGER NOT NULL CHECK (items_new >= 0 AND items_new <= items_seen),
  assessed INTEGER NOT NULL DEFAULT 0 CHECK (assessed >= 0 AND assessed <= items_new),
  carried INTEGER NOT NULL DEFAULT 0 CHECK (carried >= 0 AND carried <= items_new),
  status TEXT NOT NULL CHECK (status IN ('ok','partial','error','timeout')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 3)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_sentinel_ingest_received ON sentinel_ingest (received_at);
CREATE TRIGGER sentinel_ingest_guard_update BEFORE UPDATE ON sentinel_ingest
WHEN NOT (NEW.id IS OLD.id AND NEW.received_at IS OLD.received_at
  AND OLD.status <> 'ok' AND NEW.attempt >= OLD.attempt AND NEW.assessed >= OLD.assessed
  AND (OLD.status IN ('error','timeout')
    OR (NEW.items_seen IS OLD.items_seen AND NEW.items_new IS OLD.items_new)))
BEGIN
  SELECT RAISE(ABORT, 'sentinel_ingest: attempts and counts only grow, ok is final');
END;
CREATE TRIGGER sentinel_ingest_prune_only BEFORE DELETE ON sentinel_ingest
WHEN OLD.received_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-180 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- Rule materiality per announcement (AGT-011) and its membership flags (AGT-014, AGT-015). The
-- announcement table is the queue, so the row needs its announcement. materiality_llm (R1, +-1) and
-- text_llm go NULL -> value once and never feed a rule (AGT-011a). A held code is always tracked and
-- a watch-listed code is always a candidate (decision 43).
CREATE TABLE item_assessment (
  source TEXT NOT NULL,
  ann_id TEXT NOT NULL,
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  materiality INTEGER NOT NULL CHECK (materiality BETWEEN 0 AND 3),
  rule_version TEXT NOT NULL CHECK (length(rule_version) > 0),
  polarity INTEGER NOT NULL CHECK (polarity IN (-1,0,1)),
  held INTEGER NOT NULL CHECK (held IN (0,1)),
  watch INTEGER NOT NULL CHECK (watch IN (0,1)),
  candidate INTEGER NOT NULL CHECK (candidate IN (0,1)),
  tracked INTEGER NOT NULL CHECK (tracked IN (0,1)),
  assessed_at TEXT NOT NULL,
  materiality_llm INTEGER CHECK (materiality_llm IS NULL OR materiality_llm BETWEEN 0 AND 3),
  text_llm TEXT CHECK (text_llm IS NULL OR length(text_llm) > 0),
  PRIMARY KEY (source, ann_id),
  CHECK (held = 0 OR tracked = 1),
  CHECK (watch = 0 OR candidate = 1),
  CHECK (materiality_llm IS NULL OR abs(materiality_llm - materiality) <= 1)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_item_assessment_code ON item_assessment (market, code, assessed_at);
CREATE TRIGGER item_assessment_insert_guard BEFORE INSERT ON item_assessment
WHEN NOT EXISTS (SELECT 1 FROM announcement a WHERE a.source = NEW.source AND a.ann_id = NEW.ann_id)
BEGIN
  SELECT RAISE(ABORT, 'item_assessment: needs its announcement');
END;
CREATE TRIGGER item_assessment_guard_update BEFORE UPDATE ON item_assessment
WHEN NOT (NEW.source IS OLD.source AND NEW.ann_id IS OLD.ann_id AND NEW.market IS OLD.market
  AND NEW.code IS OLD.code AND NEW.materiality IS OLD.materiality
  AND NEW.rule_version IS OLD.rule_version AND NEW.polarity IS OLD.polarity
  AND NEW.held IS OLD.held AND NEW.watch IS OLD.watch AND NEW.candidate IS OLD.candidate
  AND NEW.tracked IS OLD.tracked AND NEW.assessed_at IS OLD.assessed_at
  AND (OLD.materiality_llm IS NULL OR NEW.materiality_llm IS OLD.materiality_llm)
  AND (OLD.text_llm IS NULL OR NEW.text_llm IS OLD.text_llm))
BEGIN
  SELECT RAISE(ABORT, 'item_assessment: only materiality_llm and text_llm may go from NULL to a value');
END;
CREATE TRIGGER item_assessment_prune_only BEFORE DELETE ON item_assessment
WHEN OLD.assessed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-400 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- Owner-added watch-list codes (AGT-014): Owner only, expiry at most 90 days after the add. The
-- DB bound is 91 days from the UTC date of added_at (the Melbourne date can be a day ahead); the
-- control enforces 90 days from the Melbourne date and the owner_add_expiry_days key. A removal
-- sets removed_at once. Forever, so the audit trail of the list survives.
CREATE TABLE watch_list_owner (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  market TEXT NOT NULL,
  code TEXT NOT NULL CHECK (length(code) > 0),
  added_by INTEGER NOT NULL CHECK (added_by >= 1),
  added_at TEXT NOT NULL,
  expires_d TEXT NOT NULL CHECK (expires_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  removed_at TEXT,
  CHECK (expires_d >= substr(added_at, 1, 10)),
  CHECK (expires_d <= date(substr(added_at, 1, 10), '+91 days'))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_watch_list_owner_code ON watch_list_owner (market, code, expires_d);
CREATE TRIGGER watch_list_owner_guard_update BEFORE UPDATE ON watch_list_owner
WHEN NOT (NEW.id IS OLD.id AND NEW.market IS OLD.market AND NEW.code IS OLD.code
  AND NEW.added_by IS OLD.added_by AND NEW.added_at IS OLD.added_at
  AND NEW.expires_d IS OLD.expires_d
  AND (OLD.removed_at IS NULL OR NEW.removed_at IS OLD.removed_at))
BEGIN
  SELECT RAISE(ABORT, 'watch_list_owner: only removed_at may go from NULL to a value');
END;
CREATE TRIGGER watch_list_owner_no_delete BEFORE DELETE ON watch_list_owner
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- ---------------------------------------------------------------------------------------------
-- Alerts (AGT-115)

-- One row per alert key (design 2.2). The tier is fixed at insert. `email_key` (the email that
-- carried the alert) and `text_llm` (in-app wording only) go NULL -> value once. Only a live
-- execution E01-E12 can raise an alert, never a control or a challenger (AGT-014, ARN-020a).
-- weight_ppm is the held weight of the position in its execution's NAV, floored, for display; the
-- tier decision compares the exact rational in code.
CREATE TABLE alert (
  alert_key TEXT PRIMARY KEY CHECK (length(alert_key) > 0),
  market TEXT NOT NULL,
  code TEXT,
  kind TEXT NOT NULL CHECK (kind IN
    ('announcement','halt','halt_proxy','thesis_breaker','regime_shift','preopen_failure')),
  tier TEXT NOT NULL CHECK (tier IN ('P0','P1','P2')),
  execution_id TEXT,
  weight_ppm INTEGER CHECK (weight_ppm IS NULL OR weight_ppm >= 0),
  materiality INTEGER CHECK (materiality IS NULL OR materiality BETWEEN 0 AND 3),
  published_at TEXT,
  detected_at TEXT NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(facts_json)),
  email_key TEXT CHECK (email_key IS NULL OR length(email_key) > 0),
  text_llm TEXT CHECK (text_llm IS NULL OR length(text_llm) > 0)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_alert_tier ON alert (tier, detected_at);
CREATE INDEX idx_alert_code ON alert (market, code, detected_at);
CREATE TRIGGER alert_insert_guard BEFORE INSERT ON alert
WHEN NEW.execution_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM execution e WHERE e.id = NEW.execution_id AND e.kind = 'E')
BEGIN
  SELECT RAISE(ABORT, 'alert: only a live execution E can raise an alert');
END;
CREATE TRIGGER alert_guard_update BEFORE UPDATE ON alert
WHEN NOT (NEW.alert_key IS OLD.alert_key AND NEW.market IS OLD.market AND NEW.code IS OLD.code
  AND NEW.kind IS OLD.kind AND NEW.tier IS OLD.tier AND NEW.execution_id IS OLD.execution_id
  AND NEW.weight_ppm IS OLD.weight_ppm AND NEW.materiality IS OLD.materiality
  AND NEW.published_at IS OLD.published_at AND NEW.detected_at IS OLD.detected_at
  AND NEW.facts_json IS OLD.facts_json
  AND (OLD.email_key IS NULL OR NEW.email_key IS OLD.email_key)
  AND (OLD.text_llm IS NULL OR NEW.text_llm IS OLD.text_llm))
BEGIN
  SELECT RAISE(ABORT, 'alert: only email_key and text_llm may go from NULL to a value');
END;
CREATE TRIGGER alert_prune_only BEFORE DELETE ON alert
WHEN OLD.detected_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-730 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- ---------------------------------------------------------------------------------------------
-- Thesis-breakers (AGT-111) and the pre-open re-check (ARN-020a)

-- Every evaluation of a card's breaker, logged for attribution (errata 13 l.78). Append-only,
-- forever. `seq` (D-097) extends the design key so that a second intraday evaluation of the same
-- breaker on the same day (a new announcement after a green one) is a new row, not lost to
-- ON CONFLICT DO NOTHING. A breaker that triggered carries the announcement id in trigger_ref.
CREATE TABLE thesis_breaker_eval (
  subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
  breaker_id TEXT NOT NULL CHECK (length(breaker_id) > 0),
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  phase TEXT NOT NULL CHECK (phase IN ('nightly','preopen','intraday')),
  seq INTEGER NOT NULL DEFAULT 1 CHECK (seq >= 1),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('trade','order')),
  card_id TEXT NOT NULL,
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('green','amber','red')),
  value_text TEXT NOT NULL,
  trigger_text TEXT NOT NULL,
  amber_text TEXT,
  trigger_ref TEXT CHECK (trigger_ref IS NULL OR length(trigger_ref) > 0),
  rule_version TEXT NOT NULL CHECK (length(rule_version) > 0),
  PRIMARY KEY (subject_id, breaker_id, d, phase, seq)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_thesis_breaker_eval_code ON thesis_breaker_eval (market, code, d);
CREATE INDEX idx_thesis_breaker_eval_card ON thesis_breaker_eval (card_id);
CREATE TRIGGER thesis_breaker_eval_insert_guard BEFORE INSERT ON thesis_breaker_eval
WHEN NOT EXISTS (SELECT 1 FROM decision_card c WHERE c.id = NEW.card_id)
BEGIN
  SELECT RAISE(ABORT, 'thesis_breaker_eval: needs its decision card');
END;
CREATE TRIGGER thesis_breaker_eval_no_update BEFORE UPDATE ON thesis_breaker_eval
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER thesis_breaker_eval_no_delete BEFORE DELETE ON thesis_breaker_eval
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- The 09:55 re-check run per (market, date). Attempt 1 may end in `error`; then attempt 2 (09:58)
-- updates the row once. `ok`, `not_run` and a second `error` are final. Timings fill once.
CREATE TABLE preopen_run (
  market TEXT NOT NULL,
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  attempt INTEGER NOT NULL CHECK (attempt IN (1,2)),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','error','not_run')),
  checked INTEGER NOT NULL DEFAULT 0 CHECK (checked >= 0),
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled >= 0 AND cancelled <= checked),
  PRIMARY KEY (market, d),
  CHECK (status <> 'ok' OR finished_at IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER preopen_run_guard_update BEFORE UPDATE ON preopen_run
WHEN NOT (NEW.market IS OLD.market AND NEW.d IS OLD.d AND (
    (OLD.status = 'error' AND OLD.attempt = 1 AND NEW.attempt = 2
      AND NEW.status IN ('ok','error'))
    OR (NEW.status IS OLD.status AND NEW.attempt IS OLD.attempt AND NEW.started_at IS OLD.started_at
      AND OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL)))
BEGIN
  SELECT RAISE(ABORT, 'preopen_run: one retry after an error, or the finish time once');
END;
CREATE TRIGGER preopen_run_no_delete BEFORE DELETE ON preopen_run
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- The outcome for each pending entry order that the re-check looked at, or that filled without a
-- re-check (`not_rechecked`, ARN-020a). The money trail: append-only, forever. A cancel needs the
-- order to be cancelled already (the route cancels and records in one transaction).
CREATE TABLE preopen_result (
  order_id TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  outcome TEXT NOT NULL CHECK (outcome IN ('pass','cancel','not_rechecked')),
  reason TEXT,
  card_id TEXT CHECK (card_id IS NULL OR length(card_id) > 0),
  CHECK ((outcome = 'cancel') = (reason IS NOT NULL)),
  CHECK (reason IS NULL OR reason = 'halt' OR reason = 'possible_halt_feed_off'
    OR reason GLOB 'filter:?*' OR reason GLOB 'tb:?*')
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_preopen_result_d ON preopen_result (market, d);
CREATE TRIGGER preopen_result_insert_guard BEFORE INSERT ON preopen_result
WHEN NOT EXISTS (SELECT 1 FROM arena_order o WHERE o.id = NEW.order_id)
  OR (NEW.outcome = 'cancel'
    AND NOT EXISTS (SELECT 1 FROM arena_order o WHERE o.id = NEW.order_id AND o.status = 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'preopen_result: needs its order, and a cancel needs the order cancelled');
END;
CREATE TRIGGER preopen_result_no_update BEFORE UPDATE ON preopen_result
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER preopen_result_no_delete BEFORE DELETE ON preopen_result
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- Evening Review (EML-010..015, 035, 036)

-- One row per (local date, version). The facts are canonical JSON (hashed), the html / text /
-- markdown are the rendered forms. Append-only and forever: the learning journal (EML-015).
-- size_html is the byte length of the html before transfer encoding (EML-013, 90 KB).
CREATE TABLE evening_review (
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  version INTEGER NOT NULL CHECK (version >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('full','partial','minimal','non_trading')),
  missing_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(missing_json)),
  facts_json TEXT NOT NULL CHECK (json_valid(facts_json)),
  facts_sha TEXT NOT NULL CHECK (length(facts_sha) = 64 AND facts_sha NOT GLOB '*[^0-9a-f]*'),
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  markdown TEXT NOT NULL,
  size_html INTEGER NOT NULL CHECK (size_html >= 0),
  narrative TEXT NOT NULL CHECK (narrative IN ('rules','llm','mock')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (d, version),
  CHECK (kind <> 'partial' OR missing_json <> '[]')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER evening_review_no_update BEFORE UPDATE ON evening_review
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER evening_review_no_delete BEFORE DELETE ON evening_review
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- "Mark as read" (EML-036): the first read of a review date, once. Forever.
CREATE TABLE review_read (
  d TEXT PRIMARY KEY CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  read_at TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('page','email_link'))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER review_read_no_update BEFORE UPDATE ON review_read
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER review_read_no_delete BEFORE DELETE ON review_read
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- ---------------------------------------------------------------------------------------------
-- Email ledger (EML-004, 020, 030; NFR-006)

-- One row per email key (design 2.4): the claim is the insert with status `claimed`, so two racing
-- senders cannot both own a key. A claimed row moves ONCE to a terminal status; its subject, sizes,
-- provider id, attempts and send time may be filled while it is claimed. Terminal rows are frozen.
-- The cap counters read this table, so a `suppressed_*` row never counts. A P0 email uses slot `p0`
-- (a pool slot capped separately, NFR-006) and never a reserved slot; each reserved slot belongs
-- to one kind. recipient_sha is a keyed hash (never the address, EML-005).
CREATE TABLE email_message (
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

-- Every provider call (EML-030): up to 3 per email key, append-only.
CREATE TABLE email_attempt (
  email_key TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n BETWEEN 1 AND 3),
  at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted','retryable','rejected','network','timeout')),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) > 0),
  PRIMARY KEY (email_key, n),
  CHECK (provider_id IS NULL OR outcome = 'accepted')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER email_attempt_insert_guard BEFORE INSERT ON email_attempt
WHEN NOT EXISTS (SELECT 1 FROM email_message m WHERE m.email_key = NEW.email_key)
BEGIN
  SELECT RAISE(ABORT, 'email_attempt: needs its email_message');
END;
CREATE TRIGGER email_attempt_no_update BEFORE UPDATE ON email_attempt
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER email_attempt_prune_only BEFORE DELETE ON email_attempt
WHEN OLD.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-400 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- ---------------------------------------------------------------------------------------------
-- Attention reminder (EML-023): health snapshots, snoozes, credential expiry

-- The nine health components (UXN-283) as of a date and purpose; "Resolved since yesterday" reads
-- the previous snapshot. Append-only.
CREATE TABLE health_snapshot (
  d TEXT NOT NULL CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  purpose TEXT NOT NULL CHECK (purpose IN ('reminder','review')),
  components_json TEXT NOT NULL CHECK (json_valid(components_json)),
  PRIMARY KEY (d, purpose)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER health_snapshot_no_update BEFORE UPDATE ON health_snapshot
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER health_snapshot_prune_only BEFORE DELETE ON health_snapshot
WHEN OLD.d >= date('now', '-400 days')
BEGIN
  SELECT RAISE(ABORT, 'append-only (delete only beyond retention)');
END;

-- An Owner snooze of one attention item (EML-023). Insert only, forever, one audit event per insert
-- (written first by the control). until_d is at most 14 days after from_d, the upper bound of
-- attention_snooze_max_days; the control applies the configured value.
CREATE TABLE attention_snooze (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  component TEXT NOT NULL CHECK (component IN ('sentinel','market_data','nightly_run','ai_models',
    'evening_email','database','backups','security','free_tier_limits')),
  item_key TEXT NOT NULL CHECK (length(item_key) > 0),
  from_d TEXT NOT NULL CHECK (from_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  until_d TEXT NOT NULL CHECK (until_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL CHECK (created_by >= 1),
  CHECK (until_d > from_d),
  CHECK (until_d <= date(from_d, '+14 days'))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_attention_snooze_item ON attention_snooze (component, item_key, until_d);
CREATE TRIGGER attention_snooze_no_update BEFORE UPDATE ON attention_snooze
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER attention_snooze_no_delete BEFORE DELETE ON attention_snooze
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Expiry dates of the SEC-017 secrets the Owner entered (tokens-due email, PLT-074, NFR-006). The
-- NAME is a fixed id from src/lib/sentinel/schema.ts (CREDENTIAL_NAMES), never a value. Updatable
-- by the Owner action only; each insert and change is logged in the history table (source_register
-- pattern). Forever.
CREATE TABLE credential_expiry (
  name TEXT PRIMARY KEY CHECK (length(name) > 0 AND name NOT GLOB '*[^a-z0-9_]*'),
  expires_on TEXT NOT NULL CHECK (expires_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  set_at TEXT NOT NULL,
  set_by INTEGER NOT NULL CHECK (set_by >= 1)
) STRICT, WITHOUT ROWID;
CREATE TABLE credential_expiry_history (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('insert','update')),
  expires_on TEXT NOT NULL,
  set_by INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_credential_expiry_history_name ON credential_expiry_history (name, id);
CREATE TRIGGER credential_expiry_log_insert AFTER INSERT ON credential_expiry
BEGIN
  INSERT INTO credential_expiry_history (name, changed_at, op, expires_on, set_by)
  VALUES (NEW.name, NEW.set_at, 'insert', NEW.expires_on, NEW.set_by);
END;
CREATE TRIGGER credential_expiry_guard_update BEFORE UPDATE ON credential_expiry
WHEN NOT (NEW.name IS OLD.name AND NEW.set_at >= OLD.set_at)
BEGIN
  SELECT RAISE(ABORT, 'credential_expiry: the name is fixed and set_at only moves forward');
END;
CREATE TRIGGER credential_expiry_log_update AFTER UPDATE ON credential_expiry
BEGIN
  INSERT INTO credential_expiry_history (name, changed_at, op, expires_on, set_by)
  VALUES (NEW.name, NEW.set_at, 'update', NEW.expires_on, NEW.set_by);
END;
CREATE TRIGGER credential_expiry_no_delete BEFORE DELETE ON credential_expiry
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;
CREATE TRIGGER credential_expiry_history_no_update BEFORE UPDATE ON credential_expiry_history
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER credential_expiry_history_no_delete BEFORE DELETE ON credential_expiry_history
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- +down
-- Dropping a table drops its triggers and indexes with it (DROP does not fire delete triggers).
-- Rolling back discards Sentinel and email data; this is meant for development only.
DROP TABLE credential_expiry_history;
DROP TABLE credential_expiry;
DROP TABLE attention_snooze;
DROP TABLE health_snapshot;
DROP TABLE email_attempt;
DROP TABLE email_message;
DROP TABLE review_read;
DROP TABLE evening_review;
DROP TABLE preopen_result;
DROP TABLE preopen_run;
DROP TABLE thesis_breaker_eval;
DROP TABLE alert;
DROP TABLE watch_list_owner;
DROP TABLE item_assessment;
DROP TABLE sentinel_ingest;
DROP TABLE sentinel_poll_day;
