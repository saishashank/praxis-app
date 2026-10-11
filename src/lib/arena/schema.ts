// Arena tables: table and column names plus row types for main migration 0007_arena.sql
// (docs/M3_design.md section 3, D-069). Constants and types only, no business logic.
//
// Money columns are INTEGER micro-AUD and are named `*_micro`; they are typed `bigint` here because
// the arena reads them with the libSQL client in bigint mode (decision 18). Share quantities,
// counts and sequence numbers are `number`. Instants are ISO-8601 UTC text with milliseconds and Z
// (D-031); `d` is the Sydney trading date YYYY-MM-DD; booleans are 0 | 1.
//
// Positions are NOT a table (decision 11): they are derived from fills, trades and the
// end-of-day snapshot in nav_daily_pos. The design's `order` table is `arena_order` (ORDER is an
// SQL keyword).

export type Flag01 = 0 | 1;
/** Integer micro-AUD (1 A$ = 1,000,000 micro). */
export type Micro = bigint;

export const ARENA_TABLES = {
  execution: "execution",
  cohort: "cohort",
  cohortEvent: "cohort_event",
  order: "arena_order",
  fill: "fill",
  trade: "trade",
  cashLedger: "cash_ledger",
  navDaily: "nav_daily",
  navDailyPos: "nav_daily_pos",
  sleeveTrade: "sleeve_trade",
  sleeveState: "sleeve_state",
  costProfile: "cost_profile",
  arenaControl: "arena_control",
} as const;

export type ArenaTableName = (typeof ARENA_TABLES)[keyof typeof ARENA_TABLES];

/** Every arena table is retained forever (DAT-142); none is ever pruned. */
export const ARENA_FOREVER_TABLES: readonly ArenaTableName[] = Object.values(ARENA_TABLES);

/** Ledger-grade tables that refuse UPDATE and DELETE outright. */
export const ARENA_APPEND_ONLY_TABLES = [
  "cohort_event",
  "fill",
  "cash_ledger",
  "nav_daily",
  "nav_daily_pos",
  "sleeve_state",
  "cost_profile",
  "arena_control",
] as const satisfies readonly ArenaTableName[];

/** State tables that allow only the documented one-way changes (DELETE is refused). */
export const ARENA_ONE_WAY_TABLES = [
  "execution",
  "cohort",
  "arena_order",
  "trade",
  "sleeve_trade",
] as const satisfies readonly ArenaTableName[];

/** Column names per table, in table order. */
export const ARENA_COLUMNS = {
  execution: [
    "id",
    "market",
    "kind",
    "family",
    "variant",
    "twin_group",
    "rule_version",
    "cost_profile",
    "status",
  ],
  cohort: [
    "id",
    "execution_id",
    "control_idx",
    "start_d",
    "seed_micro",
    "rule_version",
    "params_json",
    "cost_profile_version",
    "sleeve_json",
    "data_snapshot_id",
    "rng_seed",
    "twin_group",
    "restart_of",
    "live",
    "terminal_kind",
    "terminal_d",
    "ttd_sessions",
    "ttd_days",
    "outcome_micro",
  ],
  cohort_event: ["cohort_id", "seq", "kind", "d", "detail_json"],
  arena_order: [
    "id",
    "cohort_id",
    "decided_d",
    "fill_d",
    "code",
    "side",
    "kind",
    "qty",
    "ref_stop_micro",
    "status",
    "reject_reason",
    "tier",
    "untradeable_flag",
  ],
  fill: [
    "id",
    "order_id",
    "cohort_id",
    "d",
    "code",
    "side",
    "qty",
    "rule",
    "ref_price_micro",
    "slip_micro",
    "fill_price_micro",
    "value_micro",
    "brokerage_micro",
    "cost_profile",
    "bar_o_micro",
    "bar_h_micro",
    "bar_l_micro",
    "bar_c_micro",
  ],
  trade: [
    "id",
    "cohort_id",
    "code",
    "entry_fill_id",
    "exit_fill_id",
    "exit_type",
    "stop_micro",
    "legacy",
  ],
  cash_ledger: [
    "id",
    "cohort_id",
    "d",
    "txn_id",
    "account",
    "delta_micro",
    "kind",
    "ref_type",
    "ref_id",
  ],
  nav_daily: [
    "cohort_id",
    "d",
    "cash_settled_micro",
    "recv_micro",
    "pay_micro",
    "positions_micro",
    "div_recv_micro",
    "sleeve_margin_micro",
    "sleeve_unreal_micro",
    "fin_accrued_micro",
    "nav_micro",
    "liq_nav_micro",
    "open_positions",
    "invariants_ok",
  ],
  nav_daily_pos: ["cohort_id", "d", "code", "qty", "close_micro", "value_micro", "haircut"],
  sleeve_trade: [
    "id",
    "cohort_id",
    "code",
    "margin_micro",
    "leverage",
    "notional_micro",
    "entry_fill_id",
    "exit_fill_id",
    "price_pl_micro",
    "financing_micro",
    "closed_by",
    "shadow",
    "open_d",
    "entry_price_micro",
    "close_d",
    "exit_price_micro",
    "costs_micro",
  ],
  sleeve_state: ["cohort_id", "seq", "state", "d", "loss_to_recover_micro", "mode"],
  cost_profile: [
    "code",
    "version",
    "tiers_json",
    "slippage_json",
    "source",
    "verified",
    "effective_from",
  ],
  arena_control: ["id", "scope", "scope_key", "state", "set_at", "set_by", "reason"],
} as const satisfies Record<ArenaTableName, readonly string[]>;

