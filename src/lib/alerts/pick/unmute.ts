// M21 C3 (UXN-322, D-1207): the per-alert unmute. `pick_alert` stays append-only: an unmute is one more
// row, `armed`, at seq + 1, copying the muted row's limit and stop (nothing is updated or deleted). It is
// legal only from a latest row that is `cleared` with reason `muted`, while the user's "Alerts for all
// picks" is on and the pick is still on the current list (the poll's own `armableOrders` test). Every
// other cleared reason stays final (ARN-114). This reverses D-473 for `muted` only; the CHECK lists and
// the evaluator are unchanged, so the next tick evaluates the re-armed row like any armed alert.
import type { Exec } from "@/lib/cortex/store/common";
import { getConfig } from "@/lib/config/store";
import type { Client } from "@libsql/client";
import { armableOrders } from "./armable";
import { insertTransition } from "./store";
import type { AlertRow } from "./types";

export type UnmuteResult = { ok: true } | { error: "invalid" | "alerts_off" | "not_listed" };

const ID_RE = /^[0-9a-f]{64}$/;

/** The user's effective "Alerts for all picks": the stored choice, else the Owner default (D-385). */
export async function alertsOnFor(auth: Exec, main: Exec, userId: string): Promise<boolean> {
  const r = await auth.execute({
    sql: "SELECT u.role AS role, p.prefs_json AS prefs_json FROM app_user u LEFT JOIN user_preference p ON p.user_id = u.id WHERE u.id = ? AND u.status = 'active'",
    args: [Number(userId)],
  });
  if (r.rows.length === 0) return false;
  let pref: unknown = null;
  if (r.rows[0].prefs_json !== null) {
    try {
      const v: unknown = JSON.parse(String(r.rows[0].prefs_json));
      pref =
        typeof v === "object" && v !== null ? (v as Record<string, unknown>).pick_alerts : null;
    } catch {
      pref = null;
    }
  }
  if (pref === "on") return true;
  if (pref === "off") return false;
  if (String(r.rows[0].role) !== "owner") return false;
  return String(await getConfig(main as Client, "pick_alerts_default_owner")) === "on";
}

/** Appends the `armed` row of an unmute; never throws on a decided refusal. `sessionD` = today's market date. */
export async function unmuteAlert(
  deps: { main: Exec; auth: Exec; now: () => Date; sessionD: string },
  userId: string,
  alertId: string,
): Promise<UnmuteResult> {
  if (!ID_RE.test(alertId)) return { error: "invalid" };
  // rows-ok: one alert's latest row (primary key prefix, LIMIT 1)
  const r = await deps.main.execute({
    sql: `SELECT alert_id, seq, user_id, market, pick_d, profile, rank, code, session_d, state, clear_reason,
                 limit_micro, stop_micro FROM pick_alert WHERE alert_id = ? AND user_id = ?
          ORDER BY seq DESC LIMIT 1`,
    args: [alertId, userId],
  });
  const x = r.rows[0];
  if (!x) return { error: "invalid" };
  if (String(x.state) !== "cleared" || String(x.clear_reason) !== "muted") {
    return { error: "invalid" }; // only a muted alert comes back; every other clear is final
  }
  if (!(await alertsOnFor(deps.auth, deps.main, userId))) return { error: "alerts_off" };
  const market = String(x.market);
  const pickD = String(x.pick_d);
  const profile = String(x.profile);
  const rank = Number(x.rank); // money-float-ok: SQL integer column
  const listed = (await armableOrders(deps.main, market, deps.sessionD)).some(
    (o) => o.pickKey.d === pickD && o.pickKey.profile === profile && o.pickKey.rank === rank,
  );
  if (!listed) return { error: "not_listed" };
  const row: AlertRow = {
    alertId,
    seq: Number(x.seq) + 1, // money-float-ok: SQL integer column
    userId,
    market,
    pickD,
    profile,
    rank,
    code: String(x.code),
    sessionD: String(x.session_d),
    state: "armed",
    limitMicro: BigInt(x.limit_micro as number),
    stopMicro: BigInt(x.stop_micro as number),
    at: deps.now().toISOString(),
    hitMicro: null,
    quoteAt: null,
    clearReason: null,
  };
  await insertTransition(deps.main, row); // false = a writer took this seq first: one row either way
  return { ok: true };
}
