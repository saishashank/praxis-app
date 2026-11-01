// Owner action: let a frozen cohort carry on after the cause of a fatal ARN-101 verdict was fixed
// (V1-S1, D-680..D-683). HIGH RISK (money path): Owner-only, explicit confirmation, audit event FIRST
// (the ownerActions `audited` runner, the same shape as src/lib/learning/arenaControl.ts), then ONE
// write transaction that appends one `cohort_event` (kind `data_event`, detail type `invariants_cleared`).
// Nothing is ever cleared automatically, and nothing is edited or deleted: the bad `nav_daily` row stays
// as the permanent record; `activityOf` (closeBooks.ts) simply counts only bad days dated after the
// newest `through_d` of these events (unfreezeCore.ts).
//
// Catch-up (D-682): the sessions the cohort sat out have no cohort-day, and its orders, stops and
// corporate actions of those sessions must not be skipped. So BEFORE the clearing event is written, each
// closed session after the cohort's last nav day is closed again for THIS cohort only
// (`closeBooksDay` with `catchUpCohort`, oldest first; the other cohorts closed those nights already).
// If a catch-up day fails its invariants the cohort stays frozen (the new bad nav row counts) and the
// Owner is told which day; if the process dies midway nothing is cleared and the same action can simply
// be run again (it resumes after the cohort's newest nav day). Only after every day is ok is the single
// clearing event appended. More than MAX_CATCH_UP_SESSIONS sessions are refused (`gap_too_long`).
import type { Client } from "@libsql/client";
import type { CurrentUser } from "@/lib/auth/session";
import {
  actorOf,
  audited,
  MARKET,
  type ActionResult,
  type OwnerCtx,
} from "@/lib/learning/ownerActions";
import { ARENA_JOB, closeBooksDay } from "./closeBooks";
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

/** Longest run of skipped sessions that is replayed inside one Owner request (a request has a time limit). */
export const MAX_CATCH_UP_SESSIONS = 10; // threshold-ok: decision D-682

export type FrozenState = {
  /** Newest bad (invariants_ok = 0) day not yet cleared; null = not frozen. */
  readonly throughD: string | null;
  readonly badDays: number;
  /** Closed sessions after the cohort's newest nav day: what the catch-up would replay, oldest first. */
  readonly gapDays: readonly string[];
  readonly gapSessions: number;
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
      (SELECT MAX(d) FROM nav_daily WHERE cohort_id = ?) AS last_nav`,
    args: [cohortId, cleared, cohortId, cleared, cohortId],
  });
  const r = rs.rows[0]!;
  const throughD = r.through_d === null ? null : String(r.through_d);
  let gapDays: string[] = [];
  if (throughD !== null) {
    const after = r.last_nav === null ? throughD : String(r.last_nav);
    // the same "closed" test as previousSessionClosed: books written for the night
    const g = await db.execute({
      sql: `SELECT DISTINCT scheduled_for AS d FROM run_record
            WHERE job = ? AND market = ? AND concurrency_key LIKE 'arena-2a:%' AND scheduled_for > ?
              AND (status IN ('success','degraded')
                   OR (status = 'failed' AND json_extract(details_json, '$.navDays') IS NOT NULL))
            ORDER BY scheduled_for`,
      args: [ARENA_JOB, MARKET, after],
    });
    gapDays = g.rows.map((x) => String(x.d));
  }
  return { throughD, badDays: cnt(r.bad_days), gapDays, gapSessions: gapDays.length };
}

/** The cohorts that are frozen right now (Owner page). */
export async function listFrozenCohorts(
  db: Exec,
): Promise<{ cohortId: string; throughD: string; gapSessions: number }[]> {
  const ids = await db.execute({
    sql: "SELECT DISTINCT cohort_id FROM nav_daily WHERE invariants_ok = 0 ORDER BY cohort_id",
    args: [],
  });
  const out: { cohortId: string; throughD: string; gapSessions: number }[] = [];
  for (const row of ids.rows) {
    const id = String(row.cohort_id);
    const st = await frozenState(db, id);
    if (st.throughD !== null)
      out.push({ cohortId: id, throughD: st.throughD, gapSessions: st.gapSessions });
  }
  return out;
}

/** The exact Owner steps shown with a `gap_too_long` refusal. */
export const GAP_TOO_LONG_STEPS =
  "More than " +
  String(MAX_CATCH_UP_SESSIONS) +
  " sessions were closed without this cohort, too many to replay in one request. Leave it frozen: " +
  "the other cohorts are not affected. Ask the builder to replay the skipped sessions for this " +
  "cohort in smaller steps (closeBooksDay with catchUpCohort, oldest first), then clear it here.";

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
  if (before.gapSessions > MAX_CATCH_UP_SESSIONS) {
    return res(HTTP_CONFLICT, {
      error: "gap_too_long",
      gapSessions: before.gapSessions,
      steps: GAP_TOO_LONG_STEPS,
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
      // 1. replay the skipped sessions for this cohort, oldest first; stop at the first problem
      for (const day of before.gapDays) {
        const r = await closeBooksDay(c.mainDb, {
          market: MARKET,
          d: day,
          now: () => new Date().toISOString(),
          catchUpCohort: cohortId,
        });
        if (r.failed.includes(cohortId)) {
          return { ok: false, reason: "catch_up_invariants_failed", detail: day };
        }
        if (!r.closed.includes(cohortId)) {
          return { ok: false, reason: "catch_up_blocked", detail: `${day}: ${r.status}` };
        }
      }
      // 2. only now clear: one transaction, re-checking that the cohort is still frozen and fully caught up
      const tx = await c.mainDb.transaction("write");
      try {
        // re-read inside the write transaction: a close that ran meanwhile may have changed the picture
        const again = await frozenState(tx, cohortId);
        if (again.throughD === null) return { ok: false, reason: "not_frozen" };
        if (again.gapSessions > 0) return { ok: false, reason: "catch_up_incomplete" };
        const seq = await tx.execute({
          sql: "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM cohort_event WHERE cohort_id = ?",
          args: [cohortId],
        });
        const detail = {
          type: INVARIANTS_CLEARED,
          through_d: again.throughD,
          bad_days: again.badDays,
          gap_sessions: before.gapSessions,
          catch_up_days: before.gapDays,
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
          body: { cohortId, throughD: again.throughD, gapSessions: before.gapSessions },
        };
      } finally {
        tx.close();
      }
    },
  });
}
