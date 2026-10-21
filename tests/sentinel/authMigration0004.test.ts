// @vitest-environment node
// Auth DB migration 0004_alert_user_state (M5 T1, docs/M5_design.md decision 32, D-096; UXN-157/160/
// 161, ROL-102a): up/down/up, the per-user alert state triggers (key fixed, acknowledgement final,
// snooze free, time moves forward, no delete), the foreign key to app_user. Synthetic values only.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { ALERT_USER_STATE_COLUMNS } from "@/lib/sentinel/schema";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

type V = string | number | null;
const q = async (db: Client, sql: string, args: V[] = []) =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const run = (db: Client, sql: string, args: V[] = []) => db.execute({ sql, args });

const T0 = "2026-10-19T01:00:00.000Z";
const T1 = "2026-10-19T02:00:00.000Z";

async function withUsers(): Promise<Client> {
  const db = await freshDb("auth");
  for (const [id, email] of [
    [1, "owner@example.test"],
    [2, "editor@example.test"],
  ] as const) {
    await run(
      db,
      "INSERT INTO app_user (id, email, role, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
      [id, email, id === 1 ? "owner" : "editor", T0, T0],
    );
  }
  return db;
}

const insertState = (db: Client, userId: number, key = "ann:AU:asx_announcements:A1") =>
  run(db, "INSERT INTO alert_user_state (user_id, alert_key, updated_at) VALUES (?, ?, ?)", [
    userId,
    key,
    T0,
  ]);

describe("auth migration 0004_alert_user_state", () => {
  it("is the fourth auth migration and creates alert_user_state (STRICT, user FK)", async () => {
    const ms = await loadMigrations(MIGRATIONS("auth"));
    expect(ms[3]).toMatchObject({ version: 4, name: "alert_user_state" });
    const db = await freshDb("auth");
    const cols = await q(db, "PRAGMA table_info(alert_user_state)");
    expect(cols.map((c) => c.name)).toEqual([...ALERT_USER_STATE_COLUMNS]);
    expect(cols.map((c) => c.pk)).toEqual([1, 2, 0, 0, 0]);
    expect(
      (await q(db, "SELECT strict FROM pragma_table_list('alert_user_state')"))[0].strict,
    ).toBe(1);
    const fk = await q(db, "PRAGMA foreign_key_list(alert_user_state)");
    expect(fk.map((r) => [r.table, r.from, r.to])).toEqual([["app_user", "user_id", "id"]]);
  });

  it("two users keep separate state for the same alert; the same pair twice is a UNIQUE error", async () => {
    const db = await withUsers();
    await insertState(db, 1);
    await insertState(db, 2);
    await expect(insertState(db, 1)).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
    await run(
      db,
      "INSERT INTO alert_user_state (user_id, alert_key, updated_at) VALUES (1, 'k', ?) ON CONFLICT DO NOTHING",
      [T0],
    );
    await run(
      db,
      "INSERT INTO alert_user_state (user_id, alert_key, updated_at) VALUES (1, 'k', ?) ON CONFLICT DO NOTHING",
      [T1],
    );
    expect(await q(db, "SELECT updated_at FROM alert_user_state WHERE alert_key = 'k'")).toEqual([
      { updated_at: T0 },
    ]);
  });

  it("an acknowledgement goes NULL to a value once and is final; writing the same time again is fine", async () => {
    const db = await withUsers();
    await insertState(db, 1);
    await run(db, "UPDATE alert_user_state SET acked_at = ?, updated_at = ?", [T0, T0]);
    await run(db, "UPDATE alert_user_state SET acked_at = ?, updated_at = ?", [T0, T1]);
    await expect(run(db, "UPDATE alert_user_state SET acked_at = ?", [T1])).rejects.toThrow(
      /acknowledgement is final/,
    );
    await expect(run(db, "UPDATE alert_user_state SET acked_at = NULL")).rejects.toThrow(
      /acknowledgement is final/,
    );
  });

  it("a snooze can be set, moved and cleared, with or without an acknowledgement", async () => {
    const db = await withUsers();
    await insertState(db, 1);
    await run(db, "UPDATE alert_user_state SET snoozed_until = ?, updated_at = ?", [T1, T0]);
    await run(db, "UPDATE alert_user_state SET snoozed_until = ?, updated_at = ?", [T0, T1]);
    await run(db, "UPDATE alert_user_state SET snoozed_until = NULL, updated_at = ?", [T1]);
    expect(await q(db, "SELECT snoozed_until FROM alert_user_state")).toEqual([
      { snoozed_until: null },
    ]);
  });

  it("the key never changes and updated_at only moves forward", async () => {
    const db = await withUsers();
    await insertState(db, 1);
    await run(db, "UPDATE alert_user_state SET updated_at = ?", [T1]);
    await expect(run(db, "UPDATE alert_user_state SET user_id = 2")).rejects.toThrow(
      /key is fixed/,
    );
    await expect(run(db, "UPDATE alert_user_state SET alert_key = 'other'")).rejects.toThrow(
      /key is fixed/,
    );
    await expect(run(db, "UPDATE alert_user_state SET updated_at = ?", [T0])).rejects.toThrow(
      /updated_at moves forward/,
    );
  });

  it("rows are never deleted (a revoked user's state is kept)", async () => {
    const db = await withUsers();
    await insertState(db, 1);
    await expect(run(db, "DELETE FROM alert_user_state")).rejects.toThrow(/forever table/);
    expect((await q(db, "SELECT COUNT(*) AS n FROM alert_user_state"))[0].n).toBe(1);
  });

  it("an empty alert key is refused; a missing user is refused when foreign keys are on", async () => {
    const db = await withUsers();
    await expect(insertState(db, 1, "")).rejects.toThrow(/CHECK/);
    await run(db, "PRAGMA foreign_keys = ON");
    await expect(insertState(db, 99)).rejects.toThrow(/FOREIGN KEY/);
  });

  it("down removes the table and its triggers; up restores an identical schema", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("auth"));
    await migrateUp(db, ms);
    const full = await schemaOf(db);
    await migrateDown(db, ms, 2); // 0006 (ui) and 0005 (annotation) sit on top: take the schema as of 0004
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 3 });
    const mid = (await schemaOf(db)).join("\n");
    expect(mid).not.toContain("alert_user_state");
    expect(mid).toContain("user_preference");
    expect(await migrateUp(db, ms)).toEqual({ applied: 3, version: 6 }); // 0004, 0005, then 0006
    expect(await schemaOf(db)).toEqual(full);
    expect(await migrateUp(db, ms)).toEqual({ applied: 0, version: 6 });
  });
});
