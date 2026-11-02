-- +up
-- M13-lite (WP1, D-510..D-533): expert seed import and screening. New tables only; nothing here touches an
-- order, fill, book, ledger, rule or breaker table (PRD-035). Dates are session dates (GLOB), JSON columns are
-- json_valid, money is integer micro, times are ISO UTC text. Every table is STRICT. PRD-036: EVERY TEXT column
-- carries a length() cap (or is an enumeration) and there is no column that could hold an article, transcript
-- or page; tests/db/0022_experts.test.ts enumerates the columns. Expert tables are append-only except where a
-- guard says otherwise (expert: four columns; claim: cluster_id once from NULL).

-- 1. Experts (KB-071). licence_status is 'unchecked' for every seed expert (D-520).
CREATE TABLE expert (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 32),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  platforms_json TEXT NOT NULL DEFAULT '[]' CHECK (length(platforms_json) <= 500
    AND json_valid(platforms_json) AND json_type(platforms_json) = 'array'),
  handles_json TEXT NOT NULL DEFAULT '{}' CHECK (length(handles_json) <= 1000
    AND json_valid(handles_json) AND json_type(handles_json) = 'object'),
  home_urls_json TEXT NOT NULL DEFAULT '[]' CHECK (length(home_urls_json) <= 1500
    AND json_valid(home_urls_json) AND json_type(home_urls_json) = 'array'),
  markets_json TEXT NOT NULL DEFAULT '[]' CHECK (length(markets_json) <= 200
    AND json_valid(markets_json) AND json_type(markets_json) = 'array'),
  focus_json TEXT NOT NULL DEFAULT '[]' CHECK (length(focus_json) <= 500
    AND json_valid(focus_json) AND json_type(focus_json) = 'array'),
  licence_status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (licence_status IN ('unchecked','registered','not_registered','not_applicable')),
  status TEXT NOT NULL CHECK (status IN ('candidate','tracked','paused','retired')),
  tier TEXT NOT NULL CHECK (tier IN ('core','discovered')),
  no_feed INTEGER NOT NULL DEFAULT 0 CHECK (no_feed IN (0,1)),
  audience_size INTEGER CHECK (audience_size IS NULL OR audience_size >= 0),
  audience_d TEXT CHECK (audience_d IS NULL OR (length(audience_d) = 10
    AND audience_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  poll_json TEXT CHECK (poll_json IS NULL OR (length(poll_json) <= 1000
    AND json_valid(poll_json) AND json_type(poll_json) = 'object')),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 40)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER expert_guard_update BEFORE UPDATE ON expert
WHEN NOT (NEW.id IS OLD.id AND NEW.name IS OLD.name AND NEW.platforms_json IS OLD.platforms_json
  AND NEW.handles_json IS OLD.handles_json AND NEW.home_urls_json IS OLD.home_urls_json
  AND NEW.markets_json IS OLD.markets_json AND NEW.focus_json IS OLD.focus_json
  AND NEW.tier IS OLD.tier AND NEW.no_feed IS OLD.no_feed AND NEW.audience_size IS OLD.audience_size
  AND NEW.audience_d IS OLD.audience_d AND NEW.created_at IS OLD.created_at)
BEGIN
  SELECT RAISE(ABORT, 'expert: only status, licence_status, poll_json and updated_at may change');
END;
CREATE TRIGGER expert_no_delete BEFORE DELETE ON expert
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 2. Red flags: stored only with a source link and a date (D-521).
CREATE TABLE expert_red_flag (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  expert_id TEXT NOT NULL CHECK (length(expert_id) BETWEEN 1 AND 32),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 400),
  source_url TEXT NOT NULL CHECK (length(source_url) BETWEEN 8 AND 500
    AND (source_url LIKE 'http://%' OR source_url LIKE 'https://%')),
  noted_d TEXT NOT NULL CHECK (length(noted_d) = 10 AND noted_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 40)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER expert_red_flag_insert_guard BEFORE INSERT ON expert_red_flag
WHEN NOT EXISTS (SELECT 1 FROM expert e WHERE e.id = NEW.expert_id)
BEGIN
  SELECT RAISE(ABORT, 'expert_red_flag: needs its expert');
END;
CREATE TRIGGER expert_red_flag_no_update BEFORE UPDATE ON expert_red_flag
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER expert_red_flag_no_delete BEFORE DELETE ON expert_red_flag
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 3. Source items (KB-072): link, hash, our own short summary and at most one short quote. No page text.
-- id = sha256(url || '|' || coalesce(content_hash, '')), so a repeat of the same URL and hash is a no-op.
CREATE TABLE source_item (
  id TEXT PRIMARY KEY CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  expert_id TEXT NOT NULL CHECK (length(expert_id) BETWEEN 1 AND 32),
  url TEXT NOT NULL CHECK (length(url) BETWEEN 8 AND 500 AND (url LIKE 'http://%' OR url LIKE 'https://%')),
  platform TEXT NOT NULL CHECK (length(platform) BETWEEN 1 AND 40),
  title TEXT CHECK (title IS NULL OR length(title) <= 200),
  published_at TEXT CHECK (published_at IS NULL OR length(published_at) <= 40),
  ingested_at TEXT NOT NULL CHECK (length(ingested_at) BETWEEN 1 AND 40),
  content_hash TEXT CHECK (content_hash IS NULL OR (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*')),
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 800),
  quote TEXT CHECK (quote IS NULL OR length(quote) <= 160),
  kind TEXT NOT NULL CHECK (kind IN ('method','call','market_view','other')),
  extraction_status TEXT NOT NULL CHECK (extraction_status IN ('seeded','pending','extracted','failed')),
  UNIQUE (url, content_hash)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_source_item_expert ON source_item (expert_id);
CREATE TRIGGER source_item_insert_guard BEFORE INSERT ON source_item
WHEN NOT EXISTS (SELECT 1 FROM expert e WHERE e.id = NEW.expert_id)
BEGIN
  SELECT RAISE(ABORT, 'source_item: needs its expert');
END;
CREATE TRIGGER source_item_no_update BEFORE UPDATE ON source_item
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER source_item_no_delete BEFORE DELETE ON source_item
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 4. Clusters (KB-075), created before the claims that point at them. Immutable; the state lives in cluster_state.
CREATE TABLE cluster (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 32),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  category TEXT NOT NULL CHECK (category IN ('candlesticks','chart_patterns','trend_momentum','mean_reversion',
    'volume','events_news','macro','risk_rules','fundamentals_value','calendar','none')),
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 600),
  canonical_text TEXT CHECK (canonical_text IS NULL OR length(canonical_text) <= 1200),
  testability TEXT NOT NULL CHECK (testability IN ('testable_eod','needs_new_data','needs_intraday','not_testable')),
  external_grade TEXT NOT NULL CHECK (external_grade IN ('supports','mixed','contradicts','none','not_searched')),
  evidence_links_json TEXT NOT NULL DEFAULT '[]' CHECK (length(evidence_links_json) <= 4000
    AND json_valid(evidence_links_json) AND json_type(evidence_links_json) = 'array'),
  vocabulary_gaps INTEGER NOT NULL DEFAULT 0 CHECK (vocabulary_gaps >= 0),
  closest_family TEXT CHECK (closest_family IS NULL
    OR closest_family IN ('F1','F2','F3','F4','F5','F6','new','overlay')),
  family_fit_json TEXT CHECK (family_fit_json IS NULL OR (length(family_fit_json) <= 2000
    AND json_valid(family_fit_json) AND json_type(family_fit_json) = 'object')),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 40)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cluster_no_update BEFORE UPDATE ON cluster
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cluster_no_delete BEFORE DELETE ON cluster
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 5. Claims (KB-073). The texts live in claim_revision, so an edit is a new version. cluster_id is the primary
-- cluster: set at insert, once from NULL (a claim merge, D-530), or moved to the cluster its current cluster
-- was merged into (a cluster merge re-links its claims, D-535); nothing else on the row ever changes.
CREATE TABLE claim (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 32),
  type TEXT NOT NULL CHECK (type IN ('method','event_link','call','risk_rule')),
  testability TEXT NOT NULL CHECK (testability IN ('testable_eod','needs_new_data','needs_intraday','not_testable')),
  cluster_id TEXT CHECK (cluster_id IS NULL OR length(cluster_id) BETWEEN 1 AND 32),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 40)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_claim_cluster ON claim (cluster_id);
