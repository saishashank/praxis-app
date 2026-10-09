// @vitest-environment node
import type { Client } from "@libsql/client";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import type { Claims } from "@/lib/auth/claims";
import { gate, isPublicPath, type GateDeps } from "@/lib/http/gate";
import { freshDb } from "../db/helpers";

const BASE = "https://app.example.test";
const CLAIMS: Claims = { uid: 5, sv: 1, si: 1, rec: false };
const LIMITS = { signin_per_min_ip: 10, writes_per_min_user: 60, exports_per_hour_user: 5 };

async function mk(over: Partial<GateDeps> = {}): Promise<GateDeps> {
  const db = await freshDb("auth");
  return {
    env: { APP_BASE_URL: BASE },
    dev: false,
    db: () => db,
    readClaims: async () => CLAIMS,
    limits: LIMITS,
    nowSec: () => 1_700_000_000,
    nonce: () => "NONCE",
    ...over,
  };
}
const req = (path: string, init: { method?: string; headers?: HeadersInit; ip?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.ip) headers.set("x-forwarded-for", init.ip);
  return new NextRequest(new URL(path, BASE), { method: init.method, headers });
};
const broken = (): Client =>
  ({
    execute: async () => {
      throw new Error("down");
    },
  }) as unknown as Client;

describe("headers on every response", () => {
  it("sets CSP with nonce, no unsafe-inline in script-src, frame-ancestors none", async () => {
    const res = await gate(req("/"), await mk());
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self' 'nonce-NONCE' 'strict-dynamic'");
    const script = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(script).not.toContain("unsafe-inline");
    expect(script).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://accounts.google.com");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("forwards the nonce to Next on the request headers", async () => {
    const res = await gate(req("/"), await mk());
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe("NONCE");
    expect(res.headers.get("x-middleware-request-content-security-policy")).toContain(
      "'nonce-NONCE'",
    );
  });

  it("allows unsafe-eval only in development", async () => {
    const res = await gate(req("/"), await mk({ dev: true }));
    expect(res.headers.get("content-security-policy")).toContain("'unsafe-eval'");
    expect(res.headers.get("content-security-policy")).not.toContain("upgrade-insecure");
  });

  it("generates a fresh nonce per request by default", async () => {
    const d = await mk({ nonce: undefined });
    const a = (await gate(req("/"), d)).headers.get("content-security-policy");
    const b = (await gate(req("/"), d)).headers.get("content-security-policy");
    expect(a).not.toBe(b);
  });

  it("CSP is also on refusals (401, 403, 429, 503, redirect)", async () => {
    const d = await mk({ readClaims: async () => null });
    for (const r of [
      await gate(req("/api/x"), d),
      await gate(req("/page"), d),
      await gate(req("/x", { method: "POST" }), d),
    ]) {
      expect(r.headers.get("content-security-policy")).toContain("nonce-NONCE");
    }
  });
});

