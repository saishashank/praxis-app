"use server";
// Settings > Alerts (UXN-304, M17 WP8, D-472): the three on/off switches. Own preferences only; the
// Also holds the Picks sort toggle's action (UXN-309, D-474): the Picks pages carry no server action, so it lives
// with the other own-preference actions of this page. The field list is fixed here so this form can never write another page's fields. Quiet hours use the
// existing `setQuietHoursAction`.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb } from "@/lib/db/client";
import { updatePreferences } from "@/lib/preferences/service";
import type { ActionResult } from "@/lib/users/messages";

const FIELDS = ["pick_alerts", "cleared_pick_emails", "intraday_candidate_emails"] as const;

export async function updateAlertSettingsAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser("own_preferences", "/settings/alerts");
  const patch: Record<string, unknown> = {};
  for (const f of FIELDS) {
    const v = fd.get(f);
    if (v !== null) patch[f] = v;
  }
  try {
    const r = await updatePreferences(
      authDb(),
      process.env,
      requestMeta(await headers()),
      { id: user.id },
      patch,
    );
    if (!r.ok) return { error: r.error };
  } catch {
    return { error: "unavailable" };
  }
  revalidatePath("/settings/alerts");
  revalidatePath("/alerts");
  return { ok: true };
}

/** Picks sort toggle (UXN-309): stores the signed-in user's own `picks_sort`; the service validates it. */
export async function setPicksSortAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser("own_preferences", "/picks");
  try {
    const r = await updatePreferences(
      authDb(),
      process.env,
      requestMeta(await headers()),
      { id: user.id },
      { picks_sort: fd.get("picks_sort") },
    );
    if (!r.ok) return { error: r.error };
  } catch {
    return { error: "unavailable" };
  }
  revalidatePath("/picks");
  revalidatePath("/");
  return { ok: true };
}
