// Next 16 proxy (formerly middleware), Node.js runtime. All logic lives in lib/http/gate.ts.
import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";
import { parseClaims } from "@/lib/auth/claims";
import { authDb } from "@/lib/db/client";
import { gate } from "@/lib/http/gate";
import { getRateLimits, getSessionMaxAgeSec } from "@/lib/http/limits";

// Same names Auth.js derives: __Secure- prefix on https.
const COOKIE_SECURE = "__Secure-authjs.session-token";
const COOKIE_PLAIN = "authjs.session-token";

async function readClaims(req: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const secureCookie =
    req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const token = await getToken({
    req,
    secret,
    secureCookie,
    cookieName: secureCookie ? COOKIE_SECURE : COOKIE_PLAIN,
  });
  return parseClaims(token, Math.floor(Date.now() / 1000), getSessionMaxAgeSec());
}

export function proxy(req: NextRequest) {
  return gate(req, {
    env: process.env,
    dev: process.env.NODE_ENV === "development",
    db: authDb,
    readClaims,
    limits: getRateLimits(),
    nowSec: () => Math.floor(Date.now() / 1000),
  });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.png|icon.svg|apple-icon.png|brand/).*)",
  ],
};
