"use server";
// System Health server action: the Owner's one-click confirmation of a trading calendar year
// (DAT-160, D-057 #11). Owner only: requireUser("admin") runs first (a refusal is a 403 and is
// audit-logged by the guard, AT-02). The market and year come from the form but are validated by
// the service; the actor is always the signed-in Owner.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { confirmCalendar } from "@/lib/data/calendarAdmin";
import { authDb, mainDb } from "@/lib/db/client";

const PATH = "/health";

export type ConfirmCalendarResult = { ok: true; rows: number } | { error: string };

export async function confirmCalendarAction(fd: FormData): Promise<ConfirmCalendarResult> {
  const user = await requireUser("admin", PATH);
  const market = fd.get("market");
  const yearText = fd.get("year");
  try {
    const result = await confirmCalendar({
      mainDb: mainDb(),
      authDb: authDb(),
      env: process.env,
      meta: requestMeta(await headers()),
      actorId: user.id,
      market: typeof market === "string" ? market : undefined,
      year: typeof yearText === "string" && /^\d{4}$/.test(yearText) ? Number(yearText) : undefined,
    });
    if (!result.ok) return { error: result.error };
    revalidatePath(PATH);
    return { ok: true, rows: result.rows };
  } catch {
    return { error: "unavailable" };
  }
}
