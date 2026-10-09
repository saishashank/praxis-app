// @vitest-environment node
import type { Client } from "@libsql/client";
import { getToken } from "next-auth/jwt";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLoginHandler } from "@/app/api/test-identity/login/handler";
import { parseClaims } from "@/lib/auth/claims";
import { resolveUser } from "@/lib/auth/session";
import { TEST_IDENTITY_BUILD, isTestEmail, testIdentityEnabled } from "@/lib/auth/testIdentity";
import { auditKey, verifyAuditChain } from "@/lib/db/audit";
import { getSessionMaxAgeSec } from "@/lib/http/limits";
import { computeSignature } from "@/lib/security/hmac";
import type { NonceStore } from "@/lib/security/replay";
import { ENV, KEY, addUser, auditRows, authDb } from "./helpers";

vi.mock("@/auth", () => ({ auth: vi.fn() })); // session.ts imports it; not under test here

const SECRET = "b".repeat(64);
const AUTH_SECRET = "c".repeat(64);
const NOW = 1_800_000_000;
const URL_HTTPS = "https://staging.example.test/api/test-identity/login";
const URL_HTTP = "http://localhost:3000/api/test-identity/login";

const STAGING = {
  TEST_IDENTITY_SECRET: SECRET,
  AUTH_SECRET,
  PII_HASH_KEY: KEY,
  NODE_ENV: "production", // `next start` on Vercel; the point is that it is not "development"
} as Record<string, string | undefined>;

class MemStore implements NonceStore {
  seen = new Set<string>();
  fail = false;
  async claim(nonce: string): Promise<boolean> {
    if (this.fail) throw new Error("down");
    if (this.seen.has(nonce)) return false;
    this.seen.add(nonce);
    return true;
  }
}

function signed(
  body: string,
  o: { secret?: string; ts?: number; nonce?: string; url?: string; headers?: HeadersInit } = {},
): Request {
  const ts = String(o.ts ?? NOW);
  const nonce = o.nonce ?? randomBytes(16).toString("hex");
  const sig = computeSignature(o.secret ?? SECRET, ts, nonce, body);
  return new Request(o.url ?? URL_HTTPS, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-praxis-timestamp": ts,
      "x-praxis-nonce": nonce,
      "x-praxis-signature": sig,
      ...(o.headers as Record<string, string>),
    },
    body,
  });
}
const login = (email: unknown) => JSON.stringify({ email });

let db: Client;
let store: MemStore;
const make = (env = STAGING, over: Partial<Parameters<typeof createTestLoginHandler>[0]> = {}) =>
  createTestLoginHandler({ env, authDb: () => db, store, nowSec: () => NOW, ...over });

beforeEach(async () => {
  db = await authDb();
  store = new MemStore();
});

