// The rollback kill of a market (MKT-111, CTX-028, AT-71, D-1101, D-1194; M20 S1). HIGH-RISK (money, kill).
//
// `switchMarket(full -> off)` (src/lib/data/marketSwitch.ts) sets `mode = 'off'` and `rollback_at`, KEEPING
// `enabled = 1`. The Worker then dispatches `arena-close.yml` with `inputs.kill = market_off` at the open + 2 minutes
// of the market's next trading day (`arena-kill:<CODE>`, worker/src/schedule.ts); the script runs
// `closeBooksMain --kill market_off`, which calls `closeBooksKill` here:
//
//   1. it refuses to act unless the market is enabled, off and has `rollback_at` set (so a kill can never touch a
//      running market), and unless D is a trading session by the stored calendar;
//   2. every pending order of the market's cohorts is cancelled with reason `market_off`; no entry is ever filled;
//   3. every open position (and every open real sleeve trade) is sold at the session's open: the fill is the stock
//      close-signal fill (open price, slippage, the profile's cost model) of `fills.ts`, the order id `KILL:<trade>:<D>`,
//      the exit type `terminal`. The open comes from D's own bar; when the market was off no bar was fetched, and the
//      last known close before D stands in (a flat bar; counted in the run record as `lastClose`, D-1194);
//   4. the fill rows are posted to the cash ledger and their settlement is posted dated its settlement session by the
//      market's own lag (T+1 for IN, T+1 for US; `settlementItem`), so the books reconcile although no later job runs;
//   5. NOTHING else is written: no new entry, no NAV row, no terminal event, no financing accrual, no e-mail;
//   6. when no position is left (`remaining = 0`), ONE transaction finishes the run record as `success` and sets
//      `enabled = 0, rollback_at = NULL`; from then on the 0035 guard refuses every write for the market.
// A position that cannot be sold (halted, or no price at all) stays open: the run is `failed`, `enabled` and
// `rollback_at` stay, an S2 `market_kill_incomplete` opens, and the next trading day's slot tries again.
// Forever tables stay; the audit event of the rollback is the switch's own (the reason).
import type { Client } from "@libsql/client";
import { gateDayStatus, previousTradingDay } from "@/lib/data/calendar";
import { openS2Once } from "@/lib/heartbeat/incidents";
import type { NotifyCtx } from "@/lib/incidents/notify";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import { finishRun, hasSuccess, startRun } from "@/lib/runs/runRecord";
import { ARENA_JOB, loadCalendar, loadSleeveConfig } from "./closeBooks";
import { parseCohortParams } from "./cohort";
import { loadCohort } from "./cohortWriter";
import { loadQtyAdjustments } from "./corpActionWriter";
import { costProfileOfMarket, costProfilesOfMarket } from "./costs";
import { writeFill } from "./fillWriter";
import { fillCloseSignalExit, type Bar, type FillEnv } from "./fills";
import {
  fillTxns,
  pendingSettlements,
  replayCostBasis,
  settleTxn,
  type LedgerFill,
} from "./ledger";
import { loadLedgerFills, loadLedgerRows, writeLedgerTxn } from "./ledgerWriter";
import { createMarketData } from "./marketData";
import { marketMoney } from "./marketMoney";
import { derivePositions } from "./nav";
import { quoteSleeveExit } from "./sleeve";
import { loadSleeveTrades, writeSleeveClose } from "./sleeveWriter";

/** The reason every order and close of the kill carries (the `--kill` value, the audit words). */
export const KILL_REASON = "market_off";
export const killKey = (market: string, d: string): string => `arena-kill:${market}:${d}`;
export const INCIDENT_KILL_INCOMPLETE = "market_kill_incomplete";

export type KillStatus = "success" | "failed" | "skipped" | "already_done";
export type KillResult = {
  readonly market: string;
  readonly d: string;
  readonly status: KillStatus;
  readonly reason: string | null;
  /** Stock positions sold by this run. */
  readonly sold: number;
  /** Real sleeve trades closed by this run. */
  readonly sleeveClosed: number;
  /** Orders cancelled by this run. */
  readonly cancelled: number;
  /** Prices used: the session's own open, or the last known close. */
  readonly basis: {
    readonly open: number;
    readonly lastClose: number;
    /** Of `lastClose`: closes older than the last full session before D (a stale mark, D-1194). */
    readonly staleClose: number;
    /** The date of the oldest close used (null when none was). */
    readonly oldestCloseD: string | null;
  };
  /** Positions still open after the run (0 when the market was disabled). */
  readonly remaining: number;
  readonly disabled: boolean;
};

