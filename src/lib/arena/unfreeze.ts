// Owner action: let a frozen cohort carry on after the cause of a fatal ARN-101 verdict was fixed
// (V1-S1, D-680..D-683). HIGH RISK (money path): Owner-only, explicit confirmation, audit event FIRST
// (the ownerActions `audited` runner, the same shape as src/lib/learning/arenaControl.ts), then ONE
// write transaction that appends one `cohort_event` (kind `data_event`, detail type `invariants_cleared`).
// Nothing is ever cleared automatically, and nothing is edited or deleted: the bad `nav_daily` row stays
// as the permanent record; `activityOf` (closeBooks.ts) simply counts only bad days dated after the
// newest `through_d` of these events (unfreezeCore.ts).
//
// What a clear does NOT do: it does not re-run the sessions the cohort sat out (no cohort-day exists for
// them). A cohort that holds nothing and has nothing pending loses nothing by that, so it may resume at
// once. A cohort with an open trade, a pending order or an open sleeve trade would resume against a
// stale book (orders filled at today's open, stops and corporate actions of the skipped sessions never
// tested), so it is refused (`gap_unsafe`) once at least one session has been closed without it. The
// Owner must clear it BEFORE the next close runs (gap 0), or restart it.
import type { Client } from "@libsql/client";
import type { CurrentUser } from "@/lib/auth/session";
import {
  actorOf,
  audited,
  MARKET,
  type ActionResult,
  type OwnerCtx,
} from "@/lib/learning/ownerActions";
import { ARENA_JOB } from "./closeBooks";
import { toBig } from "./ledgerWriter";
import { INVARIANTS_CLEARED, parseClearInput, type ClearInput } from "./unfreezeCore";

const HTTP_BAD = 400; // threshold-ok: HTTP status
const HTTP_FORBIDDEN = 403; // threshold-ok: HTTP status
const HTTP_NOT_FOUND = 404; // threshold-ok: HTTP status
const HTTP_CONFLICT = 409; // threshold-ok: HTTP status
const HTTP_UNAVAILABLE = 503; // threshold-ok: HTTP status

const res = (status: number, body: Record<string, unknown>): ActionResult => ({ status, body });
const bad = (error: string, status = HTTP_BAD): ActionResult => res(status, { error });

type Exec = Pick<Client, "execute">;
const cnt = (v: unknown): number => Number.parseInt(String(v), 10);

export type FrozenState = {
  /** Newest bad (invariants_ok = 0) day not yet cleared; null = not frozen. */
  readonly throughD: string | null;
  readonly badDays: number;
  /** Close-the-books runs dated after `throughD` that this cohort sat out. */
  readonly gapSessions: number;
  readonly openTrades: number;
  readonly pendingOrders: number;
  readonly openSleeveTrades: number;
};

async function clearedThrough(db: Exec, cohortId: string): Promise<string> {
  const r = await db.execute({
    sql: `SELECT MAX(json_extract(detail_json, '$.through_d')) AS t FROM cohort_event
          WHERE cohort_id = ? AND kind = 'data_event'
            AND json_extract(detail_json, '$.type') = ?`,
    args: [cohortId, INVARIANTS_CLEARED],
  });
  const t = r.rows[0]?.t;
  return t === null || t === undefined ? "" : String(t);
}

