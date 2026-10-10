// @vitest-environment node
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { addUser as seedUser, auditRows, authDb, KEY } from "../auth/helpers";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const dbMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9", "user-agent": "agent" }),
}));
vi.mock("@/lib/db/client", () => ({ authDb: () => dbMock() }));

import {
  addUserAction,
  changeRoleAction,
  recordSharingAckAction,
  revokeUserAction,
  signOutEverywhereAction,
} from "@/app/(app)/users/actions";

afterEach(cleanupTempDbs);

let db: Client;
let ownerId: number;
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("PII_HASH_KEY", KEY);
  vi.stubEnv("OWNER_EMAIL", "owner@example.test");
  requireUser.mockReset();
  revalidatePath.mockReset();
  db = await authDb();
  dbMock.mockReset();
  dbMock.mockReturnValue(db);
  ownerId = await seedUser(db, { email: "owner@example.test", role: "owner" });
  requireUser.mockResolvedValue({
    id: ownerId,
    email: "owner@example.test",
    name: null,
    role: "owner",
  });
});

describe("guard", () => {
  const all: Array<[string, (f: FormData) => Promise<unknown>]> = [
    ["recordSharingAckAction", recordSharingAckAction],
    ["addUserAction", addUserAction],
    ["changeRoleAction", changeRoleAction],
    ["revokeUserAction", revokeUserAction],
    ["signOutEverywhereAction", signOutEverywhereAction],
  ];

  it.each(all)("%s requires admin on /users and stops when refused", async (_n, fn) => {
    const v = await seedUser(db, { email: "v@example.test" });
    await recordSharingAckAction(form({ acknowledge: "on" }));
    const acks = (await db.execute("SELECT count(*) AS c FROM sharing_ack")).rows[0].c;
    const audits = (await auditRows(db)).length;
    revalidatePath.mockReset();
    requireUser.mockReset();
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(
      fn(form({ acknowledge: "on", email: "x@example.test", userId: String(v), role: "editor" })),
    ).rejects.toThrow(/403/);
    expect(requireUser).toHaveBeenCalledWith("admin", "/users");
    expect(revalidatePath).not.toHaveBeenCalled();
    expect((await db.execute("SELECT count(*) AS c FROM sharing_ack")).rows[0].c).toBe(acks);
    expect((await auditRows(db)).length).toBe(audits);
    const r = await db.execute({
      sql: "SELECT role, status, session_version FROM app_user WHERE id = ?",
      args: [v],
    });
    expect(r.rows[0]).toMatchObject({ role: "viewer", status: "active", session_version: 1 });
    expect(
      (await db.execute("SELECT 1 FROM app_user WHERE email = 'x@example.test'")).rows,
    ).toEqual([]);
  });
});

describe("recordSharingAckAction", () => {
  it("needs the checkbox", async () => {
    expect(await recordSharingAckAction(form({}))).toEqual({ error: "invalid" });
    expect(await recordSharingAckAction(form({ acknowledge: "yes" }))).toEqual({
      error: "invalid",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it("records AU / v1, audits with the request meta and revalidates", async () => {
    expect(await recordSharingAckAction(form({ acknowledge: "on" }))).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/users");
    const r = await db.execute("SELECT market, text_version, acknowledged_by FROM sharing_ack");
    expect(r.rows[0]).toMatchObject({ market: "AU", text_version: "v1", acknowledged_by: ownerId });
    expect((await auditRows(db))[0]).toMatchObject({
      action: "sharing.ack",
      ip: "9.9.9.9",
      user_agent: "agent",
    });
  });
  it("ignores a market or version sent by the client", async () => {
    await recordSharingAckAction(form({ acknowledge: "on", market: "US", textVersion: "evil" }));
    const r = await db.execute("SELECT market, text_version FROM sharing_ack");
    expect(r.rows[0]).toMatchObject({ market: "AU", text_version: "v1" });
  });
});

describe("addUserAction", () => {
  it("returns ack_required, invalid, exists as codes", async () => {
    expect(await addUserAction(form({ email: "a@example.test", role: "viewer" }))).toEqual({
      error: "ack_required",
    });
    await recordSharingAckAction(form({ acknowledge: "on" }));
    revalidatePath.mockReset();
    expect(await addUserAction(form({ email: "bad", role: "viewer" }))).toEqual({
      error: "invalid",
    });
    expect(await addUserAction(form({ email: "a@example.test", role: "owner" }))).toEqual({
      error: "invalid",
    });
    expect(await addUserAction(form({}))).toEqual({ error: "invalid" });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(await addUserAction(form({ email: "a@example.test" }))).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/users");
    expect(await addUserAction(form({ email: "A@example.test", role: "editor" }))).toEqual({
      error: "exists",
    });
    const r = await db.execute("SELECT role, status FROM app_user WHERE email = 'a@example.test'");
    expect(r.rows[0]).toMatchObject({ role: "viewer", status: "invited" });
  });
});

describe("changeRole / revoke / sign-out-everywhere actions", () => {
  it("work on a user and reject malformed ids", async () => {
    const v = await seedUser(db, { email: "v@example.test" });
    expect(await changeRoleAction(form({ userId: String(v), role: "editor" }))).toEqual({
      ok: true,
    });
    expect(await signOutEverywhereAction(form({ userId: String(v) }))).toEqual({ ok: true });
    for (const bad of ["", "abc", "-1", "0", "1e3", "07", "1 OR 1=1", `${v}x`]) {
      expect(await revokeUserAction(form({ userId: bad }))).toEqual({ error: "invalid" });
    }
    expect(await revokeUserAction(form({}))).toEqual({ error: "invalid" });
    expect(await revokeUserAction(form({ userId: String(v) }))).toEqual({ ok: true });
    expect(await revokeUserAction(form({ userId: String(v) }))).toEqual({ error: "revoked" });
    const r = await db.execute({
      sql: "SELECT role, status, session_version FROM app_user WHERE id = ?",
      args: [v],
    });
    expect(r.rows[0]).toMatchObject({ role: "editor", status: "revoked", session_version: 4 });
  });
  it("protect the Owner row and never make an owner", async () => {
    expect(await changeRoleAction(form({ userId: String(ownerId), role: "viewer" }))).toEqual({
      error: "owner_protected",
    });
    expect(await revokeUserAction(form({ userId: String(ownerId) }))).toEqual({
      error: "owner_protected",
    });
    const v = await seedUser(db, { email: "v@example.test" });
    expect(await changeRoleAction(form({ userId: String(v), role: "owner" }))).toEqual({
      error: "invalid",
    });
    expect(await changeRoleAction(form({ userId: "9999", role: "editor" }))).toEqual({
      error: "not_found",
    });
  });
});

describe("failures", () => {
  it("returns only the code 'unavailable' when the database throws", async () => {
    dbMock.mockImplementation(() => {
      throw new Error("libsql://secret-host token=abc");
    });
    const r = await addUserAction(form({ email: "a@example.test" }));
    expect(r).toEqual({ error: "unavailable" });
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
