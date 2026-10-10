// Sign-out everywhere (PLT-033): bump session_version so every existing session fails its next check.
import type { Client } from "@libsql/client";
import type { AuthEnv } from "./env";
import { audit, NO_META, type RequestMeta } from "./audit";

export async function signOutEverywhere(
  db: Client,
  env: AuthEnv,
  uid: number,
  meta: RequestMeta = NO_META,
): Promise<void> {
  await db.execute({
    sql: "UPDATE app_user SET session_version = session_version + 1, updated_at = ? WHERE id = ?",
    args: [new Date().toISOString(), uid],
  });
  await audit(db, env, meta, {
    actorUserId: uid,
    action: "auth.signout_everywhere",
    targetType: "app_user",
    targetId: String(uid),
  });
}
