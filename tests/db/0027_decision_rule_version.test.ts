// @vitest-environment node
// Migration 0027_decision_rule_version (D-890, O-79): cortex_decision gains a nullable
// rule_version; the migration rolls back and comes back identical.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

describe("0027_decision_rule_version", () => {
  it("adds a nullable rule_version, rolls back and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[26]).toMatchObject({ version: 27, name: "decision_rule_version" });
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    const cols = (await db.execute("PRAGMA table_info(cortex_decision)")).rows.map((r) =>
      String(r.name),
    );
    expect(cols).toContain("rule_version");

    expect(await migrateDown(db, ms, 6)).toEqual({ rolledBack: 6, version: 26 }); // 0028 to 0032 sit on top;
    const back = (await db.execute("PRAGMA table_info(cortex_decision)")).rows.map((r) =>
      String(r.name),
    );
    expect(back).not.toContain("rule_version");
    expect(await migrateUp(db, ms)).toEqual({ applied: 6, version: 32 });
    expect(await schemaOf(db)).toEqual(after);
  });
});
