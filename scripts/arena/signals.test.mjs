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

test("signals.mjs: --market IN under the seed is refused, exit 2, no run record (MKT-110 a)", async () => {
  const { dir, url, db } = await freshDb();
  try {
    const lines = [];
    const code = await signals(
      ["--date", "2026-10-13", "--market", "IN"],
      { TURSO_MAIN_URL: url, TURSO_MAIN_TOKEN: "secret-token-do-not-print" },
      { nowMs: () => NOW, out: (s) => lines.push(s) },
    );
    assert.equal(code, 2);
    assert.equal(lines[0], "arena-2b: refused: market not enabled");
    assert.doesNotMatch(lines.join("\n"), /secret|file:/);
    const runs = await db.execute("SELECT COUNT(*) AS n FROM run_record");
    assert.equal(Number(runs.rows[0].n), 0);
  } finally {
    db.close();
    cleanup(dir);
  }
});

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

test("signals.mjs: --phase learn and --phase words on a data_only database record a skip each (M6 T11)", async () => {
  const { dir, url, db } = await freshDb();
  try {
    const lines = [];
    const env = { TURSO_MAIN_URL: url, TURSO_MAIN_TOKEN: "secret-token-do-not-print" };
    const deps = { nowMs: () => NOW, out: (s) => lines.push(s) };
    assert.equal(await signals(["--date", "2026-10-13", "--phase", "learn"], env, deps), 0);
    assert.equal(await signals(["--date", "2026-10-13", "--phase", "words"], env, deps), 0);
    assert.match(lines[0], /^arena-learn AU 2026-10-13: skipped \(data_only_guard\)/);
    assert.match(lines[1], /^arena-words AU 2026-10-13: skipped \(data_only_guard\)/);
    assert.doesNotMatch(lines.join("\n"), /secret|file:/);
    const rs = await db.execute("SELECT job, status FROM run_record ORDER BY id");
    assert.deepEqual(
      rs.rows.map((r) => [r.job, r.status]),
      [
        ["arena-learn", "skipped"],
        ["arena-words", "skipped"],
      ],
    );
    assert.equal(await signals(["--phase", "reports"], env, deps), 2);
  } finally {
    db.close();
    cleanup(dir);
  }
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

// M18 OPS-106 (D-666, D-953): a live 2b without a 2a is a skip until 18:40 market time (the Worker clock
// re-dispatches it once 2a has closed) and a degraded `late_2a` night after it.
async function liveNo2a(nowIso) {
  const { dir, url, db } = await freshDb();
  try {
    await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
    const lines = [];
    const code = await signals(
      ["--date", "2026-10-13", "--wait-minutes", "0"],
      { TURSO_MAIN_URL: url },
      {
        nowMs: () => Date.parse(nowIso),
        out: (s) => lines.push(s),
        sleep: async () => {},
        openDb: (u) => createClient({ url: u, intMode: "bigint" }),
      },
    );
    const rs = await db.execute(
      // 2b and batch 3 only (the learn and words phases run beside them, as before)
      "SELECT job, status, details_json FROM run_record WHERE job IN ('arena-signals', 'arena-review') ORDER BY id",
    );
    return { code, lines, rows: rs.rows };
  } finally {
    db.close();
    cleanup(dir);
  }
}

test("signals.mjs: 18:30 with no 2a success is still a skip (the clock may re-dispatch), exit 1", async () => {
  const r = await liveNo2a("2026-10-13T07:30:00.000Z"); // 18:30 AEDT
  assert.equal(r.code, 1);
  assert.match(r.lines.join("\n"), /arena-2b AU 2026-10-13: skipped \(no_2a_success\)/);
  assert.deepEqual(
    r.rows.map((x) => [x.job, x.status, JSON.parse(String(x.details_json)).reason]),
    [["arena-signals", "skipped", "no_2a_success"]],
  );
});

test("signals.mjs: 18:40 sharp is still a skip; 18:41 with no 2a success is degraded late_2a, exit 1, no review", async () => {
  const edge = await liveNo2a("2026-10-13T07:40:00.000Z"); // 18:40 AEDT
  assert.match(edge.lines.join("\n"), /skipped \(no_2a_success\)/);
  assert.equal(edge.rows[0].status, "skipped");

  const r = await liveNo2a("2026-10-13T07:41:00.000Z"); // 18:41 AEDT
  assert.equal(r.code, 1);
  assert.match(r.lines.join("\n"), /arena-2b AU 2026-10-13: degraded \(late_2a\)/);
  assert.deepEqual(
    r.rows.map((x) => [x.job, x.status, JSON.parse(String(x.details_json)).reason]),
    [["arena-signals", "degraded", "late_2a"]], // batch 3 did not run on a night 2b decided nothing
  );
  assert.doesNotMatch(r.lines.join("\n"), /arena-3/);
});
