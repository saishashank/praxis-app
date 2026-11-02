// @vitest-environment node
// V1-S5 / V1-S6 (D-715, D-714): the restore writes bounded batches with a resumable checkpoint, fills
// parents before children (foreign keys are ON), and a stream that fits one batch stays atomic.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dumpDatabase } from "@/lib/backup/dump";
import {
  foreignKeyOrder,
  referencedTables,
  RESTORE_CHECKPOINT_TABLE,
  RESTORE_CHUNK_STATEMENTS,
  restoreDatabase,
} from "@/lib/backup/restore";
import { cleanupTempDbs, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const AT = "2026-10-11T00:00:00.000Z";
const emptyDb = (): Client => track(createClient({ url: tempDbUrl() }));

/** Alphabetically the child sorts BEFORE its parent, the order the old restore used. */
async function familyDb(rows: number): Promise<Client> {
  const db = emptyDb();
  await db.execute("CREATE TABLE z_parent (id INTEGER PRIMARY KEY, name TEXT)");
  await db.execute(
    "CREATE TABLE a_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES z_parent (id))",
  );
  await db.execute(
    "CREATE TABLE m_tree (id INTEGER PRIMARY KEY, up INTEGER REFERENCES m_tree (id))",
  );
  for (let i = 1; i <= rows; i++) {
    await db.execute({ sql: "INSERT INTO z_parent VALUES (?, ?)", args: [i, `p${i}`] });
    await db.execute({ sql: "INSERT INTO a_child VALUES (?, ?)", args: [i, i] });
    await db.execute({
      sql: "INSERT INTO m_tree VALUES (?, ?)",
      args: [i, i === 1 ? null : i - 1],
    });
  }
  await db.execute("CREATE INDEX idx_child_parent ON a_child (parent_id)");
  return db;
}

const tables = async (db: Client) =>
  (await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).rows.map(
    (r) => String(r.name),
  );

describe("foreign-key order (V1-S6)", () => {
  it("reads REFERENCES out of CREATE TABLE text", () => {
    expect(referencedTables("CREATE TABLE a (x INTEGER REFERENCES app_user (id))")).toEqual([
      "app_user",
    ]);
    expect(
      referencedTables(
        'CREATE TABLE a (x, FOREIGN KEY (x) REFERENCES "p" (id), y REFERENCES q(id))',
      ),
    ).toEqual(["p", "q"]);
    expect(referencedTables("CREATE TABLE a (x)")).toEqual([]);
  });

  it("puts parents first, keeps the stream order otherwise, ignores self references", () => {
    const sql = new Map([
      ["alert_user_state", "CREATE TABLE alert_user_state (u REFERENCES app_user (id))"],
      ["app_user", "CREATE TABLE app_user (id)"],
      ["tree", "CREATE TABLE tree (up REFERENCES tree (id))"],
      ["annotation", "CREATE TABLE annotation (a REFERENCES app_user (id))"],
    ]);
    expect(foreignKeyOrder([...sql.keys()], sql)).toEqual([
      "app_user",
      "alert_user_state",
      "tree",
      "annotation",
    ]);
  });

  it("survives a true cycle without looping", () => {
    const sql = new Map([
      ["a", "CREATE TABLE a (b REFERENCES b (id))"],
      ["b", "CREATE TABLE b (a REFERENCES a (id))"],
    ]);
    expect(foreignKeyOrder(["a", "b"], sql).sort()).toEqual(["a", "b"]);
  });

  it("restores a stream that lists the child before its parent into a foreign-key-enforcing target", async () => {
    const src = await familyDb(3);
    const dump = await dumpDatabase(src, { name: "main", createdAt: AT });
    expect(dump.meta.tables.indexOf("a_child")).toBeLessThan(dump.meta.tables.indexOf("z_parent"));
    const target = emptyDb();
    const r = await restoreDatabase(target, dump.text);
    expect(r.sha256).toEqual(dump.sha256);
    expect(Number((await target.execute("PRAGMA foreign_keys")).rows[0].foreign_keys)).toBe(1);
  });
});

describe("chunked restore with a checkpoint (V1-S5)", () => {
  it("a stream within the chunk size is ONE atomic batch", async () => {
    const src = await familyDb(2);
    const dump = await dumpDatabase(src, { name: "main", createdAt: AT });
    const target = emptyDb();
    const spy = vi.spyOn(target, "batch");
    await restoreDatabase(target, dump.text);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await tables(target)).not.toContain(RESTORE_CHECKPOINT_TABLE);
  });

  it("a larger stream is written in bounded batches and the result is identical", async () => {
    const src = await familyDb(40); // 120 rows
    const dump = await dumpDatabase(src, { name: "main", createdAt: AT });
    const target = emptyDb();
    const spy = vi.spyOn(target, "batch");
    const r = await restoreDatabase(target, dump.text, { chunkStatements: 25 });
    expect(r.counts).toEqual(dump.counts);
    expect(r.sha256).toEqual(dump.sha256);
    const sizes = spy.mock.calls.map((c) => (c[0] as unknown[]).length);
    expect(sizes.length).toBeGreaterThan(4);
    // data chunks: defer pragma + at most 25 inserts + checkpoint update
    for (const n of sizes.slice(1, -1)) expect(n).toBeLessThanOrEqual(25 + 2);
    expect(await tables(target)).not.toContain(RESTORE_CHECKPOINT_TABLE);
    const idx = await target.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_child_parent'",
    );
    expect(idx.rows.length).toBe(1);
  });

  it("a halted restore resumes from the checkpoint and finishes with the same checksums", async () => {
    const src = await familyDb(40);
    const dump = await dumpDatabase(src, { name: "main", createdAt: AT });
    const target = emptyDb();
    await expect(
      restoreDatabase(target, dump.text, { chunkStatements: 25, haltAfterChunks: 2 }),
    ).rejects.toThrow(/halted at checkpoint/);
    const cp = await target.execute(`SELECT step FROM ${RESTORE_CHECKPOINT_TABLE}`);
    expect(Number(cp.rows[0].step)).toBe(50);
    const done = await target.execute("SELECT COUNT(*) AS c FROM z_parent");
    expect(Number(done.rows[0].c)).toBe(40); // parents were written first
    const r = await restoreDatabase(target, dump.text, { chunkStatements: 25 });
    expect(r.sha256).toEqual(dump.sha256);
    expect(await tables(target)).not.toContain(RESTORE_CHECKPOINT_TABLE);
  });

  it("refuses to resume with a different stream and still refuses an unrelated non-empty target", async () => {
    const a = await dumpDatabase(await familyDb(40), { name: "main", createdAt: AT });
    const b = await dumpDatabase(await familyDb(41), { name: "main", createdAt: AT });
    const target = emptyDb();
    await expect(
      restoreDatabase(target, a.text, { chunkStatements: 25, haltAfterChunks: 1 }),
    ).rejects.toThrow(/halted/);
    await expect(restoreDatabase(target, b.text, { chunkStatements: 25 })).rejects.toThrow(
      /not empty/,
    );
    const other = await familyDb(1);
    await expect(restoreDatabase(other, a.text, { chunkStatements: 25 })).rejects.toThrow(
      /not empty/,
    );
  });

  it("rejects a bad chunk size and defaults to a bounded batch", async () => {
    const dump = await dumpDatabase(await familyDb(1), { name: "main", createdAt: AT });
    await expect(restoreDatabase(emptyDb(), dump.text, { chunkStatements: 0 })).rejects.toThrow(
      /chunk size/,
    );
    expect(RESTORE_CHUNK_STATEMENTS).toBeGreaterThan(0);
    expect(RESTORE_CHUNK_STATEMENTS).toBeLessThanOrEqual(5000);
  });
});
