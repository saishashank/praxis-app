// INFRA T4: the restore drill into scratch namespaces. Local libSQL files stand in for sqld
// namespaces (create/open/drop are injected); the real sqld run is the branch CI's job.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { runDrill } from "./restore-drill.mjs";
import { seededDb, tempDir } from "./testkit.mjs";

const t = tempDir();
after(() => t.cleanup());

/** A client stand-in whose close() is a no-op (the test keeps reading the database). */
const keepOpen = (db) => ({
  execute: (...a) => db.execute(...a),
  batch: (...a) => db.batch(...a),
  transaction: (...a) => db.transaction(...a),
  close() {},
});

function scratchKit() {
  const log = [];
  return {
    log,
    scratch: {
      create: async (ns) => log.push(`create ${ns}`),
      open: async (ns) => t.open(`${ns}.db`),
      drop: async (ns) => log.push(`drop ${ns}`),
    },
  };
}

test("synthetic drill: both databases restore into scratch namespaces, which are dropped", async () => {
  const k = scratchKit();
  const lines = [];
  const code = await runDrill(
    ["--source", "synthetic"],
    {},
    { out: (s) => lines.push(s), scratch: k.scratch },
  );
  assert.equal(code, 0, lines.join("\n"));
  assert.match(
    lines[0],
    /^restore-drill: PASS main\(from synthetic: tables=\d+ rows=\d+\) auth\(from synthetic: tables=\d+ rows=\d+\) foreign keys ON, no orphan rows, scratch dropped$/,
  );
  assert.equal(/MARKER|example\.test|Zo/.test(lines[0]), false);
  assert.equal(k.log.filter((l) => l.startsWith("create")).length, 2);
  assert.equal(k.log.filter((l) => l.startsWith("drop")).length, 2);
  assert.ok(k.log.every((l) => /drill-[0-9a-f]{8}-(main|auth)$/.test(l)));
});

test("live drill: dumps the live main namespace read-only; auth is skipped without a source", async () => {
  const src = await seededDb(t, "live-main.db", "main");
  const before = (await src.execute("SELECT COUNT(*) AS c FROM app_log")).rows[0].c;
  const k = scratchKit();
  const lines = [];
  const code = await runDrill(
    [],
    { TURSO_MAIN_URL: "http://main.sqld:8080", TURSO_MAIN_TOKEN: "x" },
    { out: (s) => lines.push(s), scratch: k.scratch, openSource: () => keepOpen(src) },
  );
  assert.equal(code, 0, lines.join("\n"));
  assert.match(lines[0], /main\(from live: tables=\d+ rows=\d+\) auth\(skipped: no source\)/);
  assert.equal((await src.execute("SELECT COUNT(*) AS c FROM app_log")).rows[0].c, before);
  assert.equal(k.log.filter((l) => l.startsWith("drop")).length, 1);
});

test("a scratch target that already holds data fails the drill, and the scratch is still dropped", async () => {
  const k = scratchKit();
  k.scratch.open = async (ns) =>
    seededDb(t, `dirty-${ns}.db`, ns.endsWith("main") ? "main" : "auth");
  const lines = [];
  const code = await runDrill(
    ["--source", "synthetic"],
    {},
    { out: (s) => lines.push(s), scratch: k.scratch },
  );
  assert.equal(code, 1);
  assert.match(
    lines[0],
    /^restore-drill: FAIL \(backup stream rejected: target database is not empty\)/,
  );
  assert.equal(
    k.log.some((l) => l.startsWith("drop")),
    true,
  );
});

test("usage and configuration errors", async () => {
  const lines = [];
  const out = (s) => lines.push(s);
  assert.equal(await runDrill(["--source", "nope"], {}, { out, scratch: scratchKit().scratch }), 1);
  assert.equal(await runDrill(["--wat"], {}, { out, scratch: scratchKit().scratch }), 1);
  assert.equal(await runDrill(["--source", "synthetic"], {}, { out }), 1); // no SQLD_URL / SQLD_ADMIN_URL
  assert.match(lines[2], /SQLD_URL and SQLD_ADMIN_URL are not set/);
  assert.equal(
    await runDrill(["--source", "backup"], {}, { out, scratch: scratchKit().scratch }),
    1,
  );
  assert.match(lines[3], /BACKUP_PRIVATE_KEY is not set/);
});
