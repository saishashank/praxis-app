"use server";
// Data review queue server actions (DAT-221, UX-114). Owner only: requireUser("admin") runs first
// (a refusal is a 403 and is audit-logged by the guard, AT-02). The action id and the decision come
// from the form but are validated by the service; the actor is always the signed-in Owner.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { resolveCorporateAction } from "@/lib/data/corporateActions/admin";
import { authDb, mainDb } from "@/lib/db/client";

const PATH = "/review";

export type ReviewResult = { ok: true } | { error: string };

async function decide(fd: FormData, decision: "confirm" | "reject"): Promise<ReviewResult> {
  const user = await requireUser("admin", PATH);
  const idText = fd.get("id");
  try {
    const result = await resolveCorporateAction({
      mainDb: mainDb(),
      authDb: authDb(),
      env: process.env,
      meta: requestMeta(await headers()),
      actorId: user.id,
      actionId:
        typeof idText === "string" && /^\d{1,12}$/.test(idText) ? Number(idText) : undefined,
      decision,
    });
    if (!result.ok) return { error: result.error };
    revalidatePath(PATH);
    return { ok: true };
  } catch {
    return { error: "unavailable" };
  }
}

export async function confirmCorporateActionAction(fd: FormData): Promise<ReviewResult> {
  return decide(fd, "confirm");
}

export async function rejectCorporateActionAction(fd: FormData): Promise<ReviewResult> {
  return decide(fd, "reject");
}
