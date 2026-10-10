// @vitest-environment node
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditKey, verifyAuditChain } from "@/lib/db/audit";
import {
  addUser,
  changeRole,
  getSharingAck,
  hasSharingAck,
  listAudit,
  listUsers,
  parseEmail,
  parseRole,
  recordSharingAck,
  revokeUser,
  signOutEverywhere,
  type Ctx,
} from "@/lib/users/service";
import { cleanupTempDbs } from "../db/helpers";
import { addUser as seedUser, auditRows, authDb, ENV, KEY, NOW } from "../auth/helpers";

afterEach(cleanupTempDbs);

let db: Client;
let ownerId: number;
let ctx: Ctx;

beforeEach(async () => {
  db = await authDb();
  ownerId = await seedUser(db, { email: "owner@example.test", role: "owner", sub: "s-owner" });
  ctx = { db, env: ENV, actorId: ownerId, meta: { ip: "1.1.1.1", userAgent: "ua" }, now: NOW };
});

const row = async (id: number) =>
  (await db.execute({ sql: "SELECT * FROM app_user WHERE id = ?", args: [id] })).rows[0];
const idOf = async (email: string) =>
  Number(
    (await db.execute({ sql: "SELECT id FROM app_user WHERE email = ?", args: [email] })).rows[0]
      .id,
  );
const withAck = async () => {
  await recordSharingAck(ctx, "AU", "v1");
};

describe("validation helpers", () => {
  it("parseEmail trims, lower-cases and rejects bad shapes", () => {
    expect(parseEmail("  New.User+x@Example.TEST ")).toBe("new.user+x@example.test");
    for (const bad of [
      "",
      "a",
      "a@b",
      "a b@example.test",
      "a@@example.test",
      "a@example..test",
      "<x>@example.test",
      "a\nb@example.test",
      `${"a".repeat(250)}@example.test`,
      42,
      null,
      undefined,
    ]) {
      expect(parseEmail(bad)).toBeNull();
    }
  });
  it("parseRole accepts editor and viewer only", () => {
    expect(parseRole("editor")).toBe("editor");
    expect(parseRole("viewer")).toBe("viewer");
    for (const bad of ["owner", "admin", "", "Viewer", null, undefined, 1]) {
      expect(parseRole(bad)).toBeNull();
    }
  });
});

describe("sharing acknowledgement (ROL-107)", () => {
  it("is absent at first", async () => {
    expect(await hasSharingAck(db, "AU")).toBe(false);
    expect(await getSharingAck(db, "AU")).toBeNull();
  });

  it("records once, audits sharing.ack, and is idempotent", async () => {
    expect(await recordSharingAck(ctx, "AU", "v1")).toEqual({ ok: true });
    expect(await hasSharingAck(db, "AU")).toBe(true);
    expect(await getSharingAck(db, "AU")).toEqual({
      market: "AU",
      acknowledgedBy: ownerId,
      acknowledgedAt: NOW.toISOString(),
      textVersion: "v1",
    });
    expect(await recordSharingAck(ctx, "AU", "v1")).toEqual({ ok: true });
    const n = await db.execute("SELECT count(*) AS c FROM sharing_ack");
    expect(n.rows[0].c).toBe(1);
    const acts = (await auditRows(db)).filter((r) => r.action === "sharing.ack");
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({
      actor_user_id: ownerId,
      target_type: "market",
      target_id: "AU",
    });
    expect(acts[0].detail).toEqual({ text_version: "v1" });
  });

  it("rejects an unknown market or bad text version", async () => {
    expect(await recordSharingAck(ctx, "US", "v1")).toEqual({ ok: false, error: "invalid" });
    expect(await recordSharingAck(ctx, "AU", "")).toEqual({ ok: false, error: "invalid" });
    expect(await recordSharingAck(ctx, "AU", "x".repeat(40))).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await hasSharingAck(db, "AU")).toBe(false);
  });

  it("is refused for a non-owner actor", async () => {
    const e = await seedUser(db, { email: "e@example.test", role: "editor" });
    expect(await recordSharingAck({ ...ctx, actorId: e }, "AU", "v1")).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await hasSharingAck(db, "AU")).toBe(false);
  });

  it("is append-only", async () => {
    await withAck();
    await expect(db.execute("UPDATE sharing_ack SET market = 'XX'")).rejects.toThrow(/append-only/);
    await expect(db.execute("DELETE FROM sharing_ack")).rejects.toThrow(/append-only/);
  });
});

