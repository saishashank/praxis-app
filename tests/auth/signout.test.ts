// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientIp, hmacEmail, requestMeta } from "@/lib/auth/audit";
import { signOutEverywhere } from "@/lib/auth/signout";
import { addUser, auditRows, authDb, ENV, KEY } from "./helpers";

const authMock = vi.fn();
const currentUser = vi.fn();
const signInMock = vi.fn();
const signOutMock = vi.fn();
const dbMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => authMock(),
  signIn: (...a: unknown[]) => signInMock(...a),
  signOut: (...a: unknown[]) => signOutMock(...a),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: () => currentUser() }));
vi.mock("@/lib/db/client", () => ({ authDb: () => dbMock() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "8.8.8.8", "user-agent": "agent" }),
}));

describe("signOutEverywhere", () => {
  it("bumps session_version and audits", async () => {
    const db = await authDb();
    const id = await addUser(db, { email: "v@example.test", sv: 4 });
    await signOutEverywhere(db, ENV, id, { ip: "1.1.1.1", userAgent: "u" });
    const r = await db.execute({
      sql: "SELECT session_version FROM app_user WHERE id = ?",
      args: [id],
    });
    expect(r.rows[0].session_version).toBe(5);
    const rows = await auditRows(db);
    expect(rows[0]).toMatchObject({ action: "auth.signout_everywhere", actor_user_id: id });
  });
});

describe("audit helpers", () => {
  it("clientIp prefers the first x-forwarded-for entry, then x-real-ip", () => {
    expect(
      clientIp(new Headers({ "x-forwarded-for": " 1.1.1.1 , 2.2.2.2", "x-real-ip": "3.3.3.3" })),
    ).toBe("1.1.1.1");
    expect(clientIp(new Headers({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(clientIp(new Headers())).toBeNull();
  });
  it("truncates the user agent to 300 chars", () => {
    const m = requestMeta(new Headers({ "user-agent": "a".repeat(500) }));
    expect(m.userAgent).toHaveLength(300);
    expect(requestMeta(new Headers()).userAgent).toBeNull();
  });
  it("hmacEmail is keyed and case-insensitive", () => {
    expect(hmacEmail(KEY, " A@Example.test ")).toBe(hmacEmail(KEY, "a@example.test"));
    expect(hmacEmail(KEY, "a@example.test")).not.toBe(hmacEmail("other", "a@example.test"));
  });
});

describe("server actions", () => {
  beforeEach(() => {
    signInMock.mockReset();
    signOutMock.mockReset();
    currentUser.mockReset();
    vi.unstubAllEnvs();
    vi.stubEnv("PII_HASH_KEY", KEY);
  });

  it("signInAction passes only a safe redirect target", async () => {
    const { signInAction } = await import("@/lib/auth/actions");
    const fd = (v: string) => {
      const f = new FormData();
      f.set("callbackUrl", v);
      return f;
    };
    await signInAction(fd("/markets"));
    await signInAction(fd("//evil.test"));
    await signInAction(fd("https://evil.test"));
    expect(signInMock.mock.calls.map((c) => c[1])).toEqual([
      { redirectTo: "/markets" },
      { redirectTo: "/" },
      { redirectTo: "/" },
    ]);
    expect(signInMock.mock.calls[0][0]).toBe("google");
  });

  it("signOutAction audits then signs out", async () => {
    const db = await authDb();
    const id = await addUser(db, { email: "v@example.test" });
    dbMock.mockReturnValue(db);
    currentUser.mockResolvedValue({ id, email: "v@example.test", name: null, role: "viewer" });
    const { signOutAction } = await import("@/lib/auth/actions");
    await signOutAction();
    expect((await auditRows(db))[0]).toMatchObject({
      action: "auth.signout",
      actor_user_id: id,
      ip: "8.8.8.8",
      user_agent: "agent",
    });
    expect(signOutMock).toHaveBeenCalledWith({ redirectTo: "/signin" });
  });

  it("signOutAction without a valid session still clears the cookie, no audit", async () => {
    const db = await authDb();
    dbMock.mockReturnValue(db);
    currentUser.mockResolvedValue(null);
    const { signOutAction } = await import("@/lib/auth/actions");
    await signOutAction();
    expect(await auditRows(db)).toHaveLength(0);
    expect(signOutMock).toHaveBeenCalled();
  });
});