CREATE TRIGGER claim_insert_guard BEFORE INSERT ON claim
WHEN NEW.cluster_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cluster c WHERE c.id = NEW.cluster_id)
BEGIN
  SELECT RAISE(ABORT, 'claim: cluster must exist');
END;
CREATE TRIGGER claim_guard_update BEFORE UPDATE ON claim
WHEN NOT (NEW.id IS OLD.id AND NEW.type IS OLD.type AND NEW.testability IS OLD.testability
  AND NEW.created_at IS OLD.created_at
  AND (NEW.cluster_id IS OLD.cluster_id
    OR (NEW.cluster_id IS NOT NULL AND EXISTS (SELECT 1 FROM cluster c WHERE c.id = NEW.cluster_id)
      AND (OLD.cluster_id IS NULL
        OR COALESCE((SELECT s.merged_into FROM cluster_state s WHERE s.cluster_id = OLD.cluster_id
          ORDER BY s.seq DESC LIMIT 1), '') = NEW.cluster_id))))
BEGIN
  SELECT RAISE(ABORT, 'claim: cluster_id may be set once from NULL or follow a cluster merge');
END;
CREATE TRIGGER claim_no_delete BEFORE DELETE ON claim
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TABLE claim_revision (
  claim_id TEXT NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 32),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 600),
  formalisation_text TEXT CHECK (formalisation_text IS NULL OR length(formalisation_text) <= 1200),
  vocabulary_gap_text TEXT CHECK (vocabulary_gap_text IS NULL OR length(vocabulary_gap_text) <= 300),
  claimed_edge_text TEXT CHECK (claimed_edge_text IS NULL OR length(claimed_edge_text) <= 400),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  at TEXT NOT NULL CHECK (length(at) BETWEEN 1 AND 40),
  PRIMARY KEY (claim_id, seq)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER claim_revision_insert_guard BEFORE INSERT ON claim_revision
