// D-199: `run.mjs --mode seed-recent` downloads the history files, seeds the database and prints one
// status line with counts only; it never runs the replay and never prints a secret or an error message.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { gzipDeterministic, toJsonl } from "../../src/lib/data/backfill/rules.mjs";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { run } from "./run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENV = {
  DATA_REPO: "o/r-data",
  DATA_REPO_TOKEN: "secret-token",
  TURSO_MAIN_URL: "file:unused",
};
const NOW = Date.parse("2026-10-13T06:30:00.000Z");

test("seeds from the downloaded month files and prints counts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "seed-run-"));
  const db = createClient({ url: `file:${path.join(dir, "main.db")}` });
  try {
    await migrateUp(db, await loadMigrations(path.join(ROOT, "db", "migrations", "main")));
    const lines = [];
    const code = await run(["--mode", "seed-recent"], ENV, {
      out: (s) => lines.push(s),
      nowMs: () => NOW,
      openDb: () => db,
      downloadHistory: async ({ dir: hist }) => {
        mkdirSync(hist, { recursive: true });
        const rows = [{ code: "ZZA", d: "2026-09-30", o: 1, h: 1, l: 1, c: 1, volume: 10 }];
        writeFileSync(
          path.join(hist, "yahoo_prices-2026-09.jsonl.gz"),
          gzipDeterministic(toJsonl(rows)),
        );
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(lines, [
      "seed-recent: ok sessions=1 rows=1 written=1 from=2026-09-30 to=2026-09-30",
    ]);
  } finally {
    // the run closed the client; Windows can keep the file locked, so cleanup is best effort
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a temp folder left behind on Windows only */
    }
  }
});

test("needs the database and the data repo, and reports a failure by name only", async () => {
  const lines = [];
  assert.equal(await run(["--mode", "seed-recent"], {}, { out: (s) => lines.push(s) }), 1);
  const code = await run(["--mode", "seed-recent"], ENV, {
    out: (s) => lines.push(s),
    openDb: () => createClient({ url: "file::memory:" }),
    downloadHistory: async () => {
      throw new TypeError("https://secret.example failed");
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, [
    "seed-recent: failed (not configured)",
    "seed-recent: failed (TypeError)",
  ]);
});
