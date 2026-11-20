// @vitest-environment node
// D-1845 regression: the E2E helpers' local libSQL connection waits for another connection's lock
// instead of failing with SQLITE_BUSY (main CI 2026-11-19: m16-blueprint-page sign-in failed with
// "database is locked" while the server and other Playwright workers wrote auth.db).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLocalDb } from "../../e2e/localDb";

// A second connection in its own PROCESS that holds an EXCLUSIVE lock for `holdMs`, like the server
// committing a write while a test writes. A process, not a worker thread: on Linux SQLite locks are
// POSIX record locks, owned by the whole process, so a thread of the test process would not block
// the test's own connection (D-1845 follow-up: the thread version hung on Linux CI).
const HOLDER = `
const { DatabaseSync } = require("node:sqlite");
const [file, holdMs] = process.argv.slice(1);
const db = new DatabaseSync(file);
db.exec("BEGIN EXCLUSIVE");
db.exec("UPDATE t SET v = v + 1");
process.stdout.write("locked ");
setTimeout(() => { db.exec("COMMIT"); db.close(); process.stdout.write("released "); }, Number(holdMs));
`;

type Holder = { released: Promise<void> };

/** Starts the holder and resolves once it holds the lock; `released` settles after its COMMIT. */
function holdLock(file: string, holdMs: number): Promise<Holder> {
  const child = spawn(process.execPath, ["--no-warnings", "-e", HOLDER, file, String(holdMs)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  let onLocked: () => void = () => {};
  let onReleased: () => void = () => {};
  const locked = new Promise<void>((resolve) => (onLocked = resolve));
  const released = new Promise<void>((resolve) => (onReleased = resolve));
  child.stdout.on("data", (b: Buffer) => {
    out += b.toString();
    if (out.includes("locked")) onLocked();
    if (out.includes("released")) onReleased();
  });
  child.stderr.on("data", (b: Buffer) => (err += b.toString()));
  return new Promise((resolve, reject) => {
    child.once("exit", (code) => {
      if (!out.includes("locked")) reject(new Error(`holder exited ${code}: ${err}`));
      onReleased();
    });
    void locked.then(() => resolve({ released }));
  });
}

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

  // Writes, not reads: in WAL mode a reader is never blocked by a writer, but a second writer meets
  // the lock, which is what the sign-in write hit.
  it("a plain client's write fails at once on a locked file (the CI failure)", async () => {
    const h = await holdLock(file, 300);
    const db = createClient({ url });
    try {
      await expect(db.execute("UPDATE t SET v = v + 10")).rejects.toThrow(/SQLITE_BUSY|locked/);
    } finally {
      db.close();
      await h.released;
    }
  });

  it("openLocalDb's write waits for the lock and lands after the other commit", async () => {
    const h = await holdLock(file, 300);
    const db = await openLocalDb(url);
    try {
      await db.execute("UPDATE t SET v = v + 10");
      const r = await db.execute("SELECT v FROM t");
      expect(Number(r.rows[0].v)).toBe(12);
    } finally {
      db.close();
      await h.released;
    }
  });
});