describe("addUser", () => {
  it("refuses without the acknowledgement", async () => {
    expect(await addUser(ctx, "a@example.test", "viewer")).toEqual({
      ok: false,
      error: "ack_required",
    });
    expect(
      (await db.execute("SELECT 1 FROM app_user WHERE email = 'a@example.test'")).rows,
    ).toEqual([]);
    expect((await auditRows(db)).filter((r) => r.action === "user.add")).toHaveLength(0);
  });

  it("adds an invited, unbound Viewer by default and audits user.add without the email", async () => {
    await withAck();
    const r = await addUser(ctx, " New@Example.TEST ", undefined);
    expect(r).toEqual({ ok: true, userId: expect.any(Number) });
    const u = await row(await idOf("new@example.test"));
    expect(u).toMatchObject({
      role: "viewer",
      status: "invited",
      google_sub: null,
      session_version: 1,
      created_at: NOW.toISOString(),
    });
    const a = (await auditRows(db)).find((x) => x.action === "user.add")!;
    expect(a).toMatchObject({
      actor_user_id: ownerId,
      target_type: "app_user",
      target_id: String(u.id),
      ip: "1.1.1.1",
      user_agent: "ua",
    });
    expect(a.detail).toMatchObject({ role: "viewer" });
    expect(JSON.stringify(a)).not.toContain("new@example.test");
    expect(await verifyAuditChain(db, auditKey(KEY))).toBeNull();
  });

  it("can add an editor", async () => {
    await withAck();
    await addUser(ctx, "ed@example.test", "editor");
    expect((await row(await idOf("ed@example.test"))).role).toBe("editor");
  });

  it("rejects owner role, bad role and bad email", async () => {
    await withAck();
    expect(await addUser(ctx, "a@example.test", "owner")).toEqual({ ok: false, error: "invalid" });
    expect(await addUser(ctx, "a@example.test", "admin")).toEqual({ ok: false, error: "invalid" });
    expect(await addUser(ctx, "nope", "viewer")).toEqual({ ok: false, error: "invalid" });
  });

  it("validation runs before the ack check", async () => {
    expect(await addUser(ctx, "nope", "viewer")).toEqual({ ok: false, error: "invalid" });
  });

  it("refuses duplicates (case-insensitive) and the Owner address", async () => {
    await withAck();
    await addUser(ctx, "dup@example.test", "viewer");
    expect(await addUser(ctx, "DUP@example.test", "editor")).toEqual({
      ok: false,
      error: "exists",
    });
    expect(await addUser(ctx, "OWNER@example.test", "viewer")).toEqual({
      ok: false,
      error: "exists",
    });
  });

  it("refuses the pinned Owner address even when no row exists for it", async () => {
    const other = await authDb();
    const o = await seedUser(other, { email: "boss@example.test", role: "owner" });
    const c: Ctx = { db: other, env: ENV, actorId: o, now: NOW };
    await recordSharingAck(c, "AU", "v1");
    expect(await addUser(c, "owner@example.test", "viewer")).toEqual({
      ok: false,
      error: "exists",
    });
  });

  it("treats a lost insert race as exists", async () => {
    await withAck();
    const racing = new Proxy(db, {
      get(t, p) {
        if (p === "transaction") {
          return async (m: "write") => {
            const tx = await t.transaction(m);
            return new Proxy(tx, {
              get(x, q) {
                if (q === "execute") {
                  return async (arg: unknown) => {
                    const sql = typeof arg === "string" ? arg : (arg as { sql: string }).sql;
                    if (sql.startsWith("SELECT id, role, status FROM app_user WHERE email")) {
                      return { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: undefined };
                    }
                    return x.execute(arg as never);
                  };
                }
                const v = Reflect.get(x, q);
                return typeof v === "function" ? v.bind(x) : v;
              },
            });
          };
        }
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Client;
    await addUser(ctx, "race@example.test", "viewer");
    expect(await addUser({ ...ctx, db: racing }, "race@example.test", "viewer")).toEqual({
      ok: false,
      error: "exists",
    });
  });

  it("re-adding a revoked address reinvites: invited, no sub, session bumped", async () => {
    await withAck();
    const id = await seedUser(db, {
      email: "back@example.test",
      role: "editor",
      status: "revoked",
      sub: "old-sub",
      sv: 3,
    });
    await db.execute({
      sql: "UPDATE app_user SET revoked_at = ? WHERE id = ?",
      args: [NOW.toISOString(), id],
    });
    expect(await addUser(ctx, "Back@example.test", undefined)).toEqual({ ok: true, userId: id });
    expect(await row(id)).toMatchObject({
      status: "invited",
      role: "viewer",
      google_sub: null,
      revoked_at: null,
      session_version: 4,
    });
    const rows = await auditRows(db);
    expect(rows.filter((r) => r.action === "user.reinvite")).toHaveLength(1);
    expect(rows.filter((r) => r.action === "user.add")).toHaveLength(0);
    expect(rows.find((r) => r.action === "user.reinvite")).toMatchObject({
      actor_user_id: ownerId,
      target_id: String(id),
    });
  });

  it("a reinvite honours the role the Owner picked", async () => {
    await withAck();
    const id = await seedUser(db, { email: "back@example.test", status: "revoked" });
    await addUser(ctx, "back@example.test", "editor");
    expect((await row(id)).role).toBe("editor");
  });

  it("a revoked owner-role row is never reinvited", async () => {
    await withAck();
    const id = await seedUser(db, { email: "x@example.test", role: "owner", status: "revoked" });
    expect(await addUser(ctx, "x@example.test", "viewer")).toEqual({ ok: false, error: "exists" });
    expect((await row(id)).status).toBe("revoked");
  });

  it("is refused for a non-owner, revoked or unknown actor", async () => {
    await withAck();
    const v = await seedUser(db, { email: "v@example.test", role: "viewer" });
    const r = await seedUser(db, { email: "r@example.test", role: "owner", status: "revoked" });
    for (const actorId of [v, r, 9999]) {
      expect(await addUser({ ...ctx, actorId }, "a@example.test", "viewer")).toEqual({
        ok: false,
        error: "forbidden",
      });
    }
  });
});

describe("changeRole", () => {
  it("changes the role, bumps session_version and audits", async () => {
    const id = await seedUser(db, { email: "v@example.test", sv: 2 });
    expect(await changeRole(ctx, id, "editor")).toEqual({ ok: true });
    expect(await row(id)).toMatchObject({ role: "editor", session_version: 3 });
    const a = (await auditRows(db)).find((r) => r.action === "user.role_change")!;
    expect(a).toMatchObject({ actor_user_id: ownerId, target_id: String(id) });
    expect(a.detail).toEqual({ from: "viewer", to: "editor" });
  });

  it("a no-op change writes nothing", async () => {
    const id = await seedUser(db, { email: "v@example.test", sv: 2 });
    expect(await changeRole(ctx, id, "viewer")).toEqual({ ok: true });
    expect((await row(id)).session_version).toBe(2);
    expect(await auditRows(db)).toHaveLength(0);
  });

  it("refuses the owner row, owner role, bad input, unknown and revoked users", async () => {
    expect(await changeRole(ctx, ownerId, "viewer")).toEqual({
      ok: false,
      error: "owner_protected",
    });
    expect((await row(ownerId)).role).toBe("owner");
    const id = await seedUser(db, { email: "v@example.test" });
    expect(await changeRole(ctx, id, "owner")).toEqual({ ok: false, error: "invalid" });
    expect(await changeRole(ctx, id, "nope")).toEqual({ ok: false, error: "invalid" });
    expect(await changeRole(ctx, 0, "editor")).toEqual({ ok: false, error: "invalid" });
    expect(await changeRole(ctx, 1.5, "editor")).toEqual({ ok: false, error: "invalid" });
    expect(await changeRole(ctx, 9999, "editor")).toEqual({ ok: false, error: "not_found" });
    const rv = await seedUser(db, { email: "r@example.test", status: "revoked" });
    expect(await changeRole(ctx, rv, "editor")).toEqual({ ok: false, error: "revoked" });
    expect((await row(rv)).role).toBe("viewer");
    expect(await auditRows(db)).toHaveLength(0);
  });

  it("is refused for a non-owner actor", async () => {
    const e = await seedUser(db, { email: "e@example.test", role: "editor" });
    const v = await seedUser(db, { email: "v@example.test" });
    expect(await changeRole({ ...ctx, actorId: e }, v, "editor")).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect((await row(v)).role).toBe("viewer");
  });
});

describe("revokeUser", () => {
  it("revokes, stamps revoked_at, bumps session_version and audits user.revoke", async () => {
    const id = await seedUser(db, { email: "v@example.test", sv: 5, sub: "s" });
    expect(await revokeUser(ctx, id)).toEqual({ ok: true });
    expect(await row(id)).toMatchObject({
      status: "revoked",
      revoked_at: NOW.toISOString(),
      session_version: 6,
    });
    const a = (await auditRows(db)).find((r) => r.action === "user.revoke")!;
    expect(a).toMatchObject({ actor_user_id: ownerId, target_id: String(id) });
  });

  it("refuses the Owner row, which also covers self-revocation", async () => {
    expect(await revokeUser(ctx, ownerId)).toEqual({ ok: false, error: "owner_protected" });
    expect((await row(ownerId)).status).toBe("active");
    expect((await row(ownerId)).session_version).toBe(1);
    expect(await auditRows(db)).toHaveLength(0);
  });

  it("refuses a non-owner actor revoking themselves or anyone", async () => {
    const e = await seedUser(db, { email: "e@example.test", role: "editor" });
    const v = await seedUser(db, { email: "v@example.test" });
    expect(await revokeUser({ ...ctx, actorId: e }, e)).toEqual({ ok: false, error: "forbidden" });
    expect(await revokeUser({ ...ctx, actorId: e }, v)).toEqual({ ok: false, error: "forbidden" });
    expect((await row(e)).status).toBe("active");
    expect((await row(v)).status).toBe("active");
  });

  it("refuses bad id, unknown and already revoked", async () => {
    expect(await revokeUser(ctx, -1)).toEqual({ ok: false, error: "invalid" });
    expect(await revokeUser(ctx, 9999)).toEqual({ ok: false, error: "not_found" });
    const rv = await seedUser(db, { email: "r@example.test", status: "revoked", sv: 2 });
    expect(await revokeUser(ctx, rv)).toEqual({ ok: false, error: "revoked" });
    expect((await row(rv)).session_version).toBe(2);
  });

  it("works on an invited user", async () => {
    const id = await seedUser(db, { email: "inv@example.test", status: "invited" });
    expect(await revokeUser(ctx, id)).toEqual({ ok: true });
    expect((await row(id)).status).toBe("revoked");
  });
});

describe("signOutEverywhere", () => {
  it("bumps session_version and audits user.signout_everywhere", async () => {
    const id = await seedUser(db, { email: "v@example.test", sv: 7 });
    expect(await signOutEverywhere(ctx, id)).toEqual({ ok: true });
    expect((await row(id)).session_version).toBe(8);
    expect((await auditRows(db)).find((r) => r.action === "user.signout_everywhere")).toMatchObject(
      { actor_user_id: ownerId, target_id: String(id) },
    );
  });

  it("works on the Owner row itself", async () => {
    expect(await signOutEverywhere(ctx, ownerId)).toEqual({ ok: true });
    expect((await row(ownerId)).session_version).toBe(2);
  });

  it("refuses bad id, unknown, revoked and non-owner actor", async () => {
    expect(await signOutEverywhere(ctx, 0)).toEqual({ ok: false, error: "invalid" });
    expect(await signOutEverywhere(ctx, 9999)).toEqual({ ok: false, error: "not_found" });
    const rv = await seedUser(db, { email: "r@example.test", status: "revoked" });
    expect(await signOutEverywhere(ctx, rv)).toEqual({ ok: false, error: "revoked" });
    const e = await seedUser(db, { email: "e@example.test", role: "editor" });
    expect(await signOutEverywhere({ ...ctx, actorId: e }, ownerId)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect((await row(ownerId)).session_version).toBe(1);
  });
});

describe("listUsers", () => {
  it("returns only safe columns, owner first then by id", async () => {
    await seedUser(db, { email: "b@example.test", sub: "secret-sub" });
    await seedUser(db, { email: "a@example.test", status: "invited" });
    const list = await listUsers(db);
    expect(list.map((u) => u.email)).toEqual([
      "owner@example.test",
      "b@example.test",
      "a@example.test",
    ]);
    expect(list[0]).toMatchObject({ role: "owner", status: "active" });
    expect(Object.keys(list[1]).sort()).toEqual(
      ["email", "id", "name", "role", "status", "updatedAt"].sort(),
    );
    expect(JSON.stringify(list)).not.toContain("secret-sub");
  });
});

describe("listAudit", () => {
  it("returns newest first without ip or user agent, with paging", async () => {
    await withAck();
    for (let i = 0; i < 5; i++) await addUser(ctx, `u${i}@example.test`, "viewer");
    const all = await listAudit(db);
    expect(all).toHaveLength(6);
    expect(all[0].action).toBe("user.add");
    expect(all[all.length - 1].action).toBe("sharing.ack");
    expect(Object.keys(all[0]).sort()).toEqual(
      ["action", "actorUserId", "at", "detailJson", "id", "targetId", "targetType"].sort(),
    );
    expect(JSON.stringify(all)).not.toContain("1.1.1.1");
    const page1 = await listAudit(db, 2);
    expect(page1).toHaveLength(2);
    const page2 = await listAudit(db, 2, page1[1].id);
    expect(page2[0].id).toBeLessThan(page1[1].id);
    expect(page2).toHaveLength(2);
    expect(await listAudit(db, 0)).toHaveLength(1);
    expect(await listAudit(db, 100000)).toHaveLength(6);
    expect(await listAudit(db, Number.NaN)).toHaveLength(6);
  });
});

describe("atomicity (ROL-104): state change and audit commit together", () => {
  const breakAudit = (action: string) =>
    db.execute(
      `CREATE TRIGGER test_break_audit BEFORE INSERT ON audit_event WHEN NEW.action = '${action}'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
  const chainOk = async () => expect(await verifyAuditChain(db, auditKey(KEY))).toBeNull();

  it("addUser: a failing audit insert leaves no user row", async () => {
    await withAck();
    await breakAudit("user.add");
    expect(await addUser(ctx, "x@example.test", "viewer")).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(
      (await db.execute("SELECT 1 FROM app_user WHERE email = 'x@example.test'")).rows,
    ).toEqual([]);
    await chainOk();
  });

  it("reinvite: a failing audit insert leaves the revoked row as it was", async () => {
    await withAck();
    const id = await seedUser(db, { email: "b@example.test", status: "revoked", sub: "s", sv: 3 });
    await breakAudit("user.reinvite");
    expect((await addUser(ctx, "b@example.test", "editor")).ok).toBe(false);
    expect(await row(id)).toMatchObject({ status: "revoked", google_sub: "s", session_version: 3 });
    await chainOk();
  });

  it("changeRole: a failing audit insert leaves role and session_version", async () => {
    const id = await seedUser(db, { email: "v@example.test", sv: 2 });
    await breakAudit("user.role_change");
    expect(await changeRole(ctx, id, "editor")).toEqual({ ok: false, error: "unavailable" });
    expect(await row(id)).toMatchObject({ role: "viewer", session_version: 2 });
    await chainOk();
  });

  it("revokeUser: a failing audit insert leaves the user active", async () => {
    const id = await seedUser(db, { email: "v@example.test", sv: 2 });
    await breakAudit("user.revoke");
    expect(await revokeUser(ctx, id)).toEqual({ ok: false, error: "unavailable" });
    expect(await row(id)).toMatchObject({ status: "active", revoked_at: null, session_version: 2 });
    await chainOk();
  });

  it("signOutEverywhere: a failing audit insert leaves session_version", async () => {
    const id = await seedUser(db, { email: "v@example.test", sv: 2 });
    await breakAudit("user.signout_everywhere");
    expect(await signOutEverywhere(ctx, id)).toEqual({ ok: false, error: "unavailable" });
    expect((await row(id)).session_version).toBe(2);
    await chainOk();
  });

  it("recordSharingAck: a failing audit insert leaves no acknowledgement", async () => {
    await breakAudit("sharing.ack");
    expect(await recordSharingAck(ctx, "AU", "v1")).toEqual({ ok: false, error: "unavailable" });
    expect(await hasSharingAck(db, "AU")).toBe(false);
    await chainOk();
  });

  it("a later success still chains correctly after a rolled-back attempt", async () => {
    await withAck();
    const id = await seedUser(db, { email: "v@example.test" });
    await breakAudit("user.revoke");
    await revokeUser(ctx, id);
    await db.execute("DROP TRIGGER test_break_audit");
    expect(await revokeUser(ctx, id)).toEqual({ ok: true });
    await chainOk();
  });

  it("returns unavailable when a transaction cannot start", async () => {
    const broken = {
      transaction: async () => {
        throw new Error("down");
      },
    } as unknown as Client;
    expect(await revokeUser({ ...ctx, db: broken }, 2)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("returns unavailable even when rollback itself fails", async () => {
    const real = await db.transaction("write");
    const bad = {
      execute: () => Promise.reject(new Error("x")),
      rollback: () => Promise.reject(new Error("y")),
      commit: real.commit.bind(real),
      close: real.close.bind(real),
    };
    const client = { transaction: async () => bad } as unknown as Client;
    expect(await revokeUser({ ...ctx, db: client }, 2)).toEqual({
      ok: false,
      error: "unavailable",
    });
    real.close();
  });
});
