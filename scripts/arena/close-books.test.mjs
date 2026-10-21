// M3 T10: the two .mjs entry points really load the TypeScript engine (bundled by engine.mjs) and
// behave as the workflow needs: a data_only production database gets a skipped run record and no
// arena row (D-066, BLD-024), a remote database is refused for a replay, and nothing but statuses
// and counts is printed. The deeper cases are in tests/arena/cli.test.ts and closeBooks.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { run as closeBooks } from "./close-books.mjs";
import { run as replay } from "./replay.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = Date.parse("2026-10-13T08:00:00.000Z"); // Tuesday 13 Oct 2026, 19:00 Sydney

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows may keep the file locked for a moment; the OS temp folder is cleaned later.
  }
}

async function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-arena-"));
  const url = pathToFileURL(path.join(dir, "main.db")).href;
  const db = createClient({ url });
  await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", "main")));
  return { dir, url, db };
}

test("close-books.mjs: data_only production records a skip and writes nothing", async () => {
  const { dir, url, db } = await freshDb();
  try {
    const lines = [];
    const code = await closeBooks(
      ["--date", "2026-10-13"],
      { TURSO_MAIN_URL: url, TURSO_MAIN_TOKEN: "secret-token-do-not-print" },
      { nowMs: () => NOW, out: (s) => lines.push(s) },
    );
    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^arena-2a AU 2026-10-13: skipped \(data_only_guard\) cohorts=0/);
    assert.doesNotMatch(lines.join("\n"), /secret|file:/);
    const run = await db.execute("SELECT job, status, concurrency_key FROM run_record");
    assert.equal(run.rows.length, 1);
    assert.equal(run.rows[0].job, "arena-close");
    assert.equal(run.rows[0].status, "skipped");
    assert.equal(run.rows[0].concurrency_key, "arena-2a:AU:2026-10-13");
    for (const t of ["execution", "cohort", "arena_order", "fill", "cash_ledger", "nav_daily"]) {
      const n = await db.execute(`SELECT COUNT(*) AS n FROM ${t}`);
      assert.equal(Number(n.rows[0].n), 0, t);
    }
  } finally {
    db.close();
    cleanup(dir);
  }
});

test("close-books.mjs: not configured -> exit 1; --replay on a remote database -> exit 2", async () => {
  const lines = [];
  const deps = { out: (s) => lines.push(s) };
  assert.equal(await closeBooks([], {}, deps), 1);
  assert.equal(
    await closeBooks(
      ["--replay"],
      { TURSO_MAIN_URL: "libsql://example.turso.io", TURSO_MAIN_TOKEN: "t" },
      deps,
    ),
    2,
  );
  assert.doesNotMatch(lines.join("\n"), /example\.turso\.io/);
});

test("replay.mjs: refuses a remote database, replays a local file", async () => {
  const lines = [];
  const deps = { out: (s) => lines.push(s), nowMs: () => NOW };
  assert.equal(
    await replay(
      ["--db", "libsql://example.turso.io", "--from", "2026-10-12", "--to", "2026-10-13"],
      {},
      deps,
    ),
    2,
  );
  const { dir, url, db } = await freshDb();
  try {
    // no cohorts and no marker: each session records a skip, nothing fails
    const code = await replay(
      ["--db", url, "--from", "2026-10-12", "--to", "2026-10-13"],
      {},
      {
        ...deps,
        openDb: (u) => createClient({ url: u, intMode: "bigint" }),
      },
    );
    assert.equal(code, 0);
    assert.match(lines.at(-1), /^arena-replay AU 2026-10-12\.\.2026-10-13: sessions=2 skipped=2$/);
  } finally {
    db.close();
    cleanup(dir);
  }
});
