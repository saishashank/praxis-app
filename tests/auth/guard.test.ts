// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { authorize, defaultDeps, requireUser, withAuth, type GuardDeps } from "@/lib/auth/guard";
import { AuthUnavailableError, type CurrentUser } from "@/lib/auth/session";
import { auditRows, authDb, addUser } from "./helpers";

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
const forbiddenMock = vi.fn(() => {
  throw new Error("NEXT_HTTP_ERROR_FALLBACK;403");
});
vi.mock("next/navigation", () => ({
  redirect: (u: string) => redirectMock(u),
  forbidden: () => forbiddenMock(),
}));
const headersMock = vi.fn();
vi.mock("next/headers", () => ({ headers: () => headersMock() }));
const dbMock = vi.fn();
vi.mock("@/lib/db/client", () => ({ authDb: () => dbMock() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

const user = (role: CurrentUser["role"]): CurrentUser => ({
  id: 7,
  email: "u@example.test",
  name: null,
  role,
});
const META = { ip: "9.9.9.9", userAgent: "UA" };

function deps(u: CurrentUser | null | Error, forbid = vi.fn(async () => {})): GuardDeps {
  return {
    getUser: async () => {
      if (u instanceof Error) throw u;
      return u;
    },
    recordForbidden: forbid,
    meta: async () => META,
  };
}

describe("authorize", () => {
  it("ok when the role permits", async () => {
    expect(await authorize("annotate", "/x", null, deps(user("editor")))).toEqual({
      kind: "ok",
      user: user("editor"),
    });
  });
  it("unauthenticated", async () => {
    expect((await authorize("read", "/x", null, deps(null))).kind).toBe("unauthenticated");
  });
  it("forbidden is recorded with action and path", async () => {
    const forbid = vi.fn(async () => {});
    const out = await authorize("admin", "/admin", null, deps(user("viewer"), forbid));
    expect(out.kind).toBe("forbidden");
    expect(forbid).toHaveBeenCalledWith(user("viewer"), "admin", "/admin", META);
  });
  it("auth failure or audit failure -> unavailable (fail closed)", async () => {
    expect((await authorize("read", "/x", null, deps(new AuthUnavailableError()))).kind).toBe(
      "unavailable",
    );
    const bad = vi.fn(async () => {
      throw new Error("audit down");
    });
    expect((await authorize("admin", "/x", null, deps(user("viewer"), bad))).kind).toBe(
      "unavailable",
    );
  });
});

describe("requireUser", () => {
  it("returns the user", async () => {
    expect(await requireUser("read", "/", deps(user("viewer")))).toEqual(user("viewer"));
  });
  it("redirects to sign-in with the encoded callbackUrl", async () => {
    await expect(requireUser("read", "/a b?x=1", deps(null))).rejects.toThrow(
      "REDIRECT:/signin?callbackUrl=%2Fa%20b%3Fx%3D1",
    );
  });
  it("calls Next forbidden() (403 page) for a disallowed role, after the audit write", async () => {
    const forbid = vi.fn(async () => {});
    forbiddenMock.mockClear();
    await expect(requireUser("admin", "/a", deps(user("editor"), forbid))).rejects.toThrow(
      "NEXT_HTTP_ERROR_FALLBACK;403",
    );
    expect(forbid).toHaveBeenCalledWith(user("editor"), "admin", "/a", META);
    expect(forbiddenMock).toHaveBeenCalledTimes(1);
  });
  it("does not call forbidden() when the role is allowed", async () => {
    forbiddenMock.mockClear();
    await requireUser("read", "/", deps(user("viewer")));
    expect(forbiddenMock).not.toHaveBeenCalled();
  });
  it("throws AuthUnavailableError when identity cannot be resolved", async () => {
    await expect(requireUser("read", "/", deps(new Error("x")))).rejects.toBeInstanceOf(
      AuthUnavailableError,
    );
  });
});

describe("withAuth", () => {
  const handler = vi.fn(async () => new Response("done"));
  const req = (extra: Record<string, string> = {}) =>
    new Request("https://app.example.test/api/thing?q=1", { headers: extra });

  it("401 JSON when unauthenticated; handler not called", async () => {
    const res = await withAuth("read", handler, deps(null))(req(), {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(handler).not.toHaveBeenCalled();
  });
  it("403 JSON for a disallowed role, audit receives request meta", async () => {
    const forbid = vi.fn(async () => {});
    const r = req({ "x-forwarded-for": "5.5.5.5, 6.6.6.6", "user-agent": "agent" });
    const res = await withAuth("what_if", handler, deps(user("viewer"), forbid))(r, {});
    expect(res.status).toBe(403);
    expect(forbid).toHaveBeenCalledWith(user("viewer"), "what_if", "/api/thing", {
      ip: "5.5.5.5",
      userAgent: "agent",
    });
    expect(handler).not.toHaveBeenCalled();
  });
  it("503 when identity is unavailable", async () => {
    const res = await withAuth("read", handler, deps(new Error("x")))(req(), {});
    expect(res.status).toBe(503);
  });
  it("calls the handler with user and context when allowed", async () => {
    const res = await withAuth("read", handler, deps(user("viewer")))(req(), { id: "1" });
    expect(await res.text()).toBe("done");
    expect(handler).toHaveBeenCalledWith(expect.any(Request), user("viewer"), { id: "1" });
  });
});

describe("defaultDeps", () => {
  it("writes an auth.forbidden audit row with action, path and role", async () => {
    const db = await authDb();
    const id = await addUser(db, { email: "u@example.test" });
    dbMock.mockReturnValue(db);
    vi.stubEnv("PII_HASH_KEY", "k".repeat(64));
    await defaultDeps.recordForbidden({ ...user("viewer"), id }, "admin", "/admin", META);
    const rows = await auditRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "auth.forbidden", actor_user_id: id, ip: "9.9.9.9" });
    expect(rows[0].detail).toEqual({ action: "admin", path: "/admin", role: "viewer" });
    vi.unstubAllEnvs();
  });
  it("meta reads request headers", async () => {
    headersMock.mockResolvedValue(new Headers({ "x-real-ip": "3.3.3.3", "user-agent": "z" }));
    expect(await defaultDeps.meta()).toEqual({ ip: "3.3.3.3", userAgent: "z" });
  });
});
