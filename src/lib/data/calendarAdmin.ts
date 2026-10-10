// Trading calendar reads and the Owner's one-click confirmation (DAT-160, D-057 #11).
// Confirmation sets confirmed = 1 on every unconfirmed row of one market and year. The only
// change the table's trigger allows is confirmed 0 -> 1, so nothing else can change.
//
// Atomicity (two databases, so no single transaction; same rule as D-047): the audit event
// `calendar.confirm` (auth DB) is appended FIRST. If that fails nothing has changed. Only then
// are the rows updated, in ONE write transaction; if that fails a compensating
// `calendar.confirm_failed` event is appended (best effort). A confirmation never exists
// without an audit row. A second confirm finds no unconfirmed rows, writes nothing and appends
// no event (idempotent).
import type { Client } from "@libsql/client";
import { audit, NO_META, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import { summariseCalendar, type CalendarRow, type CalendarSummary } from "./calendar";

export const CALENDAR_MARKETS = ["AU"] as const;

export type ConfirmError = "invalid" | "forbidden" | "not_found" | "unavailable";
export type ConfirmResult = { ok: true; rows: number } | { ok: false; error: ConfirmError };

export async function loadCalendarRows(
  db: Pick<Client, "execute">,
  market: string,
  from?: string,
  to?: string,
): Promise<CalendarRow[]> {
  const res = await db.execute({
    sql: `SELECT d, kind, close_time, confirmed FROM trading_calendar
          WHERE market = ? AND d >= ? AND d <= ? ORDER BY d`,
    args: [market, from ?? "0000-01-01", to ?? "9999-12-31"],
  });
  return res.rows.map((r) => ({
    d: String(r.d),
    kind: String(r.kind) as CalendarRow["kind"],
    close_time: r.close_time === null ? null : String(r.close_time),
    confirmed: Number(r.confirmed) === 1 ? 1 : 0,
  }));
}

export async function calendarYearSummary(
  db: Pick<Client, "execute">,
  market: string,
  year: number,
): Promise<CalendarSummary> {
  const rows = await loadCalendarRows(db, market, `${year}-01-01`, `${year}-12-31`);
  return summariseCalendar(market, year, rows);
}

export type ConfirmInput = {
  mainDb: Client;
  authDb: Client;
  env: AuthEnv;
  meta?: RequestMeta;
  actorId: number;
  market: unknown;
  year: unknown;
  now?: Date;
};

const fail = (error: ConfirmError): ConfirmResult => ({ ok: false, error });

export async function confirmCalendar(p: ConfirmInput): Promise<ConfirmResult> {
  const meta = p.meta ?? NO_META;
  const now = (p.now ?? new Date()).toISOString();

  // Defence in depth: the caller passed requireUser("admin"); the actor must still be an active Owner.
  try {
    const r = await p.authDb.execute({
      sql: "SELECT 1 FROM app_user WHERE id = ? AND role = 'owner' AND status = 'active'",
      args: [p.actorId],
    });
    if (r.rows.length !== 1) return fail("forbidden");
  } catch {
    return fail("unavailable");
  }

  if (typeof p.market !== "string" || !(CALENDAR_MARKETS as readonly string[]).includes(p.market)) {
    return fail("invalid");
  }
  const market = p.market;
  if (typeof p.year !== "number" || !Number.isInteger(p.year) || p.year < 2000 || p.year > 2100) {
    return fail("invalid");
  }
  const year = p.year;
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  let rows: number;
  try {
    const all = await p.mainDb.execute({
      sql: "SELECT COUNT(*) AS n FROM trading_calendar WHERE market = ? AND d >= ? AND d <= ?",
      args: [market, from, to],
    });
    if (Number(all.rows[0].n) === 0) return fail("not_found");
    const res = await p.mainDb.execute({
      sql: `SELECT COUNT(*) AS n FROM trading_calendar
            WHERE market = ? AND d >= ? AND d <= ? AND confirmed = 0`,
      args: [market, from, to],
    });
    rows = Number(res.rows[0].n);
  } catch {
    return fail("unavailable");
  }
  if (rows === 0) return { ok: true, rows: 0 }; // already confirmed: nothing to write or audit

  const base = { at: now, actorUserId: p.actorId, targetType: "calendar", targetId: market };
  try {
    await audit(p.authDb, p.env, meta, {
      ...base,
      action: "calendar.confirm",
      detail: { market, year, rows },
    });
  } catch {
    return fail("unavailable"); // nothing has changed
  }

  try {
    const tx = await p.mainDb.transaction("write");
    try {
      await tx.execute({
        sql: `UPDATE trading_calendar SET confirmed = 1
              WHERE market = ? AND d >= ? AND d <= ? AND confirmed = 0`,
        args: [market, from, to],
      });
      await tx.commit();
    } finally {
      tx.close();
    }
    return { ok: true, rows };
  } catch {
    try {
      await audit(p.authDb, p.env, meta, {
        ...base,
        action: "calendar.confirm_failed",
        detail: { market, year },
      });
    } catch {
      // best effort: the confirmation did not happen either way
    }
    return fail("unavailable");
  }
}
