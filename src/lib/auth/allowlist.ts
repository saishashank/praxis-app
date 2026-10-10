// Sign-in decision (PLT-033, SEC-010, ROL-101, ROL-101a). Opus reviews every line.
// Every outcome writes an audit event. A refused email is stored only as an HMAC.
import type { Client } from "@libsql/client";
import { audit, hmacEmail, requireKey, NO_META, type RequestMeta } from "./audit";
import { isOwnerEmail, isRecoveryEmail, norm, type AuthEnv } from "./env";
import type { Role } from "./permissions";
import { sendRecoveryAlert } from "./recoveryEmail";

export type GoogleProfile = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
};

export type RefusalReason = "not_verified" | "not_allowlisted" | "revoked" | "sub_mismatch";

export type SignInDecision =
  | { ok: true; userId: number; role: Role; sessionVersion: number; recovery: boolean }
  | { ok: false; reason: RefusalReason };

export type DecideOpts = { meta?: RequestMeta; fetchImpl?: typeof fetch };

const ISO = (d: Date) => d.toISOString();

async function refuse(
  db: Client,
  env: AuthEnv,
  meta: RequestMeta,
  now: Date,
  reason: RefusalReason,
  email: string,
  userId: number | null = null,
): Promise<SignInDecision> {
  await audit(db, env, meta, {
    at: ISO(now),
    actorUserId: userId,
    action: "auth.signin_refused",
    detail: { reason, email_hmac: email ? hmacEmail(requireKey(env), email) : null },
  });
  if (reason === "sub_mismatch") {
    await audit(db, env, meta, {
      at: ISO(now),
      actorUserId: userId,
      action: "auth.sub_mismatch",
      targetType: "app_user",
      targetId: userId === null ? null : String(userId),
    });
  }
  return { ok: false, reason };
}

type Row = {
  id: number;
  email: string;
  google_sub: string | null;
  role: string;
  status: string;
  session_version: number;
};

async function findByEmail(db: Client, email: string): Promise<Row | null> {
  const r = await db.execute({
    sql: "SELECT id, email, google_sub, role, status, session_version FROM app_user WHERE email = ?",
    args: [email],
  });
  if (!r.rows.length) return null;
  const x = r.rows[0];
  return {
    id: Number(x.id),
    email: String(x.email),
    google_sub: x.google_sub === null ? null : String(x.google_sub),
    role: String(x.role),
    status: String(x.status),
    session_version: Number(x.session_version),
  };
}

// D-033: first sign-in of the pinned Owner address creates the owner row.
async function bootstrapOwner(db: Client, email: string, name: string | null, now: Date) {
  await db.execute({
    sql: `INSERT INTO app_user (email, name, role, status, created_at, updated_at)
          VALUES (?, ?, 'owner', 'active', ?, ?)`,
    args: [email, name, ISO(now), ISO(now)],
  });
}

export async function decideSignIn(
  db: Client,
  profile: GoogleProfile,
  env: AuthEnv,
  now: Date,
  opts: DecideOpts = {},
): Promise<SignInDecision> {
  const meta = opts.meta ?? NO_META;
  const rawEmail = typeof profile.email === "string" ? norm(profile.email) : "";
  const sub = typeof profile.sub === "string" && profile.sub !== "" ? profile.sub : null;
  const name = typeof profile.name === "string" ? profile.name.slice(0, 200) : null;

  if (profile.email_verified !== true || rawEmail === "" || sub === null) {
    return refuse(db, env, meta, now, "not_verified", rawEmail);
  }
  const email = rawEmail;
  const ownerEmail = norm(env.OWNER_EMAIL);

  // D-034: break-glass recovery address signs in as the Owner row (no sub binding).
  if (!isOwnerEmail(env, email) && isRecoveryEmail(env, email) && ownerEmail !== "") {
    let owner = await findByEmail(db, ownerEmail);
    if (!owner) {
      await bootstrapOwner(db, ownerEmail, null, now);
      owner = await findByEmail(db, ownerEmail);
    }
    if (!owner || owner.status === "revoked" || owner.role !== "owner") {
      return refuse(db, env, meta, now, "revoked", email, owner?.id ?? null);
    }
    await audit(db, env, meta, {
      at: ISO(now),
      actorUserId: owner.id,
      action: "auth.recovery_signin",
      targetType: "app_user",
      targetId: String(owner.id),
      detail: { email_hmac: hmacEmail(requireKey(env), email) },
    });
    const sent = await sendRecoveryAlert(env, opts.fetchImpl);
    if (!sent) {
      await audit(db, env, meta, {
        at: ISO(now),
        actorUserId: owner.id,
        action: "auth.recovery_alert_failed",
        targetType: "app_user",
        targetId: String(owner.id),
      });
    }
    return {
      ok: true,
      userId: owner.id,
      role: "owner",
      sessionVersion: owner.session_version,
      recovery: true,
    };
  }

  let row = await findByEmail(db, email);
  if (!row && isOwnerEmail(env, email)) {
    await bootstrapOwner(db, email, name, now);
    row = await findByEmail(db, email);
  }
  if (!row) return refuse(db, env, meta, now, "not_allowlisted", email);
  if (row.status === "revoked") return refuse(db, env, meta, now, "revoked", email, row.id);

  if (row.google_sub === null) {
    // Bind at first sign-in; the conditional update loses cleanly against a concurrent bind.
    const bound = await db.execute({
      sql: "UPDATE app_user SET google_sub = ?, updated_at = ? WHERE id = ? AND google_sub IS NULL",
      args: [sub, ISO(now), row.id],
    });
    if (bound.rowsAffected !== 1) return refuse(db, env, meta, now, "sub_mismatch", email, row.id);
  } else if (row.google_sub !== sub) {
    return refuse(db, env, meta, now, "sub_mismatch", email, row.id);
  }

  if (row.status === "invited") {
    await db.execute({
      sql: "UPDATE app_user SET status = 'active', updated_at = ? WHERE id = ? AND status = 'invited'",
      args: [ISO(now), row.id],
    });
  }

  // ROL-101a: an owner row whose email is not the pinned address has no Owner power.
  const role: Role =
    row.role === "owner" ? (isOwnerEmail(env, email) ? "owner" : "viewer") : (row.role as Role);

  await audit(db, env, meta, {
    at: ISO(now),
    actorUserId: row.id,
    action: "auth.signin_success",
    targetType: "app_user",
    targetId: String(row.id),
    detail: { role },
  });
  return { ok: true, userId: row.id, role, sessionVersion: row.session_version, recovery: false };
}
