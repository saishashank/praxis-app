// DAT-251 a (D-972): the store step keeps code_history. A code with `not_found` on 3 consecutive history
// runs becomes `delisted` and leaves the fetch list; it returns only after being missing from the ASX
// file and then present again. Real migrated file database, no network, counts only in the log.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { run as ingest } from "./ingest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// best effort: Windows may still hold the database file for a moment
const cleanup = (d) => {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    // left in the OS temp folder
  }
};
const csv = (codes) =>
  `ASX listed companies\n\nCompany name,ASX code,GICS industry group\n${codes
    .map((c) => `"CO ${c}","${c}","Materials"`)
    .join("\n")}\n`;

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-asx-ingest-"));
  const url = pathToFileURL(path.join(dir, "main.db")).href;
  const db = createClient({ url });
  await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", "main")));
  const lines = [];
  const step = async (n, status, file) => {
    const d = path.join(dir, `run${n}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "fetch-status.json"), JSON.stringify(status));
    if (file) writeFileSync(path.join(d, "companies.csv"), file);
    const code = await ingest(["--dir", d], { TURSO_MAIN_URL: url }, {
      out: (s) => lines.push(s),
      nowMs: () => Date.parse(`2026-11-0${n}T01:00:00Z`),
    });
    return code;
  };
  const history = async () =>
    (
      await db.execute(
        "SELECT code, event, runs, closed_d, absent FROM code_history ORDER BY code, event",
      )
    ).rows.map((r) => ({ ...r }));
  return { dir, url, db, lines, step, history };
}
const status = (notFound, over = {}) => ({
  companiesCause: "ok",
  causes: {},
  notFound,
  attempted: ["ZZA", "ZZB"],
  historyRan: true,
  fallback: "off",
  ...over,
});

test("three consecutive not_found runs delist a code; one answer in between resets the count", async () => {
  const t = await setup();
  try {
    await t.step(1, status(["ZZA"]));
    await t.step(2, status(["ZZA"]));
    assert.deepEqual(
      (await t.history()).map((r) => [r.code, r.event, Number(r.runs)]),
      [["ZZA", "not_found", 2]],
    );
    await t.step(3, status(["ZZA"]));
    const h = await t.history();
    assert.deepEqual(h.map((r) => [r.code, r.event]), [
      ["ZZA", "delisted"],
      ["ZZA", "not_found"],
    ]);
    // a different code: not_found, answer, not_found -> counter restarts
    await t.step(4, status(["ZZB"]));
    await t.step(5, status([]));
    await t.step(6, status(["ZZB"]));
    const b = (await t.history()).filter((r) => r.code === "ZZB" && r.closed_d === null);
    assert.equal(b.length, 1);
    assert.equal(Number(b[0].runs), 1);
    assert.ok(!t.lines.join("\n").includes("file:"), "no URL in the log");
  } finally {
    t.db.close();
    cleanup(t.dir);
  }
});

test("--write-state lists the open delisted codes; a code listed by ASX is skipped, not reappeared", async () => {
  const t = await setup();
  try {
    for (const n of [1, 2, 3]) await t.step(n, status(["ZZA"]), csv(["ZZA", "ZZB"]));
    const out = path.join(t.dir, "state.json");
    assert.equal(await ingest(["--write-state", out], { TURSO_MAIN_URL: t.url }, { out: () => {} }), 0);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).delisted, ["ZZA"]);
    // still listed in the ASX file: stays delisted (skipped from the history fetch), never "reappeared"
    await t.step(4, status([], { historyRan: false }), csv(["ZZA", "ZZB"]));
    assert.equal((await t.history()).find((r) => r.event === "delisted").closed_d, null);
  } finally {
    t.db.close();
    cleanup(t.dir);
  }
});

test("a delisted code that left the ASX file and comes back closes its row", async () => {
  const t = await setup();
  try {
    for (const n of [1, 2, 3]) await t.step(n, status(["ZZA"]), csv(["ZZA", "ZZB"]));
    await t.step(4, status([], { historyRan: false }), csv(["ZZB"])); // missing now
    let d = (await t.history()).find((r) => r.event === "delisted");
    assert.equal(Number(d.absent), 1);
    assert.equal(d.closed_d, null);
    await t.step(5, status([], { historyRan: false }), csv(["ZZA", "ZZB"])); // back
    d = (await t.history()).find((r) => r.event === "delisted");
    assert.notEqual(d.closed_d, null);
    const out = path.join(t.dir, "state.json");
    await ingest(["--write-state", out], { TURSO_MAIN_URL: t.url }, { out: () => {} });
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).delisted, []);
  } finally {
    t.db.close();
    cleanup(t.dir);
  }
});

test("source_fetch_status counts consecutive list failures and a good run resets it", async () => {
  const t = await setup();
  try {
    for (const n of [1, 2, 3])
      await t.step(n, status([], { companiesCause: "server_error", historyRan: false }));
    const n = async () =>
      Number(
        (await t.db.execute("SELECT consecutive_failures AS n FROM source_fetch_status")).rows[0].n,
      );
    assert.equal(await n(), 3);
    await t.step(4, status([], { historyRan: false }), csv(["ZZA"]));
    assert.equal(await n(), 0);
  } finally {
    t.db.close();
    cleanup(t.dir);
  }
});
