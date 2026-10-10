"use server";
// Personal preferences action (UX-110, ROL-102a). Every role may change ONLY their own
// preferences: requireUser("own_preferences") first, the target is the signed-in user (no user id
// is read from the form), the service validates every field again (SEC-013).
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb } from "@/lib/db/client";
import { updatePreferences } from "@/lib/preferences/service";
import type { ActionResult } from "@/lib/users/messages";

const PATH = "/settings";
// Form field names that map to preferences. Anything else in the form is ignored here; the service
// itself rejects unknown fields for any other caller.
const FIELDS = ["theme", "default_market", "time_format", "alert_p1", "alert_p2"] as const;

export async function updatePreferencesAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser("own_preferences", PATH);
  const patch: Record<string, unknown> = {};
  for (const f of FIELDS) {
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
  revalidatePath("/", "layout"); // the theme lives in the root layout
  return { ok: true };
}
