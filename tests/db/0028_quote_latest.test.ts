// @vitest-environment node
// Migration 0028_quote_latest (D-900, O-80): the newest delayed quote per code; rolls back and comes
// back identical.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

describe("0028_quote_latest", () => {
  it("creates quote_latest with its checks, rolls back and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[27]).toMatchObject({ version: 28, name: "quote_latest" });
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    await db.execute(
      "INSERT INTO quote_latest (market, code, last_micro, prev_close_micro, quote_at, fetched_at) " +
        "VALUES ('AU', 'AAA', 1, NULL, 't', 't')",
    );
    await expect(
      db.execute(
        "INSERT INTO quote_latest (market, code, last_micro, prev_close_micro, quote_at, fetched_at) " +
          "VALUES ('AU', 'BBB', 0, NULL, 't', 't')",
      ),
    ).rejects.toThrow();
    await db.execute("DELETE FROM quote_latest");

    expect(await migrateDown(db, ms, 4)).toEqual({ rolledBack: 4, version: 27 });
    const tables = (
      await db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quote_latest'",
      )
    ).rows;
    expect(tables).toHaveLength(0);
    expect(await migrateUp(db, ms)).toEqual({ applied: 4, version: 31 });
    expect(await schemaOf(db)).toEqual(after);
  });
});
