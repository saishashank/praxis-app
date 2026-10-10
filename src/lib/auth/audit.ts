// Auth audit helpers (ROL-104, NFR-030). Refused emails are stored only as an HMAC.
import type { Client, Transaction } from "@libsql/client";
import { createHmac } from "node:crypto";
import { appendAudit, appendAuditTx, auditKey, type AuditEvent } from "@/lib/db/audit";
import { norm, type AuthEnv } from "./env";

export type RequestMeta = { ip: string | null; userAgent: string | null };

export const NO_META: RequestMeta = { ip: null, userAgent: null };

// IP = first x-forwarded-for entry, else x-real-ip, else null. UA truncated to 300 chars.
export function clientIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff;
  return headers.get("x-real-ip")?.trim() || null;
}

export function requestMeta(headers: Headers): RequestMeta {
  const ua = headers.get("user-agent");
  return { ip: clientIp(headers), userAgent: ua ? ua.slice(0, 300) : null };
}

export function hmacEmail(piiHashKey: string, email: string): string {
  return createHmac("sha256", piiHashKey).update(norm(email)).digest("hex");
}

export function requireKey(env: AuthEnv): string {
  if (!env.PII_HASH_KEY) throw new Error("audit not configured");
  return env.PII_HASH_KEY;
}

export async function audit(
  db: Client,
  env: AuthEnv,
  meta: RequestMeta,
  event: Omit<AuditEvent, "ip" | "userAgent">,
): Promise<void> {
  await appendAudit(db, auditKey(requireKey(env)), {
    ...event,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}

// Same as audit(), inside the caller's write transaction (state change + audit commit together).
export async function auditTx(
  tx: Transaction,
  env: AuthEnv,
  meta: RequestMeta,
  event: Omit<AuditEvent, "ip" | "userAgent">,
): Promise<void> {
  await appendAuditTx(tx, auditKey(requireKey(env)), {
    ...event,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}
