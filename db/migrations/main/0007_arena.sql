-- +up
-- Practice engine and paper-trading arena tables (M3 T4, docs/M3_design.md section 3, D-069).
-- Conventions as 0004: instants are ISO-8601 UTC text with milliseconds and Z (D-031); `d` is the
-- Sydney trading date YYYY-MM-DD; booleans are 0/1 with CHECK; writers use
-- INSERT ... ON CONFLICT DO NOTHING and never the REPLACE write forms (REPLACE deletes the old row
-- without firing delete triggers; D-058, tests/data/noReplaceWrites.test.ts).
--
-- Money is INTEGER micro-AUD, columns are named `*_micro` (1 A$ = 1,000,000 micro); share
-- quantities are INTEGER; there is no REAL column anywhere. Every table is STRICT, so a fractional
-- value for an INTEGER column is refused by the engine (it is never rounded silently); a whole
-- floating value such as 2.0 is converted to 2 by the engine and is harmless.
--
-- Everything here is retained FOREVER (DAT-142: the money trail is never pruned): no DELETE
-- is ever allowed. Ledger-grade tables also refuse UPDATE (append-only); state tables allow only
-- the documented one-way changes, enforced by the guard triggers below. No wall-clock column is
-- stored on engine rows (fills, ledger, NAV) so a replay is byte-identical (ARN-102, NFR-022).
--
-- Deviations from the design table names (docs/M3_design.md section 3): the `order` table is named
-- `arena_order` because ORDER is an SQL keyword (an unquoted `order` breaks every future writer);
-- positions are NOT a table (decision 11): they are derived from fills and trades plus the
-- end-of-day snapshot in nav_daily_pos. No seed rows: cost profiles P0-P5b are loaded as config by
-- the cost module (T2) with `verified = 0` until the Owner approves the [VERIFY] numbers.

