// @vitest-environment node
import type { Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendAudit,
  auditKey,
  GENESIS_HMAC,
  hashUserPii,
  nullAuditPii,
  verifyAuditChain,
} from "@/lib/db/audit";
import { cleanupTempDbs, freshDb } from "./helpers";

afterEach(cleanupTempDbs);

const key = auditKey("test-pii-key");
const T = "2026-10-10T07:00:00.000Z";

describe("audit chain", () => {
  let db: Client;
  beforeEach(async () => {
    db = await freshDb("auth");
  });

  it("empty chain verifies; first row links to the zero hash", async () => {
    expect(await verifyAuditChain(db, key)).toBeNull();
    await appendAudit(db, key, { action: "a", at: T });
    const r = await db.execute("SELECT prev_hmac FROM audit_event");
    expect(r.rows[0].prev_hmac).toBe(GENESIS_HMAC);
  });

  it("verifies a longer chain with all optional fields", async () => {
    await appendAudit(db, key, { action: "a", at: T });
    await appendAudit(db, key, {
      action: "b",
      actorUserId: 5,
      targetType: "user",
      targetId: "7",
      detail: { x: 1 },
      ip: "1.1.1.1",
      userAgent: "ua",
    });
    await appendAudit(db, key, { action: "c" });
    expect(await verifyAuditChain(db, key)).toBeNull();
  });

  it("a different key does not verify", async () => {
    await appendAudit(db, key, { action: "a", at: T });
    expect(await verifyAuditChain(db, auditKey("other"))).toBe(1);
  });

  it("detects a tampered row (trigger bypassed) and a removed row", async () => {
    for (const a of ["a", "b", "c"]) await appendAudit(db, key, { action: a, at: T });
    await db.execute("DROP TRIGGER audit_event_no_update");
    await db.execute("UPDATE audit_event SET action = 'x' WHERE id = 2");
    expect(await verifyAuditChain(db, key)).toBe(2);

    const db2 = await freshDb("auth");
    for (const a of ["a", "b", "c"]) await appendAudit(db2, key, { action: a, at: T });
    await db2.execute("DROP TRIGGER audit_event_no_delete");
    await db2.execute("DELETE FROM audit_event WHERE id = 2");
    expect(await verifyAuditChain(db2, key)).toBe(3);
  });

  it("nulling ip/user_agent keeps the chain valid", async () => {
    await appendAudit(db, key, { action: "a", actorUserId: 3, ip: "1.1.1.1", userAgent: "ua" });
    await appendAudit(db, key, { action: "b", actorUserId: 4, ip: "2.2.2.2" });
    expect(await nullAuditPii(db, 3)).toBe(1);
    expect(await nullAuditPii(db, 3)).toBe(0);
    const r = await db.execute("SELECT ip, user_agent FROM audit_event ORDER BY id");
    expect(r.rows[0]).toMatchObject({ ip: null, user_agent: null });
    expect(r.rows[1].ip).toBe("2.2.2.2");
    expect(await verifyAuditChain(db, key)).toBeNull();
  });
});

describe("hashUserPii", () => {
  it("replaces email/name with HMAC (not plain sha256) and stays unique", async () => {
    const db = await freshDb("auth");
    await db.execute({
      sql: "INSERT INTO app_user (email, name, status, created_at, updated_at) VALUES ('Jo@example.com', 'Jo', 'revoked', ?, ?), ('ka@example.com', NULL, 'revoked', ?, ?)",
      args: [T, T, T, T],
    });
    await hashUserPii(db, "k", 1, "2026-12-01T00:00:00.000Z");
    await hashUserPii(db, "k", 2, "2026-12-01T00:00:00.000Z");
    const r = await db.execute("SELECT email, name, pii_hashed_at FROM app_user ORDER BY id");
    const plain = createHash("sha256").update("jo@example.com").digest("hex");
    expect(r.rows[0].email).toMatch(/^hashed:[0-9a-f]{64}$/);
    expect(r.rows[0].email).not.toBe(`hashed:${plain}`);
    expect(r.rows[0].name).toMatch(/^[0-9a-f]{64}$/);
    expect(r.rows[1].name).toBeNull();
    expect(r.rows[0].pii_hashed_at).toBe("2026-12-01T00:00:00.000Z");
    await expect(hashUserPii(db, "k", 99, T)).rejects.toThrow(/not found/);
  });

  it("runs on a transaction too and rolls back with it", async () => {
    const db = await freshDb("auth");
    await db.execute({
      sql: "INSERT INTO app_user (email, name, status, created_at, updated_at) VALUES ('Jo@example.com', 'Jo', 'revoked', ?, ?)",
      args: [T, T],
    });
    await appendAudit(db, key, { action: "a", actorUserId: 1, ip: "1.1.1.1", userAgent: "ua" });
    const tx = await db.transaction("write");
    try {
      await hashUserPii(tx, "k", 1, T);
      expect(await nullAuditPii(tx, 1)).toBe(1);
      await tx.rollback();
    } finally {
      tx.close();
    }
    const u = await db.execute("SELECT email, pii_hashed_at FROM app_user");
    expect(u.rows[0]).toMatchObject({ email: "Jo@example.com", pii_hashed_at: null });
    expect((await db.execute("SELECT ip FROM audit_event")).rows[0].ip).toBe("1.1.1.1");
    const tx2 = await db.transaction("write");
    try {
      await hashUserPii(tx2, "k", 1, T);
      await tx2.commit();
    } finally {
      tx2.close();
    }
    const u2 = await db.execute("SELECT email FROM app_user");
    expect(u2.rows[0].email).toMatch(/^hashed:[0-9a-f]{64}$/);
  });
});
