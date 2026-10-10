"use server";
// Configuration server action (UX-116, PLT-041). Owner only: requireUser("admin") runs first (a
// refusal is a 403 and is audit-logged by the guard, AT-02). Origin / rate limits (SEC-011/014)
// are applied by the proxy gate. The service validates the input again (SEC-013). The result is a
// code plus safe text only; no internals leave the server.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { updateConfig } from "@/lib/config/admin";
import { authDb, mainDb } from "@/lib/db/client";

const PATH = "/config";

export type ConfigActionResult = { ok: true } | { error: string; message?: string };

function text(fd: FormData, name: string): string | undefined {
  const v = fd.get(name);
  return typeof v === "string" ? v : undefined;
}

export async function updateConfigAction(fd: FormData): Promise<ConfigActionResult> {
  const user = await requireUser("admin", PATH);
  try {
    const result = await updateConfig({
      mainDb: mainDb(),
      authDb: authDb(),
      env: process.env,
      meta: requestMeta(await headers()),
      actorId: user.id,
      key: text(fd, "key"),
      scope: "global", // per-market scopes arrive with the markets (ROL-107); never taken from the client
      rawValue: text(fd, "value"),
      reason: text(fd, "reason"),
    });
    if (!result.ok) {
      return result.message === undefined
        ? { error: result.error }
        : { error: result.error, message: result.message };
    }
  } catch {
    return { error: "unavailable" };
  }
  revalidatePath(PATH);
  return { ok: true };
}
