// @vitest-environment node
// Migration 0029_job_run (INFRA T3): the self-hosted job runner's lease and run log; rolls back and comes
// back identical, and its checks refuse a bad status or job name.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const ROW =
  "INSERT INTO job_run (job, slot_id, local_date, status, started_at, heartbeat_at, exit_code, log_path) " +
  "VALUES (?, ?, ?, ?, 't', 't', NULL, NULL)";

describe("0029_job_run", () => {
  it("creates job_run with its checks, rolls back and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[28]).toMatchObject({ version: 29, name: "job_run" });
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    for (const status of ["running", "success", "failed", "timeout", "skipped", "standby"]) {
      await db.execute({ sql: ROW, args: ["backup", null, "2026-11-03", status] });
    }
    await expect(
      db.execute({ sql: ROW, args: ["backup", null, "2026-11-03", "queued"] }),
    ).rejects.toThrow();
    await expect(
      db.execute({ sql: ROW, args: ["Bad Name", null, "2026-11-03", "running"] }),
    ).rejects.toThrow();
    await expect(
      db.execute({ sql: ROW, args: ["backup", null, "2026-11-3", "running"] }),
    ).rejects.toThrow();
    await db.execute("DELETE FROM job_run");

    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 28 });
    const tables = (
      await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_run'")
    ).rows;
    expect(tables).toHaveLength(0);
    expect(await migrateUp(db, ms)).toEqual({ applied: 1, version: 29 });
    expect(await schemaOf(db)).toEqual(after);
  });
});
