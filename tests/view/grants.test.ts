// @vitest-environment node
// Unmask grants (UX-009, ROL-107; D-128): the Owner actions grantUnmaskAction / revokeUnmaskAction
// (TST-122: success, validation, auth, each role, audit, error shape) and how the mask module reads a
// grant (live, expired, revoked, lookup failure). Real migrations on local file databases.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { addUser as seedUser, auditRows, KEY } from "../auth/helpers";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const dbs = vi.hoisted(() => ({ auth: null as unknown, main: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9", "user-agent": "agent" }),
}));
vi.mock("@/lib/db/client", () => ({ authDb: () => dbs.auth, mainDb: () => dbs.main }));

import { grantUnmaskAction, revokeUnmaskAction } from "@/app/(app)/users/actions";
import { setConfig } from "@/lib/config/store";
import { hasLiveUnmaskGrant, maskContextFor } from "@/lib/view/mask";
import { grantUnmask, listGrants, revokeUnmask } from "@/lib/users/service";
import { ENV } from "../auth/helpers";

afterEach(cleanupTempDbs);

let auth: Client;
let main: Client;
let owner: number;
let editor: number;
let viewer: number;
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const grants = async () =>
  (await auth.execute("SELECT * FROM unmask_grant ORDER BY id")).rows as unknown as Array<
    Record<string, unknown>
  >;

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("PII_HASH_KEY", KEY);
  vi.stubEnv("OWNER_EMAIL", "owner@example.test");
  requireUser.mockReset();
  revalidatePath.mockReset();
  auth = await freshDb("auth");
  main = await freshDb("main");
  dbs.auth = auth;
  dbs.main = main;
  owner = await seedUser(auth, { email: "owner@example.test", role: "owner" });
  editor = await seedUser(auth, { email: "e@example.test", role: "editor" });
  viewer = await seedUser(auth, { email: "v@example.test", role: "viewer" });
  requireUser.mockResolvedValue({
    id: owner,
    email: "owner@example.test",
    name: null,
    role: "owner",
  });
});

describe("guard (TST-122: each role)", () => {
  it.each([
    ["grantUnmaskAction", grantUnmaskAction],
    ["revokeUnmaskAction", revokeUnmaskAction],
  ] as const)("%s requires admin on /users and writes nothing when refused", async (_n, fn) => {
    requireUser.mockReset();
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    const audits = (await auditRows(auth)).length;
    await expect(fn(form({ userId: String(viewer), grantId: "1", days: "5" }))).rejects.toThrow(
      /403/,
    );
    expect(requireUser).toHaveBeenCalledWith("admin", "/users");
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(await grants()).toEqual([]);
    expect((await auditRows(auth)).length).toBe(audits);
  });

  it("the permission matrix gives Editor and Viewer no access to the admin action", async () => {
    const { can } = await import("@/lib/auth/permissions");
    for (const role of ["editor", "viewer", null] as const) expect(can(role, "admin")).toBe(false);
    expect(can("owner", "admin")).toBe(true);
    expect(can("owner", "unmask")).toBe(true);
    expect(can("editor", "unmask")).toBe(false);
  });
});