WHEN NOT EXISTS (SELECT 1 FROM claim c WHERE c.id = NEW.claim_id)
  OR NEW.seq <> COALESCE((SELECT MAX(r.seq) FROM claim_revision r WHERE r.claim_id = NEW.claim_id), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'claim_revision: needs its claim and the next seq');
END;
CREATE TRIGGER claim_revision_no_update BEFORE UPDATE ON claim_revision
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER claim_revision_no_delete BEFORE DELETE ON claim_revision
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TABLE claim_expert (
  claim_id TEXT NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 32),
  expert_id TEXT NOT NULL CHECK (length(expert_id) BETWEEN 1 AND 32),
  PRIMARY KEY (claim_id, expert_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_claim_expert_expert ON claim_expert (expert_id);
CREATE TRIGGER claim_expert_insert_guard BEFORE INSERT ON claim_expert
WHEN NOT EXISTS (SELECT 1 FROM claim c WHERE c.id = NEW.claim_id)
  OR NOT EXISTS (SELECT 1 FROM expert e WHERE e.id = NEW.expert_id)
BEGIN
  SELECT RAISE(ABORT, 'claim_expert: claim and expert must exist');
END;
CREATE TRIGGER claim_expert_no_update BEFORE UPDATE ON claim_expert
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER claim_expert_no_delete BEFORE DELETE ON claim_expert
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TABLE claim_item (
  claim_id TEXT NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 32),
  item_id TEXT NOT NULL CHECK (length(item_id) = 64),
  PRIMARY KEY (claim_id, item_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_claim_item_item ON claim_item (item_id);
CREATE TRIGGER claim_item_insert_guard BEFORE INSERT ON claim_item
WHEN NOT EXISTS (SELECT 1 FROM claim c WHERE c.id = NEW.claim_id)
  OR NOT EXISTS (SELECT 1 FROM source_item i WHERE i.id = NEW.item_id)
BEGIN
  SELECT RAISE(ABORT, 'claim_item: claim and item must exist');
END;
CREATE TRIGGER claim_item_no_update BEFORE UPDATE ON claim_item
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER claim_item_no_delete BEFORE DELETE ON claim_item
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 6. Claim status chain (KB-073): append-only; current status = max seq. The first row is 'extracted' and each
-- later row must follow an allowed edge from the previous row.
CREATE TABLE claim_status (
  claim_id TEXT NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 32),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  status TEXT NOT NULL CHECK (status IN ('extracted','owner_checked','formalised','screened','challenger',
    'promoted','rejected','parked')),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 300),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  at TEXT NOT NULL CHECK (length(at) BETWEEN 1 AND 40),
  PRIMARY KEY (claim_id, seq)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER claim_status_seq_guard BEFORE INSERT ON claim_status
WHEN NOT EXISTS (SELECT 1 FROM claim c WHERE c.id = NEW.claim_id)
  OR NEW.seq <> COALESCE((SELECT MAX(s.seq) FROM claim_status s WHERE s.claim_id = NEW.claim_id), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'claim_status: needs its claim and the next seq');
END;
CREATE TRIGGER claim_status_first_guard BEFORE INSERT ON claim_status
WHEN NOT EXISTS (SELECT 1 FROM claim_status s WHERE s.claim_id = NEW.claim_id) AND NEW.status <> 'extracted'
BEGIN
  SELECT RAISE(ABORT, 'claim_status: the first status is extracted');
END;
CREATE TRIGGER claim_status_edge_guard BEFORE INSERT ON claim_status
WHEN EXISTS (SELECT 1 FROM claim_status s WHERE s.claim_id = NEW.claim_id)
  AND NOT ((SELECT s.status FROM claim_status s WHERE s.claim_id = NEW.claim_id ORDER BY s.seq DESC LIMIT 1),
    NEW.status) IN (VALUES
      ('extracted','owner_checked'), ('extracted','rejected'), ('extracted','parked'),
      ('owner_checked','formalised'), ('owner_checked','rejected'), ('owner_checked','parked'),
      ('formalised','screened'), ('formalised','parked'),
      ('screened','challenger'), ('screened','parked'), ('screened','rejected'),
      ('challenger','promoted'), ('challenger','rejected'), ('challenger','parked'),
      ('parked','owner_checked'))
BEGIN
  SELECT RAISE(ABORT, 'claim_status: edge not allowed (KB-073)');
END;
CREATE TRIGGER claim_status_no_update BEFORE UPDATE ON claim_status
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER claim_status_no_delete BEFORE DELETE ON claim_status
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 7. Cluster state chain and claim-to-cluster links.
CREATE TABLE cluster_state (
  cluster_id TEXT NOT NULL CHECK (length(cluster_id) BETWEEN 1 AND 32),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  state TEXT NOT NULL CHECK (state IN ('proposed','confirmed','merged','parked')),
  merged_into TEXT CHECK (merged_into IS NULL OR length(merged_into) BETWEEN 1 AND 32),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 300),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  at TEXT NOT NULL CHECK (length(at) BETWEEN 1 AND 40),
  PRIMARY KEY (cluster_id, seq),
  CHECK ((state = 'merged') = (merged_into IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cluster_state_insert_guard BEFORE INSERT ON cluster_state
WHEN NOT EXISTS (SELECT 1 FROM cluster c WHERE c.id = NEW.cluster_id)
  OR NEW.seq <> COALESCE((SELECT MAX(s.seq) FROM cluster_state s WHERE s.cluster_id = NEW.cluster_id), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'cluster_state: needs its cluster and the next seq');
END;
CREATE TRIGGER cluster_state_merge_guard BEFORE INSERT ON cluster_state
WHEN NEW.merged_into IS NOT NULL
  AND (NEW.merged_into = NEW.cluster_id OR NOT EXISTS (SELECT 1 FROM cluster c WHERE c.id = NEW.merged_into))
BEGIN
  SELECT RAISE(ABORT, 'cluster_state: merged_into must be another existing cluster');
END;
-- A merged cluster is final (D-535): its claims move to merged_into and nothing may reopen it.
CREATE TRIGGER cluster_state_final_guard BEFORE INSERT ON cluster_state
WHEN COALESCE((SELECT s.state FROM cluster_state s WHERE s.cluster_id = NEW.cluster_id
  ORDER BY s.seq DESC LIMIT 1), '') = 'merged'
BEGIN
  SELECT RAISE(ABORT, 'cluster_state: a merged cluster is final');
END;
CREATE TRIGGER cluster_state_no_update BEFORE UPDATE ON cluster_state
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cluster_state_no_delete BEFORE DELETE ON cluster_state
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TABLE claim_cluster (
  claim_id TEXT NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 32),
  cluster_id TEXT NOT NULL CHECK (length(cluster_id) BETWEEN 1 AND 32),
  role TEXT NOT NULL CHECK (role IN ('supports','contradicts')),
  PRIMARY KEY (claim_id, cluster_id, role)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_claim_cluster_cluster ON claim_cluster (cluster_id);
CREATE TRIGGER claim_cluster_insert_guard BEFORE INSERT ON claim_cluster
WHEN NOT EXISTS (SELECT 1 FROM claim c WHERE c.id = NEW.claim_id)
  OR NOT EXISTS (SELECT 1 FROM cluster k WHERE k.id = NEW.cluster_id)
BEGIN
  SELECT RAISE(ABORT, 'claim_cluster: claim and cluster must exist');
END;
CREATE TRIGGER claim_cluster_no_update BEFORE UPDATE ON claim_cluster
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER claim_cluster_no_delete BEFORE DELETE ON claim_cluster
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 8. Screening (KB-075/076): one run per market and week (insert-once), one result per cluster. The p-values
-- and q are REAL in 0..1 (D-534): a ppm integer would collapse the small p-values BH ranks on.
CREATE TABLE screening_run (
  run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 64),
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 16),
  d TEXT NOT NULL CHECK (length(d) = 10 AND d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  q REAL NOT NULL CHECK (q > 0 AND q <= 1),
  considered INTEGER NOT NULL CHECK (considered >= 0),
  eligible INTEGER NOT NULL CHECK (eligible >= 0 AND eligible <= considered),
  screened INTEGER NOT NULL CHECK (screened >= 0 AND screened <= eligible),
  survivors INTEGER NOT NULL CHECK (survivors >= 0 AND survivors <= screened),
  splits_json TEXT NOT NULL CHECK (length(splits_json) <= 2000
    AND json_valid(splits_json) AND json_type(splits_json) = 'object'),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 40),
  UNIQUE (market, d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER screening_run_no_update BEFORE UPDATE ON screening_run
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER screening_run_no_delete BEFORE DELETE ON screening_run
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TABLE screening_result (
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 64),
  cluster_id TEXT NOT NULL CHECK (length(cluster_id) BETWEEN 1 AND 32),
  family TEXT NOT NULL CHECK (family IN ('F1','F2','F3','F4','F5','F6')),
  params_sha TEXT NOT NULL CHECK (length(params_sha) = 64 AND params_sha NOT GLOB '*[^0-9a-f]*'),
  rows INTEGER NOT NULL CHECK (rows >= 0),
  blocks INTEGER NOT NULL CHECK (blocks >= 0),
  mean_net_ppm INTEGER NOT NULL,
  mean_excess_ppm INTEGER,
  lower90_ppm INTEGER,
  p REAL NOT NULL CHECK (p >= 0 AND p <= 1),
  adjusted_p REAL NOT NULL CHECK (adjusted_p >= 0 AND adjusted_p <= 1),
  bh_rejected INTEGER NOT NULL CHECK (bh_rejected IN (0,1)),
  sign_agrees INTEGER NOT NULL CHECK (sign_agrees IN (0,1)),
  survived INTEGER NOT NULL CHECK (survived IN (0,1)),
  rank INTEGER CHECK (rank IS NULL OR rank >= 1),
  grade TEXT NOT NULL CHECK (grade IN ('L0','L1')),
  PRIMARY KEY (run_id, cluster_id),
  CHECK (survived = (bh_rejected = 1 AND sign_agrees = 1)),
  CHECK ((grade = 'L1') = (survived = 1))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER screening_result_insert_guard BEFORE INSERT ON screening_result
WHEN NOT EXISTS (SELECT 1 FROM screening_run r WHERE r.run_id = NEW.run_id)
  OR NOT EXISTS (SELECT 1 FROM cluster k WHERE k.id = NEW.cluster_id)
BEGIN
  SELECT RAISE(ABORT, 'screening_result: run and cluster must exist');
END;
CREATE TRIGGER screening_result_no_update BEFORE UPDATE ON screening_result
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER screening_result_no_delete BEFORE DELETE ON screening_result
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 9. Proposals (KB-077). cluster_id is NULL only for the cross-cluster F7 gate row (D-534).
CREATE TABLE expert_proposal (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 96),
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 16),
  d TEXT NOT NULL CHECK (length(d) = 10 AND d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  cluster_id TEXT CHECK (cluster_id IS NULL OR length(cluster_id) BETWEEN 1 AND 32),
  kind TEXT NOT NULL CHECK (kind IN ('challenger','new_lineage','f7_lineage')),
  family TEXT CHECK (family IS NULL OR family IN ('F1','F2','F3','F4','F5','F6')),
  challenger_id TEXT CHECK (challenger_id IS NULL OR length(challenger_id) BETWEEN 1 AND 96),
  status TEXT NOT NULL CHECK (status IN ('created','exists','refused','parked_build_change','dormant')),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 300),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 40),
  CHECK ((kind = 'f7_lineage') = (cluster_id IS NULL)),
  CHECK (kind <> 'new_lineage' OR status = 'parked_build_change'),
  CHECK (kind <> 'f7_lineage' OR status = 'dormant'),
  CHECK (kind <> 'challenger' OR status IN ('created','exists','refused'))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER expert_proposal_insert_guard BEFORE INSERT ON expert_proposal
WHEN NEW.cluster_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cluster k WHERE k.id = NEW.cluster_id)
BEGIN
  SELECT RAISE(ABORT, 'expert_proposal: cluster must exist');
