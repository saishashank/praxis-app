// The one read of the Owner's own tool preferences (M21 A1, D-1214, D-1217, D-1218). `real_capital` and `broker_links`
// are returned only to the PINNED Owner (role owner and the pinned e-mail, the Blueprint rule) and only while the Owner
// switch `owner_real_money_tools` is "on". Everyone else, and the Owner while the switch is off, gets null, exactly as
// the tools answer as a missing route. A2 and B1 read these values through this function and nowhere else.
import type { Client } from "@libsql/client";
import { isOwnerEmail, type AuthEnv } from "@/lib/auth/env";
import { getConfig } from "@/lib/config/store";
import { getPreferences, type Preferences } from "./service";

export type OwnerToolPrefs = Pick<Preferences, "real_capital" | "broker_links">;

/** The pin, from the stored row: an active user with role owner whose e-mail is the pinned one. */
export async function isPinnedOwnerId(
  auth: Pick<Client, "execute">,
  userId: number,
  env: AuthEnv,
): Promise<boolean> {
  // rows-ok: app_user primary-key read
  const r = await auth.execute({
    sql: "SELECT email, role, status FROM app_user WHERE id = ?",
    args: [userId],
  });
  const row = r.rows[0];
  return (
    row !== undefined &&
    String(row.status) === "active" &&
    String(row.role) === "owner" &&
    isOwnerEmail(env, String(row.email))
  );
}

export async function ownerTools(
  dbs: { auth: Client; main: Client },
  user: { id: number } | null,
  env: AuthEnv,
): Promise<OwnerToolPrefs | null> {
  try {
    if (user === null || !(await isPinnedOwnerId(dbs.auth, user.id, env))) return null;
    if ((await getConfig(dbs.main, "owner_real_money_tools")) !== "on") return null; // fails closed on a read error
    const p = await getPreferences(dbs.auth, user.id);
    return { real_capital: p.real_capital, broker_links: p.broker_links };
  } catch {
    return null;
  }
}
