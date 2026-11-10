// INFRA T7 follow-up: a signed-in session for the smoke test of a THROWAWAY stack (branch CI only, never prod).
// Creates a test user in the auth database (a reserved .test address, role owner, status active) and writes the
// session cookie Auth.js would issue for it, so smoke.mjs can check Home, Picks and Market signed in.
//
// How the app stores sessions: JWT only (src/lib/auth/config.ts, strategy "jwt", no adapter). The "session" is the
// encrypted cookie `authjs.session-token` carrying { uid, sv, si, rec }; the only database row is app_user, whose
// id and session_version the cookie must match (src/lib/auth/session.ts re-reads it on every request). This mints
// the cookie the same way e2e/helpers.ts and the staging test-identity login do.
//
//   TURSO_AUTH_URL    the auth database of the throwaway stack (http://auth.sqld:8080 or file:...); never Turso
//   TURSO_AUTH_TOKEN  optional (only when that sqld verifies JWTs)
//   AUTH_SECRET       the stack's Auth.js secret (from its web.env)
//   node scripts/selfhost/seed-session.mjs <out-file> [email]     email defaults to owner@praxis.test (OWNER_EMAIL)
// The cookie goes only into <out-file> (mode 600) as `name=value`; nothing secret is printed.
import { createClient } from "@libsql/client";
import { encode } from "next-auth/jwt";
import { chmodSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const COOKIE_NAME = "authjs.session-token"; // the plain (http) name: the throwaway stack has no TLS
const TEST_EMAIL = /^[^\s@]+@[^\s@]+\.test$/;

/**
 * @param {{ url: string, token?: string, secret: string, email?: string, nowSec?: number }} o
 * @returns {Promise<{ cookie: string, uid: number }>}
 */
export async function seedSession(o) {
  const email = (o.email ?? "owner@praxis.test").trim().toLowerCase();
  if (!TEST_EMAIL.test(email)) throw new Error("seed-session: only reserved .test addresses");
  const u = String(o.url ?? "").trim();
  if (!/^(file:|http:\/\/)/.test(u) || /turso\.io/i.test(u)) {
    throw new Error("seed-session: only a local file: or plain http: database, never Turso");
  }
  if (!o.secret) throw new Error("seed-session: AUTH_SECRET is not set");
  const db = createClient({ url: u, authToken: o.token || undefined });
  try {
    const now = new Date((o.nowSec ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
    await db.execute({
      sql: `INSERT OR IGNORE INTO app_user (email, name, role, status, created_at, updated_at)
            VALUES (?, 'CI smoke user', 'owner', 'active', ?, ?)`,
      args: [email, now, now],
    });
    const r = await db.execute({
      sql: "SELECT id, session_version, status FROM app_user WHERE email = ?",
      args: [email],
    });
    if (r.rows.length !== 1 || String(r.rows[0].status) !== "active") {
      throw new Error("seed-session: the user is not active");
    }
    const uid = Number(r.rows[0].id);
    const value = await encode({
      token: {
        uid,
        sv: Number(r.rows[0].session_version),
        si: o.nowSec ?? Math.floor(Date.now() / 1000),
        rec: false,
      },
      secret: o.secret,
      salt: COOKIE_NAME,
      maxAge: 3600,
    });
    return { cookie: `${COOKIE_NAME}=${value}`, uid };
  } finally {
    db.close();
  }
}

export async function main(argv, env = process.env, out = (s) => console.log(s)) {
  const file = argv[0];
  if (!file || argv.length > 2) {
    out("usage: seed-session.mjs <out-file> [email]");
    return 2;
  }
  try {
    const r = await seedSession({
      url: env.TURSO_AUTH_URL ?? "",
      token: env.TURSO_AUTH_TOKEN,
      secret: env.AUTH_SECRET ?? "",
      email: argv[1],
    });
    writeFileSync(file, r.cookie, { mode: 0o600 });
    chmodSync(file, 0o600);
    out(`seed-session: user ${r.uid} (owner, active) and a session cookie written`);
    return 0;
  } catch (e) {
    out(
      e instanceof Error && e.message.startsWith("seed-session:")
        ? e.message
        : "seed-session: failed",
    );
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
