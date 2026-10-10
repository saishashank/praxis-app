// Users & roles service (UX-111, ROL-101..107, SEC-010, SEC-013). Opus reviews every line.
// Pure functions on an auth-DB client; every statement is parameterised; every change and its
// audit event commit in one transaction (ROL-104), Owner as actor. Audit detail never holds an email
// (NFR-030): the target is identified by user id, and refused/added addresses by HMAC only.
// The caller (server action) has already passed requireUser("admin"); each mutation here
// re-checks that the actor row is an active Owner as defence in depth.
import type { Client, Transaction } from "@libsql/client";
import { auditTx, hmacEmail, NO_META, requireKey, type RequestMeta } from "@/lib/auth/audit";
import { isOwnerEmail, type AuthEnv } from "@/lib/auth/env";

export type Assignable = "editor" | "viewer";
export type ErrorCode =
  | "invalid"
  | "forbidden"
  | "ack_required"
  | "exists"
  | "not_found"
  | "owner_protected"
  | "revoked"
  | "unavailable";
export type Fail = { ok: false; error: ErrorCode };
export type Done<T = object> = ({ ok: true } & T) | Fail;

export type Ctx = {
  db: Client;
  env: AuthEnv;
  actorId: number;
  meta?: RequestMeta;
  now?: Date;
};

// The only market there is until a second one activates (ROL-107).
export const MARKETS = ["AU"] as const;
export const DEFAULT_MARKET = "AU";

const fail = (error: ErrorCode): Fail => ({ ok: false, error });
const iso = (c: Ctx) => (c.now ?? new Date()).toISOString();

// ---- schema helpers (no dependency) ---------------------------------------------------------

const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function parseEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  if (e.length > 254 || e.indexOf("@") > 64) return null;
  return EMAIL_RE.test(e) ? e : null;
}

export function parseRole(v: unknown): Assignable | null {
  return v === "editor" || v === "viewer" ? v : null;
}

function parseId(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

const TEXT_VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;

// ---- internals ------------------------------------------------------------------------------

type Exec = Pick<Client, "execute">; // a Client or a Transaction

// ROL-104: the state change and its audit event commit together or not at all. Every read,
// write and the audit append run in one write transaction. A refusal (Fail) rolls back; any
// thrown error rolls back and becomes `unavailable` (no internals leak).
async function atomically<T extends Done<object>>(
  c: Ctx,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T | Fail> {
  let tx: Transaction;
  try {
    tx = await c.db.transaction("write");
  } catch {
    return fail("unavailable");
  }
  try {
    const result = await fn(tx);
    if (!result.ok) {
      await tx.rollback();
      return result;
    }
    await tx.commit();
    return result;
  } catch {
    try {
      await tx.rollback();
    } catch {
      // the connection is closed below either way
    }
    return fail("unavailable");
  } finally {
    tx.close();
  }
}

async function actorIsOwner(db: Exec, actorId: number): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT 1 FROM app_user WHERE id = ? AND role = 'owner' AND status = 'active'",
    args: [actorId],
  });
  return r.rows.length === 1;
}

type Target = { id: number; role: string; status: string };

async function loadTarget(db: Exec, id: number): Promise<Target | null> {
  const r = await db.execute({
    sql: "SELECT id, role, status FROM app_user WHERE id = ?",
    args: [id],
  });
  if (!r.rows.length) return null;
  const x = r.rows[0];
  return { id: Number(x.id), role: String(x.role), status: String(x.status) };
}

function record(
  tx: Transaction,
  c: Ctx,
  action: string,
  target: { type: string; id: string },
  detail?: unknown,
): Promise<void> {
  return auditTx(tx, c.env, c.meta ?? NO_META, {
    at: iso(c),
    actorUserId: c.actorId,
    action,
    targetType: target.type,
    targetId: target.id,
    detail,
  });
}

// Shared by changeRole / revokeUser / signOutEverywhere: validate id, load, refuse protected rows.
async function mutableTarget(
  tx: Transaction,
  c: Ctx,
  rawId: unknown,
  opts: { allowOwner: boolean },
): Promise<{ target: Target } | Fail> {
  const id = parseId(rawId);
  if (id === null) return fail("invalid");
  if (!(await actorIsOwner(tx, c.actorId))) return fail("forbidden");
  const target = await loadTarget(tx, id);
  if (!target) return fail("not_found");
  if (target.role === "owner" && !opts.allowOwner) return fail("owner_protected");
  if (target.status === "revoked") return fail("revoked");
  return { target };
}