-- Executions: E01..E12, C1, C2-<family>, C3-<family>. Only `status` and `rule_version` may change.
CREATE TABLE execution (
  id TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('E','C1','C2','C3')),
  family TEXT,
  variant TEXT CHECK (variant IN ('U','L')),
  twin_group TEXT,
  rule_version TEXT NOT NULL,
  cost_profile TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (length(status) > 0),
  CHECK (kind <> 'E' OR (family IS NOT NULL AND variant IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER execution_guard_update BEFORE UPDATE ON execution
WHEN NOT (NEW.id IS OLD.id AND NEW.market IS OLD.market AND NEW.kind IS OLD.kind
  AND NEW.family IS OLD.family AND NEW.variant IS OLD.variant AND NEW.twin_group IS OLD.twin_group
  AND NEW.cost_profile IS OLD.cost_profile)
BEGIN
  SELECT RAISE(ABORT, 'execution: only status and rule_version may change');
END;
CREATE TRIGGER execution_no_delete BEFORE DELETE ON execution
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- Cohorts. Terminal columns go NULL -> value exactly once, all together (CHECK) and never again;
-- `live` may go 1 -> 0 once (live liquidated, continued in shadow, ARN-053). Nothing else changes.
CREATE TABLE cohort (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  control_idx INTEGER CHECK (control_idx IS NULL OR control_idx >= 1),
  start_d TEXT NOT NULL,
  seed_micro INTEGER NOT NULL CHECK (seed_micro > 0),
  rule_version TEXT NOT NULL,
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  cost_profile_version INTEGER NOT NULL CHECK (cost_profile_version >= 1),
  sleeve_json TEXT CHECK (sleeve_json IS NULL OR json_valid(sleeve_json)),
  data_snapshot_id TEXT,
  rng_seed INTEGER NOT NULL,
  twin_group TEXT,
  restart_of TEXT,
  live INTEGER NOT NULL DEFAULT 1 CHECK (live IN (0,1)),
  terminal_kind TEXT CHECK (terminal_kind IN ('target','bust','stalled','timeout')),
  terminal_d TEXT,
  ttd_sessions INTEGER CHECK (ttd_sessions IS NULL OR ttd_sessions >= 0),
  ttd_days INTEGER CHECK (ttd_days IS NULL OR ttd_days >= 0),
  outcome_micro INTEGER,
  CHECK ((terminal_kind IS NULL AND terminal_d IS NULL AND ttd_sessions IS NULL
          AND ttd_days IS NULL AND outcome_micro IS NULL)
      OR (terminal_kind IS NOT NULL AND terminal_d IS NOT NULL AND ttd_sessions IS NOT NULL
          AND ttd_days IS NOT NULL AND outcome_micro IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_cohort_execution ON cohort (execution_id, start_d);
CREATE TRIGGER cohort_guard_update BEFORE UPDATE ON cohort
WHEN NOT (NEW.id IS OLD.id AND NEW.execution_id IS OLD.execution_id
  AND NEW.control_idx IS OLD.control_idx AND NEW.start_d IS OLD.start_d
  AND NEW.seed_micro IS OLD.seed_micro AND NEW.rule_version IS OLD.rule_version
  AND NEW.params_json IS OLD.params_json AND NEW.cost_profile_version IS OLD.cost_profile_version
  AND NEW.sleeve_json IS OLD.sleeve_json AND NEW.data_snapshot_id IS OLD.data_snapshot_id
  AND NEW.rng_seed IS OLD.rng_seed AND NEW.twin_group IS OLD.twin_group
  AND NEW.restart_of IS OLD.restart_of
  AND (NEW.live = OLD.live OR (OLD.live = 1 AND NEW.live = 0))
  AND (OLD.terminal_kind IS NULL
       OR (NEW.terminal_kind IS OLD.terminal_kind AND NEW.terminal_d IS OLD.terminal_d
           AND NEW.ttd_sessions IS OLD.ttd_sessions AND NEW.ttd_days IS OLD.ttd_days
           AND NEW.outcome_micro IS OLD.outcome_micro)))
BEGIN
  SELECT RAISE(ABORT, 'cohort: terminal state is set once; live may go 1 to 0; nothing else changes');
END;
CREATE TRIGGER cohort_no_delete BEFORE DELETE ON cohort
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- Cohort events (start, terminal, restart, shadow_continue, lock, unlock; ca_adjust records a
-- split / consolidation quantity re-base, decision 14; data_event marks a corporate action,
-- suspension or data correction that touched the cohort, ch.06). Append-only.
CREATE TABLE cohort_event (
  cohort_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (kind IN
    ('start','terminal','restart','shadow_continue','lock','unlock','ca_adjust','data_event')),
  d TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  PRIMARY KEY (cohort_id, seq)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cohort_event_no_update BEFORE UPDATE ON cohort_event
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cohort_event_no_delete BEFORE DELETE ON cohort_event
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Orders: one row per family signal (accepted or rejected), so "every signal rejected only for
-- parcel / whole-share" is a query. A rejected order may be inserted directly; a pending order moves
-- to exactly one terminal status (filled / rejected / cancelled) once; `fill_d` and `reject_reason`
-- may be set at that move. 'filled' is only reachable by UPDATE after the fill row exists.
CREATE TABLE arena_order (
  id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL,
  decided_d TEXT NOT NULL,
  fill_d TEXT,
  code TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  kind TEXT NOT NULL CHECK (kind IN ('entry','exit_cs','exit_is','sleeve_open','sleeve_close')),
  qty INTEGER NOT NULL CHECK (qty >= 0),
  ref_stop_micro INTEGER CHECK (ref_stop_micro IS NULL OR ref_stop_micro > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','filled','rejected','cancelled')),
  reject_reason TEXT CHECK (reject_reason IS NULL OR length(reject_reason) > 0),
  tier TEXT CHECK (tier IN ('U1','U2','U3')),
  untradeable_flag INTEGER NOT NULL DEFAULT 0 CHECK (untradeable_flag IN (0,1)),
  UNIQUE (cohort_id, decided_d, code, kind),
  CHECK ((status = 'rejected') = (reject_reason IS NOT NULL) OR status = 'cancelled'),
  CHECK (status <> 'filled' OR fill_d IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_arena_order_cohort_status ON arena_order (cohort_id, status);
CREATE TRIGGER arena_order_insert_guard BEFORE INSERT ON arena_order
WHEN NEW.status = 'filled'
BEGIN
  SELECT RAISE(ABORT, 'order: filled is reached by update after the fill row exists');
END;
CREATE TRIGGER arena_order_guard_update BEFORE UPDATE ON arena_order
WHEN NOT (OLD.status = 'pending' AND NEW.status <> 'pending'
  AND NEW.id IS OLD.id AND NEW.cohort_id IS OLD.cohort_id AND NEW.decided_d IS OLD.decided_d
  AND NEW.code IS OLD.code AND NEW.side IS OLD.side AND NEW.kind IS OLD.kind
  AND NEW.qty IS OLD.qty AND NEW.ref_stop_micro IS OLD.ref_stop_micro
  AND NEW.tier IS OLD.tier AND NEW.untradeable_flag IS OLD.untradeable_flag)
BEGIN
  SELECT RAISE(ABORT, 'order: only pending to one terminal status; other columns are immutable');
END;
CREATE TRIGGER arena_order_filled_needs_fill BEFORE UPDATE ON arena_order
WHEN NEW.status = 'filled' AND NOT EXISTS (SELECT 1 FROM fill WHERE order_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'order: no fill row for this order');
END;
CREATE TRIGGER arena_order_no_delete BEFORE DELETE ON arena_order
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- Fills: append-only evidence of every execution, including a copy of the day's bar.
CREATE TABLE fill (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  cohort_id TEXT NOT NULL,
  d TEXT NOT NULL,
  code TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  qty INTEGER NOT NULL CHECK (qty > 0),
  rule TEXT NOT NULL CHECK (rule IN ('open','level','gap_open','close_signal')),
  ref_price_micro INTEGER NOT NULL CHECK (ref_price_micro > 0),
  slip_micro INTEGER NOT NULL CHECK (slip_micro >= 0),
  fill_price_micro INTEGER NOT NULL CHECK (fill_price_micro > 0),
  value_micro INTEGER NOT NULL CHECK (value_micro >= 0),
  brokerage_micro INTEGER NOT NULL CHECK (brokerage_micro >= 0),
  cost_profile TEXT NOT NULL,
  bar_o_micro INTEGER NOT NULL CHECK (bar_o_micro >= 0),
  bar_h_micro INTEGER NOT NULL CHECK (bar_h_micro >= 0),
  bar_l_micro INTEGER NOT NULL CHECK (bar_l_micro >= 0),
  bar_c_micro INTEGER NOT NULL CHECK (bar_c_micro >= 0)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_fill_cohort_d ON fill (cohort_id, d);
CREATE TRIGGER fill_insert_guard BEFORE INSERT ON fill
WHEN NOT EXISTS (SELECT 1 FROM arena_order o WHERE o.id = NEW.order_id AND o.status = 'pending'
  AND o.cohort_id = NEW.cohort_id AND o.code = NEW.code AND o.side = NEW.side
  AND NEW.qty <= o.qty)
BEGIN
  SELECT RAISE(ABORT, 'fill: needs a matching pending order (same cohort, code, side; qty not above the order)');
END;
CREATE TRIGGER fill_no_update BEFORE UPDATE ON fill
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER fill_no_delete BEFORE DELETE ON fill
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Trades: an open row is inserted with the entry fill; the close is one update that sets exit_type
-- (and the exit fill, except for a legacy close of a suspended position, ARN-026). Open positions
-- are derived from open trades x fill qty (decision 11); there is no position table.
CREATE TABLE trade (
  id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL,
  code TEXT NOT NULL,
  entry_fill_id TEXT NOT NULL UNIQUE,
  exit_fill_id TEXT UNIQUE,
  exit_type TEXT CHECK (exit_type IN ('IS','CS','terminal','legacy')),
  stop_micro INTEGER NOT NULL CHECK (stop_micro > 0),
  legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0,1)),
  CHECK ((legacy = 1) = (exit_type IS 'legacy')),
  CHECK ((exit_type IS NULL AND exit_fill_id IS NULL)
      OR (exit_type = 'legacy' AND exit_fill_id IS NULL)
      OR (exit_type IN ('IS','CS','terminal') AND exit_fill_id IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_trade_cohort ON trade (cohort_id, code);
CREATE TRIGGER trade_insert_guard BEFORE INSERT ON trade
WHEN NEW.exit_type IS NOT NULL OR NOT EXISTS (SELECT 1 FROM fill f WHERE f.id = NEW.entry_fill_id
  AND f.cohort_id = NEW.cohort_id AND f.code = NEW.code AND f.side = 'buy')
BEGIN
  SELECT RAISE(ABORT, 'trade: opens with a matching buy fill and no exit');
END;
CREATE TRIGGER trade_guard_update BEFORE UPDATE ON trade
WHEN NOT (OLD.exit_type IS NULL AND NEW.exit_type IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.cohort_id IS OLD.cohort_id AND NEW.code IS OLD.code
  AND NEW.entry_fill_id IS OLD.entry_fill_id AND NEW.stop_micro IS OLD.stop_micro)
BEGIN
  SELECT RAISE(ABORT, 'trade: only the one-way close (exit_type NULL to value) may change');
END;
CREATE TRIGGER trade_exit_fill_guard BEFORE UPDATE ON trade
WHEN NEW.exit_fill_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fill f
  WHERE f.id = NEW.exit_fill_id AND f.cohort_id = NEW.cohort_id AND f.code = NEW.code
  AND f.side = 'sell')
BEGIN
  SELECT RAISE(ABORT, 'trade: exit fill must be a sell fill of the same cohort and code');
END;
CREATE TRIGGER trade_no_delete BEFORE DELETE ON trade
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- Cash ledger: double entry, append-only. Debit-positive signs: assets (cash_settled, cash_recv,
-- div_recv, sleeve_margin, position_cost = cost basis of shares held) and the expense fees_paid are
-- positive; liabilities (cash_pay, fin_accrued) and `equity` (seed capital, realised P/L, income,
-- financing) are negative. The rows of EVERY txn_id net to zero: the writer checks it, the nightly
-- invariant re-checks it (a CHECK cannot span rows). A correction is a compensating `reversal`
-- txn, never an update (decision 13).
CREATE TABLE cash_ledger (
  id INTEGER PRIMARY KEY,
  cohort_id TEXT NOT NULL,
  d TEXT NOT NULL,
  txn_id TEXT NOT NULL,
  account TEXT NOT NULL CHECK (account IN
    ('cash_settled','cash_recv','cash_pay','div_recv','sleeve_margin','fin_accrued','fees_paid',
     'position_cost','equity')),
  delta_micro INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('seed','buy','sell','brokerage','settle','div_accrue','div_pay','sleeve_open','sleeve_close',
     'sleeve_pnl','financing','ca_comp','reversal')),
  ref_type TEXT,
  ref_id TEXT,
  UNIQUE (cohort_id, d, txn_id, account)
) STRICT;
CREATE INDEX idx_cash_ledger_cohort_d ON cash_ledger (cohort_id, d);
CREATE TRIGGER cash_ledger_no_update BEFORE UPDATE ON cash_ledger
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cash_ledger_no_delete BEFORE DELETE ON cash_ledger
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Daily NAV per cohort (append-only; liquidation NAV is what terminal checks use, ARN-051).
CREATE TABLE nav_daily (
  cohort_id TEXT NOT NULL,
  d TEXT NOT NULL,
  cash_settled_micro INTEGER NOT NULL,
  recv_micro INTEGER NOT NULL,
  pay_micro INTEGER NOT NULL,
  positions_micro INTEGER NOT NULL,
  div_recv_micro INTEGER NOT NULL,
  sleeve_margin_micro INTEGER NOT NULL,
  sleeve_unreal_micro INTEGER NOT NULL,
  fin_accrued_micro INTEGER NOT NULL,
  nav_micro INTEGER NOT NULL,
  liq_nav_micro INTEGER NOT NULL,
  open_positions INTEGER NOT NULL CHECK (open_positions >= 0),
  invariants_ok INTEGER NOT NULL CHECK (invariants_ok IN (0,1)),
  PRIMARY KEY (cohort_id, d)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER nav_daily_no_update BEFORE UPDATE ON nav_daily
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER nav_daily_no_delete BEFORE DELETE ON nav_daily
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Positions as of each close (reproducibility evidence). Append-only.
CREATE TABLE nav_daily_pos (
  cohort_id TEXT NOT NULL,
  d TEXT NOT NULL,
  code TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  close_micro INTEGER NOT NULL CHECK (close_micro >= 0),
  value_micro INTEGER NOT NULL CHECK (value_micro >= 0),
  haircut INTEGER NOT NULL DEFAULT 0 CHECK (haircut IN (0,1)),
  PRIMARY KEY (cohort_id, d, code)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER nav_daily_pos_no_update BEFORE UPDATE ON nav_daily_pos
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER nav_daily_pos_no_delete BEFORE DELETE ON nav_daily_pos
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Leverage sleeve trades (ARN-040..048). Opened with the entry; closed by one update that sets
-- closed_by, price_pl_micro, financing_micro (and the exit fill) together. A shadow trade
-- (shadow = 1, logged while locked, ARN-048) is hypothetical and has no fills.
CREATE TABLE sleeve_trade (
  id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL,
  code TEXT NOT NULL,
  margin_micro INTEGER NOT NULL CHECK (margin_micro > 0),
  leverage INTEGER NOT NULL CHECK (leverage >= 1),
  notional_micro INTEGER NOT NULL CHECK (notional_micro > 0),
  entry_fill_id TEXT UNIQUE,
  exit_fill_id TEXT UNIQUE,
  price_pl_micro INTEGER,
  financing_micro INTEGER,
  closed_by TEXT CHECK (closed_by IN ('exit','closeout')),
  shadow INTEGER NOT NULL DEFAULT 0 CHECK (shadow IN (0,1)),
  CHECK (shadow = 1 OR entry_fill_id IS NOT NULL),
  CHECK ((closed_by IS NULL AND price_pl_micro IS NULL AND financing_micro IS NULL
          AND exit_fill_id IS NULL)
      OR (closed_by IS NOT NULL AND price_pl_micro IS NOT NULL AND financing_micro IS NOT NULL
          AND (shadow = 1 OR exit_fill_id IS NOT NULL)))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_sleeve_trade_cohort ON sleeve_trade (cohort_id);
CREATE TRIGGER sleeve_trade_insert_guard BEFORE INSERT ON sleeve_trade
WHEN NEW.closed_by IS NOT NULL OR (NEW.entry_fill_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM fill f WHERE f.id = NEW.entry_fill_id AND f.cohort_id = NEW.cohort_id
  AND f.code = NEW.code))
BEGIN
  SELECT RAISE(ABORT, 'sleeve_trade: opens unclosed, with an entry fill of the same cohort and code');
END;
CREATE TRIGGER sleeve_trade_guard_update BEFORE UPDATE ON sleeve_trade
WHEN NOT (OLD.closed_by IS NULL AND NEW.closed_by IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.cohort_id IS OLD.cohort_id AND NEW.code IS OLD.code
  AND NEW.margin_micro IS OLD.margin_micro AND NEW.leverage IS OLD.leverage
  AND NEW.notional_micro IS OLD.notional_micro AND NEW.entry_fill_id IS OLD.entry_fill_id
  AND NEW.shadow IS OLD.shadow)
BEGIN
  SELECT RAISE(ABORT, 'sleeve_trade: only the one-way close may change');
END;
CREATE TRIGGER sleeve_trade_exit_fill_guard BEFORE UPDATE ON sleeve_trade
WHEN NEW.exit_fill_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fill f
  WHERE f.id = NEW.exit_fill_id AND f.cohort_id = NEW.cohort_id AND f.code = NEW.code)
BEGIN
  SELECT RAISE(ABORT, 'sleeve_trade: exit fill must be of the same cohort and code');
END;
CREATE TRIGGER sleeve_trade_no_delete BEFORE DELETE ON sleeve_trade
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;

-- Sleeve lock / unlock history (REC-1..REC-4, ARN-047). Append-only.
CREATE TABLE sleeve_state (
  cohort_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  state TEXT NOT NULL CHECK (state IN ('unlocked','locked')),
  d TEXT NOT NULL,
  loss_to_recover_micro INTEGER NOT NULL DEFAULT 0 CHECK (loss_to_recover_micro >= 0),
  mode TEXT NOT NULL CHECK (mode IN ('REC-1','REC-2','REC-3','REC-4')),
  PRIMARY KEY (cohort_id, seq)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER sleeve_state_no_update BEFORE UPDATE ON sleeve_state
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER sleeve_state_no_delete BEFORE DELETE ON sleeve_state
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Cost profiles (P0-P5b): append-only and versioned; cohorts pin the version (ARN-034, ARN-102).
-- A change of a number, or the Owner's approval (verified 0 -> 1), is a NEW version row.
CREATE TABLE cost_profile (
  code TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  tiers_json TEXT NOT NULL CHECK (json_valid(tiers_json)),
  slippage_json TEXT NOT NULL CHECK (json_valid(slippage_json)),
  source TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  effective_from TEXT NOT NULL,
  PRIMARY KEY (code, version)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cost_profile_no_update BEFORE UPDATE ON cost_profile
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER cost_profile_no_delete BEFORE DELETE ON cost_profile
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Owner pause and kill-switch STATE as an append-only event log; the current state of a scope is
-- its row with the highest id (ARN-093 evaluation is M4). Not the same thing as controls C1-C3.
CREATE TABLE arena_control (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('market','family','execution')),
  scope_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('enabled','paused','killed')),
  set_at TEXT NOT NULL,
  set_by TEXT NOT NULL,
  reason TEXT
) STRICT;
CREATE INDEX idx_arena_control_scope ON arena_control (scope, scope_key, id);
CREATE TRIGGER arena_control_no_update BEFORE UPDATE ON arena_control
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER arena_control_no_delete BEFORE DELETE ON arena_control
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- +down
-- Dropping a table drops its triggers and indexes with it (DROP does not fire delete triggers).
-- No existing guard is touched by this migration, so there is nothing to restore. Rolling back
-- discards arena data; this is meant for development only.
DROP TABLE arena_control;
DROP TABLE cost_profile;
DROP TABLE sleeve_state;
DROP TABLE sleeve_trade;
DROP TABLE nav_daily_pos;
DROP TABLE nav_daily;
DROP TABLE cash_ledger;
DROP TABLE trade;
DROP TABLE fill;
DROP TABLE arena_order;
DROP TABLE cohort_event;
DROP TABLE cohort;
DROP TABLE execution;
