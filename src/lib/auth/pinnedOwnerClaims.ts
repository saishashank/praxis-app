// Proxy-side pin check for Blueprint (D-371). Same rules as session.ts resolveUser (active row,
// matching session_version, no dead recovery session) plus role owner and the pinned email, but
// without importing Auth.js so the proxy stays light. Any DB error propagates; the gate treats a
// throw as "not the Owner".
import type { Client } from "@libsql/client";
import type { Claims } from "./claims";
import { isOwnerEmail, isRecoveryEmail, type AuthEnv } from "./env";

export async function isPinnedOwnerClaims(
  db: Client,
  claims: Claims,
  env: AuthEnv,
): Promise<boolean> {
  const { rows } = await db.execute({
    sql: "SELECT email, role, status, session_version FROM app_user WHERE id = ?",
    args: [claims.uid],
  });
  if (!rows.length) return false;
  const r = rows[0];
  if (String(r.status) !== "active") return false;
  if (Number(r.session_version) !== claims.sv) return false;
  if (claims.rec && !isRecoveryEmail(env, String(env.OWNER_RECOVERY_EMAIL ?? ""))) return false;
  return String(r.role) === "owner" && isOwnerEmail(env, String(r.email));
}
