"use server";
// Settings > Region & markets: the Owner's switch-on and rollback (MKT-111, AT-71, D-1100, D-1101; M20 S1).
// Owner only: requireUser("admin") runs first (a refusal is a 403 and is audit-logged by the guard, AT-02). The market,
// the target mode and the reason come from the form and are validated again by `switchMarket`; the actor is always the
// signed-in Owner. `PRAXIS_MARKETS_ENABLED` is not touched here: it stays the Owner's own step (D-994).
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { switchMarket } from "@/lib/data/marketSwitch";
import { authDb, mainDb } from "@/lib/db/client";

const PATH = "/settings/region";

export type SwitchActionResult = { ok: true; changed: boolean } | { error: string };

export async function switchMarketAction(fd: FormData): Promise<SwitchActionResult> {
  const user = await requireUser("admin", PATH);
  const market = fd.get("market");
  const to = fd.get("to");
  const reason = fd.get("reason");
  try {
    const result = await switchMarket({
      mainDb: mainDb(),
      authDb: authDb(),
      env: process.env,
      meta: requestMeta(await headers()),
      actorId: user.id,
      market: typeof market === "string" ? market : undefined,
      to: typeof to === "string" ? to : undefined,
      reason: typeof reason === "string" ? reason : undefined,
    });
    if (!result.ok) return { error: result.error };
    revalidatePath(PATH);
    revalidatePath("/usage");
    return { ok: true, changed: result.changed };
  } catch {
    return { error: "unavailable" };
  }
}
