"use server";
// Settings actions (UX-110, UXN-160, UXN-280..282, ROL-102a). Every role may change ONLY their own
// preferences: requireUser("own_preferences") first, the target is the signed-in user (no user id
// is read from the form), the service validates every field again (SEC-013). Each page of Settings
// has its own action with its own field list, so a form can never write another page's fields.
// All writes go through the audited preferences service (same transaction as the audit event);
// quiet hours use the audited alerts writer that stores them beside the same preferences row.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { setQuietHours } from "@/lib/alerts/api";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb } from "@/lib/db/client";
import { updatePreferences } from "@/lib/preferences/service";
import type { ActionResult } from "@/lib/users/messages";

const PATH = "/settings";
// Anything else in a form is ignored here; the service itself rejects unknown fields for any other caller.
const PERSONAL_FIELDS = ["time_format", "alert_p1", "alert_p2"] as const;
const APPEARANCE_FIELDS = ["theme", "motion"] as const;
const REGION_FIELDS = ["default_market", "times_in"] as const;

async function save(path: string, fields: readonly string[], fd: FormData): Promise<ActionResult> {
  const user = await requireUser("own_preferences", path);
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    const v = fd.get(f);
    if (v !== null) patch[f] = v; // a File value fails validation as a non-string
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
  revalidatePath("/", "layout"); // theme and motion live in the root layout
  return { ok: true };
}

/** Settings > Personal: time format and P1/P2 alert delivery (P0 is not a setting). */
export async function updatePreferencesAction(fd: FormData): Promise<ActionResult> {
  return save(PATH, PERSONAL_FIELDS, fd);
}

/** Settings > Appearance: theme (UXN-280) and the Motion switch (UXN-281). */
export async function updateAppearanceAction(fd: FormData): Promise<ActionResult> {
  return save("/settings/appearance", APPEARANCE_FIELDS, fd);
}

/** Settings > Region & markets: opening market and Melbourne or exchange time (UXN-282). */
export async function updateRegionAction(fd: FormData): Promise<ActionResult> {
  return save("/settings/region", REGION_FIELDS, fd);
}

/**
 * Settings > Personal: quiet hours (UXN-160). `quiet_off` set clears them; otherwise `quiet_start`
 * and `quiet_end` (HH:MM Melbourne, may wrap midnight) are required. P0 is never suppressed.
 */
export async function setQuietHoursAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser("own_preferences", PATH);
  let q: { start: unknown; end: unknown } | null;
  if (fd.get("quiet_off") !== null) q = null;
  else q = { start: fd.get("quiet_start"), end: fd.get("quiet_end") };
  try {
    const r = await setQuietHours(
      {
        authDb: authDb(),
        env: process.env,
        meta: requestMeta(await headers()),
      },
      { id: user.id },
      q,
    );
    if (!r.ok) return { error: r.error };
  } catch {
    return { error: "unavailable" };
  }
  revalidatePath("/", "layout"); // the alert bell badge honours quiet hours
  return { ok: true };
}