describe("testIdentityEnabled (SEC-109)", () => {
  it("is enabled on staging: valid secret, no production markers", () => {
    expect(testIdentityEnabled(STAGING)).toBe(true);
  });

  it.each([
    ["no secret", { TEST_IDENTITY_SECRET: undefined }],
    ["empty secret", { TEST_IDENTITY_SECRET: "" }],
    ["short secret", { TEST_IDENTITY_SECRET: "ab12" }],
    ["upper-case hex secret", { TEST_IDENTITY_SECRET: "B".repeat(64) }],
    ["non-hex secret", { TEST_IDENTITY_SECRET: "z".repeat(64) }],
    ["BACKUP_PUBLIC_KEY present (production marker)", { BACKUP_PUBLIC_KEY: "age1abc" }],
    ["OWNER_RECOVERY_EMAIL present (production marker)", { OWNER_RECOVERY_EMAIL: "r@x.test" }],
    ["NODE_ENV development", { NODE_ENV: "development" }],
  ])("each signal alone disables it: %s", (_n, over) => {
    expect(testIdentityEnabled({ ...STAGING, ...over })).toBe(false);
  });

  it("blank production markers (whitespace) do not count as present", () => {
    const env = { ...STAGING, BACKUP_PUBLIC_KEY: "  ", OWNER_RECOVERY_EMAIL: "" };
    expect(testIdentityEnabled(env)).toBe(true);
  });

  it("development is allowed only when a test says so explicitly", () => {
    const dev = { ...STAGING, NODE_ENV: "development" };
    expect(testIdentityEnabled(dev)).toBe(false);
    expect(testIdentityEnabled(dev, { allowDevelopment: true })).toBe(true);
    expect(testIdentityEnabled(dev, { allowDevelopment: false })).toBe(false);
  });

  it("production configuration (with or without a leaked secret) is disabled", () => {
    const prod = { BACKUP_PUBLIC_KEY: "age1abc", OWNER_RECOVERY_EMAIL: "r@x.test" };
    expect(testIdentityEnabled(prod)).toBe(false);
    expect(testIdentityEnabled({ ...prod, TEST_IDENTITY_SECRET: SECRET })).toBe(false);
  });

  it("TEST_IDENTITY_BUILD is a boolean and never decides anything by itself", () => {
    expect(typeof TEST_IDENTITY_BUILD).toBe("boolean");
  });

  it("isTestEmail accepts only .test and .invalid addresses", () => {
    for (const e of ["a@b.test", "a@x.y.invalid", "a+1@b.test"]) expect(isTestEmail(e)).toBe(true);
    for (const e of ["a@b.com", "a@b.test.com", "a@testtest", "a b@c.test", "", "a@b.testx"]) {
      expect(isTestEmail(e)).toBe(false);
    }
  });
});