// ---- sharing acknowledgement (ROL-107) ------------------------------------------------------

export type SharingAck = {
  market: string;
  acknowledgedBy: number;
  acknowledgedAt: string;
  textVersion: string;
};

export async function getSharingAck(db: Exec, market: string): Promise<SharingAck | null> {
  const r = await db.execute({
    sql: `SELECT market, acknowledged_by, acknowledged_at, text_version
          FROM sharing_ack WHERE market = ? ORDER BY id DESC LIMIT 1`,
    args: [market],
  });
  if (!r.rows.length) return null;
  const x = r.rows[0];
  return {
    market: String(x.market),
    acknowledgedBy: Number(x.acknowledged_by),
    acknowledgedAt: String(x.acknowledged_at),
    textVersion: String(x.text_version),
  };
}

export async function hasSharingAck(db: Exec, market: string): Promise<boolean> {
  return (await getSharingAck(db, market)) !== null;
}

export async function recordSharingAck(
  c: Ctx,
  market: unknown,
  textVersion: unknown,
): Promise<Done> {
  if (!MARKETS.includes(market as (typeof MARKETS)[number])) return fail("invalid");
  if (typeof textVersion !== "string" || !TEXT_VERSION_RE.test(textVersion)) return fail("invalid");
  const m = market as string;
  return atomically(c, async (tx) => {
    if (!(await actorIsOwner(tx, c.actorId))) return fail("forbidden");
    if (await hasSharingAck(tx, m)) return { ok: true as const }; // already recorded; no duplicate
    await tx.execute({
      sql: `INSERT INTO sharing_ack (market, acknowledged_by, acknowledged_at, text_version)
            VALUES (?, ?, ?, ?)`,
      args: [m, c.actorId, iso(c), textVersion],
    });
    await record(tx, c, "sharing.ack", { type: "market", id: m }, { text_version: textVersion });
    return { ok: true as const };
  });
}

// ---- users ----------------------------------------------------------------------------------

export type UserRow = {
  id: number;
  email: string;
  name: string | null;
  role: string;
  status: string;
  updatedAt: string;
};

export async function listUsers(db: Client): Promise<UserRow[]> {
  const r = await db.execute(
    `SELECT id, email, name, role, status, updated_at FROM app_user
     ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, id`,
  );
  return r.rows.map((x) => ({
    id: Number(x.id),
    email: String(x.email),
    name: x.name === null ? null : String(x.name),
    role: String(x.role),
    status: String(x.status),
    updatedAt: String(x.updated_at),
  }));
}

export async function addUser(
  c: Ctx,
  rawEmail: unknown,
  rawRole: unknown,
): Promise<Done<{ userId: number }>> {
  const email = parseEmail(rawEmail);
  const role = rawRole === undefined || rawRole === "" ? "viewer" : parseRole(rawRole); // ROL-101
  if (email === null || role === null) return fail("invalid");
  return atomically(c, async (tx) => {
    if (!(await actorIsOwner(tx, c.actorId))) return fail("forbidden");
    if (!(await hasSharingAck(tx, DEFAULT_MARKET))) return fail("ack_required");
    if (isOwnerEmail(c.env, email)) return fail("exists"); // the pinned Owner is never an entry
    const now = iso(c);
    const ehmac = hmacEmail(requireKey(c.env), email);

    const found = await tx.execute({
      sql: "SELECT id, role, status FROM app_user WHERE email = ?",
      args: [email],
    });
    if (found.rows.length) {
      const t = found.rows[0];
      const id = Number(t.id);
      if (String(t.status) !== "revoked" || String(t.role) === "owner") return fail("exists");
      // NFR-030: fresh binding, old sessions refused, no old Google sub kept.
      const upd = await tx.execute({
        sql: `UPDATE app_user SET status = 'invited', role = ?, google_sub = NULL, revoked_at = NULL,
                session_version = session_version + 1, updated_at = ?
              WHERE id = ? AND status = 'revoked' AND role <> 'owner'`,
        args: [role, now, id],
      });
      if (upd.rowsAffected !== 1) return fail("exists");
      await record(
        tx,
        c,
        "user.reinvite",
        { type: "app_user", id: String(id) },
        { role, email_hmac: ehmac },
      );
      return { ok: true as const, userId: id };
    }

    let id: number;
    try {
      const ins = await tx.execute({
        sql: `INSERT INTO app_user (email, role, status, session_version, created_at, updated_at)
              VALUES (?, ?, 'invited', 1, ?, ?)`,
        args: [email, role, now, now],
      });
      id = Number(ins.lastInsertRowid);
    } catch {
      return fail("exists"); // UNIQUE(email) lost a race with a concurrent add
    }
    await record(
      tx,
      c,
      "user.add",
      { type: "app_user", id: String(id) },
      { role, email_hmac: ehmac },
    );
    return { ok: true as const, userId: id };
  });
}

