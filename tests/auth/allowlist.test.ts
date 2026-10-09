// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { decideSignIn } from "@/lib/auth/allowlist";
import { auditKey, verifyAuditChain } from "@/lib/db/audit";
import { ENV, KEY, NOW, addUser, auditRows, authDb, hmac } from "./helpers";

const prof = (o: Record<string, unknown> = {}) => ({
  sub: "sub-1",
  email: "viewer@example.test",
  email_verified: true,
  name: "V",
  ...o,
});
const okFetch = () => vi.fn(async () => new Response("{}", { status: 200 }));

describe("decideSignIn", () => {
  it("refuses unverified email and audits only an HMAC", async () => {
    const db = await authDb();
    await addUser(db, { email: "viewer@example.test" });
    const d = await decideSignIn(db, prof({ email_verified: false }), ENV, NOW);
    expect(d).toEqual({ ok: false, reason: "not_verified" });
    const rows = await auditRows(db);
    expect(rows[0].action).toBe("auth.signin_refused");
    expect(rows[0].detail).toEqual({
      reason: "not_verified",
      email_hmac: hmac("viewer@example.test"),
    });
    expect(JSON.stringify(rows)).not.toContain("viewer@example.test");
  });

  it("refuses string 'true', missing sub and missing email", async () => {
    const db = await authDb();
    expect((await decideSignIn(db, prof({ email_verified: "true" }), ENV, NOW)).ok).toBe(false);
    expect((await decideSignIn(db, prof({ sub: undefined }), ENV, NOW)).ok).toBe(false);
    expect((await decideSignIn(db, prof({ email: undefined }), ENV, NOW)).ok).toBe(false);
    const rows = await auditRows(db);
    expect(rows[2].detail).toEqual({ reason: "not_verified", email_hmac: null });
  });

  it("refuses an address that is not on the allowlist", async () => {
    const db = await authDb();
    const d = await decideSignIn(db, prof({ email: "Stranger@Example.test" }), ENV, NOW);
    expect(d).toEqual({ ok: false, reason: "not_allowlisted" });
    const rows = await auditRows(db);
    expect(rows[0].detail?.email_hmac).toBe(hmac("stranger@example.test"));
    expect(JSON.stringify(rows)).not.toMatch(/stranger/i);
  });

  it("refuses a revoked user", async () => {
    const db = await authDb();
    const id = await addUser(db, { email: "viewer@example.test", status: "revoked" });
    const d = await decideSignIn(db, prof(), ENV, NOW);
    expect(d).toEqual({ ok: false, reason: "revoked" });
    expect((await auditRows(db))[0].actor_user_id).toBe(id);
  });

  it("bootstraps the Owner on first verified sign-in (case-insensitive)", async () => {
    const db = await authDb();
    const d = await decideSignIn(db, prof({ email: "OWNER@example.test", sub: "o1" }), ENV, NOW);
    expect(d.ok && d.role).toBe("owner");
    const u = await db.execute("SELECT role, status, google_sub, email FROM app_user");
    expect(u.rows[0]).toMatchObject({
      role: "owner",
      status: "active",
      email: "owner@example.test",
    });
    expect(u.rows[0].google_sub).toBe("o1");
    const rows = await auditRows(db);
    expect(rows[0].action).toBe("auth.signin_success");
    expect(await verifyAuditChain(db, auditKey(KEY))).toBeNull();
  });

  it("never yields Owner for an owner-role row with a different email", async () => {
    const db = await authDb();
    await addUser(db, { email: "other@example.test", role: "owner" });
    const d = await decideSignIn(db, prof({ email: "other@example.test" }), ENV, NOW);
    expect(d.ok && d.role).toBe("viewer");
  });

  it("never yields Owner when OWNER_EMAIL is unset", async () => {
    const db = await authDb();
    await addUser(db, { email: "other@example.test", role: "owner" });
    const env = { ...ENV, OWNER_EMAIL: "" };
    const d = await decideSignIn(db, prof({ email: "other@example.test" }), env, NOW);
    expect(d.ok && d.role).toBe("viewer");
  });

  it("throws (fail closed) when the owner row cannot be inserted", async () => {
    const db = await authDb();
    await addUser(db, { email: "other@example.test", role: "owner" });
    await expect(
      decideSignIn(db, prof({ email: "owner@example.test" }), ENV, NOW),
    ).rejects.toThrow();
  });

  it("activates an invited user and binds the sub on first sign-in", async () => {
    const db = await authDb();
    await addUser(db, { email: "viewer@example.test", status: "invited", role: "editor" });
    const meta = { ip: "1.2.3.4", userAgent: "UA" };
    const d = await decideSignIn(db, prof(), ENV, NOW, { meta });
    expect(d).toMatchObject({ ok: true, role: "editor", recovery: false });
    const u = await db.execute("SELECT status, google_sub FROM app_user");
    expect(u.rows[0]).toMatchObject({ status: "active", google_sub: "sub-1" });
    const rows = await auditRows(db);
    expect(rows[0]).toMatchObject({ ip: "1.2.3.4", user_agent: "UA" });
  });

  it("accepts a repeat sign-in with the same sub", async () => {
    const db = await authDb();
    await addUser(db, { email: "viewer@example.test", sub: "sub-1" });
    expect((await decideSignIn(db, prof(), ENV, NOW)).ok).toBe(true);
  });

  it("refuses a different sub and audits sub_mismatch", async () => {
    const db = await authDb();
    await addUser(db, { email: "viewer@example.test", sub: "sub-OTHER" });
    const d = await decideSignIn(db, prof(), ENV, NOW);
    expect(d).toEqual({ ok: false, reason: "sub_mismatch" });
    const actions = (await auditRows(db)).map((r) => r.action);
    expect(actions).toEqual(["auth.signin_refused", "auth.sub_mismatch"]);
  });

  it("refuses when the sub is already bound to another account row", async () => {
    const db = await authDb();
    await addUser(db, { email: "viewer@example.test" });
    await addUser(db, { email: "second@example.test", sub: "sub-1" });
    await expect(decideSignIn(db, prof(), ENV, NOW)).rejects.toThrow(); // UNIQUE google_sub
  });

  describe("recovery (D-034)", () => {
    const rec = prof({ email: "recovery@example.test", sub: "rec-sub" });
    const on = { ...ENV, OWNER_RECOVERY_ENABLED: "true" };

    it("disabled: treated like any other address", async () => {
      const db = await authDb();
      const f = okFetch();
      expect(await decideSignIn(db, rec, ENV, NOW, { fetchImpl: f })).toEqual({
        ok: false,
        reason: "not_allowlisted",
      });
      expect(f).not.toHaveBeenCalled();
      const almost = { ...ENV, OWNER_RECOVERY_ENABLED: "yes" };
      expect((await decideSignIn(db, rec, almost, NOW, { fetchImpl: f })).ok).toBe(false);
    });

    it("disabled but allowlisted as a viewer: signs in as a viewer only", async () => {
      const db = await authDb();
      await addUser(db, { email: "recovery@example.test" });
      const d = await decideSignIn(db, rec, ENV, NOW);
      expect(d.ok && d.role).toBe("viewer");
    });

    it("enabled: signs in as the Owner row, audits and emails the Owner", async () => {
      const db = await authDb();
      const ownerId = await addUser(db, { email: "owner@example.test", role: "owner", sub: "o1" });
      const f = okFetch();
      const d = await decideSignIn(db, rec, on, NOW, { fetchImpl: f });
      expect(d).toMatchObject({ ok: true, userId: ownerId, role: "owner", recovery: true });
      const rows = await auditRows(db);
      expect(rows.map((r) => r.action)).toEqual(["auth.recovery_signin"]);
      expect(JSON.stringify(rows)).not.toContain("recovery@example.test");
      expect(f).toHaveBeenCalledTimes(1);
      const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.resend.com/emails");
      const body = JSON.parse(String(init.body));
      expect(body.to).toEqual(["owner@example.test"]);
      expect(body.subject).toBe("[Praxis] Recovery sign-in used");
      expect(body.from).toBe("Praxis <onboarding@resend.dev>");
      const u = await db.execute({
        sql: "SELECT google_sub FROM app_user WHERE id = ?",
        args: [ownerId],
      });
      expect(u.rows[0].google_sub).toBe("o1"); // recovery is a different Google account
    });

    it("enabled with no owner row yet: creates it", async () => {
      const db = await authDb();
      const d = await decideSignIn(db, rec, on, NOW, { fetchImpl: okFetch() });
      expect(d.ok && d.role).toBe("owner");
    });

    it("enabled but the Owner row is revoked: refused", async () => {
      const db = await authDb();
      await addUser(db, { email: "owner@example.test", role: "owner", status: "revoked" });
      const d = await decideSignIn(db, rec, on, NOW, { fetchImpl: okFetch() });
      expect(d.ok).toBe(false);
    });

    it.each([
      ["non-2xx", async () => new Response("no", { status: 500 })],
      [
        "network error",
        async (): Promise<Response> => {
          throw new Error("down");
        },
      ],
    ])("email failure (%s) does not block and is audit-logged", async (_n, impl) => {
      const db = await authDb();
      await addUser(db, { email: "owner@example.test", role: "owner" });
      const d = await decideSignIn(db, rec, on, NOW, { fetchImpl: vi.fn(impl) });
      expect(d.ok).toBe(true);
      expect((await auditRows(db)).map((r) => r.action)).toEqual([
        "auth.recovery_signin",
        "auth.recovery_alert_failed",
      ]);
    });

    it("no Resend key: audit-logged failure, still signs in", async () => {
      const db = await authDb();
      await addUser(db, { email: "owner@example.test", role: "owner" });
      const f = okFetch();
      const d = await decideSignIn(db, rec, { ...on, RESEND_API_KEY: undefined }, NOW, {
        fetchImpl: f,
      });
      expect(d.ok).toBe(true);
      expect(f).not.toHaveBeenCalled();
    });

    it("the Owner address itself is never a recovery sign-in", async () => {
      const db = await authDb();
      const env = { ...on, OWNER_RECOVERY_EMAIL: "owner@example.test" };
      const f = okFetch();
      const p = prof({ email: "owner@example.test" });
      const d = await decideSignIn(db, p, env, NOW, { fetchImpl: f });
      expect(d).toMatchObject({ ok: true, recovery: false });
      expect(f).not.toHaveBeenCalled();
    });
  });

  it("fails closed without PII_HASH_KEY", async () => {
    const db = await authDb();
    const env = { ...ENV, PII_HASH_KEY: undefined };
    await expect(decideSignIn(db, prof({ email_verified: false }), env, NOW)).rejects.toThrow(
      "audit not configured",
    );
  });
});
