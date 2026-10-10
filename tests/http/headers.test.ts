// @vitest-environment node
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import robots from "@/app/robots";
import { GET as health } from "@/app/api/health/route";
import { buildCsp, newNonce } from "@/lib/http/csp";
import { getRateLimits, getSessionMaxAgeSec } from "@/lib/http/limits";

describe("next.config headers (SEC-012, PLT-036)", () => {
  it("sets the static security headers on every path", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("/:path*");
    const h = Object.fromEntries(rules[0].headers.map((x) => [x.key, x.value]));
    expect(h["Strict-Transport-Security"]).toMatch(/^max-age=\d+; includeSubDomains/);
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("same-origin");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["X-Robots-Tag"]).toBe("noindex, nofollow");
    expect(h["Permissions-Policy"]).toContain("camera=()");
  });
  it("does not advertise the framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

describe("robots and health", () => {
  it("robots disallows everything", () => {
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });
  it("health is a bare, uncached 'ok'", async () => {
    const res = health();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("csp helpers", () => {
  it("nonce is base64 and unique", () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(newNonce());
  });
  it("production policy has no unsafe-eval and no inline scripts", () => {
    const csp = buildCsp("n", false);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp.split("; ").find((d) => d.startsWith("script-src"))).toBe(
      "script-src 'self' 'nonce-n' 'strict-dynamic'",
    );
  });
});

describe("limits accessor", () => {
  it("returns the registry defaults", () => {
    expect(getRateLimits()).toEqual({
      signin_per_min_ip: 10,
      writes_per_min_user: 60,
      exports_per_hour_user: 5,
    });
    expect(getSessionMaxAgeSec()).toBe(14 * 86400);
  });
});