export async function changeRole(c: Ctx, rawId: unknown, rawRole: unknown): Promise<Done> {
  const role = parseRole(rawRole); // 'owner' can never be assigned here
  if (role === null) return fail("invalid");
  return atomically(c, async (tx) => {
    const got = await mutableTarget(tx, c, rawId, { allowOwner: false });
    if ("ok" in got) return got;
    const { target } = got;
    if (target.role === role) return { ok: true as const };
    // session_version bump makes the new role apply on the very next request (SEC-010).
    const upd = await tx.execute({
      sql: `UPDATE app_user SET role = ?, session_version = session_version + 1, updated_at = ?
            WHERE id = ? AND role <> 'owner' AND status <> 'revoked'`,
      args: [role, iso(c), target.id],
    });
    if (upd.rowsAffected !== 1) return fail("not_found");
    await record(
      tx,
      c,
      "user.role_change",
      { type: "app_user", id: String(target.id) },
      { from: target.role, to: role },
    );
    return { ok: true as const };
  });
}

// The Owner row is protected, which also rules out self-revocation (the actor is the Owner).
export async function revokeUser(c: Ctx, rawId: unknown): Promise<Done> {
  return atomically(c, async (tx) => {
    const got = await mutableTarget(tx, c, rawId, { allowOwner: false });
    if ("ok" in got) return got;
    const now = iso(c);
    const upd = await tx.execute({
      sql: `UPDATE app_user SET status = 'revoked', revoked_at = ?,
              session_version = session_version + 1, updated_at = ?
            WHERE id = ? AND role <> 'owner' AND status <> 'revoked'`,
      args: [now, now, got.target.id],
    });
    if (upd.rowsAffected !== 1) return fail("revoked");
    await record(tx, c, "user.revoke", { type: "app_user", id: String(got.target.id) });
    return { ok: true as const };
  });
}

export async function signOutEverywhere(c: Ctx, rawId: unknown): Promise<Done> {
  return atomically(c, async (tx) => {
    const got = await mutableTarget(tx, c, rawId, { allowOwner: true });
    if ("ok" in got) return got;
    const upd = await tx.execute({
      sql: `UPDATE app_user SET session_version = session_version + 1, updated_at = ?
            WHERE id = ? AND status <> 'revoked'`,
      args: [iso(c), got.target.id],
    });
    if (upd.rowsAffected !== 1) return fail("revoked");
    await record(tx, c, "user.signout_everywhere", {
      type: "app_user",
      id: String(got.target.id),
    });
    return { ok: true as const };
  });
}

// ---- audit log ------------------------------------------------------------------------------

export type AuditRow = {
  id: number;
  at: string;
  action: string;
  actorUserId: number | null;
  targetType: string | null;
  targetId: string | null;
  detailJson: string | null;
};

// Deliberately omits ip and user_agent: the Owner page shows events, not network data.
export async function listAudit(db: Client, limit = 100, beforeId?: number): Promise<AuditRow[]> {
  const n = Number.isFinite(limit) ? Math.min(500, Math.max(1, Math.trunc(limit))) : 100;
  const before = beforeId !== undefined && Number.isSafeInteger(beforeId) ? beforeId : null;
  const r = await db.execute({
    sql: `SELECT id, at, action, actor_user_id, target_type, target_id, detail_json
          FROM audit_event WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
    args: [before, before, n],
  });
  return r.rows.map((x) => ({
    id: Number(x.id),
    at: String(x.at),
    action: String(x.action),
    actorUserId: x.actor_user_id === null ? null : Number(x.actor_user_id),
    targetType: x.target_type === null ? null : String(x.target_type),
    targetId: x.target_id === null ? null : String(x.target_id),
    detailJson: x.detail_json === null ? null : String(x.detail_json),
  }));
}
