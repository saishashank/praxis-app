"use server";
// My alerts actions (UXN-303, M17 WP8, D-473). Both change only the signed-in user's own state
// (requireUser("own_preferences") first; no user id is read from the form). Mute is one append-only
// `cleared` transition with reason `muted` (ARN-114, the same row the alert evaluator would write), and
// only for an armed alert of the user's own. "Alerts for all picks" writes the `pick_alerts` preference
// through the audited preferences service.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { updatePreferences } from "@/lib/preferences/service";
import { insertTransition } from "@/lib/alerts/pick/store";
import type { AlertRow } from "@/lib/alerts/pick/types";
import type { ActionResult } from "@/lib/users/messages";

const PATH = "/alerts";
const ID_RE = /^[0-9a-f]{64}$/;

export async function muteAlertAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser("own_preferences", PATH);
  const id = fd.get("alert_id");
  if (typeof id !== "string" || !ID_RE.test(id)) return { error: "invalid" };
  try {
    const r = await mainDb().execute({
      sql: `SELECT alert_id, seq, user_id, market, pick_d, profile, rank, code, session_d, state,
                   limit_micro, stop_micro FROM pick_alert WHERE alert_id = ? AND user_id = ?
            ORDER BY seq DESC LIMIT 1`,
      args: [id, String(user.id)],
    });
    const x = r.rows[0];
    if (!x) return { error: "invalid" };
    if (String(x.state) !== "armed") return { error: "invalid" };
    const row: AlertRow = {
      alertId: id,
      seq: Number(x.seq) + 1, // money-float-ok: SQL integer column
      userId: String(x.user_id),
      market: String(x.market),
      pickD: String(x.pick_d),
      profile: String(x.profile),
      rank: Number(x.rank), // money-float-ok: SQL integer column
      code: String(x.code),
      sessionD: String(x.session_d),
      state: "cleared",
      limitMicro: BigInt(x.limit_micro as number),
      stopMicro: BigInt(x.stop_micro as number),
      at: new Date().toISOString(),
      hitMicro: null,
      quoteAt: null,
      clearReason: "muted",
    };
    await insertTransition(mainDb(), row); // false = a tick cleared it first: the end state is the same
  } catch {
    return { error: "unavailable" };
  }
  revalidatePath(PATH);
  return { ok: true };
}

/** "Alerts for all picks": switches the user's own `pick_alerts` preference on or off. */
export async function setAlertsForAllAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser("own_preferences", PATH);
  const v = fd.get("pick_alerts");
  try {
    const r = await updatePreferences(
      authDb(),
      process.env,
      requestMeta(await headers()),
      { id: user.id },
      { pick_alerts: v },
    );
    if (!r.ok) return { error: r.error };
  } catch {
    return { error: "unavailable" };
  }
  revalidatePath(PATH);
  revalidatePath("/settings/alerts");
  return { ok: true };
}
