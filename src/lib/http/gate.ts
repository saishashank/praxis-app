// Request gate used by src/proxy.ts (Next 16 proxy, Node runtime). Opus reviews every line.
// Order: CSP headers -> same-origin check for writes (SEC-011) -> sign-in rate limit (SEC-014)
// -> authentication (PLT-031) -> per-user write rate limit (SEC-014).
// The JWT is verified here; role / status / session_version are re-read from the DB by
// requireUser / withAuth on every page, route and action (the proxy is the first line only).
import type { Client } from "@libsql/client";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import type { Claims } from "@/lib/auth/claims";
import { buildCsp, newNonce } from "./csp";
import type { RateLimits } from "./limits";
import { rateLimit } from "./rateLimit";

export type GateDeps = {
  env: AuthEnv;
  dev: boolean;
  db: () => Client;
  readClaims: (req: NextRequest) => Promise<Claims | null>;
  limits: RateLimits;
  nowSec: () => number;
  nonce?: () => string;
};

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
// HMAC-authenticated machine routes (SEC-017): public, exempt from the same-origin check.
// The test-identity login answers 404 in production (SEC-109, TST-113).
const TEST_LOGIN_ROUTE = "/api/test-identity/login";
const MACHINE_ROUTES = new Set([
  "/api/internal/self-check",
  "/api/internal/maintenance",
  "/api/internal/backup-export",
  TEST_LOGIN_ROUTE,
]);
const PUBLIC_EXACT = new Set(["/signin", "/privacy", "/terms", "/api/health", "/robots.txt"]);

export function isPublicPath(p: string): boolean {
  return (
    PUBLIC_EXACT.has(p) || p === "/api/auth" || p.startsWith("/api/auth/") || MACHINE_ROUTES.has(p)
  );
}

function expectedOrigin(req: NextRequest, env: GateDeps["env"]): string {
  if (env.APP_BASE_URL) {
    try {
      return new URL(env.APP_BASE_URL).origin;
    } catch {
      // fall through to the request's own origin
    }
  }
  return req.nextUrl.origin;
}

function sameOrigin(req: NextRequest, expected: string): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null) return origin === expected;
  const referer = req.headers.get("referer");
  if (referer === null) return false;
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}

export async function gate(req: NextRequest, deps: GateDeps): Promise<NextResponse> {
  const nonce = (deps.nonce ?? newNonce)();
  const csp = buildCsp(nonce, deps.dev);
  const decorate = (res: NextResponse): NextResponse => {
    res.headers.set("Content-Security-Policy", csp);
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
    return res;
  };
  const text = (status: number, body: string) =>
    decorate(new NextResponse(body, { status, headers: { "Cache-Control": "no-store" } }));

  const path = req.nextUrl.pathname;
  const isApi = path === "/api" || path.startsWith("/api/");
  const method = req.method.toUpperCase();
  const write = !SAFE.has(method);
  const machine = MACHINE_ROUTES.has(path);

  try {
    // SEC-011: writes must come from our own origin (Origin, else Referer; neither -> refuse).
    if (write && !machine && !sameOrigin(req, expectedOrigin(req, deps.env))) {
      return text(403, "forbidden");
    }

    const now = deps.nowSec();

    // SEC-014: sign-in endpoints per IP. DB failure -> 503 (caught below), never allowed through.
    const signinPath =
      path.startsWith("/api/auth/callback/") ||
      path.startsWith("/api/auth/signin/") ||
      path === TEST_LOGIN_ROUTE ||
      (write && path === "/signin");
    if (signinPath) {
      const r = await rateLimit(
        deps.db(),
        `signin:${clientIp(req.headers) ?? "unknown"}`,
        deps.limits.signin_per_min_ip,
        60,
        now,
      );
      if (!r.allowed) return text(429, "too many requests");
    }

    let claims: Claims | null = null;
    if (!isPublicPath(path)) {
      claims = await deps.readClaims(req);
      if (!claims) {
        if (isApi) {
          return decorate(
            NextResponse.json(
              { error: "unauthorized" },
              { status: 401, headers: { "Cache-Control": "no-store" } },
            ),
          );
        }
        const cb = encodeURIComponent(path + req.nextUrl.search);
        return decorate(NextResponse.redirect(new URL(`/signin?callbackUrl=${cb}`, req.nextUrl)));
      }
    }

    // SEC-014: authenticated writes per user (public paths such as sign-out under /api/auth
    // are covered by the sign-in limit only).
    if (claims && write && !machine) {
      const r = await rateLimit(
        deps.db(),
        `write:${claims.uid}`,
        deps.limits.writes_per_min_user,
        60,
        now,
      );
      if (!r.allowed) return text(429, "too many requests");
    }

    // Next picks the nonce up from the request's CSP header and stamps its own scripts.
    const reqHeaders = new Headers(req.headers);
    reqHeaders.set("x-nonce", nonce);
    reqHeaders.set("Content-Security-Policy", csp);
    return decorate(NextResponse.next({ request: { headers: reqHeaders } }));
  } catch {
    return text(503, "unavailable");
  }
}
