// @vitest-environment node
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

describe("auth migration 0002_sharing_ack", () => {
  it("is the second auth migration and creates sharing_ack with its columns", async () => {
    const ms = await loadMigrations(MIGRATIONS("auth"));
    expect(ms[1]).toMatchObject({ version: 2, name: "sharing_ack" });
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, ms);
    const cols = await db.execute("PRAGMA table_info(sharing_ack)");
    expect(cols.rows.map((c) => [c.name, c.notnull])).toEqual([
      ["id", 0],
      ["market", 1],
      ["acknowledged_by", 1],
      ["acknowledged_at", 1],
      ["text_version", 1],
    ]);
  });

  it("is append-only", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("auth")));
    await db.execute(
      "INSERT INTO sharing_ack (market, acknowledged_by, acknowledged_at, text_version) VALUES ('AU', 1, 'x', 'v1')",
    );
    await expect(db.execute("UPDATE sharing_ack SET text_version = 'v2'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM sharing_ack")).rejects.toThrow(/append-only/);
  });

  it("down removes table and triggers; up again restores the same schema", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("auth"));
    await migrateUp(db, ms);
    const before = await schemaOf(db);
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 1 });
    const mid = (await schemaOf(db)).join("\n");
    expect(mid).not.toContain("sharing_ack");
    expect(mid).toContain("app_user");
    await migrateUp(db, ms);
    expect(await schemaOf(db)).toEqual(before);
  });
});
