// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthConfig } from "@/lib/auth/config";
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
  it("leaves cookies at Auth.js defaults, which are HttpOnly + Secure + SameSite=Lax on https", () => {
    expect(cfg.cookies).toBeUndefined();
    const c = defaultCookies(true);
    expect(c.sessionToken.name).toBe("__Secure-authjs.session-token");
    for (const k of ["sessionToken", "callbackUrl", "csrfToken", "pkceCodeVerifier", "state"]) {
      const opt = (c as Record<string, { options: Record<string, unknown> }>)[k].options;
      expect(opt).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true });
    }
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
