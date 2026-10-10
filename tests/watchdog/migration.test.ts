// @vitest-environment node
// Main DB migration 0003_incident (NFR-006): up and down.
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf } from "../db/helpers";

afterEach(cleanupTempDbs);

describe("main migration 0003_incident", () => {
  it("is the third main migration", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[2]).toMatchObject({ version: 3, name: "incident" });
  });

  it("creates incident with a severity CHECK and the open-incident index", async () => {
    const db = await freshDb("main");
    const cols = (await db.execute("PRAGMA table_info(incident)")).rows.map((r) => String(r.name));
    expect(cols).toEqual(["id", "at", "severity", "kind", "detail_json", "resolved_at"]);
    await db.execute("INSERT INTO incident (at, severity, kind) VALUES ('t', 'S1', 'k')");
    await expect(
      db.execute("INSERT INTO incident (at, severity, kind) VALUES ('t', 'S9', 'k')"),
    ).rejects.toThrow();
    const idx = await db.execute("SELECT name FROM sqlite_master WHERE name = 'idx_incident_open'");
    expect(idx.rows).toHaveLength(1);
  });

  it("down removes the table and the index; up again restores them", async () => {
    const db = await freshDb("main");
    const ms = await loadMigrations(MIGRATIONS("main"));
    const before = await schemaOf(db);
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 2 });
    expect((await schemaOf(db)).some((s) => s.includes("incident"))).toBe(false);
    await migrateUp(db, ms);
    expect(await schemaOf(db)).toEqual(before);
  });
});