describe("login handler", () => {
  it("disabled -> 404 before the body is read, the store or the DB is touched", async () => {
    const text = vi.fn(async () => "{}");
    const req = { text, headers: new Headers() } as unknown as Request;
    const authDbSpy = vi.fn(() => db);
    const claim = vi.fn(async () => true);
    const h = make(
      { ...STAGING, BACKUP_PUBLIC_KEY: "age1abc" },
      { authDb: authDbSpy, store: { claim } },
    );
    const res = await h(req);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(text).not.toHaveBeenCalled();
    expect(authDbSpy).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("success: sets an HttpOnly Secure SameSite=Lax cookie that the proxy reader accepts", async () => {
    const uid = await addUser(db, { email: "e2e-editor@praxis.test", role: "editor", sv: 3 });
    const res = await make()(signed(login("E2E-Editor@Praxis.TEST ")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: "editor" });
    const [pair, ...attrs] = res.headers.get("set-cookie")!.split("; ");
    expect(pair.startsWith("__Secure-authjs.session-token=")).toBe(true);
    expect(attrs).toEqual(expect.arrayContaining(["Path=/", "HttpOnly", "SameSite=Lax", "Secure"]));
    expect(attrs).toContain(`Max-Age=${getSessionMaxAgeSec()}`);
    expect(res.headers.get("cache-control")).toBe("no-store");

    // Round trip exactly as src/proxy.ts reads it.
    const read = (secret: string) =>
      getToken({
        req: new Request(URL_HTTPS, { headers: { cookie: pair } }),
        secret,
        secureCookie: true,
        cookieName: "__Secure-authjs.session-token",
      });
    const token = await read(AUTH_SECRET);
    const claims = parseClaims(token, NOW, getSessionMaxAgeSec());
    expect(claims).toEqual({ uid, sv: 3, si: NOW, rec: false });
    expect(await read("d".repeat(64))).toBeNull();
    const user = await resolveUser(db, claims, ENV);
    expect(user).toMatchObject({ id: uid, email: "e2e-editor@praxis.test", role: "editor" });
    // The cookie carries nothing but the claims (no email, name or picture).
    expect(Object.keys(token ?? {}).sort()).toEqual([
      "exp",
      "iat",
      "jti",
      "rec",
      "si",
      "sv",
      "uid",
    ]);
  });

  it("plain http uses the non-prefixed cookie name and no Secure attribute", async () => {
    await addUser(db, { email: "v@praxis.invalid", role: "viewer" });
    const res = await make()(signed(login("v@praxis.invalid"), { url: URL_HTTP }));
    expect(res.status).toBe(200);
    const sc = res.headers.get("set-cookie")!;
    expect(sc.startsWith("authjs.session-token=")).toBe(true);
    expect(sc).not.toContain("Secure");
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
  });

  it("x-forwarded-proto https selects the secure cookie even on an http url", async () => {
    await addUser(db, { email: "v@praxis.test" });
    const res = await make()(
      signed(login("v@praxis.test"), { url: URL_HTTP, headers: { "x-forwarded-proto": "https" } }),
    );
    expect(res.headers.get("set-cookie")!.startsWith("__Secure-authjs.session-token=")).toBe(true);
  });

  it("an invited user gets a cookie, but resolveUser refuses it until activation", async () => {
    const uid = await addUser(db, { email: "inv@praxis.test", status: "invited" });
    const res = await make()(signed(login("inv@praxis.test")));
    expect(res.status).toBe(200);
    expect(await resolveUser(db, { uid, sv: 1, si: NOW, rec: false }, ENV)).toBeNull();
  });

  it("writes audit auth.test_identity_signin with the user as actor and a valid chain", async () => {
    const uid = await addUser(db, { email: "a@praxis.test" });
    const res = await make()(
      signed(login("a@praxis.test"), {
        headers: { "x-forwarded-for": "9.9.9.9", "user-agent": "e2e" },
      }),
    );
    expect(res.status).toBe(200);
    const rows = await auditRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "auth.test_identity_signin",
      actor_user_id: uid,
      target_type: "user",
      target_id: String(uid),
      ip: "9.9.9.9",
      user_agent: "e2e",
    });
    expect(JSON.stringify(rows[0])).not.toContain("a@praxis.test");
    expect(await verifyAuditChain(db, auditKey(KEY))).toBeNull();
  });

  it("audit failure (no PII_HASH_KEY) -> 401 and no cookie (fail closed)", async () => {
    await addUser(db, { email: "a@praxis.test" });
    const res = await make({ ...STAGING, PII_HASH_KEY: undefined })(signed(login("a@praxis.test")));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("missing AUTH_SECRET -> 401, no audit row", async () => {
    await addUser(db, { email: "a@praxis.test" });
    const res = await make({ ...STAGING, AUTH_SECRET: undefined })(signed(login("a@praxis.test")));
    expect(res.status).toBe(401);
    expect(await auditRows(db)).toHaveLength(0);
  });

  describe("every failure is the same generic 401", () => {
    const expect401 = async (res: Response) => {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(res.headers.get("set-cookie")).toBeNull();
    };

    beforeEach(async () => {
      await addUser(db, { email: "ok@praxis.test" });
    });

    it("unsigned, bad signature, wrong secret, tampered body", async () => {
      const body = login("ok@praxis.test");
      await expect401(await make()(new Request(URL_HTTPS, { method: "POST", body })));
      await expect401(await make()(new Request(URL_HTTPS, { method: "POST", body: "{}" })));
      await expect401(await make()(signed(body, { secret: "e".repeat(64) })));
      const t = new Request(URL_HTTPS, {
        method: "POST",
        headers: signed(body).headers,
        body: login("other@praxis.test"),
      });
      await expect401(await make()(t));
    });

    it("stale and future timestamps", async () => {
      const body = login("ok@praxis.test");
      await expect401(await make()(signed(body, { ts: NOW - 301 })));
      await expect401(await make()(signed(body, { ts: NOW + 301 })));
      expect((await make()(signed(body, { ts: NOW - 300 }))).status).toBe(200);
    });

    it("replayed nonce", async () => {
      const body = login("ok@praxis.test");
      const nonce = "1".repeat(32);
      expect((await make()(signed(body, { nonce }))).status).toBe(200);
      await expect401(await make()(signed(body, { nonce })));
    });

    it("replay store failure", async () => {
      store.fail = true;
      await expect401(await make()(signed(login("ok@praxis.test"))));
    });

    it("non-test, unknown, revoked and malformed emails", async () => {
      await addUser(db, { email: "real@gmail.com" });
      await addUser(db, { email: "gone@praxis.test", status: "revoked" });
      const emails = ["real@gmail.com", "nobody@praxis.test", "gone@praxis.test", 5, null, ""];
      for (const email of emails) await expect401(await make()(signed(login(email))));
      await expect401(await make()(signed("not json")));
      await expect401(await make()(signed("null")));
      await expect401(await make()(signed("{}")));
      expect(await auditRows(db)).toHaveLength(0);
    });

    it("oversized body is refused before verification", async () => {
      const claim = vi.fn(async () => true);
      const big = JSON.stringify({ email: "ok@praxis.test", pad: "x".repeat(2000) });
      await expect401(await make(STAGING, { store: { claim } })(signed(big)));
      expect(claim).not.toHaveBeenCalled();
    });

    it("a DB error", async () => {
      const broken = {
        execute: async () => {
          throw new Error("down");
        },
      } as unknown as Client;
      const h = make(STAGING, { authDb: () => broken });
      await expect401(await h(signed(login("ok@praxis.test"))));
    });
  });
});

describe("route", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/db/client");
    vi.doUnmock("@/lib/security/replay");
  });

  it("production -> 404 'Not found' without reading the body or touching any DB", async () => {
    vi.stubEnv("TEST_IDENTITY_SECRET", SECRET);
    vi.stubEnv("BACKUP_PUBLIC_KEY", "age1abc");
    const authDbSpy = vi.fn();
    const ctor = vi.fn();
    vi.doMock("@/lib/db/client", () => ({ authDb: authDbSpy }));
    vi.doMock("@/lib/security/replay", () => ({ TursoNonceStore: ctor }));
    const { POST } = await import("@/app/api/test-identity/login/route");
    const text = vi.fn(async () => "{}");
    const res = await POST({ text, headers: new Headers() } as unknown as Request);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(text).not.toHaveBeenCalled();
    expect(authDbSpy).not.toHaveBeenCalled();
    expect(ctor).not.toHaveBeenCalled();
  });

  it("no secret at all (a plain production deploy) -> 404", async () => {
    vi.stubEnv("TEST_IDENTITY_SECRET", "");
    const { POST } = await import("@/app/api/test-identity/login/route");
    const res = await POST(new Request(URL_HTTPS, { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
  });

  it("enabled -> wires the handler (unsigned call -> 401)", async () => {
    vi.stubEnv("TEST_IDENTITY_SECRET", SECRET);
    vi.stubEnv("BACKUP_PUBLIC_KEY", "");
    vi.stubEnv("OWNER_RECOVERY_EMAIL", "");
    vi.stubEnv("NODE_ENV", "production");
    const fakeDb = await authDb();
    vi.doMock("@/lib/db/client", () => ({ authDb: () => fakeDb }));
    const { POST } = await import("@/app/api/test-identity/login/route");
    const res = await POST(new Request(URL_HTTPS, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("enabled + signed, replay store misconfigured -> 401 (fails closed)", async () => {
    vi.stubEnv("TEST_IDENTITY_SECRET", SECRET);
    vi.stubEnv("BACKUP_PUBLIC_KEY", "");
    vi.stubEnv("OWNER_RECOVERY_EMAIL", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURSO_MAIN_URL", "");
    vi.stubEnv("TURSO_MAIN_TOKEN", "");
    const fakeDb = await authDb();
    vi.doMock("@/lib/db/client", () => ({ authDb: () => fakeDb }));
    const { POST } = await import("@/app/api/test-identity/login/route");
    const res = await POST(signed(login("x@praxis.test")));
    expect(res.status).toBe(401);
  });
});