/**
 * Columns that hold money (INTEGER micro-AUD, typed bigint). Derived from the column lists: every
 * `*_micro` column, and nothing else.
 */
type MicroColumns<T extends readonly string[]> = Extract<T[number], `${string}_micro`>;
export const ARENA_MONEY_COLUMNS: {
  [K in ArenaTableName]: readonly MicroColumns<(typeof ARENA_COLUMNS)[K]>[];
} = Object.fromEntries(
  Object.entries(ARENA_COLUMNS).map(([t, cols]) => [
    t,
    (cols as readonly string[]).filter((c) => c.endsWith("_micro")),
  ]),
) as never;

// ---- value sets (mirror the CHECK constraints of 0007) ----
export const EXECUTION_KINDS = ["E", "C1", "C2", "C3"] as const;
export type ExecutionKind = (typeof EXECUTION_KINDS)[number];
export type Variant = "U" | "L";

export const TERMINAL_KINDS = ["target", "bust", "stalled", "timeout"] as const;
export type TerminalKind = (typeof TERMINAL_KINDS)[number];

export const COHORT_EVENT_KINDS = [
  "start",
  "terminal",
  "restart",
  "shadow_continue",
  "lock",
  "unlock",
  "ca_adjust",
  "data_event",
] as const;
export type CohortEventKind = (typeof COHORT_EVENT_KINDS)[number];

