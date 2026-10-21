"use server";
// Remembers the Strategies sort chip per user (UXN-046a, UX-110; TST-122). requireUser first (every
// role may keep its own preference, ROL-102a), the target is always the actor, the value is checked
// against the four chips, the change and its audit event commit together, and the page is revalidated.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb } from "@/lib/db/client";
import { writeStrategySort } from "@/lib/preferences/strategySort";
import type { ActionResult } from "@/lib/users/messages";

const PATH = "/strategies";

export async function setSortPreferenceAction(sort: string): Promise<ActionResult> {
  const user = await requireUser("own_preferences", PATH);
  try {
    const r = await writeStrategySort(
      authDb(),
      process.env,
      requestMeta(await headers()),
      { id: user.id },
      sort,
    );
    if (!r.ok) return { error: r.error };
  } catch {
    return { error: "unavailable" };
  }
  revalidatePath(PATH);
  return { ok: true };
}
