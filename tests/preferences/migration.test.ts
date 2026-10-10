// @vitest-environment node
// UX-110, DAT-150, ROL-102a, TST-125: auth migration 0003_user_preference.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

describe("auth migration 0003_user_preference", () => {
  it("is the third auth migration and creates user_preference", async () => {
    const ms = await loadMigrations(MIGRATIONS("auth"));
    expect(ms[2]).toMatchObject({ version: 3, name: "user_preference" });
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, ms);
    const cols = await db.execute("PRAGMA table_info(user_preference)");
    expect(cols.rows.map((c) => [c.name, c.notnull, c.pk])).toEqual([
      ["user_id", 0, 1],
      ["prefs_json", 1, 0],
      ["updated_at", 1, 0],
    ]);
    const fk = await db.execute("PRAGMA foreign_key_list(user_preference)");
    expect(fk.rows.map((r) => [r.table, r.from, r.to])).toEqual([["app_user", "user_id", "id"]]);
  });

  it("down removes the table; up again restores the same schema", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("auth"));
    await migrateUp(db, ms);
    const before = await schemaOf(db);
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 2 });
    expect((await schemaOf(db)).some((s) => s.includes("user_preference"))).toBe(false);
    await migrateUp(db, ms);
    expect(await schemaOf(db)).toEqual(before);
  });
});