describe("authentication (PLT-031)", () => {
  it("unauthenticated page -> redirect to /signin with callbackUrl", async () => {
    const res = await gate(req("/markets?x=1"), await mk({ readClaims: async () => null }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/signin?callbackUrl=%2Fmarkets%3Fx%3D1`);
  });

  it("unauthenticated API -> 401 JSON", async () => {
    const res = await gate(req("/api/data"), await mk({ readClaims: async () => null }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    "/signin",
    "/privacy",
    "/terms",
    "/api/health",
    "/robots.txt",
    "/api/auth/session",
    "/api/auth/callback/google",
    "/api/auth/csrf",
    "/api/internal/self-check",
    "/api/internal/maintenance",
    "/api/internal/backup-export",
    "/api/test-identity/login",
  ])("public path %s passes without a session", async (p) => {
    const readClaims = vi.fn(async () => null);
    const res = await gate(req(p), await mk({ readClaims }));
    expect(res.status).toBe(200);
    expect(readClaims).not.toHaveBeenCalled();
  });

  it("everything else is protected", async () => {
    for (const p of ["/", "/api", "/api/other", "/signinx", "/privacy/x", "/api/authx", "/admin"]) {
      expect(isPublicPath(p)).toBe(false);
    }
    expect(isPublicPath("/api/auth")).toBe(true);
  });

  it("authenticated request passes", async () => {
    expect((await gate(req("/"), await mk())).status).toBe(200);
  });
});

describe("same-origin check (SEC-011)", () => {
  const post = (headers: Record<string, string> = {}, path = "/api/thing") =>
    req(path, { method: "POST", headers });

  it("POST without Origin and Referer -> 403", async () => {
    expect((await gate(post(), await mk())).status).toBe(403);
  });
  it("cross-origin Origin -> 403", async () => {
    expect((await gate(post({ origin: "https://evil.test" }), await mk())).status).toBe(403);
    expect((await gate(post({ origin: "null" }), await mk())).status).toBe(403);
  });
  it("same-origin Origin passes", async () => {
    expect((await gate(post({ origin: BASE }), await mk())).status).toBe(200);
  });
  it("Referer is used when Origin is absent", async () => {
    expect((await gate(post({ referer: `${BASE}/a/b` }), await mk())).status).toBe(200);
    expect((await gate(post({ referer: "https://evil.test/a" }), await mk())).status).toBe(403);
    expect((await gate(post({ referer: "not a url" }), await mk())).status).toBe(403);
  });
  it("Origin wins over a good Referer", async () => {
    const h = { origin: "https://evil.test", referer: `${BASE}/` };
    expect((await gate(post(h), await mk())).status).toBe(403);
  });
  it.each(["PUT", "PATCH", "DELETE"])("%s is checked too", async (method) => {
    expect((await gate(req("/api/x", { method }), await mk())).status).toBe(403);
  });
  it("GET, HEAD, OPTIONS are not checked", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect((await gate(req("/", { method }), await mk())).status).toBe(200);
    }
  });
  it("falls back to the request origin without APP_BASE_URL (or with a bad one)", async () => {
    for (const env of [{}, { APP_BASE_URL: "::bad::" }]) {
      const d = await mk({ env });
      expect((await gate(post({ origin: BASE }), d)).status).toBe(200);
      expect((await gate(post({ origin: "https://evil.test" }), d)).status).toBe(403);
    }
  });
  it("APP_BASE_URL decides the expected origin", async () => {
    const d = await mk({ env: { APP_BASE_URL: "https://other.example.test/" } });
    expect((await gate(post({ origin: BASE }), d)).status).toBe(403);
    expect((await gate(post({ origin: "https://other.example.test" }), d)).status).toBe(200);
  });
  it("the HMAC self-check route is exempt and needs no session", async () => {
    const d = await mk({ readClaims: async () => null });
    const res = await gate(req("/api/internal/self-check", { method: "POST" }), d);
    expect(res.status).toBe(200);
  });
  it("the signed maintenance route is exempt from the origin check and needs no session", async () => {
    const d = await mk({ readClaims: async () => null });
    const res = await gate(req("/api/internal/maintenance", { method: "POST" }), d);
    expect(res.status).toBe(200);
    // sub-paths and look-alikes are not exempt
    for (const p of ["/api/internal/maintenance/x", "/api/internal/maintenancex"]) {
      expect(isPublicPath(p)).toBe(false);
      expect((await gate(req(p, { method: "POST" }), d)).status).toBe(403);
    }
  });
  it("the signed backup-export route is exempt from the origin check and needs no session", async () => {
    const d = await mk({ readClaims: async () => null });
    const res = await gate(req("/api/internal/backup-export", { method: "POST" }), d);
    expect(res.status).toBe(200);
    for (const p of ["/api/internal/backup-export/x", "/api/internal/backup-exportx"]) {
      expect(isPublicPath(p)).toBe(false);
      expect((await gate(req(p, { method: "POST" }), d)).status).toBe(403);
    }
  });
  it("the signed test-identity login is exempt from the origin check and needs no session", async () => {
    const d = await mk({ readClaims: async () => null });
    const res = await gate(req("/api/test-identity/login", { method: "POST" }), d);
    expect(res.status).toBe(200);
    // sub-paths and look-alikes are not exempt
    for (const p of [
      "/api/test-identity/login/x",
      "/api/test-identity",
      "/api/test-identity/other",
    ]) {
      expect(isPublicPath(p)).toBe(false);
      expect((await gate(req(p, { method: "POST" }), d)).status).toBe(403);
    }
  });
  it("the check runs before authentication (cross-origin POST by anonymous -> 403)", async () => {
    const d = await mk({ readClaims: async () => null });
    expect((await gate(post({ origin: "https://evil.test" }), d)).status).toBe(403);
  });
});

describe("rate limits (SEC-014)", () => {
  it("11th sign-in callback within a minute -> 429", async () => {
    const d = await mk({ readClaims: async () => null });
    const call = () => gate(req("/api/auth/callback/google", { ip: "7.7.7.7, 1.1.1.1" }), d);
    for (let i = 0; i < 10; i++) expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
    // another IP is unaffected
    const other = await gate(req("/api/auth/callback/google", { ip: "8.8.8.8" }), d);
    expect(other.status).toBe(200);
  });

  it("the test-identity login is limited per IP like a sign-in", async () => {
    const d = await mk({
      readClaims: async () => null,
      limits: { ...LIMITS, signin_per_min_ip: 2 },
    });
    const call = () => gate(req("/api/test-identity/login", { method: "POST", ip: "6.6.6.6" }), d);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });

  it("limits /api/auth/signin/* and the sign-in form POST, not other auth GETs", async () => {
    const d = await mk({
      readClaims: async () => null,
      limits: { ...LIMITS, signin_per_min_ip: 1 },
    });
    const same = { origin: BASE };
    expect(
      (await gate(req("/api/auth/signin/google", { method: "POST", headers: same }), d)).status,
    ).toBe(200);
    expect(
      (await gate(req("/api/auth/signin/google", { method: "POST", headers: same }), d)).status,
    ).toBe(429);
    const d2 = await mk({
      readClaims: async () => null,
      limits: { ...LIMITS, signin_per_min_ip: 1 },
    });
    expect((await gate(req("/signin", { method: "POST", headers: same }), d2)).status).toBe(200);
    expect((await gate(req("/signin", { method: "POST", headers: same }), d2)).status).toBe(429);
    for (let i = 0; i < 3; i++) expect((await gate(req("/api/auth/session"), d2)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await gate(req("/signin"), d2)).status).toBe(200); // GET page
  });

  it("unknown IPs share one bucket", async () => {
    const d = await mk({
      readClaims: async () => null,
      limits: { ...LIMITS, signin_per_min_ip: 1 },
    });
    await gate(req("/api/auth/callback/google"), d);
    expect((await gate(req("/api/auth/callback/google"), d)).status).toBe(429);
  });

  it("rate-limit DB failure on sign-in -> 503, never allowed through", async () => {
    const d = await mk({ readClaims: async () => null, db: broken });
    expect((await gate(req("/api/auth/callback/google"), d)).status).toBe(503);
  });

  it("authenticated writes: 61st in a minute -> 429, per user", async () => {
    const h = { origin: BASE };
    const d = await mk();
    const call = (uid = 5) => {
      const dd = { ...d, readClaims: async () => ({ ...CLAIMS, uid }) };
      return gate(req("/api/thing", { method: "POST", headers: h }), dd);
    };
    for (let i = 0; i < 60; i++) expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
    expect((await call(6)).status).toBe(200);
  });

  it("authenticated GETs are not write-limited", async () => {
    const d = await mk({ limits: { ...LIMITS, writes_per_min_user: 1 } });
    for (let i = 0; i < 5; i++) expect((await gate(req("/"), d)).status).toBe(200);
  });

  it("write rate-limit DB failure -> 503", async () => {
    const d = await mk({ db: broken });
    const res = await gate(req("/api/thing", { method: "POST", headers: { origin: BASE } }), d);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("unavailable");
  });

  it("unexpected error while reading the session -> 503", async () => {
    const d = await mk({
      readClaims: async () => {
        throw new Error("boom");
      },
    });
    expect((await gate(req("/"), d)).status).toBe(503);
  });
});
