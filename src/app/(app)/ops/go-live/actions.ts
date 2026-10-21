"use server";
// Go-live sign-off server action (M8 T11, decisions 33 and 34). Owner only: requireUser("admin")
// runs FIRST (a refusal is a 403 and is audit-logged by the guard, AT-02), then the audit-first
// writer in src/lib/golive/signoff.ts. The actor is the signed-in Owner. The action never changes
// the market mode: the Owner does that afterwards in the System Health data controls.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { signOffGoLive } from "@/lib/golive/signoff";

const PATH = "/ops/go-live";

export type SignoffActionResult = { ok: true; changed: boolean } | { error: string };

const text = (fd: FormData, name: string): string | undefined => {
  const v = fd.get(name);
  return typeof v === "string" ? v : undefined;
};

export async function signOffGoLiveAction(fd: FormData): Promise<SignoffActionResult> {
  const user = await requireUser("admin", PATH);
  try {
    const result = await signOffGoLive({
      mainDb: mainDb(),
      authDb: authDb(),
      env: process.env,
      meta: requestMeta(await headers()),
      actorId: user.id,
      items: fd.getAll("item").filter((v): v is string => typeof v === "string"),
      confirmation: text(fd, "confirmation"),
      note: text(fd, "note"),
      commit: text(fd, "commit"),
    });
    if (!result.ok) return { error: result.error };
    revalidatePath(PATH);
    revalidatePath("/health");
    return { ok: true, changed: result.changed };
  } catch {
    return { error: "unavailable" };
  }
}
