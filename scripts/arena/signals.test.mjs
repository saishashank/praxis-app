// M4 T8: signals.mjs really loads the TypeScript engine (bundled by engine.mjs) and behaves as the
// workflow needs: a data_only production database gets a skipped run record and no agent or arena
// row (D-066, BLD-024), a remote database is refused for a replay, 2b without a closed 2a for the
// session fails visibly after the wait, and nothing but statuses and counts is printed. The deeper
// cases are in tests/agents/batch2b*.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { run as signals } from "./signals.mjs";

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
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-signals-"));
  const url = pathToFileURL(path.join(dir, "main.db")).href;
  const db = createClient({ url });
  await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", "main")));
  return { dir, url, db };
}

test("signals.mjs: data_only production records a skip and writes nothing", async () => {
  const { dir, url, db } = await freshDb();
  try {
    const lines = [];
    const code = await signals(
      ["--date", "2026-10-13"],
      { TURSO_MAIN_URL: url, TURSO_MAIN_TOKEN: "secret-token-do-not-print" },
      { nowMs: () => NOW, out: (s) => lines.push(s) },
    );
    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /^arena-2b AU 2026-10-13: skipped \(data_only_guard\) cohorts=0 signals=0/,
    );
    assert.doesNotMatch(lines.join("\n"), /secret|file:/);
    const rs = await db.execute("SELECT job, status, concurrency_key FROM run_record");
    assert.equal(rs.rows.length, 1);
    assert.equal(rs.rows[0].job, "arena-signals");
    assert.equal(rs.rows[0].status, "skipped");
    assert.equal(rs.rows[0].concurrency_key, "arena-2b:AU:2026-10-13");
    for (const t of [
      "execution",
      "cohort",
      "arena_order",
      "signal",
      "regime_daily",
      "event",
      "insider_flow_score",
      "stop_level",
      "c2_selection",
    ]) {
      const n = await db.execute(`SELECT COUNT(*) AS n FROM ${t}`);
      assert.equal(Number(n.rows[0].n), 0, t);
    }
  } finally {
    db.close();
    cleanup(dir);
  }
});

test("signals.mjs: not configured -> exit 1; --replay on a remote database -> exit 2", async () => {
  const lines = [];
  const deps = { out: (s) => lines.push(s) };
  assert.equal(await signals([], {}, deps), 1);
  assert.equal(
    await signals(
      ["--replay"],
      { TURSO_MAIN_URL: "libsql://example.turso.io", TURSO_MAIN_TOKEN: "t" },
      deps,
    ),
    2,
  );
  assert.doesNotMatch(lines.join("\n"), /example\.turso\.io/);
});

test("signals.mjs: a replay without a closed 2a fails visibly, after the (zero) wait", async () => {
  const { dir, url, db } = await freshDb();
  try {
    await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
    const lines = [];
    const code = await signals(
      ["--date", "2026-10-13", "--replay", "--wait-minutes", "0"],
      { TURSO_MAIN_URL: url },
      {
        nowMs: () => NOW,
        out: (s) => lines.push(s),
        sleep: async () => {},
        openDb: (u) => createClient({ url: u, intMode: "bigint" }),
      },
    );
    assert.equal(code, 1);
    assert.match(lines[0], /^arena-2b AU 2026-10-13: skipped \(no_2a_success\)/);
  } finally {
    db.close();
    cleanup(dir);
  }
});