/** What the freeze looks like right now (read-only; also the re-check inside the write transaction). */
export async function frozenState(db: Exec, cohortId: string): Promise<FrozenState> {
  const cleared = await clearedThrough(db, cohortId);
  const rs = await db.execute({
    sql: `SELECT
      (SELECT MAX(d) FROM nav_daily WHERE cohort_id = ? AND invariants_ok = 0 AND d > ?) AS through_d,
      (SELECT COUNT(*) FROM nav_daily WHERE cohort_id = ? AND invariants_ok = 0 AND d > ?) AS bad_days,
      (SELECT COUNT(*) FROM trade WHERE cohort_id = ? AND exit_type IS NULL) AS open_trades,
      (SELECT COUNT(*) FROM arena_order WHERE cohort_id = ? AND status = 'pending') AS pending_orders,
      (SELECT COUNT(*) FROM sleeve_trade WHERE cohort_id = ? AND closed_by IS NULL) AS sleeve_open`,
    args: [cohortId, cleared, cohortId, cleared, cohortId, cohortId, cohortId],
  });
  const r = rs.rows[0]!;
  const throughD = r.through_d === null ? null : String(r.through_d);
  let gap = 0;
  if (throughD !== null) {
    const g = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM run_record WHERE job = ? AND market = ? AND scheduled_for > ?
            AND status IN ('success','degraded','failed') AND concurrency_key LIKE 'arena-2a:%'`,
      args: [ARENA_JOB, MARKET, throughD],
    });
    gap = cnt(g.rows[0]!.n);
  }
  return {
    throughD,
    badDays: cnt(r.bad_days),
    gapSessions: gap,
    openTrades: cnt(r.open_trades),
    pendingOrders: cnt(r.pending_orders),
    openSleeveTrades: cnt(r.sleeve_open),
  };
}

const unsafe = (s: FrozenState): boolean =>
  s.gapSessions > 0 && (s.openTrades > 0 || s.pendingOrders > 0 || s.openSleeveTrades > 0);

/**
 * The Owner action. The caller has ALREADY passed the Owner guard (`requireUser("admin")`); the role is
 * checked once more here so a mistaken caller cannot bypass it.
 */
export async function clearCohortInvariants(
  c: OwnerCtx,
  user: CurrentUser,
  input: ClearInput,
): Promise<ActionResult> {
  if (user.role !== "owner") return bad("forbidden", HTTP_FORBIDDEN);
  const p = parseClearInput(input);
  if (!p.ok) return p.error === "invalid" ? bad("invalid") : res(HTTP_CONFLICT, { error: p.error });
  const { cohortId, cause } = p.value;
  let before: FrozenState;
  try {
    const exists = await c.mainDb.execute({
      sql: "SELECT 1 FROM cohort WHERE id = ?",
      args: [cohortId],
    });
    if (exists.rows.length === 0) return bad("not_found", HTTP_NOT_FOUND);
    before = await frozenState(c.mainDb, cohortId);
  } catch {
    return bad("unavailable", HTTP_UNAVAILABLE);
  }
  if (before.throughD === null) return res(HTTP_CONFLICT, { error: "not_frozen" });
  if (unsafe(before)) {
    return res(HTTP_CONFLICT, {
      error: "gap_unsafe",
      gapSessions: before.gapSessions,
      openTrades: before.openTrades,
      pendingOrders: before.pendingOrders,
      openSleeveTrades: before.openSleeveTrades,
    });
  }
  return audited(c, user, {
    action: "arena.cohort_unfreeze",
    targetType: "cohort",
    targetId: cohortId,
    detail: {
      cohortId,
      throughD: before.throughD,
      badDays: before.badDays,
      gapSessions: before.gapSessions,
      cause,
    },
    run: async (auditRef, d, now) => {
      const tx = await c.mainDb.transaction("write");
      try {
        // re-read inside the write transaction: a close that ran meanwhile may have changed the picture
        const again = await frozenState(tx, cohortId);
        if (again.throughD === null) return { ok: false, reason: "not_frozen" };
        if (unsafe(again)) return { ok: false, reason: "gap_unsafe" };
        const seq = await tx.execute({
          sql: "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM cohort_event WHERE cohort_id = ?",
          args: [cohortId],
        });
        const detail = {
          type: INVARIANTS_CLEARED,
          through_d: again.throughD,
          bad_days: again.badDays,
          gap_sessions: again.gapSessions,
          cause,
          by: actorOf(user),
          audit: auditRef,
          at: now,
        };
        await tx.execute({
          sql: `INSERT INTO cohort_event (cohort_id, seq, kind, d, detail_json)
                VALUES (?, ?, 'data_event', ?, ?)`,
          args: [cohortId, toBig(seq.rows[0]!.n), d, JSON.stringify(detail)],
        });
        await tx.commit();
        return {
          ok: true,
          body: { cohortId, throughD: again.throughD, gapSessions: again.gapSessions },
        };
      } finally {
        tx.close();
      }
    },
  });
}
