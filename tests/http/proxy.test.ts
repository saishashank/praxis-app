// @vitest-environment node
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../db/helpers";

const dbMock = vi.fn();
vi.mock("@/lib/db/client", () => ({ authDb: () => dbMock() }));

const SECRET = "s".repeat(48);
const BASE = "https://app.example.test";

async function cookieFor(claims: Record<string, unknown>, name: string, secret = SECRET) {
  return `${name}=${await encode({ token: claims, secret, salt: name, maxAge: 3600 })}`;
}
const now = () => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("APP_BASE_URL", BASE);
  dbMock.mockReturnValue(await freshDb("auth"));
});
afterEach(() => vi.unstubAllEnvs());

describe("proxy (real JWT decoding)", () => {
  it("a valid Auth.js session cookie lets the request through", async () => {
    const { proxy } = await import("@/proxy");
    const cookie = await cookieFor({ uid: 1, sv: 1, si: now() }, "__Secure-authjs.session-token");
    const res = await proxy(new NextRequest(`${BASE}/`, { headers: { cookie } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("'nonce-");
  });

  it("plain cookie name is used on http", async () => {
    const { proxy } = await import("@/proxy");
    const cookie = await cookieFor({ uid: 1, sv: 1, si: now() }, "authjs.session-token");
    const res = await proxy(new NextRequest("http://localhost:3000/", { headers: { cookie } }));
    expect(res.status).toBe(200);
  });

  it("x-forwarded-proto https selects the secure cookie name", async () => {
    const { proxy } = await import("@/proxy");
    const cookie = await cookieFor({ uid: 1, sv: 1, si: now() }, "__Secure-authjs.session-token");
    const res = await proxy(
      new NextRequest("http://localhost:3000/", {
        headers: { cookie, "x-forwarded-proto": "https" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it.each([
    ["no cookie", async () => ""],
    [
      "wrong secret",
      () =>
        cookieFor({ uid: 1, sv: 1, si: now() }, "__Secure-authjs.session-token", "x".repeat(48)),
    ],
    [
      "expired by sign-in time",
      () => cookieFor({ uid: 1, sv: 1, si: 1 }, "__Secure-authjs.session-token"),
    ],
    ["missing claims", () => cookieFor({ sub: "1" }, "__Secure-authjs.session-token")],
    ["garbage token", async () => "__Secure-authjs.session-token=abc.def"],
  ])("%s -> redirected to sign-in", async (_n, mkCookie) => {
    const { proxy } = await import("@/proxy");
    const cookie = await mkCookie();
    const res = await proxy(new NextRequest(`${BASE}/`, { headers: cookie ? { cookie } : {} }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/signin?callbackUrl=%2F");
  });

  it("without AUTH_SECRET nobody is authenticated", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    const { proxy } = await import("@/proxy");
    const cookie = await cookieFor({ uid: 1, sv: 1, si: now() }, "__Secure-authjs.session-token");
    const res = await proxy(new NextRequest(`${BASE}/api/x`, { headers: { cookie } }));
    expect(res.status).toBe(401);
  });

  it("matcher skips static assets only", async () => {
    const { config } = await import("@/proxy");
    const re = new RegExp(`^${config.matcher[0]}$`);
    expect(re.test("/_next/static/a.js")).toBe(false);
    expect(re.test("/brand/praxis-logo-light.svg")).toBe(false);
    expect(re.test("/icon.png")).toBe(false);
    expect(re.test("/")).toBe(true);
    expect(re.test("/api/auth/session")).toBe(true);
    expect(re.test("/signin")).toBe(true);
  });
});
