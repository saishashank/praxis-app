// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthConfig } from "@/lib/auth/config";
import {
  SESSION_COOKIE_PLAIN,
  SESSION_COOKIE_SECURE,
  cookieSecure,
  pinnedOrigin,
  sessionCookieConfig,
  trustHostFor,
} from "@/lib/auth/cookies";
import { addUser, auditRows, authDb, ENV } from "./helpers";
// Auth.js default cookie table (not exported by the package): pins HttpOnly/Secure/SameSite=Lax.
import { defaultCookies } from "../../node_modules/@auth/core/lib/utils/cookie.js";

const dbMock = vi.fn();
vi.mock("@/lib/db/client", () => ({ authDb: () => dbMock() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "4.4.4.4", "user-agent": "ua" }),
}));

type Cb = NonNullable<ReturnType<typeof buildAuthConfig>["callbacks"]>;
const cb = () => buildAuthConfig().callbacks as Required<Pick<Cb, "signIn" | "jwt" | "session">>;

beforeEach(() => {
  dbMock.mockReset();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v as string);
});

describe("auth config object", () => {
  const cfg = buildAuthConfig();
  it("uses JWT sessions with the configured lifetime and no adapter", () => {
    expect(cfg.session).toEqual({ strategy: "jwt", maxAge: 14 * 86400 });
    expect(cfg.adapter).toBeUndefined();
    // no APP_BASE_URL and not production (vitest): the host may be derived from the request
    expect(cfg.trustHost).toBe(true);
    expect(cfg.pages).toEqual({ signIn: "/signin", error: "/signin" });
  });
  it("lifetime never exceeds 14 days (SEC-010)", () => {
    expect((cfg.session?.maxAge ?? 0) <= 14 * 86400).toBe(true);
  });
  it("Google provider with PKCE + state and minimal scopes (PLT-035)", () => {
    const p = cfg.providers[0] as unknown as {
      id: string;
      options?: Record<string, unknown>;
      checks?: unknown;
      authorization?: unknown;
    };
    expect(p.id).toBe("google");
    const o = (p.options ?? p) as {
      checks: string[];
      authorization: { params: { scope: string } };
    };
    expect(o.checks).toEqual(["pkce", "state"]);
    expect(o.authorization.params.scope).toBe("openid email profile");
  });
  it("pins the session cookie to the Auth.js default name and flags (PLT-033, V1-I10)", () => {
    const https = defaultCookies(true);
    expect(
      sessionCookieConfig({ APP_BASE_URL: "https://praxis.example.test" }).sessionToken,
    ).toEqual({ name: https.sessionToken.name, options: https.sessionToken.options });
    const http = defaultCookies(false);
    expect(sessionCookieConfig({ APP_BASE_URL: "http://localhost:3000" }).sessionToken).toEqual({
      name: http.sessionToken.name,
      options: http.sessionToken.options,
    });
    for (const k of ["callbackUrl", "csrfToken", "pkceCodeVerifier", "state"]) {
      const opt = (https as Record<string, { options: Record<string, unknown> }>)[k].options;
      expect(opt).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true });
    }
    expect(SESSION_COOKIE_SECURE).toBe(https.sessionToken.name);
    expect(SESSION_COOKIE_PLAIN).toBe(http.sessionToken.name);
  });
  it("buildAuthConfig carries the pinned cookie block", () => {
    vi.stubEnv("APP_BASE_URL", "https://praxis.example.test");
    const c = buildAuthConfig();
    expect(c.cookies?.sessionToken).toEqual({
      name: "__Secure-authjs.session-token",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    });
  });
});

