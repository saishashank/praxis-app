"use server";
// Sources page server action (M22 E2; UXN-296, DAT-229, D-1480): the Owner approves, dismisses or snoozes (90 days) a
// discovery candidate. Owner only: requireUser("admin") runs first (a refusal is a 403 and is audit-logged by the guard); the
// service re-checks the role, appends the audit row before the change and then writes (src/lib/experts/poll/candidates.ts).
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { decideCandidate } from "@/lib/experts/poll/candidates";

export type CandidateActionResult = { ok: true } | { error: string };

const PATH = "/reviews/experts/sources";

const field = (fd: FormData, name: string): string | undefined => {
  const v = fd.get(name);
  return typeof v === "string" ? v : undefined;
};

export async function candidateAction(fd: FormData): Promise<CandidateActionResult> {
  const user = await requireUser("admin", PATH);
  try {
    const result = await decideCandidate(
      {
        mainDb: mainDb(),
        authDb: authDb(),
        env: process.env,
        meta: requestMeta(await headers()),
        actorId: user.id,
      },
      field(fd, "action"),
      field(fd, "expert"),
    );
    if ("error" in result) return { error: result.error };
    revalidatePath(PATH);
    revalidatePath("/reviews/experts");
    return { ok: true };
  } catch {
    return { error: "unavailable" };
  }
}
