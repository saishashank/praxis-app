// Auth.js configuration (v5, JWT sessions, no adapter: our auth DB is the source of truth).
import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { headers } from "next/headers";
import { authDb } from "@/lib/db/client";
import { getSessionMaxAgeSec } from "@/lib/http/limits";
import { requestMeta } from "./audit";
import { decideSignIn } from "./allowlist";

type Tok = Record<string, unknown>;

export function buildAuthConfig(): NextAuthConfig {
  return {
    providers: [
      Google({
        checks: ["pkce", "state"],
        authorization: { params: { scope: "openid email profile" } },
      }),
    ],
    session: { strategy: "jwt", maxAge: getSessionMaxAgeSec() },
    trustHost: true,
    pages: { signIn: "/signin", error: "/signin" },
    callbacks: {
      async signIn({ user, profile }) {
        const meta = requestMeta(await headers());
        const d = await decideSignIn(authDb(), profile ?? {}, process.env, new Date(), { meta });
        if (!d.ok) return "/signin?error=AccessDenied";
        // Handed to the jwt callback (same object, no adapter): our user id, not Google's.
        user.id = `${d.userId}:${d.recovery ? "r" : "n"}`;
        return true;
      },
      async jwt({ token, user }) {
        if (!user?.id) return token; // refresh of an existing token: claims unchanged (si fixed)
        const [uidStr, flag] = user.id.split(":");
        const uid = Number(uidStr);
        const res = await authDb().execute({
          sql: "SELECT session_version FROM app_user WHERE id = ?",
          args: [uid],
        });
        if (!res.rows.length) return null;
        // Fresh object: no name, email or picture is kept in the cookie.
        return {
          uid,
          sv: Number(res.rows[0].session_version),
          si: Math.floor(Date.now() / 1000),
          rec: flag === "r",
        } as Tok;
      },
      async session({ session, token }) {
        const t = token as Tok;
        return {
          expires: session.expires,
          praxis: { uid: t.uid, sv: t.sv, si: t.si, rec: t.rec },
        } as unknown as typeof session;
      },
    },
  };
}
