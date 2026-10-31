// diagnose.mjs really loads the engine, reads a migrated database and writes nothing: every table
// keeps its row count and the log holds no secret or URL. The guard itself: tests/arena/diagnose.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { run as diagnose } from "./diagnose.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function tableCounts(db) {
  const names = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  const out = {};
  for (const r of names.rows) {
    const n = await db.execute(`SELECT COUNT(*) AS n FROM "${String(r.name)}"`);
    out[String(r.name)] = Number(n.rows[0].n);
  }
  return out;
}

test("diagnose.mjs: reads, prints counts only, and writes nothing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-diagnose-"));
  try {
    const url = pathToFileURL(path.join(dir, "main.db")).href;
    const db = createClient({ url });
    await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", "main")));
    const before = await tableCounts(db);
    const lines = [];
    const code = await diagnose(
      ["--dates", "2026-10-30"],
      { TURSO_MAIN_URL: url, TURSO_MAIN_TOKEN: "secret-token-do-not-print" },
      (s) => lines.push(s),
    );
    assert.ok(code === 0 || code === 1, `exit ${code}`);
    assert.match(lines[0], /^diagnose 2026-10-30: /);
    assert.doesNotMatch(lines.join("\n"), /secret|file:|write refused/);
    assert.deepEqual(await tableCounts(db), before);
    db.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows may keep the file locked for a moment.
    }
  }
});
