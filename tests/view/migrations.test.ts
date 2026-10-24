// @vitest-environment node
// M7 T2 migrations: auth 0006_ui (unmask_grant, user_watchlist) and main 0011_ui (instrument.sector,
// ops_task_done). Up, down and up again give the same schema; the triggers hold.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

async function fresh(name: "main" | "auth") {
  const db = track(createClient({ url: tempDbUrl() }));
  const ms = await loadMigrations(MIGRATIONS(name));
  await migrateUp(db, ms);
  return { db, ms };
}

describe("auth 0006_ui", () => {
  it("is the sixth auth migration and creates unmask_grant and user_watchlist", async () => {
    const { db, ms } = await fresh("auth");
    expect(ms[5]).toMatchObject({ version: 6, name: "ui" });
    const cols = async (t: string) =>
      (await db.execute(`PRAGMA table_info(${t})`)).rows.map((c) => [c.name, c.notnull]);
    expect(await cols("unmask_grant")).toEqual([
      ["id", 0],
      ["user_id", 1],
      ["granted_by", 1],
      ["granted_at", 1],
      ["expires_at", 1],
      ["revoked_at", 0],
      ["revoked_by", 0],
    ]);
    expect(await cols("user_watchlist")).toEqual([
      ["user_id", 1],
      ["market", 1],
      ["code", 1],
      ["added_at", 1],
    ]);
  });

  it("down removes both tables; up again restores the same schema", async () => {
    const { db, ms } = await fresh("auth");
    const before = await schemaOf(db);
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 5 });
    const mid = (await schemaOf(db)).join("\n");
    expect(mid).not.toContain("unmask_grant");
    expect(mid).not.toContain("user_watchlist");
    expect(mid).toContain("annotation");
    await migrateUp(db, ms);
    expect(await schemaOf(db)).toEqual(before);
  });

  it("unmask_grant: expiry after grant, revocation fields together, one revocation, no delete", async () => {
    const { db } = await fresh("auth");
    await db.execute(
      "INSERT INTO app_user (email, role, status, session_version, created_at, updated_at) VALUES ('o@example.test','owner','active',1,'x','x'), ('v@example.test','viewer','active',1,'x','x')",
    );
    const ins = (granted: string, expires: string, rat: string | null, rby: number | null) =>
      db.execute({
        sql: "INSERT INTO unmask_grant (user_id, granted_by, granted_at, expires_at, revoked_at, revoked_by) VALUES (2, 1, ?, ?, ?, ?)",
        args: [granted, expires, rat, rby],
      });
    await expect(ins("2026-10-20", "2026-10-20", null, null)).rejects.toThrow(/CHECK/);
    await expect(ins("2026-10-20", "2026-10-19", null, null)).rejects.toThrow(/CHECK/);
    await expect(ins("2026-10-20", "2026-10-21", "2026-10-20", null)).rejects.toThrow(/CHECK/);
    await expect(ins("2026-10-20", "2026-10-21", null, 1)).rejects.toThrow(/CHECK/);
    await ins("2026-10-20", "2026-10-21", null, null);
    await expect(db.execute("UPDATE unmask_grant SET expires_at = '2030-01-01'")).rejects.toThrow(
      /one revocation/,
    );
    await expect(db.execute("UPDATE unmask_grant SET revoked_at = 'x'")).rejects.toThrow(
      /one revocation|CHECK/,
    );
    await db.execute("UPDATE unmask_grant SET revoked_at = '2026-10-20T01', revoked_by = 1");
    await expect(db.execute("UPDATE unmask_grant SET revoked_by = 2")).rejects.toThrow(
      /one revocation/,
    );
    await expect(db.execute("DELETE FROM unmask_grant")).rejects.toThrow(/forever/);
  });

  it("user_watchlist: one row per (user, market, code)", async () => {
    const { db } = await fresh("auth");
    await db.execute(
      "INSERT INTO app_user (email, role, status, session_version, created_at, updated_at) VALUES ('e@example.test','editor','active',1,'x','x')",
    );
    const add = () =>
      db.execute(
        "INSERT INTO user_watchlist (user_id, market, code, added_at) VALUES (1,'AU','ZZA','t')",
      );
    await add();
    await expect(add()).rejects.toThrow();
    await expect(
      db.execute(
        "INSERT INTO user_watchlist (user_id, market, code, added_at) VALUES (1,'AU','','t')",
      ),
    ).rejects.toThrow(/CHECK/);
  });
});