END;
CREATE TRIGGER expert_proposal_no_update BEFORE UPDATE ON expert_proposal
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER expert_proposal_no_delete BEFORE DELETE ON expert_proposal
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 10. Calls (KB-080): paper calls, never picks or orders. luck_pct is a whole percent (D-534).
CREATE TABLE expert_call (
  claim_id TEXT PRIMARY KEY CHECK (length(claim_id) BETWEEN 1 AND 32),
  market TEXT NOT NULL CHECK (length(market) BETWEEN 1 AND 16),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 32),
  direction TEXT NOT NULL CHECK (direction IN ('long','short')),
  call_d TEXT NOT NULL CHECK (length(call_d) = 10 AND call_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  horizon_sessions INTEGER NOT NULL CHECK (horizon_sessions >= 1),
  target_micro INTEGER CHECK (target_micro IS NULL OR target_micro > 0),
  stop_micro INTEGER CHECK (stop_micro IS NULL OR stop_micro > 0),
  tracked INTEGER NOT NULL CHECK (tracked IN (0,1)),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 40)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER expert_call_insert_guard BEFORE INSERT ON expert_call
WHEN NOT EXISTS (SELECT 1 FROM claim c WHERE c.id = NEW.claim_id AND c.type = 'call')
BEGIN
  SELECT RAISE(ABORT, 'expert_call: needs a claim of type call');