export type KillOptions = {
  readonly market: string;
  /** The session the kill runs on (the market's local trading date). */
  readonly d: string;
  readonly now: () => string;
  readonly commitSha?: string | null;
  readonly notify?: Omit<NotifyCtx, "db" | "now">;
};

const text = (v: unknown): string => String(v);

type OpenTrade = { readonly id: string; readonly cohortId: string; readonly code: string };

const result = (
  o: KillOptions,
  status: KillStatus,
  reason: string | null,
  extra: Partial<KillResult> = {},
): KillResult => ({
  market: o.market,
  d: o.d,
  status,
  reason,
  sold: 0,
  sleeveClosed: 0,
  cancelled: 0,
  basis: { open: 0, lastClose: 0, staleClose: 0, oldestCloseD: null },
  remaining: 0,
  disabled: false,
  ...extra,
});

/** Close every open book of `opts.market` at the open of `opts.d` with reason `market_off`, then disable it. */
export async function closeBooksKill(db: Client, opts: KillOptions): Promise<KillResult> {
  const key = killKey(opts.market, opts.d);
  // rows-ok: primary-key probe of one market row
  const m = await db.execute({
    sql: "SELECT mode, enabled, rollback_at FROM market WHERE code = ?",
    args: [opts.market],
  });
  if (m.rows.length !== 1) return result(opts, "skipped", "market_missing");
  const row = m.rows[0]!;
  const enabled = Number(row.enabled); // money-float-ok: the 0/1 enabled flag, not money
  if (enabled !== 1) {
    // nothing may be written for a market that is not enabled (not even a run record): it is already closed
    return result(opts, "skipped", "market_not_enabled");
  }
  if (await hasSuccess(db, key)) return result(opts, "already_done", null);
  const pending = row.rollback_at !== null && row.rollback_at !== undefined;
  const reason = text(row.mode) !== "off" || !pending ? "kill_not_pending" : null;
  const calendar = await loadCalendar(db, opts.market);
  const money = marketMoney(opts.market); // D-1170: the market's buckets and tick grid in every kill fill
  const dayState = gateDayStatus(opts.d, calendar, true);
  const refused = reason ?? (dayState === "open" ? null : "non_trading_day");
  if (refused !== null) return recordSkip(db, opts, refused);

  const runId = await startRun(db, {
    job: ARENA_JOB,
    market: opts.market,
    concurrencyKey: key,
    scheduledFor: opts.d,
    commitSha: opts.commitSha ?? undefined,
    now: opts.now(),
  });
  let sold = 0;
  let sleeveClosed = 0;
  let cancelled = 0;
  const basis: {
    open: number;
    lastClose: number;
    staleClose: number;
    oldestCloseD: string | null;
  } = {
    open: 0,
    lastClose: 0,
    staleClose: 0,
    oldestCloseD: null,
  };
  try {
    const priorD = previousTradingDay(opts.d, calendar);
    const data = createMarketData(db, opts.market, opts.d);
    const lag = staticProfile(opts.market).settlementDays!;
    const profiles = costProfilesOfMarket(opts.market);
    // rows-ok: the cohorts of one market (a few dozen: executions x controls), by idx_cohort_execution
    const cohorts = await db.execute({
      sql: `SELECT c.id FROM cohort c JOIN execution e ON e.id = c.execution_id
            WHERE e.market = ? ORDER BY c.id`,
      args: [opts.market],
    });
    let remaining = 0;
    for (const c of cohorts.rows) {
      const cohortId = text(c.id);
      // 2. nothing pending survives: no entry fills, no exit waits (the kill sells instead)
      const cancel = await db.execute({
        sql: `UPDATE arena_order SET status = 'cancelled', reject_reason = ?
              WHERE cohort_id = ? AND status = 'pending'`,
        args: [KILL_REASON, cohortId],
      });
      cancelled += cancel.rowsAffected;
      const cohort = await loadCohort(db, cohortId);
      if (cohort === null) continue;
      const params = parseCohortParams(cohort.paramsJson);
      // a cohort params code the market has no table for falls back to the profile's own cost formula
      const profile =
        profiles[params.costProfile] ?? costProfileOfMarket(staticProfile(opts.market) as never);
      // rows-ok: the open trades of one cohort
      const open = await db.execute({
        sql: "SELECT id, code FROM trade WHERE cohort_id = ? AND exit_type IS NULL ORDER BY code, id",
        args: [cohortId],
      });
      const trades: OpenTrade[] = open.rows.map((t) => ({
        id: text(t.id),
        cohortId,
        code: text(t.code),
      }));
      const [fills, adjustments] = await Promise.all([
        loadLedgerFills(db, cohortId),
        loadQtyAdjustments(db, cohortId),
      ]);
      const positions = derivePositions(fills, adjustments, opts.d).positions;
      const killFillIds = new Set<string>();
      const envFor = async (
        code: string,
      ): Promise<{ env: FillEnv; kind: "open" | "lastClose"; closeD: string | null } | null> => {
        if (await data.halted(code, opts.d)) return null;
        const bar = await data.bar(code, opts.d);
        const adv = await data.adv(code, priorD);
        if (bar !== null) {
          return {
            env: {
              bar,
              advMicro: adv,
              profile,
              tickCrossFactor: params.tickCrossFactor,
              buckets: money.buckets,
              tickTable: money.tickTable,
            },
            kind: "open",
            closeD: null,
          };
        }
        const last = await data.lastClose(code, priorD);
        if (last === null) return null;
        // rows-ok: one row through the (market, code, d) key, newest first
        const dated = await db.execute({
          sql: "SELECT d FROM price_bar WHERE market = ? AND code = ? AND d <= ? ORDER BY d DESC LIMIT 1",
          args: [opts.market, code, priorD],
        });
        const closeD = dated.rows.length === 0 ? null : text(dated.rows[0]!.d);
        const flat: Bar = { openMicro: last, highMicro: last, lowMicro: last, closeMicro: last };
        return {
          env: {
            bar: flat,
            advMicro: adv,
            profile,
            tickCrossFactor: params.tickCrossFactor,
            buckets: money.buckets,
            tickTable: money.tickTable,
          },
          kind: "lastClose",
          closeD,
        };
      };
      // 3a. the stock positions
      for (const t of trades) {
        const qty = positions.get(t.code) ?? 0n;
        if (qty <= 0n) continue;
        const priced = await envFor(t.code);
        if (priced === null) {
          remaining += 1;
          continue;
        }
        const orderId = `KILL:${t.id}:${opts.d}`;
        await db.execute({
          sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty)
                VALUES (?, ?, ?, ?, 'sell', 'exit_cs', ?) ON CONFLICT DO NOTHING`,
          args: [orderId, cohortId, opts.d, t.code, qty],
        });
        const fill = fillCloseSignalExit(priced.env, qty);
        const written = await writeFill(db, {
          fillId: `F1:${orderId}`,
          orderId,
          cohortId,
          d: opts.d,
          code: t.code,
          fill,
          trade: { kind: "close", tradeId: t.id, exitType: "terminal" },
        });
        if (written.written) {
          sold += 1;
          basis[priced.kind] += 1;
          if (priced.closeD !== null) {
            if (priced.closeD < priorD) basis.staleClose += 1;
            if (basis.oldestCloseD === null || priced.closeD < basis.oldestCloseD) {
              basis.oldestCloseD = priced.closeD;
            }
          }
          killFillIds.add(`F1:${orderId}`);
        }
      }
      // 3b. the real sleeve trades follow their stock position out, at the open
      const cfg = await loadSleeveConfig(db, cohortId);
      if (cfg !== null) {
        const sleeve = (await loadSleeveTrades(db, cohortId)).filter(
          (s) => !s.shadow && s.closed === null,
        );
        for (const s of sleeve) {
          const priced = await envFor(s.code);
          if (priced === null) {
            remaining += 1;
            continue;
          }
          const quote = quoteSleeveExit(
            { ...priced.env, profile: cfg.profile },
            s,
            { kind: "cs" },
            cfg,
          );
          if (quote === null) {
            remaining += 1;
            continue;
          }
          const w = await writeSleeveClose(db, {
            cohortId,
            tradeId: s.id,
            cfg,
            closeD: opts.d,
            exit: quote,
            orderId: `SCO:KILL:${s.id}`,
            fillId: `SCF:KILL:${s.id}`,
            decidedD: opts.d,
            adjustments,
          });
          if (w.written) sleeveClosed += 1;
        }
      }
      // 4. post the fills to the ledger, then their settlement dated its settlement session (T+lag)
      if (killFillIds.size > 0)
        await postKillFills(db, cohortId, killFillIds, calendar, lag, adjustments);
    }
    const doneAll = remaining === 0;
    const details = {
      reason: KILL_REASON,
      sold,
      sleeveClosed,
      cancelled,
      basis,
      remaining,
      d: opts.d,
    };
    if (!doneAll) {
      await finishRun(db, runId, {
        status: "failed",
        errorSummary: `${KILL_REASON}: ${remaining} position(s) could not be sold`,
        details,
        itemsProcessed: sold + sleeveClosed,
        now: opts.now(),
      });
      await openS2Once(
        db,
        INCIDENT_KILL_INCOMPLETE,
        {
          market: opts.market,
          d: opts.d,
          remaining,
          staleClose: basis.staleClose,
          oldestCloseD: basis.oldestCloseD,
        },
        opts.now(),
        opts.notify,
        `The rollback of ${opts.market} could not sell ${remaining} position(s)` +
          (basis.staleClose > 0
            ? `; ${basis.staleClose} sold at a close as old as ${basis.oldestCloseD}`
            : ""),
      );
      return result(opts, "failed", "positions_remaining", {
        sold,
        sleeveClosed,
        cancelled,
        basis,
        remaining,
      });
    }
    // 6. the last close row and the disable are ONE transaction
    const endedAt = opts.now();
    const tx = await db.transaction("write");
    try {
      await tx.execute({
        sql: `UPDATE run_record SET status = 'success', ended_at = ?, items_processed = ?, details_json = ?
              WHERE id = ?`,
        args: [endedAt, sold + sleeveClosed, JSON.stringify({ ...details, disabled: true }), runId],
      });
      await tx.execute({
        sql: `UPDATE market SET enabled = 0, rollback_at = NULL
              WHERE code = ? AND enabled = 1 AND mode = 'off' AND rollback_at IS NOT NULL`,
        args: [opts.market],
      });
      await tx.commit();
    } finally {
      tx.close();
    }
    return result(opts, "success", null, {
      sold,
      sleeveClosed,
      cancelled,
      basis,
      remaining: 0,
      disabled: true,
    });
  } catch (error) {
    await finishRun(db, runId, {
      status: "failed",
      errorSummary: `kill failed: ${error instanceof Error ? error.name : "unknown"}`,
      now: opts.now(),
    }).catch(() => undefined);
    throw error;
  }
}

async function recordSkip(db: Client, o: KillOptions, reason: string): Promise<KillResult> {
  const runId = await startRun(db, {
    job: ARENA_JOB,
    market: o.market,
    concurrencyKey: killKey(o.market, o.d),
    scheduledFor: o.d,
    commitSha: o.commitSha ?? undefined,
    now: o.now(),
  });
  await finishRun(db, runId, { status: "skipped", details: { reason }, now: o.now() });
  return result(o, "skipped", reason);
}

/** Post the kill fills' ledger rows, then each one's settlement dated its settlement session. */
async function postKillFills(
  db: Client,
  cohortId: string,
  killFillIds: ReadonlySet<string>,
  calendar: Awaited<ReturnType<typeof loadCalendar>>,
  lag: number,
  adjustments: Awaited<ReturnType<typeof loadQtyAdjustments>>,
): Promise<void> {
  const fills: LedgerFill[] = await loadLedgerFills(db, cohortId);
  const costs = replayCostBasis(fills, adjustments, "9999-12-31").saleCostByFillId;
  for (const f of fills) {
    if (!killFillIds.has(f.id)) continue;
    for (const txn of fillTxns(f, costs.get(f.id))) await writeLedgerTxn(db, cohortId, txn);
  }
  const rows = await loadLedgerRows(db, cohortId);
  const settled = new Set(
    rows.filter((r) => r.kind === "settle" && r.refType === "fill").map((r) => text(r.refId)),
  );
  for (const item of pendingSettlements(fills, settled, calendar, lag)) {
    if (killFillIds.has(item.fillId))
      await writeLedgerTxn(db, cohortId, settleTxn(item, item.settleD));
  }
}
