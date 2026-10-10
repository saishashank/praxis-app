// Per-request identity (PLT-031, ROL-101, SEC-010): role, status and session_version are read from
// the auth DB on EVERY call; the JWT only says who the user claims to be.
import type { Client } from "@libsql/client";
import { auth } from "@/auth";
import { authDb } from "@/lib/db/client";
import { getSessionMaxAgeSec } from "@/lib/http/limits";
import { parseClaims, type Claims } from "./claims";
import { isOwnerEmail, isRecoveryEmail, type AuthEnv } from "./env";
import type { Role } from "./permissions";

export class AuthUnavailableError extends Error {
  constructor() {
    super("auth unavailable");
    this.name = "AuthUnavailableError";
  }
}

export type CurrentUser = { id: number; email: string; name: string | null; role: Role };

export async function resolveUser(
  db: Client,
  claims: Claims | null,
  env: AuthEnv,
): Promise<CurrentUser | null> {
  if (!claims) return null;
  let rows;
  try {
    rows = (
      await db.execute({
        sql: "SELECT id, email, name, role, status, session_version FROM app_user WHERE id = ?",
        args: [claims.uid],
      })
    ).rows;
  } catch {
    throw new AuthUnavailableError();
  }
  if (!rows.length) return null;
  const r = rows[0];
  if (String(r.status) !== "active") return null; // revoked (or never activated) -> refused now
  if (Number(r.session_version) !== claims.sv) return null;
  const email = String(r.email);
  // A recovery session dies the moment recovery is switched off.
  if (claims.rec && !isRecoveryEmail(env, String(env.OWNER_RECOVERY_EMAIL ?? ""))) return null;
  const stored = String(r.role);
  // ROL-101a: Owner power only for the pinned address.
  const role: Role =
    stored === "owner" ? (isOwnerEmail(env, email) ? "owner" : "viewer") : (stored as Role);
  return { id: Number(r.id), email, name: r.name === null ? null : String(r.name), role };
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  const raw = (session as { praxis?: unknown } | null)?.praxis;
  const claims = parseClaims(raw, Math.floor(Date.now() / 1000), getSessionMaxAgeSec());
  if (!claims) return null;
  let db: Client;
  try {
    db = authDb();
  } catch {
    throw new AuthUnavailableError();
  }
  return resolveUser(db, claims, process.env);
}