describe("main 0011_ui", () => {
  it("is the eleventh main migration: instrument.sector (nullable) and ops_task_done", async () => {
    const { db, ms } = await fresh("main");
    expect(ms[10]).toMatchObject({ version: 11, name: "ui" });
    const sector = (await db.execute("PRAGMA table_info(instrument)")).rows.find(
      (c) => c.name === "sector",
    );
    expect(sector).toMatchObject({ type: "TEXT", notnull: 0 });
    const cols = (await db.execute("PRAGMA table_info(ops_task_done)")).rows.map((c) => c.name);
    expect(cols).toEqual(["task_id", "due_d", "done_by", "done_at", "audit_ref"]);
  });

  it("the sector column works on existing rows and the identity guard still holds", async () => {
    const { db } = await fresh("main");
    await db.execute("INSERT INTO instrument (market, code, name) VALUES ('AU','ZZA','Zed A')");
    expect((await db.execute("SELECT sector FROM instrument")).rows[0]!.sector).toBeNull();
    await db.execute("UPDATE instrument SET sector = 'Materials' WHERE code = 'ZZA'");
    expect((await db.execute("SELECT sector FROM instrument")).rows[0]!.sector).toBe("Materials");
    await expect(db.execute("UPDATE instrument SET code = 'ZZB'")).rejects.toThrow(/immutable/);
  });

  it("the movers index the design needs already exists (no new index in 0011)", async () => {
    const { db } = await fresh("main");
    const plan = await db.execute(
      "EXPLAIN QUERY PLAN SELECT code FROM price_bar WHERE market = 'AU' AND d = '2026-10-19'",
    );
    expect(plan.rows.map((r) => String(r.detail)).join(" ")).toMatch(
      /USING (COVERING )?INDEX|PRIMARY KEY/,
    );
  });

  it("ops_task_done is append-only, one row per (task, due date), done_by is a real id", async () => {
    const { db } = await fresh("main");
    const add = (task: string, due: string, by = 1) =>
      db.execute({
        sql: "INSERT INTO ops_task_done (task_id, due_d, done_by, done_at, audit_ref) VALUES (?, ?, ?, 't', 'a:1')",
        args: [task, due, by],
      });
    await add("rotate-key", "2026-11-01");
    await add("rotate-key", "2026-12-01");
    await expect(add("rotate-key", "2026-11-01")).rejects.toThrow();
    await expect(add("rotate-key", "not-a-date")).rejects.toThrow(/CHECK/);
    await expect(add("", "2026-11-01")).rejects.toThrow(/CHECK/);
    await expect(add("x", "2026-11-01", 0)).rejects.toThrow(/CHECK/);
    await expect(db.execute("UPDATE ops_task_done SET done_by = 2")).rejects.toThrow(/append-only/);
    await expect(db.execute("DELETE FROM ops_task_done")).rejects.toThrow(/append-only/);
  });

  it("down drops the table and the column; up again restores the same schema", async () => {
    const { db, ms } = await fresh("main");
    const before = await schemaOf(db);
    await migrateDown(db, ms, 3); // 0014 (pick checks), 0013 (calendar history) and 0012 (golive) sit on top of 0011
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 10 });
    const mid = (await schemaOf(db)).join("\n");
    expect(mid).not.toContain("ops_task_done");
    expect(mid).not.toContain("sector");
    await migrateUp(db, ms);
    expect(await schemaOf(db)).toEqual(before);
  });
});
