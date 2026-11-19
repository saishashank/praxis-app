// State `alerts-muted` (TST-135 (a), AT-62): one pick alert that armed and was then cleared because the user
// muted it (clear reason `muted`), with the mail outcome `off`, so My alerts and Settings > Alerts render a
// muted history from stored rows. Synthetic ZZ code, fixed ids, idempotent (the unique (alert_id, seq) keeps
// the alert rows single; the mail row is guarded by a NOT EXISTS).
// An alert id is 64 lower-case hex characters (the unmute action refuses any other shape as "invalid", D-1330).
export const ALERT_ID = "e2ea" + "0".repeat(60);
export const CODE = "ZZAM";

/**
 * pick_alert.user_id is String(app_user.id) (src/lib/ui/loaders/pickAlerts.ts), and the viewer's row lives in the auth DB,
 * so the id comes in through ctx.viewerId (e2e/prepare-db.mjs reads it). A literal name would match no signed-in user.
 * @param {import("@libsql/client").Client} client @param {string} nowIso @param {{ viewerId?: string }} [ctx]
 */
export async function apply(client, nowIso, ctx = {}) {
  const viewerId = ctx.viewerId ?? "e2e-viewer";
  const d = nowIso.slice(0, 10);
  /** @param {number} seq @param {string} state @param {string | null} reason */
  const row = (seq, state, reason) => ({
    sql: `INSERT OR IGNORE INTO pick_alert (alert_id, seq, user_id, market, pick_d, profile, rank, code, session_d, state,
            limit_micro, stop_micro, at, hit_micro, quote_at, clear_reason)
          VALUES (?, ?, ?, 'AU', ?, 'balanced', 1, ?, ?, ?, 10050000, 9200000, ?, NULL, NULL, ?)`,
    args: [ALERT_ID, seq, viewerId, d, CODE, d, state, nowIso, reason],
  });
  await client.batch(
    [
      row(1, "armed", null),
      row(2, "cleared", "muted"),
      {
        sql: `INSERT INTO pick_alert_mail (alert_id, kind, email_key, status, at)
              SELECT ?, 'pick_cleared', NULL, 'off', ?
              WHERE NOT EXISTS (SELECT 1 FROM pick_alert_mail WHERE alert_id = ?)`,
        args: [ALERT_ID, nowIso, ALERT_ID],
      },
    ],
    "write",
  );
}