describe("grantUnmaskAction", () => {
  it("grants for the configured unmask_expiry (30 days) when no length is given; audited first, same transaction", async () => {
    const before = Date.now();
    expect(await grantUnmaskAction(form({ userId: String(viewer) }))).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/users");
    const g = (await grants())[0]!;
    expect(g).toMatchObject({ user_id: viewer, granted_by: owner, revoked_at: null });
    const days = (Date.parse(String(g.expires_at)) - Date.parse(String(g.granted_at))) / 86_400_000;
    expect(days).toBe(30);
    expect(Date.parse(String(g.granted_at))).toBeGreaterThanOrEqual(before - 5000);
    const a = (await auditRows(auth)).filter((x) => x.action === "unmask.grant");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      actor_user_id: owner,
      target_type: "app_user",
      target_id: String(viewer),
      ip: "9.9.9.9",
    });
    expect(a[0]!.detail).toMatchObject({ days: 30 });
    expect(JSON.stringify(a[0])).not.toContain("example.test"); // no email in the audit event (NFR-030)
  });

  it("follows a changed unmask_expiry key, and an explicit length wins over it", async () => {
    await setConfig(main, {
      key: "unmask_expiry",
      value: 7,
      userId: null,
      now: "2026-10-01T00:00:00.000Z",
    });
    await grantUnmaskAction(form({ userId: String(viewer) }));
    await grantUnmaskAction(form({ userId: String(editor), days: "2" }));
    const rows = await grants();
    const len = (r: Record<string, unknown>) =>
      (Date.parse(String(r.expires_at)) - Date.parse(String(r.granted_at))) / 86_400_000;
    expect(rows.map(len)).toEqual([7, 2]);
  });

  it("validates the user and the length, returning only codes", async () => {
    for (const bad of ["", "abc", "0", "-1", "1e3", "07", "1 OR 1=1"]) {
      expect(await grantUnmaskAction(form({ userId: bad })), bad).toEqual({ error: "invalid" });
    }
    for (const days of ["0", "366", "1.5", "-3", "abc", "9999"]) {
      expect(await grantUnmaskAction(form({ userId: String(viewer), days })), days).toEqual({
        error: "invalid",
      });
    }
    expect(await grantUnmaskAction(form({}))).toEqual({ error: "invalid" });
    expect(await grantUnmaskAction(form({ userId: "9999" }))).toEqual({ error: "not_found" });
    expect(await grants()).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses the Owner (always unmasked), a revoked user and a second live grant", async () => {
    expect(await grantUnmaskAction(form({ userId: String(owner) }))).toEqual({
      error: "owner_protected",
    });
    const gone = await seedUser(auth, { email: "g@example.test", status: "revoked" });
    expect(await grantUnmaskAction(form({ userId: String(gone) }))).toEqual({ error: "revoked" });
    expect(await grantUnmaskAction(form({ userId: String(viewer) }))).toEqual({ ok: true });
    expect(await grantUnmaskAction(form({ userId: String(viewer) }))).toEqual({
      error: "grant_exists",
    });
    expect(await grants()).toHaveLength(1);
  });

  it("an invited user can be granted; an expired grant does not block a new one", async () => {
    const inv = await seedUser(auth, { email: "i@example.test", status: "invited" });
    expect(await grantUnmaskAction(form({ userId: String(inv) }))).toEqual({ ok: true });
    await auth.execute({
      sql: "INSERT INTO unmask_grant (user_id, granted_by, granted_at, expires_at) VALUES (?, ?, '2019-01-01T00:00:00.000Z', '2019-02-01T00:00:00.000Z')",
      args: [editor, owner],
    });
    expect(await grantUnmaskAction(form({ userId: String(editor) }))).toEqual({ ok: true });
  });

  it("returns only 'unavailable' when the database throws", async () => {
    await auth.execute("DROP TABLE unmask_grant");
    const r = await grantUnmaskAction(form({ userId: String(viewer) }));
    expect(r).toEqual({ error: "unavailable" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("a failed audit rolls the grant back (grant and audit commit together)", async () => {
    await auth.execute("DROP TRIGGER IF EXISTS audit_event_no_update");
    await auth.execute("ALTER TABLE audit_event RENAME TO audit_event_gone");
    expect(await grantUnmaskAction(form({ userId: String(viewer) }))).toEqual({
      error: "unavailable",
    });
    expect(await grants()).toEqual([]);
  });
});

describe("revokeUnmaskAction", () => {
  it("revokes once, audits, and the person is masked again at once", async () => {
    await grantUnmaskAction(form({ userId: String(viewer) }));
    const id = String((await grants())[0]!.id);
    expect(await maskContextFor({ id: viewer, role: "viewer" }, auth)).toEqual({ masked: false });
    expect(await revokeUnmaskAction(form({ grantId: id }))).toEqual({ ok: true });
    const g = (await grants())[0]!;
    expect(g).toMatchObject({ revoked_by: owner });
    expect(typeof g.revoked_at).toBe("string");
    expect(await maskContextFor({ id: viewer, role: "viewer" }, auth)).toEqual({ masked: true });
    const a = (await auditRows(auth)).filter((x) => x.action === "unmask.revoke");
    expect(a).toHaveLength(1);
    expect(a[0]!.detail).toMatchObject({ grant_id: Number(id) });
    expect(await revokeUnmaskAction(form({ grantId: id }))).toEqual({ error: "revoked" });
    expect((await auditRows(auth)).filter((x) => x.action === "unmask.revoke")).toHaveLength(1);
  });

  it("validates the id and reports a missing grant", async () => {
    for (const bad of ["", "x", "0", "-2", "1.5", "1;DROP"]) {
      expect(await revokeUnmaskAction(form({ grantId: bad })), bad).toEqual({ error: "invalid" });
    }
    expect(await revokeUnmaskAction(form({}))).toEqual({ error: "invalid" });
    expect(await revokeUnmaskAction(form({ grantId: "4242" }))).toEqual({ error: "not_found" });
  });
});

describe("service: owner check in depth", () => {
  const ctx = (actorId: number, now?: Date) => ({ db: auth, env: ENV, actorId, now });
  it("a non-Owner actor is refused by the service itself, whatever the action layer did", async () => {
    expect(await grantUnmask(ctx(editor), viewer, 5)).toEqual({ ok: false, error: "forbidden" });
    expect(await grantUnmask(ctx(viewer), editor, 5)).toEqual({ ok: false, error: "forbidden" });
    expect(await revokeUnmask(ctx(editor), 1)).toEqual({ ok: false, error: "forbidden" });
    expect(await grants()).toEqual([]);
  });
  it("rejects non-integer ids and lengths", async () => {
    for (const bad of [0, -1, 1.5, "1", null, undefined, NaN]) {
      expect((await grantUnmask(ctx(owner), bad, 5)).ok).toBe(false);
      expect((await grantUnmask(ctx(owner), viewer, bad)).ok).toBe(false);
      expect((await revokeUnmask(ctx(owner), bad)).ok).toBe(false);
    }
  });
  it("expiry is exactly granted_at + days", async () => {
    const now = new Date("2026-10-20T00:00:00.000Z");
    const r = await grantUnmask(ctx(owner, now), viewer, 3);
    expect(r).toMatchObject({ ok: true, expiresAt: "2026-10-23T00:00:00.000Z" });
    const rows = await listGrants(auth);
    expect(rows[0]).toMatchObject({
      userId: viewer,
      grantedBy: owner,
      grantedAt: "2026-10-20T00:00:00.000Z",
      expiresAt: "2026-10-23T00:00:00.000Z",
      revokedAt: null,
    });
  });
});

describe("how masking reads a grant (live, expired, revoked, failure)", () => {
  const insert = (user: number, expires: string, revoked = false) =>
    auth.execute({
      sql: `INSERT INTO unmask_grant (user_id, granted_by, granted_at, expires_at, revoked_at, revoked_by)
            VALUES (?, ?, '2019-01-01T00:00:00.000Z', ?, ?, ?)`,
      args: [
        user,
        owner,
        expires,
        revoked ? "2019-06-01T00:00:00.000Z" : null,
        revoked ? owner : null,
      ],
    });
  const at = new Date("2026-10-20T00:00:00.000Z");

  it("Owner is never masked, and does not need a grant row", async () => {
    expect(await maskContextFor({ id: owner, role: "owner" }, auth, at)).toEqual({ masked: false });
  });
  it("no grant: masked. Live grant: unmasked. Expiry instant: masked again", async () => {
    expect(await maskContextFor({ id: viewer, role: "viewer" }, auth, at)).toEqual({
      masked: true,
    });
    await insert(viewer, "2026-10-20T00:00:01.000Z");
    expect(await maskContextFor({ id: viewer, role: "viewer" }, auth, at)).toEqual({
      masked: false,
    });
    expect(
      await maskContextFor(
        { id: viewer, role: "viewer" },
        auth,
        new Date("2026-10-20T00:00:01.000Z"),
      ),
    ).toEqual({ masked: true });
  });
  it("a grant belongs to one user only", async () => {
    await insert(viewer, "2099-01-01T00:00:00.000Z");
    expect(await maskContextFor({ id: editor, role: "editor" }, auth, at)).toEqual({
      masked: true,
    });
    expect(await hasLiveUnmaskGrant(auth, editor, at)).toBe(false);
  });
  it("an expired or revoked grant masks", async () => {
    await insert(viewer, "2020-01-01T00:00:00.000Z");
    await insert(editor, "2099-01-01T00:00:00.000Z", true);
    expect(await maskContextFor({ id: viewer, role: "viewer" }, auth, at)).toEqual({
      masked: true,
    });
    expect(await maskContextFor({ id: editor, role: "editor" }, auth, at)).toEqual({
      masked: true,
    });
  });
  it("a lookup failure, an unknown role and a missing user mask", async () => {
    await insert(viewer, "2099-01-01T00:00:00.000Z");
    await auth.execute("DROP TABLE unmask_grant");
    expect(await maskContextFor({ id: viewer, role: "viewer" }, auth, at)).toEqual({
      masked: true,
    });
    expect(await maskContextFor({ id: viewer, role: "root" }, auth, at)).toEqual({ masked: true });
    expect(await maskContextFor(null, auth, at)).toEqual({ masked: true });
  });
  it("the grant row cannot be edited or deleted after the fact", async () => {
    await insert(viewer, "2099-01-01T00:00:00.000Z");
    await expect(
      auth.execute("UPDATE unmask_grant SET expires_at = '2100-01-01T00:00:00.000Z'"),
    ).rejects.toThrow();
    await expect(auth.execute("UPDATE unmask_grant SET user_id = 99")).rejects.toThrow();
    await expect(auth.execute("DELETE FROM unmask_grant")).rejects.toThrow(/forever/);
    await auth.execute({
      sql: "UPDATE unmask_grant SET revoked_at = '2026-01-01T00:00:00.000Z', revoked_by = ?",
      args: [owner],
    });
    await expect(
      auth.execute("UPDATE unmask_grant SET revoked_at = '2027-01-01T00:00:00.000Z'"),
    ).rejects.toThrow();
  });
});
