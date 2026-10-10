// Handler for the staging-only test-identity login (SEC-109, TST-113). Dependencies are injected.
// Every failure is a generic 401 (404 when disabled); nothing about the cause leaves here.
// Issues the same session cookie Auth.js would (JWT, claims { uid, sv, si, rec }, D-035).
import type { Client } from "@libsql/client";
import { encode } from "next-auth/jwt";
import { audit, requestMeta } from "@/lib/auth/audit";
import { isTestEmail, testIdentityEnabled, type TestIdentityEnv } from "@/lib/auth/testIdentity";
import { getSessionMaxAgeSec } from "@/lib/http/limits";
import { verifySignedRequest } from "@/lib/security/hmac";
import type { NonceStore } from "@/lib/security/replay";

export type TestLoginDeps = {
  env: TestIdentityEnv;
  authDb: () => Client;
  store: NonceStore;
  nowSec: () => number;
};

export const MAX_BODY_BYTES = 1024;
// Same names Auth.js derives: __Secure- prefix on https (see src/proxy.ts).
export const COOKIE_SECURE = "__Secure-authjs.session-token";
export const COOKIE_PLAIN = "authjs.session-token";

const NO_STORE = { "Cache-Control": "no-store" };
const unauthorized = () =>
  Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
const notFound = () => new Response("Not found", { status: 404, headers: NO_STORE });

function isHttps(req: Request): boolean {
  if (req.headers.get("x-forwarded-proto") === "https") return true;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function createTestLoginHandler(deps: TestLoginDeps) {
  return async function handle(req: Request): Promise<Response> {
    // Defence in depth: the route already checked; a direct caller of the handler is covered too.
    if (!testIdentityEnabled(deps.env)) return notFound();
    try {
      const rawBody = await req.text();
      if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return unauthorized();

      const nowSec = deps.nowSec();
      const verdict = await verifySignedRequest({
        secret: deps.env.TEST_IDENTITY_SECRET,
        headers: req.headers,
        rawBody,
        nowSec,
        store: deps.store,
      });
      if (!verdict.ok) return unauthorized();

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return unauthorized();
      }
      const raw = (parsed as { email?: unknown } | null)?.email;
      if (typeof raw !== "string") return unauthorized();
      const email = raw.trim().toLowerCase();
      if (!isTestEmail(email)) return unauthorized(); // never a real user

      const authSecret = deps.env.AUTH_SECRET;
      if (!authSecret) return unauthorized();

      const db = deps.authDb();
      const res = await db.execute({
        sql: "SELECT id, role, status, session_version FROM app_user WHERE email = ?",
        args: [email],
      });
      if (!res.rows.length) return unauthorized();
      const u = res.rows[0];
      const status = String(u.status);
      if (status !== "active" && status !== "invited") return unauthorized();
      const uid = Number(u.id);

      // Fail closed: no audit row, no session.
      await audit(db, deps.env, requestMeta(req.headers), {
        actorUserId: uid,
        action: "auth.test_identity_signin",
        targetType: "user",
        targetId: String(uid),
      });

      const https = isHttps(req);
      const name = https ? COOKIE_SECURE : COOKIE_PLAIN;
      const maxAge = getSessionMaxAgeSec();
      const token = await encode({
        token: { uid, sv: Number(u.session_version), si: nowSec, rec: false },
        secret: authSecret,
        salt: name,
        maxAge,
      });
      const cookie = [
        `${name}=${token}`,
        "Path=/",
        `Max-Age=${maxAge}`,
        "HttpOnly",
        "SameSite=Lax",
        ...(https ? ["Secure"] : []),
      ].join("; ");
      return Response.json(
        { ok: true, role: String(u.role) },
        { status: 200, headers: { ...NO_STORE, "Set-Cookie": cookie } },
      );
    } catch {
      return unauthorized();
    }
  };
}
