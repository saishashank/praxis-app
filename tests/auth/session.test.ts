// @vitest-environment node
import type { Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseClaims } from "@/lib/auth/claims";
import { AuthUnavailableError, getCurrentUser, resolveUser } from "@/lib/auth/session";
import { ENV, addUser, authDb } from "./helpers";

const authMock = vi.fn();
const dbMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/db/client", () => ({ authDb: () => dbMock() }));

const claims = (uid: number, o: Record<string, unknown> = {}) => ({
  uid,
  sv: 1,
  si: 1000,
  rec: false,
  ...o,
});

describe("parseClaims", () => {
  const MAX = 14 * 86400;
  it("accepts a fresh claim set", () => {
    expect(parseClaims({ uid: 3, sv: 2, si: 1000 }, 1100, MAX)).toEqual({
      uid: 3,
      sv: 2,
      si: 1000,
      rec: false,
    });
    expect(parseClaims({ uid: 3, sv: 2, si: 1000, rec: true }, 1100, MAX)?.rec).toBe(true);
  });
  it("enforces the absolute lifetime and clock sanity", () => {
    expect(parseClaims({ uid: 3, sv: 2, si: 1000 }, 1000 + MAX, MAX)).not.toBeNull();
    expect(parseClaims({ uid: 3, sv: 2, si: 1000 }, 1001 + MAX, MAX)).toBeNull();
    expect(parseClaims({ uid: 3, sv: 2, si: 5000 }, 1000, MAX)).toBeNull(); // from the future
  });
  it.each([null, undefined, "x", 5, {}, { uid: "1", sv: 1, si: 1 }, { uid: 0, sv: 1, si: 1 }])(
    "rejects malformed %j",
    (raw) => {
      expect(parseClaims(raw, 1000, MAX)).toBeNull();
    },
  );
  it("rejects bad sv / si", () => {
    expect(parseClaims({ uid: 1, sv: 0, si: 1000 }, 1000, MAX)).toBeNull();
    expect(parseClaims({ uid: 1, sv: 1, si: "1000" }, 1000, MAX)).toBeNull();
    expect(parseClaims({ uid: 1.5, sv: 1, si: 1000 }, 1000, MAX)).toBeNull();
  });
});

describe("resolveUser", () => {
  it("returns the user with the role from the DB", async () => {
    const db = await authDb();
    const id = await addUser(db, { email: "e@example.test", role: "editor" });
    expect(await resolveUser(db, claims(id), ENV)).toMatchObject({
      id,
      email: "e@example.test",
      role: "editor",
    });
  });

  it("no claims or unknown uid -> null", async () => {
    const db = await authDb();
    expect(await resolveUser(db, null, ENV)).toBeNull();
    expect(await resolveUser(db, claims(999), ENV)).toBeNull();
  });

  it("revocation after sign-in is refused on the very next call", async () => {
    const db = await authDb();
    const id = await addUser(db, { email: "e@example.test" });
    expect(await resolveUser(db, claims(id), ENV)).not.toBeNull();
    await db.execute({ sql: "UPDATE app_user SET status = 'revoked' WHERE id = ?", args: [id] });
    expect(await resolveUser(db, claims(id), ENV)).toBeNull();
  });

  it("a role change takes effect on the next call", async () => {
    const db = await authDb();
    const id = await addUser(db, { email: "e@example.test", role: "editor" });
    await db.execute({ sql: "UPDATE app_user SET role = 'viewer' WHERE id = ?", args: [id] });
    expect((await resolveUser(db, claims(id), ENV))?.role).toBe("viewer");
  });

  it("session_version bump invalidates the session", async () => {
    const db = await authDb();
    const id = await addUser(db, { email: "e@example.test" });
    await db.execute({
      sql: "UPDATE app_user SET session_version = session_version + 1 WHERE id = ?",
      args: [id],
    });
    expect(await resolveUser(db, claims(id), ENV)).toBeNull();
  });

  it("an invited (never activated) user has no session", async () => {
    const db = await authDb();
    const id = await addUser(db, { email: "e@example.test", status: "invited" });
    expect(await resolveUser(db, claims(id), ENV)).toBeNull();
  });

  it("owner role requires the pinned address", async () => {
    const db = await authDb();
    const a = await addUser(db, { email: "owner@example.test", role: "owner" });
    expect((await resolveUser(db, claims(a), ENV))?.role).toBe("owner");
    expect(
      (await resolveUser(db, claims(a), { ...ENV, OWNER_EMAIL: "x@example.test" }))?.role,
    ).toBe("viewer");
    expect((await resolveUser(db, claims(a), { ...ENV, OWNER_EMAIL: undefined }))?.role).toBe(
      "viewer",
    );
  });

  it("a recovery session ends when recovery is disabled", async () => {
    const db = await authDb();
    const id = await addUser(db, { email: "owner@example.test", role: "owner" });
    const on = { ...ENV, OWNER_RECOVERY_ENABLED: "true" };
    expect(await resolveUser(db, claims(id, { rec: true }), on)).not.toBeNull();
    expect(await resolveUser(db, claims(id, { rec: true }), ENV)).toBeNull();
  });

  it("DB error -> AuthUnavailableError", async () => {
    const broken = {
      execute: async () => {
        throw new Error("down");
      },
    } as unknown as Client;
    await expect(resolveUser(broken, claims(1), ENV)).rejects.toBeInstanceOf(AuthUnavailableError);
  });
});

describe("getCurrentUser", () => {
  beforeEach(() => {
    authMock.mockReset();
    dbMock.mockReset();
    vi.useRealTimers();
  });

  it("no session -> null, no DB access", async () => {
    authMock.mockResolvedValue(null);
    expect(await getCurrentUser()).toBeNull();
    expect(dbMock).not.toHaveBeenCalled();
  });

  it("expired claims -> null", async () => {
    authMock.mockResolvedValue({ praxis: claims(1, { si: 1 }) });
    expect(await getCurrentUser()).toBeNull();
  });

  it("valid session -> user, using process.env", async () => {
    const db = await authDb();
    const id = await addUser(db, { email: "v@example.test" });
    dbMock.mockReturnValue(db);
    authMock.mockResolvedValue({
      praxis: claims(id, { si: Math.floor(Date.now() / 1000) }),
    });
    expect((await getCurrentUser())?.id).toBe(id);
  });

  it("DB client not configured -> AuthUnavailableError", async () => {
    authMock.mockResolvedValue({ praxis: claims(1, { si: Math.floor(Date.now() / 1000) }) });
    dbMock.mockImplementation(() => {
      throw new Error("database not configured");
    });
    await expect(getCurrentUser()).rejects.toBeInstanceOf(AuthUnavailableError);
  });
});
