// Reads the paper books for the tax report (M21 B3; ARN-122, D-1222). Read only. Every list read is bounded and
// keyset-paged (no OFFSET, PRD-045): trades by trade id, split events by (cohort, seq), dividends per cohort by ledger id.
// A page cap stops a runaway read; the report then says its figures are incomplete (`truncated`).
import type { Client } from "@libsql/client";
import { makeRational } from "@/lib/money/rational";
import type { BookTrade, DividendRow, Split, TaxFill } from "./types";

const PAGE = 500;
const CLOSING = new Set(["merger_cash", "merger_scrip", "delisting"]);
export const MAX_PAGES = 40;

export type BookData = {
  readonly trades: BookTrade[];
  readonly splitsByCohort: Map<string, Split[]>;
  readonly dividends: DividendRow[];
  readonly truncated: boolean;
};

const big = (v: unknown): bigint => BigInt(String(v));
const str = (v: unknown): string => String(v);

/** Trades whose entry is on or before `range.end`; an exit after the year end is treated as still open. */
async function loadTrades(
  db: Client,
  market: string,
  end: string,
): Promise<{ trades: BookTrade[]; truncated: boolean }> {
  const trades: BookTrade[] = [];
  let after = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // rows-ok: keyset by trade id, LIMIT PAGE, at most MAX_PAGES pages
    const r = await db.execute({
      sql: `SELECT t.id AS trade_id, t.cohort_id, c.execution_id, t.code, t.legacy, c.terminal_d,
                   ef.id AS e_id, ef.d AS e_d, ef.qty AS e_qty, ef.value_micro AS e_value, ef.brokerage_micro AS e_fee,
                   xf.id AS x_id, xf.d AS x_d, xf.qty AS x_qty, xf.value_micro AS x_value, xf.brokerage_micro AS x_fee
            FROM trade t
            JOIN cohort c ON c.id = t.cohort_id
            JOIN execution e ON e.id = c.execution_id
            JOIN fill ef ON ef.id = t.entry_fill_id
            LEFT JOIN fill xf ON xf.id = t.exit_fill_id
            WHERE e.market = ? AND ef.d <= ? AND t.id > ?
            ORDER BY t.id LIMIT ?`,
      args: [market, end, after, PAGE],
    });
    for (const x of r.rows) {
      const code = str(x.code);
      const entry: TaxFill = {
        id: str(x.e_id),
        d: str(x.e_d),
        code,
        side: "buy",
        qty: big(x.e_qty),
        valueMicro: big(x.e_value),
        feeMicro: big(x.e_fee),
      };
      const exit: TaxFill | null =
        x.x_id === null || x.x_id === undefined
          ? null
          : {
              id: str(x.x_id),
              d: str(x.x_d),
              code,
              side: "sell",
              qty: big(x.x_qty),
              valueMicro: big(x.x_value),
              feeMicro: big(x.x_fee),
            };
      trades.push({
        tradeId: str(x.trade_id),
        cohortId: str(x.cohort_id),
        executionId: str(x.execution_id),
        code,
        entry,
        exit,
        legacy: big(x.legacy) === 1n,
        legacyD: x.terminal_d === null || x.terminal_d === undefined ? null : str(x.terminal_d),
      });
    }
    if (r.rows.length < PAGE) return { trades, truncated: false };
    after = str(r.rows[r.rows.length - 1]!.trade_id);
  }
  return { trades, truncated: true };
}

/** The cohorts' recorded quantity re-bases (`ca_adjust` cohort events), by (cohort, seq). */
async function loadSplits(
  db: Client,
  market: string,
  end: string,
): Promise<{ splits: Map<string, Split[]>; truncated: boolean }> {
  const splits = new Map<string, Split[]>();
  let afterCohort = "";
  let afterSeq = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // rows-ok: keyset by (cohort_id, seq), LIMIT PAGE, at most MAX_PAGES pages
    const r = await db.execute({
      sql: `SELECT ev.cohort_id, ev.seq, ev.d, ev.detail_json
            FROM cohort_event ev
            JOIN cohort c ON c.id = ev.cohort_id
            JOIN execution e ON e.id = c.execution_id
            WHERE e.market = ? AND ev.kind = 'ca_adjust' AND ev.d <= ?
              AND (ev.cohort_id > ? OR (ev.cohort_id = ? AND ev.seq > ?))
            ORDER BY ev.cohort_id, ev.seq LIMIT ?`,
      args: [market, end, afterCohort, afterCohort, afterSeq, PAGE],
    });
    for (const x of r.rows) {
      const detail = JSON.parse(str(x.detail_json)) as {
        action_id: string;
        type: string;
        code: string;
        ratio_num: string;
        ratio_den: string;
      };
      const ratio = makeRational(BigInt(detail.ratio_num), BigInt(detail.ratio_den));
      const list = splits.get(str(x.cohort_id)) ?? [];
      let closure: Split["closure"];
      if (ratio.num === 0n && CLOSING.has(detail.type)) {
        // The cash the books settled for the closed holding: the ca_dispose entry `ca:<action id>` (none = no cash)
        // rows-ok: one row by the unique key (cohort_id, d, txn_id, account)
        const c = await db.execute({
          sql: `SELECT delta_micro FROM cash_ledger
                WHERE cohort_id = ? AND d = ? AND txn_id = ? AND account = 'cash_settled'`,
          args: [str(x.cohort_id), str(x.d), `ca:${detail.action_id}`],
        });
        closure = {
          actionId: detail.action_id,
          proceedsMicro: c.rows.length === 0 ? 0n : big(c.rows[0]!.delta_micro),
        };
      }
      list.push({ code: detail.code, exD: str(x.d), ratio, ...(closure ? { closure } : {}) });
      splits.set(str(x.cohort_id), list);
    }
    if (r.rows.length < PAGE) return { splits, truncated: false };
    const last = r.rows[r.rows.length - 1]!;
    afterCohort = str(last.cohort_id);
    afterSeq = Number(last.seq);
  }
  return { splits, truncated: true };
}

