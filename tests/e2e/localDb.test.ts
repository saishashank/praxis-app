// @vitest-environment node
// D-1845 regression: the E2E helpers' local libSQL connection waits for another connection's lock
// instead of failing with SQLITE_BUSY (main CI 2026-11-19: m16-blueprint-page sign-in failed with
// "database is locked" while the server and other Playwright workers wrote auth.db).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLocalDb } from "../../e2e/localDb";

// A second connection, in its own thread, that holds an EXCLUSIVE lock for `holdMs`, like the
// server committing a write while a test reads.
const HOLDER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.file);
db.exec("BEGIN EXCLUSIVE");
db.exec("UPDATE t SET v = v + 1");
parentPort.postMessage("locked");
setTimeout(() => { db.exec("COMMIT"); db.close(); parentPort.postMessage("released"); }, workerData.holdMs);
`;

function holdLock(file: string, holdMs: number): Promise<Worker> {
  const w = new Worker(HOLDER, { eval: true, workerData: { file, holdMs } });
  return new Promise((resolve, reject) => {
    w.once("error", reject);
    w.once("message", (m) => (m === "locked" ? resolve(w) : reject(new Error(String(m)))));
  });
}

const released = (w: Worker) =>
  new Promise<void>((resolve) => w.once("message", (m) => m === "released" && resolve()));

describe("e2e openLocalDb", () => {
  let dir = "";
  let file = "";
  let url = "";
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "praxis-localdb-"));
    file = path.join(dir, "auth.db");
    url = pathToFileURL(file).href;
    const db = createClient({ url });
    await db.execute("CREATE TABLE t (v INTEGER)");
    await db.execute("INSERT INTO t (v) VALUES (1)");
    db.close();
  });
  afterEach(() => {
    // Windows can keep the closed file's handle a moment (EPERM); the run's Temp folder is swept anyway.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swept by scripts/test/runTemp.mjs */
    }
  });

  // Writes, not reads: in WAL mode (Linux CI) a reader is never blocked by a writer, but a second
  // writer meets the lock on every platform, which is what the sign-in write hit.
  it("a plain client's write fails at once on a locked file (the CI failure)", async () => {
    const w = await holdLock(file, 300);
    const db = createClient({ url });
    try {
      await expect(db.execute("UPDATE t SET v = v + 10")).rejects.toThrow(/SQLITE_BUSY|locked/);
    } finally {
      db.close();
      await released(w);
    }
  });

  it("openLocalDb's write waits for the lock and lands after the other commit", async () => {
    const w = await holdLock(file, 300);
    const done = released(w);
    const db = await openLocalDb(url);
    try {
      await db.execute("UPDATE t SET v = v + 10");
      const r = await db.execute("SELECT v FROM t");
      expect(Number(r.rows[0].v)).toBe(12);
    } finally {
      db.close();
      await done;
    }
  });
});
