"use server";
// System Health "Worker slots" server action (M8 T11, decision 32, D-155). Owner only:
// requireUser("admin") runs FIRST (a refusal is a 403 and is audit-logged by the guard, AT-02), then
// the audit-first writer in src/lib/golive/slots.ts. The actor is the signed-in Owner; the slot ids
// and the confirmation come from the form but are validated by the writer.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { setSlotsEnabled } from "@/lib/golive/slots";

const PATH = "/health";

export type SlotsActionResult = { ok: true; changed: boolean } | { error: string };

export async function setSlotsEnabledAction(fd: FormData): Promise<SlotsActionResult> {
  const user = await requireUser("admin", PATH);
  try {
    const result = await setSlotsEnabled({
      mainDb: mainDb(),
      authDb: authDb(),
      env: process.env,
      meta: requestMeta(await headers()),
      actorId: user.id,
      slots: fd.getAll("slot").filter((v): v is string => typeof v === "string"),
      confirmed: fd.get("confirm") === "yes",
    });
    if (!result.ok) return { error: result.error };
    revalidatePath(PATH);
    return { ok: true, changed: result.changed };
  } catch {
    return { error: "unavailable" };
  }
}
