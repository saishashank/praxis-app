// @vitest-environment node
import { createClient } from "@libsql/client";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadMigrations,
  migrateDown,
  migrateUp,
  parseMigration,
  splitStatements,
} from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

describe.each(["main", "auth"] as const)("migrations (%s)", (name) => {
  it("fresh DB applies all; second run applies none", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS(name));
    const first = await migrateUp(db, ms);
    expect(first.applied).toBe(ms.length);
    expect(first.version).toBe(ms.length);
    const second = await migrateUp(db, ms);
    expect(second).toEqual({ applied: 0, version: ms.length });
    const rows = await db.execute("SELECT checksum FROM schema_migrations");
    expect(String(rows.rows[0].checksum)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("down(1) then up gives the same schema", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS(name));
    await migrateUp(db, ms);
    const before = await schemaOf(db);
    const down = await migrateDown(db, ms, 1);
    expect(down).toEqual({ rolledBack: 1, version: ms.length - 1 });
    expect((await schemaOf(db)).length).toBeLessThan(before.length);
    await migrateUp(db, ms);
    expect(await schemaOf(db)).toEqual(before);
  });
});

describe("runner edge cases", () => {
  function writeDir(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), "praxis-mig-"));
    mkdirSync(dir, { recursive: true });
    for (const [f, c] of Object.entries(files)) writeFileSync(path.join(dir, f), c);
    return dir;
  }
  const good = "-- +up\nCREATE TABLE a (x INTEGER);\n-- +down\nDROP TABLE a;\n";

  it("hard-errors when an applied file changed", async () => {
    const dir = writeDir({ "0001_a.sql": good });
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(dir));
    writeFileSync(path.join(dir, "0001_a.sql"), good.replace("(x INTEGER)", "(x INTEGER, y TEXT)"));
    await expect(migrateUp(db, await loadMigrations(dir))).rejects.toThrow(/changed after/);
  });

  it("errors when an applied migration has no file", async () => {
    const dir = writeDir({ "0001_a.sql": good });
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(dir));
    await expect(migrateUp(db, [])).rejects.toThrow(/no file/);
    await expect(migrateDown(db, [], 1)).rejects.toThrow(/no file/);
  });

  it("rolls back a failing file as a unit", async () => {
    const bad =
      "-- +up\nCREATE TABLE b (x INTEGER);\nINSERT INTO nope VALUES (1);\n-- +down\nDROP TABLE b;\n";
    const dir = writeDir({ "0001_b.sql": bad });
    const db = track(createClient({ url: tempDbUrl() }));
    await expect(migrateUp(db, await loadMigrations(dir))).rejects.toThrow();
    const t = await db.execute("SELECT name FROM sqlite_master WHERE name = 'b'");
    expect(t.rows.length).toBe(0);
    const v = await db.execute("SELECT count(*) AS c FROM schema_migrations");
    expect(Number(v.rows[0].c)).toBe(0);
  });

  it("rejects bad names, gaps and missing sections", async () => {
    await expect(loadMigrations(writeDir({ "x.sql": good }))).rejects.toThrow(/not allowed/);
    await expect(loadMigrations(writeDir({ "0002_a.sql": good }))).rejects.toThrow(/contiguous/);
    await expect(loadMigrations(writeDir({ "0001_a.sql": "-- +up\nSELECT 1;\n" }))).rejects.toThrow(
      /sections/,
    );
  });

  it("splits statements, keeping trigger bodies whole", () => {
    const s = splitStatements(
      "-- comment\nCREATE TABLE t (a INT);\n\nCREATE TRIGGER x BEFORE DELETE ON t\nBEGIN\n  SELECT 1;\nEND;\n",
    );
    expect(s).toHaveLength(2);
    expect(s[1]).toContain("SELECT 1;");
    expect(() => splitStatements("SELECT 1")).toThrow(/unterminated/);
    expect(parseMigration(good, "f").down).toEqual(["DROP TABLE a;"]);
  });
});
