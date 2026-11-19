"use server";
// Expert page server action (M22 E1; KB-083, D-1472): the Owner accepts the risk for one expert source. Owner only:
// requireUser("admin") runs first (a refusal is a 403 and is audit-logged by the guard); the service re-checks the
// role, appends the audit row before the change and writes the licence row (src/lib/experts/licence/accept.ts).
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { acceptRisk } from "@/lib/experts/licence/accept";

export type AcceptRiskResult = { ok: true } | { error: string };

const ID_RE = /^[A-Za-z0-9_.:-]{1,32}$/; // threshold-ok: expert id column length (0022)

const field = (fd: FormData, name: string): string | undefined => {
  const v = fd.get(name);
  return typeof v === "string" ? v : undefined;
};

export async function acceptRiskAction(fd: FormData): Promise<AcceptRiskResult> {
  const expertId = field(fd, "expert");
  const user = await requireUser("admin", `/reviews/experts/${expertId ?? ""}`);
  try {
    const result = await acceptRisk(
      {
        mainDb: mainDb(),
        authDb: authDb(),
        env: process.env,
        meta: requestMeta(await headers()),
        actorId: user.id,
      },
      { expertId, sourceKey: field(fd, "source") },
    );
    if ("error" in result) return { error: result.error };
    if (expertId !== undefined && ID_RE.test(expertId)) {
      revalidatePath(`/reviews/experts/${expertId}`);
    }
    return { ok: true };
  } catch {
    return { error: "unavailable" };
  }
}
