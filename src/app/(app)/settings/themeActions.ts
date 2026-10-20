"use server";
// The header theme shortcut (UXN-280, TST-122): steps the signed-in user's theme to the next of the
// six. requireUser("own_preferences") first, the target is always the actor, the service validates
// and audits the change, and the layout is revalidated so the new theme applies without a reload.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb } from "@/lib/db/client";
import { getPreferences, updatePreferences } from "@/lib/preferences/service";
import { nextTheme } from "@/lib/ui/nav";
import type { ActionResult } from "@/lib/users/messages";

const PATH = "/settings";

export async function cycleThemeAction(): Promise<ActionResult> {
  const user = await requireUser("own_preferences", PATH);
  try {
    const db = authDb();
    const current = await getPreferences(db, user.id);
    const r = await updatePreferences(
      db,
      process.env,
      requestMeta(await headers()),
      { id: user.id },
      { theme: nextTheme(current.theme) },
    );
    if (!r.ok) return { error: r.error };
  } catch {
    return { error: "unavailable" };
  }
  revalidatePath("/", "layout"); // the theme lives in the root layout
  return { ok: true };
}
