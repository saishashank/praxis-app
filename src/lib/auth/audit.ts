// Auth audit helpers (ROL-104, NFR-030). Refused emails are stored only as an HMAC.
import type { Client, Transaction } from "@libsql/client";
import { createHmac } from "node:crypto";
import { appendAudit, appendAuditTx, auditKey, type AuditEvent } from "@/lib/db/audit";
import { norm, type AuthEnv } from "./env";

export type RequestMeta = { ip: string | null; userAgent: string | null };

export const NO_META: RequestMeta = { ip: null, userAgent: null };

// Client IP for the sign-in rate limit and the audit trail (V1-I11 / D-785). Order:
//   1. x-vercel-forwarded-for: set by the Vercel edge to the client address and not client-settable.
//   2. x-forwarded-for, RIGHT-most entry: the hop our nearest trusted proxy appended. The first entry
//      is whatever the client claimed, so a spoofed value there must never choose the rate-limit
//      bucket. (On Vercel x-forwarded-for holds a single entry, so both ends agree.)
//   3. x-real-ip, else null. UA is truncated to 300 chars.
export function clientIp(headers: Headers): string | null {
  const vercel = headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  if (vercel) return vercel;
  const parts = headers.get("x-forwarded-for")?.split(",") ?? [];
  const xff = parts[parts.length - 1]?.trim();
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
): Promise<number> {
  return appendAudit(db, auditKey(requireKey(env)), {
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
