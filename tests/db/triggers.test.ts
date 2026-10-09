// @vitest-environment node
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDbs, freshDb } from "./helpers";

afterEach(cleanupTempDbs);

const T = "2026-10-10T07:00:00.000Z";

describe("main DB constraints", () => {
  let db: Client;
  beforeEach(async () => {
    db = await freshDb("main");
    await db.execute({
      sql: "INSERT INTO config_version (key, value_json, changed_at) VALUES ('k', '1', ?)",
      args: [T],
    });
  });

  it("config_version is append-only", async () => {
    await expect(db.execute("UPDATE config_version SET value_json = '2'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM config_version")).rejects.toThrow(/append-only/);
    const r = await db.execute("SELECT scope FROM config_version");
    expect(r.rows[0].scope).toBe("global");
  });

  it("run_record rejects bad status", async () => {
    await expect(
      db.execute({
        sql: "INSERT INTO run_record (job, concurrency_key, started_at, status) VALUES ('j','k',?,'bogus')",
        args: [T],
      }),
    ).rejects.toThrow();
  });

  it("app_log rejects bad level", async () => {
    await expect(
      db.execute({
        sql: "INSERT INTO app_log (at, level, source, message) VALUES (?, 'debug', 's', 'm')",
        args: [T],
      }),
    ).rejects.toThrow();
  });
});

describe("auth DB constraints", () => {
  let db: Client;
  const user = (email: string, role = "viewer", status = "active") =>
    db.execute({
      sql: "INSERT INTO app_user (email, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      args: [email, role, status, T, T],
    });
  const audit = (n: string) =>
    db.execute({
      sql: "INSERT INTO audit_event (at, actor_user_id, action, ip, user_agent, prev_hmac, row_hmac) VALUES (?, 1, 'a', '1.2.3.4', 'ua', 'p', ?)",
      args: [T, n],
    });
  beforeEach(async () => {
    db = await freshDb("auth");
  });

  it("defaults: viewer, invited, session_version 1", async () => {
    await db.execute({
      sql: "INSERT INTO app_user (email, created_at, updated_at) VALUES ('a@x.io', ?, ?)",
      args: [T, T],
    });
    const r = await db.execute("SELECT role, status, session_version FROM app_user");
    expect(r.rows[0]).toMatchObject({ role: "viewer", status: "invited", session_version: 1 });
  });

  it("allows only one non-revoked owner", async () => {
    await user("o1@x.io", "owner");
    await expect(user("o2@x.io", "owner")).rejects.toThrow();
    await db.execute("UPDATE app_user SET status = 'revoked'");
    await user("o2@x.io", "owner");
  });

  it("rejects bad role and duplicate email", async () => {
    await expect(user("a@x.io", "admin")).rejects.toThrow();
    await user("a@x.io");
    await expect(user("a@x.io")).rejects.toThrow();
  });

  it("audit_event: delete and edit abort; nulling ip/user_agent works", async () => {
    await audit("h1");
    await expect(db.execute("DELETE FROM audit_event")).rejects.toThrow(/append-only/);
    await expect(db.execute("UPDATE audit_event SET action = 'b'")).rejects.toThrow(/append-only/);
    await expect(db.execute("UPDATE audit_event SET ip = '9.9.9.9'")).rejects.toThrow(
      /append-only/,
    );
    await db.execute("UPDATE audit_event SET user_agent = NULL");
    await db.execute("UPDATE audit_event SET ip = NULL, user_agent = NULL");
    const r = await db.execute("SELECT ip, user_agent, action FROM audit_event");
    expect(r.rows[0]).toMatchObject({ ip: null, user_agent: null, action: "a" });
  });

  it("rate_limit has a composite key", async () => {
    await db.execute("INSERT INTO rate_limit VALUES ('b', 1, 1)");
    await expect(db.execute("INSERT INTO rate_limit VALUES ('b', 1, 2)")).rejects.toThrow();
  });
});