export type Side = "buy" | "sell";
export const ORDER_KINDS = ["entry", "exit_cs", "exit_is", "sleeve_open", "sleeve_close"] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];
export const ORDER_STATUSES = ["pending", "filled", "rejected", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
/** Reasons the design names; the column accepts any non-empty text ("..." in the design). */
export const KNOWN_REJECT_REASONS = [
  "parcel",
  "whole_share",
  "participation",
  "cash",
  "gate",
  "halted",
] as const;
export type Tier = "U1" | "U2" | "U3";

export const FILL_RULES = ["open", "level", "gap_open", "close_signal"] as const;
export type FillRule = (typeof FILL_RULES)[number];

export const EXIT_TYPES = ["IS", "CS", "terminal", "legacy"] as const;
export type ExitType = (typeof EXIT_TYPES)[number];

export const LEDGER_ACCOUNTS = [
  "cash_settled",
  "cash_recv",
  "cash_pay",
  "div_recv",
  "sleeve_margin",
  "fin_accrued",
  "fees_paid",
  "position_cost",
  "equity",
] as const;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

export const LEDGER_KINDS = [
  "seed",
  "buy",
  "sell",
  "brokerage",
  "settle",
  "div_accrue",
  "div_pay",
  "sleeve_open",
  "sleeve_close",
  "sleeve_pnl",
  "financing",
  "ca_comp",
  "ca_dispose",
  "reversal",
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const SLEEVE_CLOSED_BY = ["exit", "closeout"] as const;
export type SleeveClosedBy = (typeof SLEEVE_CLOSED_BY)[number];
export type SleeveLockState = "unlocked" | "locked";
export const RECOVERY_MODES = ["REC-1", "REC-2", "REC-3", "REC-4"] as const;
export type RecoveryMode = (typeof RECOVERY_MODES)[number];

export const CONTROL_SCOPES = ["market", "family", "execution"] as const;
export type ControlScope = (typeof CONTROL_SCOPES)[number];
export const CONTROL_STATES = ["enabled", "paused", "killed"] as const;
export type ControlState = (typeof CONTROL_STATES)[number];

// ---- row types (money fields are bigint) ----
export type ExecutionRow = {
  id: string;
  market: string;
  kind: ExecutionKind;
  family: string | null;
  variant: Variant | null;
  twin_group: string | null;
  rule_version: string;
  cost_profile: string;
  status: string;
};

export type CohortRow = {
  id: string;
  execution_id: string;
  control_idx: number | null;
  start_d: string;
  seed_micro: Micro;
  rule_version: string;
  params_json: string;
  cost_profile_version: number;
  sleeve_json: string | null;
  data_snapshot_id: string | null;
  rng_seed: bigint;
  twin_group: string | null;
  restart_of: string | null;
  live: Flag01;
  terminal_kind: TerminalKind | null;
  terminal_d: string | null;
  ttd_sessions: number | null;
  ttd_days: number | null;
  outcome_micro: Micro | null;
};

export type CohortEventRow = {
  cohort_id: string;
  seq: number;
  kind: CohortEventKind;
  d: string;
  detail_json: string;
};

export type OrderRow = {
  id: string;
  cohort_id: string;
  decided_d: string;
  fill_d: string | null;
  code: string;
  side: Side;
  kind: OrderKind;
  qty: number;
  ref_stop_micro: Micro | null;
  status: OrderStatus;
  reject_reason: string | null;
  tier: Tier | null;
  untradeable_flag: Flag01;
};

export type FillRow = {
  id: string;
  order_id: string;
  cohort_id: string;
  d: string;
  code: string;
  side: Side;
  qty: number;
  rule: FillRule;
  ref_price_micro: Micro;
  slip_micro: Micro;
  fill_price_micro: Micro;
  value_micro: Micro;
  brokerage_micro: Micro;
  cost_profile: string;
  bar_o_micro: Micro;
  bar_h_micro: Micro;
  bar_l_micro: Micro;
  bar_c_micro: Micro;
};

export type TradeRow = {
  id: string;
  cohort_id: string;
  code: string;
  entry_fill_id: string;
  exit_fill_id: string | null;
  exit_type: ExitType | null;
  stop_micro: Micro;
  legacy: Flag01;
};

export type CashLedgerRow = {
  id: number;
  cohort_id: string;
  d: string;
  txn_id: string;
  account: LedgerAccount;
  delta_micro: Micro;
  kind: LedgerKind;
  ref_type: string | null;
  ref_id: string | null;
};

export type NavDailyRow = {
  cohort_id: string;
  d: string;
  cash_settled_micro: Micro;
  recv_micro: Micro;
  pay_micro: Micro;
  positions_micro: Micro;
  div_recv_micro: Micro;
  sleeve_margin_micro: Micro;
  sleeve_unreal_micro: Micro;
  fin_accrued_micro: Micro;
  nav_micro: Micro;
  liq_nav_micro: Micro;
  open_positions: number;
  invariants_ok: Flag01;
};

export type NavDailyPosRow = {
  cohort_id: string;
  d: string;
  code: string;
  qty: number;
  close_micro: Micro;
  value_micro: Micro;
  haircut: Flag01;
};

export type SleeveTradeRow = {
  id: string;
  cohort_id: string;
  code: string;
  margin_micro: Micro;
  leverage: number;
  notional_micro: Micro;
  entry_fill_id: string | null;
  exit_fill_id: string | null;
  price_pl_micro: Micro | null;
  financing_micro: Micro | null;
  closed_by: SleeveClosedBy | null;
  shadow: Flag01;
  open_d: string;
  entry_price_micro: Micro;
  close_d: string | null;
  exit_price_micro: Micro | null;
  costs_micro: Micro | null;
};

export type SleeveStateRow = {
  cohort_id: string;
  seq: number;
  state: SleeveLockState;
  d: string;
  loss_to_recover_micro: Micro;
  mode: RecoveryMode;
};

export type CostProfileRow = {
  code: string;
  version: number;
  tiers_json: string;
  slippage_json: string;
  source: string;
  verified: Flag01;
  effective_from: string;
};

export type ArenaControlRow = {
  id: number;
  scope: ControlScope;
  scope_key: string;
  state: ControlState;
  set_at: string;
  set_by: string;
  reason: string | null;
};