END;
CREATE TRIGGER expert_call_no_update BEFORE UPDATE ON expert_call
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER expert_call_no_delete BEFORE DELETE ON expert_call
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TABLE expert_call_outcome (
  claim_id TEXT PRIMARY KEY CHECK (length(claim_id) BETWEEN 1 AND 32),
  state TEXT NOT NULL CHECK (state IN ('closed_target','closed_stop','closed_horizon','no_bars')),
  entry_d TEXT CHECK (entry_d IS NULL OR (length(entry_d) = 10
    AND entry_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  exit_d TEXT CHECK (exit_d IS NULL OR (length(exit_d) = 10
    AND exit_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  net_ppm INTEGER,
  index_code TEXT NOT NULL CHECK (length(index_code) BETWEEN 1 AND 32),
  basis TEXT NOT NULL CHECK (length(basis) BETWEEN 1 AND 40),
  market_ret_ppm INTEGER,
  vs_market_ppm INTEGER,
  luck_pct INTEGER CHECK (luck_pct IS NULL OR luck_pct BETWEEN 0 AND 100),
  settled_d TEXT NOT NULL CHECK (length(settled_d) = 10
    AND settled_d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (state = 'no_bars' OR (entry_d IS NOT NULL AND exit_d IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER expert_call_outcome_insert_guard BEFORE INSERT ON expert_call_outcome
WHEN NOT EXISTS (SELECT 1 FROM expert_call c WHERE c.claim_id = NEW.claim_id AND c.tracked = 1)
BEGIN
  SELECT RAISE(ABORT, 'expert_call_outcome: needs a tracked call');
END;
CREATE TRIGGER expert_call_outcome_no_update BEFORE UPDATE ON expert_call_outcome
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER expert_call_outcome_no_delete BEFORE DELETE ON expert_call_outcome
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- 11. Licence register (DAT-227, D-522): three automated-channel classes stay PENDING (terms [VERIFY]; nothing
-- fetches in M13-lite); five manual-only platforms are DISABLED (the Owner pastes a link). Status rows are 'off'.
-- The inserts write their history rows through the 0004 trigger.
INSERT INTO source_register (source, permitted_use, rate_limits, risk, status, owner_ref, summarisation_permitted)
VALUES
  ('expert_rss', 'public feed metadata and own summary only (PRD-036, DAT-227); terms [VERIFY]',
   'none set; nothing fetches in M13-lite', 'medium', 'pending', NULL, 1),
  ('expert_youtube_feed', 'public feed metadata and own summary only (PRD-036, DAT-227); terms [VERIFY]',
   'none set; nothing fetches in M13-lite', 'medium', 'pending', NULL, 1),
  ('expert_own_site', 'public feed metadata and own summary only (PRD-036, DAT-227); terms [VERIFY]',
   'none set; nothing fetches in M13-lite', 'medium', 'pending', NULL, 1),
  ('expert_x', 'manual-only: Owner pastes a link, public metadata only (DAT-227)',
   'none; no automated reading', 'high', 'disabled', NULL, 0),
  ('expert_instagram', 'manual-only: Owner pastes a link, public metadata only (DAT-227)',
   'none; no automated reading', 'high', 'disabled', NULL, 0),
  ('expert_tiktok', 'manual-only: Owner pastes a link, public metadata only (DAT-227)',
   'none; no automated reading', 'high', 'disabled', NULL, 0),
  ('expert_facebook', 'manual-only: Owner pastes a link, public metadata only (DAT-227)',
   'none; no automated reading', 'high', 'disabled', NULL, 0),
  ('expert_linkedin', 'manual-only: Owner pastes a link, public metadata only (DAT-227)',
   'none; no automated reading', 'high', 'disabled', NULL, 0);
INSERT INTO source_status (source, mode, since)
VALUES
  ('expert_rss', 'off', '2026-11-01T00:00:00.000Z'),
  ('expert_youtube_feed', 'off', '2026-11-01T00:00:00.000Z'),
  ('expert_own_site', 'off', '2026-11-01T00:00:00.000Z'),
  ('expert_x', 'off', '2026-11-01T00:00:00.000Z'),
  ('expert_instagram', 'off', '2026-11-01T00:00:00.000Z'),
  ('expert_tiktok', 'off', '2026-11-01T00:00:00.000Z'),
  ('expert_facebook', 'off', '2026-11-01T00:00:00.000Z'),
  ('expert_linkedin', 'off', '2026-11-01T00:00:00.000Z');

-- +down
-- The register, its history and the status table refuse DELETE: the guards are lifted for the statements
-- below and restored with the identical definitions from migration 0004.
DROP TRIGGER source_register_no_delete;
DROP TRIGGER source_register_history_no_delete;
DELETE FROM source_register_history WHERE source IN ('expert_rss','expert_youtube_feed','expert_own_site',
  'expert_x','expert_instagram','expert_tiktok','expert_facebook','expert_linkedin');
DELETE FROM source_register WHERE source IN ('expert_rss','expert_youtube_feed','expert_own_site',
  'expert_x','expert_instagram','expert_tiktok','expert_facebook','expert_linkedin');
CREATE TRIGGER source_register_no_delete BEFORE DELETE ON source_register
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;
CREATE TRIGGER source_register_history_no_delete BEFORE DELETE ON source_register_history
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
DROP TRIGGER source_status_no_delete;
DELETE FROM source_status WHERE source IN ('expert_rss','expert_youtube_feed','expert_own_site',
  'expert_x','expert_instagram','expert_tiktok','expert_facebook','expert_linkedin');
CREATE TRIGGER source_status_no_delete BEFORE DELETE ON source_status
BEGIN
  SELECT RAISE(ABORT, 'state rows are never deleted');
END;

DROP TABLE expert_call_outcome;
DROP TABLE expert_call;
DROP TABLE expert_proposal;
DROP TABLE screening_result;
DROP TABLE screening_run;
DROP TABLE claim_cluster;
DROP TABLE cluster_state;
DROP TABLE claim_status;
DROP TABLE claim_item;
DROP TABLE claim_expert;
DROP TABLE claim_revision;
DROP TABLE claim;
DROP TABLE cluster;
DROP TABLE source_item;
DROP TABLE expert_red_flag;
DROP TABLE expert;
