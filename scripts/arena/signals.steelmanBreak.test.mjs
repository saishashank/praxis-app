// OPS-111 (5), D-977: the try/catch around the steelman bundle (D-504) is proven by a test that breaks the
// bundle build. The steelman is an opinion only: a stage that cannot even load changes neither the exit
// code nor anything the night wrote, and says so in one line.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { loadEngine } from "./engine.mjs";
import { run as signals } from "./signals.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = Date.parse("2026-10-13T08:00:00.000Z");

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows may keep the file locked for a moment
  }
}

test("signals.mjs: a steelman bundle that fails to build gives exit 0, one degraded line, and changes nothing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-signals-break-"));
  const url = pathToFileURL(path.join(dir, "main.db")).href;
  const db = createClient({ url });
  try {
    await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", "main")));
    const lines = [];
    const broken = (entry) => {
      if (entry === "src/lib/steelman/cli.ts") {
        return Promise.reject(new SyntaxError("the steelman bundle did not build"));
      }
      return loadEngine(entry);
    };
    const code = await signals(
      ["--date", "2026-10-13"],
      { TURSO_MAIN_URL: url, TURSO_MAIN_TOKEN: "secret-token-do-not-print" },
      { nowMs: () => NOW, out: (s) => lines.push(s), loadEngine: broken },
    );
    assert.equal(code, 0, "the night's exit code is the batch's, not the steelman's");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^arena-2b AU 2026-10-13: skipped \(data_only_guard\)/);
    assert.equal(lines[1], "arena-steelman: degraded (stage not run: SyntaxError)");
    assert.doesNotMatch(lines.join("\n"), /secret|file:|did not build/);
    // nothing of the steelman was written
    const rs = await db.execute(
      "SELECT (SELECT COUNT(*) FROM steelman_night) AS n, (SELECT COUNT(*) FROM steelman_pack) AS p",
    );
    assert.deepEqual([Number(rs.rows[0].n), Number(rs.rows[0].p)], [0, 0]);
    // the same run without the break writes the same run records
    const runs = (await db.execute("SELECT job, status FROM run_record ORDER BY id")).rows.map(
      (r) => [r.job, r.status],
    );
    assert.deepEqual(runs, [["arena-signals", "skipped"]]);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test("signals.mjs: a failure of the batch itself still wins over a broken steelman", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-signals-break2-"));
  const url = pathToFileURL(path.join(dir, "main.db")).href;
  const db = createClient({ url });
  try {
    await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", "main")));
    const lines = [];
    const code = await signals(
      ["--date", "2026-10-13", "--replay", "--wait-minutes", "0"],
      { TURSO_MAIN_URL: url },
      {
        nowMs: () => NOW,
        out: (s) => lines.push(s),
        sleep: async () => {},
        openDb: (u) => createClient({ url: u, intMode: "bigint" }),
        loadEngine: (entry) =>
          entry === "src/lib/steelman/cli.ts" ? Promise.reject(new Error("x")) : loadEngine(entry),
      },
    );
    assert.notEqual(
      code,
      0,
      "a failed batch keeps its failing exit code whatever the steelman does",
    );
  } finally {
    db.close();
    cleanup(dir);
  }
});
