import type { Client } from "@libsql/client";
import { createHmac } from "node:crypto";
import { freshDb } from "../db/helpers";

export const KEY = "k".repeat(64);
export const ENV = {
  OWNER_EMAIL: "owner@example.test",
  OWNER_RECOVERY_EMAIL: "recovery@example.test",
  PII_HASH_KEY: KEY,
  RESEND_API_KEY: "re_test_placeholder",
} as Record<string, string | undefined>;
export const NOW = new Date("2026-10-10T12:00:00.000Z");
export const authDb = () => freshDb("auth");

export async function addUser(
  db: Client,
  u: {
    email: string;
    role?: "owner" | "editor" | "viewer";
    status?: "invited" | "active" | "revoked";
    sub?: string | null;
    sv?: number;
  },
): Promise<number> {
  const r = await db.execute({
    sql: `INSERT INTO app_user (email, role, status, google_sub, session_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      u.email,
      u.role ?? "viewer",
      u.status ?? "active",
      u.sub ?? null,
      u.sv ?? 1,
      NOW.toISOString(),
      NOW.toISOString(),
    ],
  });
  return Number(r.lastInsertRowid);
}

export async function auditRows(db: Client) {
  const r = await db.execute("SELECT * FROM audit_event ORDER BY id");
  return r.rows.map((x) => ({
    ...x,
    detail: x.detail_json ? JSON.parse(String(x.detail_json)) : null,
  })) as Array<Record<string, unknown> & { detail: Record<string, unknown> | null }>;
}

export const hmac = (v: string) => createHmac("sha256", KEY).update(v).digest("hex");
