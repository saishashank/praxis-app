// @vitest-environment node
// Migration 0030_daily_learning (D-921): the nightly learning loop's stored night; rolls back and
// comes back identical, and its CHECK constraints hold.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const ins = (d: string, body: string) =>
  `INSERT INTO daily_learning (market, d, body_json, created_at) VALUES ('AU','${d}','${body}','2026-11-10T09:00:00.000Z')`;

describe("0030_daily_learning", () => {
  it("creates the table, rolls back and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[29]).toMatchObject({ version: 30, name: "daily_learning" });
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    expect(await migrateDown(db, ms, 2)).toEqual({ rolledBack: 2, version: 29 });
    const tables = (
      await db.execute("SELECT name FROM sqlite_master WHERE name = 'daily_learning'")
    ).rows;
    expect(tables).toHaveLength(0);
    expect(await migrateUp(db, ms)).toEqual({ applied: 2, version: 31 });
    expect(await schemaOf(db)).toEqual(after);
  });

  it("holds one valid JSON document per market and session", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    await db.execute(ins("2026-11-10", "{}"));
    await expect(db.execute(ins("2026-11-10", "{}"))).rejects.toThrow(); // primary key
    await expect(db.execute(ins("2026-11-11", "not json"))).rejects.toThrow(); // json_valid
    await expect(db.execute(ins("11 Nov", "{}"))).rejects.toThrow(); // date shape
  });
});