describe("pinned host (V1-I10)", () => {
  afterEach(() => {
    delete process.env.AUTH_URL;
  });
  it("pinnedOrigin reads only a valid http(s) APP_BASE_URL", () => {
    expect(pinnedOrigin({ APP_BASE_URL: "https://praxis.example.test/x/" })).toBe(
      "https://praxis.example.test",
    );
    for (const v of [undefined, "", "  ", "not a url", "ftp://x.test", "javascript:1"])
      expect(pinnedOrigin({ APP_BASE_URL: v })).toBeNull();
  });
  it("production without a pin refuses to trust the request host; with a pin it does", () => {
    expect(trustHostFor({ NODE_ENV: "production" })).toBe(false);
    expect(trustHostFor({ NODE_ENV: "production", APP_BASE_URL: "https://p.example.test" })).toBe(
      true,
    );
    expect(trustHostFor({ NODE_ENV: "development" })).toBe(true);
  });
  it("cookieSecure follows the pinned scheme, else production", () => {
    expect(cookieSecure({ APP_BASE_URL: "https://p.example.test" })).toBe(true);
    expect(cookieSecure({ APP_BASE_URL: "http://localhost:3000", NODE_ENV: "production" })).toBe(
      false,
    );
    expect(cookieSecure({ NODE_ENV: "production" })).toBe(true);
    expect(cookieSecure({})).toBe(false);
  });
  it("buildAuthConfig hands the origin to Auth.js as AUTH_URL, keeping an explicit one", () => {
    vi.stubEnv("APP_BASE_URL", "https://praxis.example.test");
    delete process.env.AUTH_URL;
    buildAuthConfig();
    expect(process.env.AUTH_URL).toBe("https://praxis.example.test");
    process.env.AUTH_URL = "https://other.example.test";
    buildAuthConfig();
    expect(process.env.AUTH_URL).toBe("https://other.example.test");
  });
});

describe("signIn callback", () => {
  const profile = { sub: "s1", email: "owner@example.test", email_verified: true };

  it("allows the Owner, hands our uid to the jwt callback", async () => {
    const db = await authDb();
    dbMock.mockReturnValue(db);
    const user = { id: "google-sub" };
    const res = await cb().signIn({ user, profile } as never);
    expect(res).toBe(true);
    expect(user.id).toMatch(/^\d+:n$/);
    const rows = await auditRows(db);
    expect(rows[0]).toMatchObject({ action: "auth.signin_success", ip: "4.4.4.4" });
  });

  it("refused account redirects to the neutral error", async () => {
    const db = await authDb();
    dbMock.mockReturnValue(db);
    const res = await cb().signIn({
      user: { id: "x" },
      profile: { ...profile, email: "nobody@example.test" },
    } as never);
    expect(res).toBe("/signin?error=AccessDenied");
  });

  it("missing profile is refused", async () => {
    const db = await authDb();
    dbMock.mockReturnValue(db);
    expect(await cb().signIn({ user: { id: "x" } } as never)).toBe("/signin?error=AccessDenied");
  });

  it("recovery sign-in flags the token", async () => {
    const db = await authDb();
    dbMock.mockReturnValue(db);
    vi.stubEnv("OWNER_RECOVERY_ENABLED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const user = { id: "g" };
    const ok = await cb().signIn({
      user,
      profile: { sub: "r", email: "recovery@example.test", email_verified: true },
    } as never);
    expect(ok).toBe(true);
    expect(user.id).toMatch(/^\d+:r$/);
    vi.unstubAllGlobals();
  });
});

describe("jwt callback", () => {
  it("builds a minimal token at sign-in (no name/email/picture)", async () => {
    const db = await authDb();
    const id = await addUser(db, { email: "v@example.test", sv: 3 });
    dbMock.mockReturnValue(db);
    const t = (await cb().jwt({
      token: { name: "N", email: "v@example.test", picture: "p", sub: "1" },
      user: { id: `${id}:n` },
    } as never)) as Record<string, unknown>;
    expect(Object.keys(t).sort()).toEqual(["rec", "si", "sv", "uid"]);
    expect(t).toMatchObject({ uid: id, sv: 3, rec: false });
    expect(Math.abs((t.si as number) - Date.now() / 1000)).toBeLessThan(5);
  });

  it("keeps the sign-in time on later refreshes", async () => {
    const token = { uid: 1, sv: 1, si: 123, rec: false };
    expect(await cb().jwt({ token } as never)).toBe(token);
  });

  it("returns null when the user vanished", async () => {
    dbMock.mockReturnValue(await authDb());
    expect(await cb().jwt({ token: {}, user: { id: "99:n" } } as never)).toBeNull();
  });
});

describe("session callback", () => {
  it("exposes only the claims and expiry", async () => {
    const out = await cb().session({
      session: { expires: "2026-10-24T00:00:00.000Z", user: { name: "N", email: "e" } },
      token: { uid: 2, sv: 1, si: 5, rec: false, email: "e" },
    } as never);
    expect(out).toEqual({
      expires: "2026-10-24T00:00:00.000Z",
      praxis: { uid: 2, sv: 1, si: 5, rec: false },
    });
  });
});
