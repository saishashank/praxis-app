// @vitest-environment node
// Migration 0023 (V2 should-fix batch E; V2-S2 and V2-S4, D-700…D-703): cortex_feature_daily becomes
// prunable beyond 400 days (and only beyond), the maintenance job prunes it, the migration rolls back and
// comes back identical; and the rollback tooling of V2-S4: a database AHEAD of the tree is tolerated only
// on request, the checksum and gap checks still hold, and `--down-to` walks the `-- +down` sections to the
// V1 schema (0014) and back. Synthetic ZZ data only (SEC-110).
import { createClient, type Client } from "@libsql/client";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateDownTo, migrateUp } from "@/lib/db/migrate-core.mjs";
import { pruneLearningTables } from "@/lib/maintenance/retention";
import { cleanupTempDbs, freshDb, MIGRATIONS, ROOT, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const J = "'{}'";
const feature = (d: string, code: string): string =>
  `INSERT INTO cortex_feature_daily (market, d, code, features_json, flags_json, active_set_hash, manifest_id)
   VALUES ('AU', '${d}', '${code}', ${J}, ${J}, 'h', 'm1')`;

const dayAgo = (n: number): string =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const fails = async (db: Client, sql: string): Promise<string> => {
  try {
    await db.execute(sql);
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error(`expected to fail: ${sql}`);
};

describe("migration 0023: cortex_feature_daily is prunable beyond 400 days", () => {
  it("a row inside the floor can never be deleted, a row beyond it can; UPDATE still aborts", async () => {
    const db = await freshDb("main");
    await db.execute(feature(dayAgo(10), "ZZNEW"));
    await db.execute(feature(dayAgo(399), "ZZEDGE"));
    await db.execute(feature(dayAgo(430), "ZZOLD"));
    expect(await fails(db, "DELETE FROM cortex_feature_daily WHERE code = 'ZZNEW'")).toMatch(
      /append-only/,
    );
    expect(await fails(db, "DELETE FROM cortex_feature_daily WHERE code = 'ZZEDGE'")).toMatch(
      /append-only/,
    );
    expect(
      await fails(db, "UPDATE cortex_feature_daily SET code = code WHERE code = 'ZZOLD'"),
    ).toMatch(/append-only/);
    await db.execute("DELETE FROM cortex_feature_daily WHERE code = 'ZZOLD'");
    const left = await db.execute("SELECT code FROM cortex_feature_daily ORDER BY code");
    expect(left.rows.map((r) => r.code)).toEqual(["ZZEDGE", "ZZNEW"]);
  });

  it("the maintenance job prunes exactly the rows beyond the retention", async () => {
    const db = await freshDb("main");
    await db.execute(feature(dayAgo(10), "ZZNEW"));
    await db.execute(feature(dayAgo(401), "ZZOLD"));
    await db.execute(feature(dayAgo(900), "ZZOLDER"));
    const n = await pruneLearningTables(db, new Date().toISOString());
    expect(n).toBeGreaterThanOrEqual(2);
    const left = await db.execute("SELECT code FROM cortex_feature_daily");
    expect(left.rows.map((r) => r.code)).toEqual(["ZZNEW"]);
    // idempotent
    expect(await pruneLearningTables(db, new Date().toISOString())).toBe(0);
  });

  it("rolls back to the unconditional trigger and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    expect(await migrateDown(db, ms, 4)).toEqual({ rolledBack: 4, version: 22 });
    await db.execute(feature(dayAgo(900), "ZZOLD"));
    expect(await fails(db, "DELETE FROM cortex_feature_daily")).toMatch(/append-only/);
    expect(await migrateUp(db, ms)).toEqual({ applied: 4, version: 26 });
    expect(await schemaOf(db)).toEqual(after);
  });
});

describe("rollback to V1 (V2-S4)", () => {
  /** A copy of the main migrations holding only 0001…`last`: what an older build's tree knows. */
  function treeUpTo(last: number): string {
    const dir = mkdtempSync(path.join(tmpdir(), "praxis-tree-"));
    for (const f of readdirSync(MIGRATIONS("main"))) {
      if (Number(f.slice(0, 4)) <= last)
        cpSync(path.join(MIGRATIONS("main"), f), path.join(dir, f));
    }
    return dir;
  }
  const rm = (d: string): void => rmSync(d, { recursive: true, force: true });

  it("an older tree throws on the migrated database by default, and tolerates it only on request", async () => {
    const db = await freshDb("main");
    const dir = treeUpTo(14);
    try {
      const old = await loadMigrations(dir);
      await expect(migrateUp(db, old)).rejects.toThrow(/applied migration 15 has no file/);
      expect(await migrateUp(db, old, { allowNewer: true })).toEqual({
        applied: 0,
        version: 26,
        newer: [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
      });
    } finally {
      rm(dir);
    }
  });

  it("the tolerance stays narrow: a changed checksum still throws", async () => {
    const db = await freshDb("main");
    const dir = treeUpTo(14);
    try {
      writeFileSync(
        path.join(dir, "0014_pick_check.sql"),
        `${await readFile(path.join(MIGRATIONS("main"), "0014_pick_check.sql"), "utf8")}\n-- edited\n`,
      );
      const edited = await loadMigrations(dir);
      await expect(migrateUp(db, edited, { allowNewer: true })).rejects.toThrow(
        /changed after it was applied/,
      );
    } finally {
      rm(dir);
    }
  });

  it("--down-to walks 0026…0015 down to the V1 schema (0014) and the up path restores it", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    const full = await schemaOf(db);
    expect(await migrateDownTo(db, ms, 14)).toEqual({ rolledBack: 12, version: 14 });
    const v1 = await schemaOf(db);
    expect(v1.some((s) => s.startsWith("table:cortex_night:"))).toBe(false);
    expect(v1.some((s) => s.startsWith("table:expert:"))).toBe(false);
    expect(await migrateDownTo(db, ms, 14)).toEqual({ rolledBack: 0, version: 14 });
    // the V1 tree now accepts the database with no flag at all
    const dir = treeUpTo(14);
    try {
      expect(await migrateUp(db, await loadMigrations(dir))).toEqual({ applied: 0, version: 14 });
    } finally {
      rm(dir);
    }
    expect(await migrateUp(db, ms)).toEqual({ applied: 12, version: 26 });
    expect(await schemaOf(db)).toEqual(full);
  }, 60_000);

  const CLI = path.join(ROOT, "scripts", "db", "migrate.mjs");
  const run = (args: string[], env: Record<string, string>) => {
    const base: Record<string, string> = { PATH: process.env.PATH ?? "" };
    if (process.env.SystemRoot) base.SystemRoot = process.env.SystemRoot;
    const r = spawnSync(process.execPath, [CLI, ...args], {
      env: { ...base, ...env } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("the CLI refuses --down-to without --confirm-down, then rolls back with it", async () => {
    const url = tempDbUrl();
    expect(run(["--db", "main"], { TURSO_MAIN_URL: url }).code).toBe(0);
    const refused = run(["--db", "main", "--down-to", "14"], { TURSO_MAIN_URL: url });
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("--confirm-down");
    const done = run(["--db", "main", "--down-to", "14", "--confirm-down"], {
      TURSO_MAIN_URL: url,
    });
    expect(done.code).toBe(0);
    expect(done.out).toContain("rolled back 12 (now at v14)");
    expect(
      run(["--db", "main", "--down-to", "x", "--confirm-down"], { TURSO_MAIN_URL: url }).code,
    ).toBe(1);
  }, 60_000);

  it("MIGRATE_ALLOW_NEWER=1 and --allow-newer are read by the build step; without them the build fails", () => {
    // the real tree is at 26, so build a database one version AHEAD of it by faking schema_migrations
    const url = tempDbUrl();
    expect(run(["--db", "main"], { TURSO_MAIN_URL: url }).code).toBe(0);
    const bump = spawnSync(
      process.execPath,
      [
        "-e",
        `const {createClient}=require("@libsql/client");const c=createClient({url:process.env.U});` +
          `c.execute("INSERT INTO schema_migrations (version,name,checksum,applied_at) VALUES (27,'zz','x','t')").then(()=>c.close());`,
      ],
      { env: { ...process.env, U: url }, encoding: "utf8", cwd: ROOT },
    );
    expect(bump.status).toBe(0);
    const plain = run(["--db", "main"], { TURSO_MAIN_URL: url });
    expect(plain.code).toBe(1);
    expect(plain.out).toContain("applied migration 27 has no file");
    const flag = run(["--db", "main", "--allow-newer"], { TURSO_MAIN_URL: url });
    expect(flag.code).toBe(0);
    expect(flag.out).toContain("database is ahead of this build");
    const env = run(["--db", "main"], { TURSO_MAIN_URL: url, MIGRATE_ALLOW_NEWER: "1" });
    expect(env.code).toBe(0);
  }, 60_000);
});
