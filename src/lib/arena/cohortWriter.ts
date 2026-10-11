// DB side of executions, cohorts, terminal states, restarts and the legacy ledger (M3 design 3,
// 4.2 step 6, 4.6; migration 0007; cohort.ts and terminal.ts hold the logic). Style of
// ledgerWriter.ts / sleeveWriter.ts: every public call is ONE write transaction, idempotent (the
// same inputs a second time write nothing and report `written: false`), and a stored row that
// differs from what the inputs would write raises a typed error and writes nothing (ARN-102).
// Money goes in as bigint; reads accept bigint (intMode "bigint") or safe-integer numbers.
//
// The terminal step for a close D (runTerminalChecks):
//   1. judge every cohort on LIQUIDATION NAV (read-only),
//   2. per restart group with a LIVE cohort that resolved: in ONE transaction record every
//      verdict of the group (terminal state once, 'terminal' event, liquidation orders for D+1's
//      open), flip the group's unfinished live cohorts to shadow, and start every successor
//      cohort on the same session (the open after the liquidation) - the group restarts together,
//   3. a shadow cohort that resolved (or a group without a live trigger) records only its own
//      terminal state and liquidation orders.
// Liquidation orders are plain `exit_cs` orders (normal fill rules); the orchestrator fills them
// at D+1's open, closes an open sleeve with a `cs` exit and sets the trades' exit_type to
// 'terminal' (fillWriter). Positions that cannot be sold because the code is halted then move to the
// legacy ledger (writeLegacyMoves, ARN-026).
import type { Client, Row, Transaction } from "@libsql/client";
import type { CalendarRow } from "@/lib/data/calendar";
import { assertInt64, type Micro } from "@/lib/money/micro";
import {
  canonicalJson,
  parseCohortParams,
  planGroupRestart,
  type CohortParams,
  type CohortStart,
  type GroupRestartPlan,
  type SlotCohort,
} from "./cohort";
import { loadQtyAdjustments } from "./corpActionWriter";
import {
  loadNavDays,
  toBig,
  loadLedgerFills,
  writeLedgerTxnIn,
  LedgerWriteError,
} from "./ledgerWriter";
import { derivePositions } from "./nav";
import type { CohortEventKind, ExecutionRow, TerminalKind } from "./schema";
import { openRealTradeAt } from "./sleeve";
import { loadSleeveTrades } from "./sleeveWriter";
import {
  evaluateTerminal,
  isParcelOnlyReasonText,
  liquidationOrderId,
  planLiquidation,
  type CloseDay,
  type LegacyItem,
  type LiquidationPlan,
  type TerminalVerdict,
} from "./terminal";

export type CohortWriteErrorCode =
  | "execution_conflict"
  | "execution_missing"
  | "cohort_conflict"
  | "cohort_missing"
  | "terminal_conflict"
  | "order_conflict"
  | "restart_conflict"
  | "not_terminal"
  | "no_nav"
  | "legacy_conflict"
  | "event_conflict"
  | "trigger_refused"
  | "constraint_refused";

export class CohortWriteError extends Error {
  readonly code: CohortWriteErrorCode;
  constructor(code: CohortWriteErrorCode, message: string) {
    super(message);
    this.name = "CohortWriteError";
    this.code = code;
  }
}

const TRIGGER_PREFIXES = [
  "execution:",
  "cohort:",
  "order:",
  "trade:",
  "forever table",
  "append-only",
];

function refusal(error: unknown): CohortWriteError | null {
  const message = error instanceof Error ? error.message : String(error);
  if (TRIGGER_PREFIXES.some((p) => message.includes(p))) {
    return new CohortWriteError("trigger_refused", message);
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
    return new CohortWriteError("constraint_refused", message);
  }
  return null;
}

const text = (value: unknown): string => String(value);
const textOrNull = (value: unknown): string | null => (value === null ? null : String(value));
const bigOrNull = (value: unknown): bigint | null => (value === null ? null : toBig(value));

