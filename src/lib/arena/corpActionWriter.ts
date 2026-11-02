// DB side of the corporate-action engine (M3 design 4.2 step 3, 4.5, 4.6; migration 0007).
// Reads CONFIRMED actions (M2 `corporate_action` + newest `corporate_action_event`), the cohort's
// recorded quantity re-bases (cohort_event `ca_adjust`, decision 14), and applies one cohort-day:
// ledger txns through writeLedgerTxn (idempotent, conflicts raise) and one `ca_adjust` event per
// quantity-changing action. Every step is append-only and replay-safe: running a day twice writes
// nothing the second time. A re-run whose stored rows differ raises (txn_conflict / event conflict).
import type { Client } from "@libsql/client";
import { makeRational } from "@/lib/money/rational";
import { stateOf } from "@/lib/data/corporateActions/rules.mjs";
import {
  planCorporateActions,
  type CorpActionPlan,
  boundedKnownAt,
  type CorpActionRecord,
  type PlannedAdjustment,
} from "./corpActions";
import type { QtyAdjustment } from "./ledger";
import { loadLedgerFills, loadLedgerRows, toBig, writeLedgerTxn } from "./ledgerWriter";

const text = (value: unknown): string => String(value);

/** Confirmed actions of a market with ex-date on or before `upToD`, ordered by id. */
export async function loadConfirmedActions(
  db: Client,
  market: string,
  upToD: string,
): Promise<CorpActionRecord[]> {
  const actions = await db.execute({
    sql: `SELECT id, code, type, ex_date, payload_json, known_at FROM corporate_action
          WHERE market = ? AND ex_date <= ? ORDER BY id`,
    args: [market, upToD],
  });
  const events = await db.execute({
    sql: `SELECT e.action_id, e.status, e.note, e.at FROM corporate_action_event e
          JOIN corporate_action a ON a.id = e.action_id
          WHERE a.market = ? ORDER BY e.id`,
    args: [market],
  });
  const newest = new Map<string, { status: string; note: string | null }>();
  const firstAt = new Map<string, string>();
  const newestAt = new Map<string, string>();
  for (const e of events.rows) {
    newest.set(text(e.action_id), {
      status: text(e.status),
      note: e.note === null ? null : text(e.note),
    });
    if (!firstAt.has(text(e.action_id))) firstAt.set(text(e.action_id), text(e.at));
    newestAt.set(text(e.action_id), text(e.at));
  }
  const out: CorpActionRecord[] = [];
  for (const a of actions.rows) {
    const id = text(a.id);
    if (stateOf(newest.get(id)).state !== "confirmed") continue;
    const payload: unknown = JSON.parse(text(a.payload_json));
    out.push({
      id,
      code: text(a.code),
      type: text(a.type),
      exDate: text(a.ex_date),
      payload: payload !== null && typeof payload === "object" ? (payload as never) : {},
      knownAt: boundedKnownAt(
        a.known_at === null || a.known_at === undefined ? null : text(a.known_at),
        firstAt.get(id) ?? null,
        newestAt.get(id) ?? null,
      ),
    });
  }
  return out;
}

type AdjustDetail = {
  action_id: string;
  type: string;
  code: string;
  ratio_num: string;
  ratio_den: string;
  qty_before: string;
  qty_after: string;
};

function detailOf(a: PlannedAdjustment): AdjustDetail {
  return {
    action_id: a.actionId,
    type: a.type,
    code: a.code,
    ratio_num: a.ratio.num.toString(),
    ratio_den: a.ratio.den.toString(),
    qty_before: a.qtyBefore.toString(),
    qty_after: a.qtyAfter.toString(),
  };
}

/** The cohort's recorded quantity re-bases (ex-date = the event's `d`), oldest first. */
export async function loadQtyAdjustments(db: Client, cohortId: string): Promise<QtyAdjustment[]> {
  const rs = await db.execute({
    sql: `SELECT d, detail_json FROM cohort_event WHERE cohort_id = ? AND kind = 'ca_adjust'
          ORDER BY seq`,
    args: [cohortId],
  });
  return rs.rows.map((r) => {
    const detail = JSON.parse(text(r.detail_json)) as AdjustDetail;
    return {
      code: detail.code,
      exD: text(r.d),
      ratio: makeRational(BigInt(detail.ratio_num), BigInt(detail.ratio_den)),
    };
  });
}

export class CorpActionWriteError extends Error {
  readonly code = "adjust_conflict";
  constructor(message: string) {
    super(message);
    this.name = "CorpActionWriteError";
  }
}

/**
 * Record one quantity re-base as a `ca_adjust` cohort event (next sequence number). The same
 * action already recorded identically is a no-op; recorded differently raises.
 */
export async function writeAdjustment(
  db: Client,
  cohortId: string,
  adjustment: PlannedAdjustment,
): Promise<{ readonly written: boolean }> {
  const detail = JSON.stringify(detailOf(adjustment));
  const tx = await db.transaction("write");
  try {
    const existing = await tx.execute({
      sql: `SELECT detail_json FROM cohort_event
            WHERE cohort_id = ? AND kind = 'ca_adjust' AND json_extract(detail_json, '$.action_id') = ?`,
      args: [cohortId, adjustment.actionId],
    });
    if (existing.rows.length > 0) {
      if (text(existing.rows[0].detail_json) !== detail) {
        throw new CorpActionWriteError(`ca_adjust for action ${adjustment.actionId} differs`);
      }
      await tx.rollback();
      return { written: false };
    }
    const next = await tx.execute({
      sql: "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM cohort_event WHERE cohort_id = ?",
      args: [cohortId],
    });
    await tx.execute({
      sql: `INSERT INTO cohort_event (cohort_id, seq, kind, d, detail_json)
            VALUES (?, ?, 'ca_adjust', ?, ?)`,
      args: [cohortId, toBig(next.rows[0].n), adjustment.exD, detail],
    });
    await tx.commit();
    return { written: true };
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}

export type ApplyInput = {
  readonly cohortId: string;
  readonly market: string;
  /** The session being closed and the session before it. */
  readonly d: string;
  readonly priorD: string;
  /** Last traded raw close at or before priorD (micro), for delistings and scrip fallbacks. */
  readonly lastCloseFor: (code: string) => bigint | undefined;
};

export type ApplyResult = {
  readonly plan: CorpActionPlan;
  readonly txnsWritten: number;
  readonly adjustmentsWritten: number;
};

/**
 * Close the corporate-action part of one cohort-day. Adjustments are written first (a later step
 * of the same day reads positions through them), then the ledger txns in plan order.
 */
export async function applyCorporateActionsDay(
  db: Client,
  input: ApplyInput,
): Promise<ApplyResult> {
  const [actions, fills, adjustments, ledgerRows] = await Promise.all([
    loadConfirmedActions(db, input.market, input.d),
    loadLedgerFills(db, input.cohortId),
    loadQtyAdjustments(db, input.cohortId),
    loadLedgerRows(db, input.cohortId, input.d),
  ]);
  const plan = planCorporateActions({
    d: input.d,
    priorD: input.priorD,
    actions,
    fills,
    adjustments,
    ledgerRows,
    lastCloseFor: input.lastCloseFor,
  });
  let adjustmentsWritten = 0;
  for (const a of plan.adjustments) {
    if ((await writeAdjustment(db, input.cohortId, a)).written) adjustmentsWritten += 1;
  }
  let txnsWritten = 0;
  for (const txn of plan.txns) {
    if ((await writeLedgerTxn(db, input.cohortId, txn)).written) txnsWritten += 1;
  }
  return { plan, txnsWritten, adjustmentsWritten };
}