/** Dividends paid in the year: `div_pay` ledger rows of the cohorts that traded, less any reversal of a payment. */
async function loadDividends(
  db: Client,
  cohorts: ReadonlyMap<string, string>,
  range: { start: string; end: string },
): Promise<{ rows: DividendRow[]; truncated: boolean }> {
  const paid: { executionId: string; refId: string; d: string; amount: bigint }[] = [];
  let truncated = false;
  for (const [cohortId, executionId] of [...cohorts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let after = 0;
    let done = false;
    for (let page = 0; page < MAX_PAGES && !done; page += 1) {
      // rows-ok: one cohort, one year, keyset by ledger id, LIMIT PAGE (index cohort_id, d)
      const r = await db.execute({
        sql: `SELECT id, d, kind, ref_id, delta_micro FROM cash_ledger
              WHERE cohort_id = ? AND d >= ? AND d <= ? AND account = 'cash_settled'
                AND ((kind = 'div_pay' AND ref_type = 'dividend')
                  OR (kind = 'reversal' AND ref_type = 'txn' AND ref_id LIKE 'divpay:%'))
                AND id > ?
              ORDER BY id LIMIT ?`,
        args: [cohortId, range.start, range.end, after, PAGE],
      });
      for (const x of r.rows) {
        const isReversal = str(x.kind) === "reversal";
        const ref = isReversal ? str(x.ref_id).slice("divpay:".length) : str(x.ref_id);
        paid.push({ executionId, refId: ref, d: str(x.d), amount: big(x.delta_micro) });
      }
      if (r.rows.length < PAGE) done = true;
      else after = Number(r.rows[r.rows.length - 1]!.id);
    }
    if (!done) truncated = true;
  }
  if (paid.length === 0) return { rows: [], truncated };
  // The corporate action behind each payment: its code and the franking it recorded (payload only, never computed).
  const info = new Map<string, { code: string; pct: string | null; credit: bigint | null }>();
  // the action ids are integers; anything else is skipped (a primary-key IN list, not a scan)
  const ids = [...new Set(paid.map((p) => p.refId))].filter((i) => /^\d+$/.test(i)).sort();
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    // rows-ok: primary-key list, at most CHUNK ids
    const r = await db.execute({
      sql: `SELECT id, code, payload_json FROM corporate_action
            WHERE id IN (${part.map(() => "?").join(",")})`,
      args: part.map((i) => Number(i)),
    });
    for (const x of r.rows) {
      let payload: Record<string, unknown> = {};
      try {
        const p: unknown = JSON.parse(str(x.payload_json));
        if (p !== null && typeof p === "object") payload = p as Record<string, unknown>;
      } catch {
        payload = {};
      }
      const pct = payload.franking_pct;
      const credit = payload.franking_credit_micro;
      info.set(str(x.id), {
        code: str(x.code),
        pct: pct === undefined || pct === null ? null : String(pct),
        credit:
          credit === undefined || credit === null || !/^-?\d+$/.test(String(credit))
            ? null
            : BigInt(String(credit)),
      });
    }
  }
  const rows: DividendRow[] = paid.map((p) => {
    const a = info.get(p.refId);
    return {
      executionId: p.executionId,
      code: a?.code ?? "unknown",
      d: p.d,
      amountMicro: p.amount,
      frankingPct: a?.pct ?? null,
      frankingCreditMicro: a?.credit ?? null,
    };
  });
  return { rows, truncated };
}

export async function loadBook(
  db: Client,
  market: string,
  range: { start: string; end: string },
): Promise<BookData> {
  const t = await loadTrades(db, market, range.end);
  const s = await loadSplits(db, market, range.end);
  const cohorts = new Map<string, string>();
  for (const x of t.trades) cohorts.set(x.cohortId, x.executionId);
  const d = await loadDividends(db, cohorts, range);
  return {
    trades: t.trades,
    splitsByCohort: s.splits,
    dividends: d.rows,
    truncated: t.truncated || s.truncated || d.truncated,
  };
}
