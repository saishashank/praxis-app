// @vitest-environment node
// PLT-061, PLT-050: Health "Quota usage" line - worst level for all roles, meter and ratio owner-only
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getHealthSummary } from "@/lib/health/summary";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});
const NOW = new Date("2026-10-10T12:00:00.000Z");

async function seedWrites(n: number) {
  await db.execute({
    sql: `INSERT INTO run_record (job, concurrency_key, started_at, status, rows_written)
          VALUES ('data-refresh', 'q1', '2026-10-02T00:00:00.000Z', 'success', ?)`,
    args: [n],
  });
}

describe("health quota line", () => {
  it("owner gets worst level, meter name and ratio", async () => {
    await seedWrites(5_400_000);
    const s = await getHealthSummary(db, NOW, "owner", {});
    expect(s.quota).toEqual({ level: "alert", meter: "Turso rows written", ratio: 0.9 });
  });

  it.each(["editor", "viewer"] as const)("%s gets the level only", async (role) => {
    await seedWrites(5_400_000);
    const s = await getHealthSummary(db, NOW, role, {});
    expect(s.quota).toEqual({ level: "alert" });
  });

  it("uses staging limits when TEST_IDENTITY_SECRET is present", async () => {
    await seedWrites(900_000);
    const s = await getHealthSummary(db, NOW, "viewer", { TEST_IDENTITY_SECRET: "x" });
    expect(s.quota.level).toBe("degrade");
  });

  it("reads process.env by default", async () => {
    const s = await getHealthSummary(db, NOW, "viewer");
    expect(s.quota.level).toBe("ok");
  });

  it("a meter failure shows NO DATA and does not break job status", async () => {
    const broken = {
      execute: (q: unknown) => {
        const sql = typeof q === "string" ? q : (q as { sql: string }).sql;
        if (sql.includes("SUM(rows_read)")) throw new Error("boom");
        return db.execute(q as never);
      },
    } as unknown as Client;
    const s = await getHealthSummary(broken, NOW, "owner", {});
    expect(s.quota).toEqual({ level: "no data" });
    expect(s.jobs.length).toBeGreaterThan(0);
  });
});