async function inTransaction<T>(db: Client, body: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await db.transaction("write");
  try {
    const result = await body(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    if (error instanceof CohortWriteError || error instanceof LedgerWriteError) throw error;
    throw refusal(error) ?? error;
  } finally {
    tx.close();
  }
}

type Reader = Pick<Client, "execute">;

// ---- executions ------------------------------------------------------------------------------------------

/**
 * Insert the execution registry. A stored row equal in every immutable column (status and
 * rule_version may change later, so they are not compared) is a no-op; a different one raises
 * `execution_conflict`. Returns how many rows were new.
 */
export async function seedExecutions(
  db: Client,
  rows: readonly ExecutionRow[],
): Promise<{ readonly written: number }> {
  return inTransaction(db, async (tx) => {
    let written = 0;
    for (const e of rows) {
      const existing = await tx.execute({
        sql: `SELECT market, kind, family, variant, twin_group, cost_profile FROM execution WHERE id = ?`,
        args: [e.id],
      });
      if (existing.rows.length > 0) {
        const r = existing.rows[0];
        const same =
          text(r.market) === e.market &&
          text(r.kind) === e.kind &&
          textOrNull(r.family) === e.family &&
          textOrNull(r.variant) === e.variant &&
          textOrNull(r.twin_group) === e.twin_group &&
          text(r.cost_profile) === e.cost_profile;
        if (!same)
          throw new CohortWriteError("execution_conflict", `${e.id} is stored differently`);
        continue;
      }
      await tx.execute({
        sql: `INSERT INTO execution (id, market, kind, family, variant, twin_group, rule_version,
                cost_profile, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        args: [
          e.id,
          e.market,
          e.kind,
          e.family,
          e.variant,
          e.twin_group,
          e.rule_version,
          e.cost_profile,
          e.status,
        ],
      });
      written += 1;
    }
    return { written };
  });
}

export async function loadExecutions(db: Reader): Promise<ExecutionRow[]> {
  const rs = await db.execute(
    `SELECT id, market, kind, family, variant, twin_group, rule_version, cost_profile, status
     FROM execution ORDER BY id`,
  );
  return rs.rows.map((r) => ({
    id: text(r.id),
    market: text(r.market),
    kind: text(r.kind) as ExecutionRow["kind"],
    family: textOrNull(r.family),
    variant: textOrNull(r.variant) as ExecutionRow["variant"],
    twin_group: textOrNull(r.twin_group),
    rule_version: text(r.rule_version),
    cost_profile: text(r.cost_profile),
    status: text(r.status),
  }));
}

// ---- cohorts: reading --------------------------------------------------------------------------------------

export type StoredCohort = {
  readonly id: string;
  readonly executionId: string;
  readonly controlIdx: number | null;
  readonly startD: string;
  readonly seedMicro: Micro;
  readonly paramsJson: string;
  readonly rngSeed: bigint;
  readonly twinGroup: string | null;
  readonly restartOf: string | null;
  readonly live: boolean;
  readonly terminalKind: TerminalKind | null;
  readonly terminalD: string | null;
  readonly ttdSessions: bigint | null;
  readonly ttdDays: bigint | null;
  readonly outcomeMicro: Micro | null;
};

const COHORT_COLUMNS = `id, execution_id, control_idx, start_d, seed_micro, params_json, rng_seed,
  twin_group, restart_of, live, terminal_kind, terminal_d, ttd_sessions, ttd_days, outcome_micro`;

function cohortFrom(r: Row): StoredCohort {
  const idx = bigOrNull(r.control_idx);
  return {
    id: text(r.id),
    executionId: text(r.execution_id),
    controlIdx: idx === null ? null : Number.parseInt(idx.toString(), 10),
    startD: text(r.start_d),
    seedMicro: toBig(r.seed_micro),
    paramsJson: text(r.params_json),
    rngSeed: toBig(r.rng_seed),
    twinGroup: textOrNull(r.twin_group),
    restartOf: textOrNull(r.restart_of),
    live: toBig(r.live) === 1n,
    terminalKind: textOrNull(r.terminal_kind) as TerminalKind | null,
    terminalD: textOrNull(r.terminal_d),
    ttdSessions: bigOrNull(r.ttd_sessions),
    ttdDays: bigOrNull(r.ttd_days),
    outcomeMicro: bigOrNull(r.outcome_micro),
  };
}

export async function loadCohort(db: Reader, id: string): Promise<StoredCohort | null> {
  const rs = await db.execute({
    sql: `SELECT ${COHORT_COLUMNS} FROM cohort WHERE id = ?`,
    args: [id],
  });
  return rs.rows.length === 0 ? null : cohortFrom(rs.rows[0]);
}

/** All cohorts of an execution, oldest start first (effective-N reporting reads these fields). */
export async function loadCohortsOfExecution(
  db: Reader,
  executionId: string,
): Promise<StoredCohort[]> {
  const rs = await db.execute({
    sql: `SELECT ${COHORT_COLUMNS} FROM cohort WHERE execution_id = ? ORDER BY start_d, id`,
    args: [executionId],
  });
  return rs.rows.map(cohortFrom);
}

/** The live cohorts of a restart group (one per slot), by execution id then control index. */
export async function loadLiveCohorts(db: Reader, group: string): Promise<StoredCohort[]> {
  const rs = await db.execute({
    sql: `SELECT ${COHORT_COLUMNS} FROM cohort WHERE twin_group = ? AND live = 1
          ORDER BY execution_id, COALESCE(control_idx, 0), id`,
    args: [group],
  });
  return rs.rows.map(cohortFrom);
}

/**
 * Cohorts that have started by `d` and have no terminal state yet (live and shadow alike): the ones
 * the daily batch judges at each close. Wind-down of a resolved cohort (liquidation fills, T+2
 * settlement) is driven by its pending orders and open items instead.
 */
export async function loadUnresolvedCohorts(db: Reader, d: string): Promise<StoredCohort[]> {
  const rs = await db.execute({
    sql: `SELECT ${COHORT_COLUMNS} FROM cohort WHERE terminal_kind IS NULL AND start_d <= ?
          ORDER BY id`,
    args: [d],
  });
  return rs.rows.map(cohortFrom);
}

// ---- cohorts: events and starts ---------------------------------------------------------------------------

async function nextSeq(tx: Reader, cohortId: string): Promise<bigint> {
  const rs = await tx.execute({
    sql: "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM cohort_event WHERE cohort_id = ?",
    args: [cohortId],
  });
  return toBig(rs.rows[0].n);
}

/** Append an event unless an event of this kind with the same detail exists; differing detail raises. */
async function appendEventIn(
  tx: Reader,
  cohortId: string,
  kind: CohortEventKind,
  d: string,
  detail: Record<string, unknown>,
  identity: string,
): Promise<boolean> {
  const json = canonicalJson(detail);
  const existing = await tx.execute({
    sql: `SELECT detail_json FROM cohort_event WHERE cohort_id = ? AND kind = ?
          AND json_extract(detail_json, '$.id') = ?`,
    args: [cohortId, kind, identity],
  });
  if (existing.rows.length > 0) {
    if (text(existing.rows[0].detail_json) !== json) {
      throw new CohortWriteError("event_conflict", `${cohortId} ${kind} ${identity} differs`);
    }
    return false;
  }
  await tx.execute({
    sql: `INSERT INTO cohort_event (cohort_id, seq, kind, d, detail_json) VALUES (?, ?, ?, ?, ?)`,
    args: [cohortId, await nextSeq(tx, cohortId), kind, d, json],
  });
  return true;
}

function sameStart(r: Row, s: CohortStart): boolean {
  return (
    text(r.execution_id) === s.executionId &&
    bigOrNull(r.control_idx) === (s.controlIdx === null ? null : BigInt(s.controlIdx)) &&
    text(r.start_d) === s.startD &&
    toBig(r.seed_micro) === s.seedMicro &&
    text(r.rule_version) === s.ruleVersion &&
    text(r.params_json) === s.paramsJson &&
    toBig(r.cost_profile_version) === BigInt(s.costProfileVersion) &&
    textOrNull(r.sleeve_json) === s.sleeveJson &&
    textOrNull(r.data_snapshot_id) === s.dataSnapshotId &&
    toBig(r.rng_seed) === s.rngSeed &&
    textOrNull(r.twin_group) === s.twinGroup &&
    textOrNull(r.restart_of) === s.restartOf
  );
}

async function startCohortIn(tx: Transaction, s: CohortStart): Promise<boolean> {
  const existing = await tx.execute({
    sql: `SELECT execution_id, control_idx, start_d, seed_micro, rule_version, params_json,
            cost_profile_version, sleeve_json, data_snapshot_id, rng_seed, twin_group, restart_of
          FROM cohort WHERE id = ?`,
    args: [s.id],
  });
  if (existing.rows.length > 0) {
    if (!sameStart(existing.rows[0], s)) {
      throw new CohortWriteError("cohort_conflict", `cohort ${s.id} is stored differently`);
    }
    return false;
  }
  const exec = await tx.execute({
    sql: "SELECT 1 FROM execution WHERE id = ?",
    args: [s.executionId],
  });
  if (exec.rows.length === 0) {
    throw new CohortWriteError("execution_missing", `execution ${s.executionId} is not seeded`);
  }
  await tx.execute({
    sql: `INSERT INTO cohort (id, execution_id, control_idx, start_d, seed_micro, rule_version,
            params_json, cost_profile_version, sleeve_json, data_snapshot_id, rng_seed, twin_group,
            restart_of, live)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    args: [
      s.id,
      s.executionId,
      s.controlIdx,
      s.startD,
      assertInt64(s.seedMicro),
      s.ruleVersion,
      s.paramsJson,
      s.costProfileVersion,
      s.sleeveJson,
      s.dataSnapshotId,
      assertInt64(s.rngSeed),
      s.twinGroup,
      s.restartOf,
    ],
  });
  await writeLedgerTxnIn(tx, s.id, s.seedTxn);
  const params = JSON.parse(s.paramsJson) as { hash: string };
  await appendEventIn(
    tx,
    s.id,
    "start",
    s.startD,
    { id: "start", params_hash: params.hash, restart_of: s.restartOf, start_d: s.startD },
    "start",
  );
  return true;
}

/**
 * Start cohorts together (one transaction): the cohort row (live), the seed cash txn (ARN-001) and
 * the 'start' event. Existing identical cohorts are skipped; a different stored cohort raises.
 */
export async function startCohorts(
  db: Client,
  starts: readonly CohortStart[],
): Promise<{ readonly written: number }> {
  return inTransaction(db, async (tx) => {
    let written = 0;
    for (const s of starts) if (await startCohortIn(tx, s)) written += 1;
    return { written };
  });
}

// ---- close history for the terminal tests --------------------------------------------------------------------

/**
 * The closes of a cohort for the terminal tests: one `CloseDay` per stored nav_daily row up to
 * `upToD`. Family signals are the cohort's entry orders decided on that day; the day counts as
 * known only up to `signalsThroughD` (the last session whose signals batch 2b has already written -
 * the PREVIOUS session when the books of `upToD` are being closed, ARN-060); later days carry
 * `signals: null`.
 */
export async function loadCloseHistory(
  db: Client,
  cohortId: string,
  upToD: string,
  signalsThroughD: string,
): Promise<CloseDay[]> {
  const days = (await loadNavDays(db, cohortId)).filter((day) => day.row.d <= upToD);
  const orders = await db.execute({
    sql: `SELECT decided_d, status, reject_reason FROM arena_order
          WHERE cohort_id = ? AND kind = 'entry' AND decided_d <= ? ORDER BY decided_d, id`,
    args: [cohortId, upToD],
  });
  const perDay = new Map<string, { signals: number; parcelOnly: number }>();
  for (const o of orders.rows) {
    const d = text(o.decided_d);
    const acc = perDay.get(d) ?? { signals: 0, parcelOnly: 0 };
    acc.signals += 1;
    if (text(o.status) === "rejected" && isParcelOnlyReasonText(textOrNull(o.reject_reason))) {
      acc.parcelOnly += 1;
    }
    perDay.set(d, acc);
  }
  return days.map(({ row }) => {
    const known = row.d <= signalsThroughD;
    const acc = perDay.get(row.d);
    return {
      d: row.d,
      navMicro: row.navMicro,
      liqNavMicro: row.liqNavMicro,
      openPositions: row.openPositions,
      signals: known ? (acc?.signals ?? 0) : null,
      parcelOnlyRejections: known ? (acc?.parcelOnly ?? 0) : 0,
    };
  });
}

// ---- terminal: read-only evaluation ------------------------------------------------------------------------------

export type TerminalEvaluation = {
  readonly cohort: StoredCohort;
  readonly params: CohortParams;
  readonly verdict: TerminalVerdict;
  readonly liquidation: LiquidationPlan;
};

export type EvaluateInput = {
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  /** Last session whose signals are already written (see loadCloseHistory). */
  readonly signalsThroughD: string;
};

/** Judge one cohort at the close of `d` (read-only). Null when unresolved or already resolved. */
export async function evaluateCohort(
  db: Client,
  cohortId: string,
  input: EvaluateInput,
): Promise<TerminalEvaluation | null> {
  const cohort = await loadCohort(db, cohortId);
  if (cohort === null) throw new CohortWriteError("cohort_missing", `no cohort ${cohortId}`);
  if (cohort.terminalKind !== null || cohort.startD > input.d) return null;
  const history = await loadCloseHistory(db, cohortId, input.d, input.signalsThroughD);
  if (history.length === 0 || history[history.length - 1].d !== input.d) {
    throw new CohortWriteError("no_nav", `${cohortId} has no NAV for ${input.d}`);
  }
  const params = parseCohortParams(cohort.paramsJson);
  const verdict = evaluateTerminal({
    params: params.terminal,
    startD: cohort.startD,
    calendar: input.calendar,
    history,
  });
  if (verdict === null) return null;
  const [fills, adjustments, trades, sleeves] = await Promise.all([
    loadLedgerFills(db, cohortId),
    loadQtyAdjustments(db, cohortId),
    db.execute({
      sql: "SELECT id, code FROM trade WHERE cohort_id = ? AND exit_type IS NULL ORDER BY code, id",
      args: [cohortId],
    }),
    loadSleeveTrades(db, cohortId),
  ]);
  const positions = derivePositions(fills, adjustments, input.d).positions;
  const sleeve = openRealTradeAt(sleeves, input.d);
  const liquidation = planLiquidation({
    cohortId,
    d: input.d,
    calendar: input.calendar,
    positions,
    openTrades: trades.rows.map((t) => ({ tradeId: text(t.id), code: text(t.code) })),
    openSleeveTradeId: sleeve === null ? null : sleeve.id,
  });
  return { cohort, params, verdict, liquidation };
}

// ---- terminal: writing ----------------------------------------------------------------------------------------------

function verdictDetail(v: TerminalVerdict, plan: LiquidationPlan): Record<string, unknown> {
  return {
    id: "terminal",
    kind: v.kind,
    rule: v.rule,
    d: v.d,
    ttd_sessions: v.ttdSessions.toString(),
    ttd_days: v.ttdDays.toString(),
    liq_nav_micro: v.outcomeMicro.toString(),
    nav_micro: v.navMicro.toString(),
    target_micro: v.targetMicro.toString(),
    bust_micro: v.bustMicro.toString(),
    liquidation_d: plan.fillD,
    sleeve_trade_id: plan.sleeveTradeId,
    liquidation_orders: plan.orders.map((o) => o.orderId),
  };
}

async function writeLiquidationOrdersIn(tx: Transaction, plan: LiquidationPlan): Promise<number> {
  let written = 0;
  // A resolved cohort takes no further entries: pending entries (none expected) are cancelled.
  await tx.execute({
    sql: `UPDATE arena_order SET status = 'cancelled' WHERE cohort_id = ? AND kind = 'entry'
          AND status = 'pending'`,
    args: [plan.cohortId],
  });
  for (const o of plan.orders) {
    const existing = await tx.execute({
      sql: "SELECT cohort_id, decided_d, code, side, kind, qty FROM arena_order WHERE id = ?",
      args: [o.orderId],
    });
    if (existing.rows.length > 0) {
      const r = existing.rows[0];
      const same =
        text(r.cohort_id) === o.cohortId &&
        text(r.decided_d) === o.decidedD &&
        text(r.code) === o.code &&
        text(r.side) === "sell" &&
        text(r.kind) === "exit_cs" &&
        toBig(r.qty) === o.qty;
      if (!same) throw new CohortWriteError("order_conflict", `order ${o.orderId} differs`);
      continue;
    }
    await tx.execute({
      sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty)
            VALUES (?, ?, ?, ?, 'sell', 'exit_cs', ?)`,
      args: [o.orderId, o.cohortId, o.decidedD, o.code, o.qty],
    });
    written += 1;
  }
  return written;
}

async function writeTerminalIn(tx: Transaction, e: TerminalEvaluation): Promise<boolean> {
  const v = e.verdict;
  const stored = await tx.execute({
    sql: `SELECT terminal_kind, terminal_d, ttd_sessions, ttd_days, outcome_micro FROM cohort WHERE id = ?`,
    args: [e.cohort.id],
  });
  if (stored.rows.length === 0) {
    throw new CohortWriteError("cohort_missing", `no cohort ${e.cohort.id}`);
  }
  const s = stored.rows[0];
  let written = false;
  if (s.terminal_kind !== null) {
    const same =
      text(s.terminal_kind) === v.kind &&
      text(s.terminal_d) === v.d &&
      toBig(s.ttd_sessions) === v.ttdSessions &&
      toBig(s.ttd_days) === v.ttdDays &&
      toBig(s.outcome_micro) === v.outcomeMicro;
    if (!same) {
      throw new CohortWriteError(
        "terminal_conflict",
        `${e.cohort.id} already has a different terminal state (${text(s.terminal_kind)})`,
      );
    }
  } else {
    await tx.execute({
      sql: `UPDATE cohort SET terminal_kind = ?, terminal_d = ?, ttd_sessions = ?, ttd_days = ?,
              outcome_micro = ? WHERE id = ? AND terminal_kind IS NULL`,
      args: [v.kind, v.d, v.ttdSessions, v.ttdDays, assertInt64(v.outcomeMicro), e.cohort.id],
    });
    written = true;
  }
  if (
    await appendEventIn(
      tx,
      e.cohort.id,
      "terminal",
      v.d,
      verdictDetail(v, e.liquidation),
      "terminal",
    )
  ) {
    written = true;
  }
  if ((await writeLiquidationOrdersIn(tx, e.liquidation)) > 0) written = true;
  return written;
}

async function restartGroupIn(tx: Transaction, plan: GroupRestartPlan): Promise<boolean> {
  let written = false;
  for (const s of plan.starts) if (await startCohortIn(tx, s)) written = true;
  const flip = async (cohortId: string): Promise<void> => {
    const r = await tx.execute({
      sql: "UPDATE cohort SET live = 0 WHERE id = ? AND live = 1",
      args: [cohortId],
    });
    if (r.rowsAffected > 0) written = true;
  };
  for (const s of plan.shadow) {
    await flip(s.cohortId);
    const added = await appendEventIn(
      tx,
      s.cohortId,
      "shadow_continue",
      plan.closeD,
      {
        id: s.newCohortId,
        new_cohort_id: s.newCohortId,
        trigger: plan.triggerCohortId,
        close_d: plan.closeD,
        restart_d: plan.restartD,
        live_liquidation_nav_micro:
          s.liveLiquidationNavMicro === null ? null : s.liveLiquidationNavMicro.toString(),
      },
      s.newCohortId,
    );
    if (added) written = true;
  }
  for (const s of plan.ended) {
    await flip(s.cohortId);
    const added = await appendEventIn(
      tx,
      s.cohortId,
      "restart",
      plan.closeD,
      {
        id: s.newCohortId,
        new_cohort_id: s.newCohortId,
        trigger: plan.triggerCohortId,
        close_d: plan.closeD,
        restart_d: plan.restartD,
      },
      s.newCohortId,
    );
    if (added) written = true;
  }
  return written;
}

export type RestartConfig = {
  readonly executionFor: (executionId: string) => ExecutionRow;
  readonly paramsFor: (execution: ExecutionRow) => CohortParams;
  readonly masterSeed: bigint;
  readonly dataSnapshotId?: string | null;
};

export type TerminalDayResult = {
  readonly d: string;
  /** Cohorts that resolved at this close, ascending id. */
  readonly resolved: readonly TerminalEvaluation[];
  /** Group restarts written (live trigger present). */
  readonly restarts: readonly GroupRestartPlan[];
  readonly written: boolean;
};

async function slotCohortsIn(
  tx: Reader,
  group: string,
  closeD: string,
  verdicts: ReadonlyMap<string, TerminalVerdict>,
): Promise<SlotCohort[]> {
  const live = await loadLiveCohorts(tx, group);
  const out: SlotCohort[] = [];
  for (const c of live) {
    const today = verdicts.get(c.id);
    const nav = await tx.execute({
      sql: "SELECT liq_nav_micro FROM nav_daily WHERE cohort_id = ? AND d = ?",
      args: [c.id, closeD],
    });
    out.push({
      id: c.id,
      executionId: c.executionId,
      controlIdx: c.controlIdx,
      startD: c.startD,
      terminalKind: c.terminalKind ?? today?.kind ?? null,
      liqNavMicro: nav.rows.length === 0 ? null : toBig(nav.rows[0].liq_nav_micro),
    });
  }
  return out;
}

/**
 * The terminal step of the close of `input.d` for the given cohorts (ARN-052, ARN-053). Judges all
 * of them first, then writes per restart group in one transaction each (see the file header).
 * Cohorts that are already resolved or not started are skipped; running it twice writes nothing
 * the second time.
 */
export async function runTerminalChecks(
  db: Client,
  cohortIds: readonly string[],
  input: EvaluateInput & { readonly restart: RestartConfig },
): Promise<TerminalDayResult> {
  const evaluations: TerminalEvaluation[] = [];
  for (const id of [...cohortIds].sort()) {
    const e = await evaluateCohort(db, id, input);
    if (e !== null) evaluations.push(e);
  }
  const verdicts = new Map(evaluations.map((e) => [e.cohort.id, e.verdict]));
  const byGroup = new Map<string, TerminalEvaluation[]>();
  const loose: TerminalEvaluation[] = [];
  for (const e of evaluations) {
    if (e.cohort.live && e.cohort.twinGroup !== null) {
      byGroup.set(e.cohort.twinGroup, [...(byGroup.get(e.cohort.twinGroup) ?? []), e]);
    } else {
      loose.push(e);
    }
  }
  const restarts: GroupRestartPlan[] = [];
  let written = false;
  for (const group of [...byGroup.keys()].sort()) {
    const members = byGroup.get(group) ?? [];
    const plan = await inTransaction(db, async (tx) => {
      let wrote = false;
      for (const e of members) if (await writeTerminalIn(tx, e)) wrote = true;
      const live = await slotCohortsIn(tx, group, input.d, verdicts);
      const restartPlan = planGroupRestart({
        group,
        triggerCohortId: members[0].cohort.id,
        closeD: input.d,
        calendar: input.calendar,
        live,
        executionFor: input.restart.executionFor,
        paramsFor: input.restart.paramsFor,
        masterSeed: input.restart.masterSeed,
        dataSnapshotId: input.restart.dataSnapshotId,
      });
      if (await restartGroupIn(tx, restartPlan)) wrote = true;
      return { restartPlan, wrote };
    });
    restarts.push(plan.restartPlan);
    if (plan.wrote) written = true;
  }
  for (const e of loose) {
    await inTransaction(db, async (tx) => {
      if (await writeTerminalIn(tx, e)) written = true;
    });
  }
  return {
    d: input.d,
    resolved: [...evaluations].sort((a, b) => (a.cohort.id < b.cohort.id ? -1 : 1)),
    restarts,
    written,
  };
}

// ---- after the liquidation open: realised value and the legacy ledger ----------------------------------------------

/** The liquidation orders of a cohort that are still pending (the orchestrator fills them). */
export async function loadPendingLiquidationOrders(
  db: Reader,
  cohortId: string,
): Promise<
  {
    readonly id: string;
    readonly code: string;
    readonly qty: bigint;
    readonly fillD: string | null;
  }[]
> {
  const rs = await db.execute({
    sql: `SELECT id, code, qty, fill_d FROM arena_order
          WHERE cohort_id = ? AND kind = 'exit_cs' AND status = 'pending' AND id LIKE 'LQ:%'
          ORDER BY code`,
    args: [cohortId],
  });
  return rs.rows.map((r) => ({
    id: text(r.id),
    code: text(r.code),
    qty: toBig(r.qty),
    fillD: textOrNull(r.fill_d),
  }));
}

/**
 * Move positions that could not be sold (halted) to the legacy ledger (ARN-026, ARN-053): the open
 * trade closes with exit_type 'legacy' and legacy = 1 (no exit fill), the pending liquidation
 * order is cancelled with reason 'halted', and a 'data_event' records code, quantity, frozen price
 * and the carried (haircut) value. The cohort must be resolved. The position stays in the ended
 * cohort's own books at its marked value; the legacy ledger is `trade WHERE legacy = 1`.
 */
export async function writeLegacyMoves(
  db: Client,
  input: { readonly cohortId: string; readonly d: string; readonly items: readonly LegacyItem[] },
): Promise<{ readonly written: boolean }> {
  return inTransaction(db, async (tx) => {
    const cohort = await loadCohort(tx, input.cohortId);
    if (cohort === null)
      throw new CohortWriteError("cohort_missing", `no cohort ${input.cohortId}`);
    if (cohort.terminalKind === null || cohort.terminalD === null) {
      throw new CohortWriteError("not_terminal", `${input.cohortId} has not ended`);
    }
    if (input.items.length === 0) return { written: false };
    let written = false;
    for (const item of input.items) {
      const closed = await tx.execute({
        sql: `UPDATE trade SET exit_type = 'legacy', legacy = 1
              WHERE id = ? AND cohort_id = ? AND code = ? AND exit_type IS NULL`,
        args: [item.tradeId, input.cohortId, item.code],
      });
      if (closed.rowsAffected === 1) {
        written = true;
      } else {
        const t = await tx.execute({
          sql: "SELECT exit_type, legacy FROM trade WHERE id = ? AND cohort_id = ?",
          args: [item.tradeId, input.cohortId],
        });
        const already =
          t.rows.length === 1 &&
          text(t.rows[0].exit_type) === "legacy" &&
          toBig(t.rows[0].legacy) === 1n;
        if (!already) {
          throw new CohortWriteError(
            "legacy_conflict",
            `trade ${item.tradeId} cannot move to legacy`,
          );
        }
      }
      const cancelled = await tx.execute({
        sql: `UPDATE arena_order SET status = 'cancelled', reject_reason = 'halted'
              WHERE id = ? AND status = 'pending'`,
        args: [liquidationOrderId(input.cohortId, cohort.terminalD, item.code)],
      });
      if (cancelled.rowsAffected > 0) written = true;
    }
    const detail = {
      id: `legacy:${input.d}`,
      d: input.d,
      legacy: input.items.map((i) => ({
        trade_id: i.tradeId,
        code: i.code,
        qty: i.qty.toString(),
        close_micro: i.closeMicro.toString(),
        haircut: i.haircut,
        value_micro: i.valueMicro.toString(),
      })),
    };
    if (await appendEventIn(tx, input.cohortId, "data_event", input.d, detail, detail.id)) {
      written = true;
    }
    return { written };
  });
}

/**
 * Store the realised value after the actual next-open liquidation (section 5.1): the cohort's NAV
 * once everything sellable is sold, plus the value carried in the legacy ledger. One 'liquidated'
 * event per cohort; the same call again is a no-op, a different figure raises.
 */
export async function writeLiquidated(
  db: Client,
  input: {
    readonly cohortId: string;
    readonly d: string;
    readonly realisedNavMicro: Micro;
    readonly legacyValueMicro?: Micro;
  },
): Promise<{ readonly written: boolean }> {
  return inTransaction(db, async (tx) => {
    const cohort = await loadCohort(tx, input.cohortId);
    if (cohort === null)
      throw new CohortWriteError("cohort_missing", `no cohort ${input.cohortId}`);
    if (cohort.terminalKind === null) {
      throw new CohortWriteError("not_terminal", `${input.cohortId} has not ended`);
    }
    const written = await appendEventIn(
      tx,
      input.cohortId,
      "liquidated",
      input.d,
      {
        id: "liquidated",
        d: input.d,
        realised_nav_micro: assertInt64(input.realisedNavMicro).toString(),
        legacy_value_micro: (input.legacyValueMicro ?? 0n).toString(),
      },
      "liquidated",
    );
    return { written };
  });
}
