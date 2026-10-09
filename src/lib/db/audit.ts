// Audit hash chain (NFR-023, D-032) and personal-data handling (NFR-030).
// row_hmac = HMAC-SHA256(key, prev_hmac + "|" + canonical JSON of the content fields).
// ip and user_agent are deliberately NOT in the content so nulling them never breaks the chain.
import type { Client } from "@libsql/client";
import { createHmac } from "node:crypto";
import { nowIso } from "./time";

export const GENESIS_HMAC = "0".repeat(64);

export type AuditEvent = {
  at?: string;
  actorUserId?: number | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  detail?: unknown;
  ip?: string | null;
  userAgent?: string | null;
};

// Chain key derived from PII_HASH_KEY, so no new secret is needed.
export function auditKey(piiHashKey: string): Buffer {
  return createHmac("sha256", piiHashKey).update("praxis-audit-chain-v1").digest();
}

type Content = {
  at: string;
  actor_user_id: number | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail_json: string | null;
};

// Fixed field order = canonical form.
function canonical(c: Content): string {
  return JSON.stringify([
    c.at,
    c.actor_user_id,
    c.action,
    c.target_type,
    c.target_id,
    c.detail_json,
  ]);
}

function chain(key: Buffer, prev: string, c: Content): string {
  return createHmac("sha256", key)
    .update(`${prev}|${canonical(c)}`)
    .digest("hex");
}

export async function appendAudit(db: Client, key: Buffer, event: AuditEvent): Promise<number> {
  const content: Content = {
    at: event.at ?? nowIso(),
    actor_user_id: event.actorUserId ?? null,
    action: event.action,
    target_type: event.targetType ?? null,
    target_id: event.targetId ?? null,
    detail_json: event.detail === undefined ? null : JSON.stringify(event.detail),
  };
  const tx = await db.transaction("write");
  try {
    const last = await tx.execute("SELECT row_hmac FROM audit_event ORDER BY id DESC LIMIT 1");
    const prev = last.rows.length ? String(last.rows[0].row_hmac) : GENESIS_HMAC;
    const rowHmac = chain(key, prev, content);
    const res = await tx.execute({
      sql: `INSERT INTO audit_event (at, actor_user_id, action, target_type, target_id, detail_json, ip, user_agent, prev_hmac, row_hmac)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        content.at,
        content.actor_user_id,
        content.action,
        content.target_type,
        content.target_id,
        content.detail_json,
        event.ip ?? null,
        event.userAgent ?? null,
        prev,
        rowHmac,
      ],
    });
    await tx.commit();
    return Number(res.lastInsertRowid);
  } finally {
    tx.close();
  }
}

// Returns the id of the first broken row, or null when the whole chain verifies.
export async function verifyAuditChain(db: Client, key: Buffer): Promise<number | null> {
  const res = await db.execute(
    "SELECT id, at, actor_user_id, action, target_type, target_id, detail_json, prev_hmac, row_hmac FROM audit_event ORDER BY id",
  );
  let prev = GENESIS_HMAC;
  for (const r of res.rows) {
    const content: Content = {
      at: String(r.at),
      actor_user_id: r.actor_user_id === null ? null : Number(r.actor_user_id),
      action: String(r.action),
      target_type: r.target_type === null ? null : String(r.target_type),
      target_id: r.target_id === null ? null : String(r.target_id),
      detail_json: r.detail_json === null ? null : String(r.detail_json),
    };
    if (String(r.prev_hmac) !== prev || String(r.row_hmac) !== chain(key, prev, content)) {
      return Number(r.id);
    }
    prev = String(r.row_hmac);
  }
  return null;
}

// NFR-030: null ip/user_agent on a user's audit rows (the trigger permits exactly this change).
export async function nullAuditPii(db: Client, userId: number): Promise<number> {
  const res = await db.execute({
    sql: "UPDATE audit_event SET ip = NULL, user_agent = NULL WHERE actor_user_id = ? AND (ip IS NOT NULL OR user_agent IS NOT NULL)",
    args: [userId],
  });
  return res.rowsAffected;
}

// NFR-030: replace email/name with HMAC-SHA-256 (never a plain hash). Email stays UNIQUE via prefix.
export async function hashUserPii(
  db: Client,
  piiHashKey: string,
  userId: number,
  now: string,
): Promise<void> {
  const h = (v: string) => createHmac("sha256", piiHashKey).update(v).digest("hex");
  const u = await db.execute({
    sql: "SELECT email, name FROM app_user WHERE id = ?",
    args: [userId],
  });
  if (!u.rows.length) throw new Error("user not found");
  const email = String(u.rows[0].email);
  const name = u.rows[0].name === null ? null : String(u.rows[0].name);
  await db.execute({
    sql: "UPDATE app_user SET email = ?, name = ?, pii_hashed_at = ?, updated_at = ? WHERE id = ?",
    args: [`hashed:${h(email.toLowerCase())}`, name === null ? null : h(name), now, now, userId],
  });
}
