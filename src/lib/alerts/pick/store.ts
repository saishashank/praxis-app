// M17 WP3: storage of pick alert transitions (ARN-115). `pick_alert` is append-only (triggers abort
// UPDATE and DELETE): a transition is one INSERT with seq = previous seq + 1, UNIQUE (alert_id, seq).
// A second writer of the same transition (two ticks, a retried POST) hits the unique key and writes
// nothing, so the caller sends no second mail. Reads other tables only to decide transitions.
import { createHash } from "node:crypto";
import type { Exec } from "@/lib/cortex/store/common";
import type { AlertRow, AlertStateName, ClearReason } from "./types";

/** sha of user|market|d_pick|profile|rank (design, schema of `pick_alert`). */
export function alertIdOf(
  userId: string,
  market: string,
  pickD: string,
  profile: string,
  rank: number,
): string {
  return createHash("sha256")
    .update(`${userId}|${market}|${pickD}|${profile}|${rank}`)
    .digest("hex");
}

const COLUMNS = `alert_id, seq, user_id, market, pick_d, profile, rank, code, session_d, state,
  limit_micro, stop_micro, at, hit_micro, quote_at, clear_reason`;

const rowOf = (x: Record<string, unknown>): AlertRow => ({
  alertId: String(x.alert_id),
  seq: Number(x.seq),
  userId: String(x.user_id),
  market: String(x.market),
  pickD: String(x.pick_d),
  profile: String(x.profile),
  rank: Number(x.rank),
  code: String(x.code),
  sessionD: String(x.session_d),
  state: String(x.state) as AlertStateName,
  limitMicro: BigInt(x.limit_micro as number),
  stopMicro: BigInt(x.stop_micro as number),
  at: String(x.at),
  hitMicro: x.hit_micro === null ? null : BigInt(x.hit_micro as number),
  quoteAt: x.quote_at === null ? null : String(x.quote_at),
  clearReason: x.clear_reason === null ? null : (String(x.clear_reason) as ClearReason),
});

export async function alertExists(db: Exec, alertId: string): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT 1 FROM pick_alert WHERE alert_id = ? LIMIT 1",
    args: [alertId],
  });
  return r.rows.length > 0;
}

export type NewTransition = Omit<AlertRow, "seq"> & { seq: number };

/** Inserts one transition row; false = the (alert_id, seq) row already existed (nothing written). */
export async function insertTransition(db: Exec, t: NewTransition): Promise<boolean> {
  const r = await db.execute({
    sql:
      `INSERT INTO pick_alert (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
      "ON CONFLICT DO NOTHING",
    args: [
      t.alertId,
      t.seq,
      t.userId,
      t.market,
      t.pickD,
      t.profile,
      t.rank,
      t.code,
      t.sessionD,
      t.state,
      t.limitMicro,
      t.stopMicro,
      t.at,
      t.hitMicro,
      t.quoteAt,
      t.clearReason,
    ],
  });
  return r.rowsAffected > 0;
}

export type ActiveAlert = {
  /** Latest row (current state, max seq); never `cleared`. */
  latest: AlertRow;
  /** Session of the first (`armed`) row. */
  armedSession: string;
};

/** Alerts whose latest transition is not `cleared`, oldest first. */
export async function activeAlerts(db: Exec, market: string): Promise<ActiveAlert[]> {
  const r = await db.execute({
    sql: `SELECT ${COLUMNS},
              (SELECT f.session_d FROM pick_alert f WHERE f.alert_id = a.alert_id AND f.seq = 1) AS armed_session
       FROM pick_alert a
       WHERE a.market = ? AND a.state <> 'cleared'
         AND a.seq = (SELECT MAX(b.seq) FROM pick_alert b WHERE b.alert_id = a.alert_id)
       ORDER BY a.pick_d, a.profile, a.rank, a.user_id`,
    args: [market],
  });
  return r.rows.map((x) => ({ latest: rowOf(x), armedSession: String(x.armed_session) }));
}

/** True when the simulated book bought (or closed) the pick (`pick_outcome`): reason `filled`. */
export async function pickFilled(db: Exec, a: AlertRow): Promise<boolean> {
  const r = await db.execute({
    sql: `SELECT 1 FROM pick_outcome WHERE market = ? AND d = ? AND profile = ? AND rank = ?
          AND kind = 'pick' AND state IN ('bought','closed') LIMIT 1`,
    args: [a.market, a.pickD, a.profile, a.rank],
  });
  return r.rows.length > 0;
}

/** Codes flagged halted by the latest universe snapshot on or before the session. */
export async function haltedCodes(db: Exec, market: string, session: string): Promise<Set<string>> {
  const r = await db.execute({
    sql:
      "SELECT code FROM universe_snapshot WHERE market = ? AND halted = 1 " +
      "AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d <= ?)",
    args: [market, market, session],
  });
  return new Set(r.rows.map((x) => String(x.code)));
}

/** Watch-listed codes (after the armed picks in the poll order). */
export async function watchCodes(db: Exec, market: string, session: string): Promise<string[]> {
  const r = await db.execute({
    sql:
      "SELECT DISTINCT code FROM watch_list_owner WHERE market = ? AND removed_at IS NULL " +
      "AND expires_d >= ? ORDER BY code",
    args: [market, session],
  });
  return r.rows.map((x) => String(x.code));
}

/**
 * Users whose pick alerts are on (ARN-112): the stored `pick_alerts` preference when present, else
 * the Owner default (`pick_alerts_default_owner`) and off for every other role (D-385). Auth DB, read
 * only. A user the app has revoked or not yet activated never receives alerts.
 */
export async function alertRecipients(auth: Exec, ownerDefaultOn: boolean): Promise<string[]> {
  const r = await auth.execute(
    "SELECT u.id AS id, u.role AS role, p.prefs_json AS prefs_json FROM app_user u " +
      "LEFT JOIN user_preference p ON p.user_id = u.id WHERE u.status = 'active' ORDER BY u.id",
  );
  const out: string[] = [];
  for (const x of r.rows) {
    let pref: unknown = null;
    if (x.prefs_json !== null) {
      try {
        const v: unknown = JSON.parse(String(x.prefs_json));
        pref =
          typeof v === "object" && v !== null ? (v as Record<string, unknown>).pick_alerts : null;
      } catch {
        pref = null;
      }
    }
    const on =
      pref === "on" ? true : pref === "off" ? false : String(x.role) === "owner" && ownerDefaultOn;
    if (on) out.push(String(x.id));
  }
  return out;
}
