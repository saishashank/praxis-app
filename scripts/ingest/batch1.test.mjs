// M2 T6: the Batch 1 CLI against a local libSQL file and synthetic bars (no network, no real
// service, no secrets). Checks exit codes, step outputs, the request file and that nothing but
// counts and statuses is printed (SEC-110 b).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { run } from "./batch1.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = Date.parse("2026-10-13T06:30:00.000Z"); // 17:30 Sydney, Tuesday 13 Oct 2026
const URL_MARK = "libsql://praxis-secret-host.turso.io";
const TOKEN = "eyJ-SECRET-TOKEN-do-not-print";

function bars(dates, codes = ["ZZA", "ZZB"]) {
  return dates.flatMap((date) =>
    codes.map((code, i) => ({
      code,
      date,
      open: 10 + i,
      high: 11 + i,
      low: 9 + i,
      close: 10.5 + i,
      volume: 1000,
      adj_close: 10.5 + i,
      source: "yahoo",
      published_at: null,
      fetched_at: "2026-10-13T06:35:00.000Z",
    })),
  );
}

async function setup({ seed = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-b1-"));
  const url = pathToFileURL(path.join(dir, "main.db")).href;
  const db = createClient({ url });
  await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", "main")));
  if (seed) {
    await db.execute("UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_eod'");
    for (const code of ["ZZA", "ZZB"]) {
      await db.execute({
        sql: "INSERT INTO instrument (market, code, name, listed_on) VALUES ('AU', ?, 'Synthetic', '2020-01-01')",
        args: [code],
      });
    }
  }
  const lines = [];
  const deps = {
    openDb: (u) => createClient({ url: u }),
    nowMs: () => NOW,
    out: (s) => lines.push(s),
  };
  const env = {
    TURSO_MAIN_URL: url,
    TURSO_MAIN_TOKEN: "unused-for-file",
    COMMIT_SHA: "c".repeat(40),
  };
  const cleanup = () => {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows lock: temp folder holds synthetic data only
    }
  };
  return { db, dir, env, deps, lines, cleanup };
}

const count = async (db, sql) => Number((await db.execute(sql)).rows[0].c);

test("prepare writes request.json and the step outputs, and changes nothing", async () => {
  const s = await setup();
  try {
    const req = path.join(s.dir, "request.json");
    const gh = path.join(s.dir, "gh-output");
    writeFileSync(gh, "");
    const before = await count(s.db, "SELECT COUNT(*) AS c FROM run_record");
    const code = await run(["prepare", "--request", req], { ...s.env, GITHUB_OUTPUT: gh }, s.deps);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(readFileSync(req, "utf8")), {
      codes: ["ZZA", "ZZB"],
      start: "2026-10-12",
      end: "2026-10-13",
    });
    assert.equal(readFileSync(gh, "utf8"), "fetch=true\nchunk_size=100\nmin_gap_s=5\n");
    assert.equal(await count(s.db, "SELECT COUNT(*) AS c FROM run_record"), before);
    assert.equal(await count(s.db, "SELECT COUNT(*) AS c FROM price_bar"), 0);
    assert.match(s.lines.join("\n"), /fetch dates=1 codes=2 excluded=0/);
    assert.ok(!s.lines.join("\n").includes("ZZA"));
  } finally {
    s.cleanup();
  }
});

test("prepare with nothing to fetch reports fetch=false and does not write the request", async () => {
  const s = await setup({ seed: false }); // no universe, source not accepted
  try {
    const req = path.join(s.dir, "request.json");
    const gh = path.join(s.dir, "gh-output");
    writeFileSync(gh, "");
    assert.equal(
      await run(["prepare", "--request", req], { ...s.env, GITHUB_OUTPUT: gh }, s.deps),
      0,
    );
    assert.equal(readFileSync(gh, "utf8"), "fetch=false\n");
    assert.throws(() => readFileSync(req));
    assert.match(s.lines.join("\n"), /no fetch \(source_not_accepted\)/);
  } finally {
    s.cleanup();
  }
});

test("run ingests bars.json: exit 0, counts only, data and run record written", async () => {
  const s = await setup();
  try {
    const file = path.join(s.dir, "bars.json");
    writeFileSync(file, JSON.stringify(bars(["2026-10-12", "2026-10-13"])));
    const code = await run(["run", "--bars", file], s.env, s.deps);
    assert.equal(code, 0);
    assert.equal(await count(s.db, "SELECT COUNT(*) AS c FROM price_bar"), 2);
    const rr = (await s.db.execute("SELECT * FROM run_record")).rows[0];
    assert.equal(rr.status, "success");
    assert.equal(rr.commit_sha, "c".repeat(40));
    assert.equal(rr.concurrency_key, "batch1:AU:2026-10-13");
    const text = s.lines.join("\n");
    assert.match(
      text,
      /^ingest-batch1: ok target=2026-10-13 dates=1 read=\d+ written=5 bars=2 rejected=0 refetch=0$/m,
    );
    for (const secret of ["ZZA", "ZZB", "10.5", URL_MARK, TOKEN])
      assert.ok(!text.includes(secret), secret);
    // a second run is a no-op (PLT-076)
    s.lines.length = 0;
    assert.equal(await run(["run", "--bars", file], s.env, s.deps), 0);
    assert.match(s.lines.join("\n"), /skipped \(already_done\)/);
    assert.equal(await count(s.db, "SELECT COUNT(*) AS c FROM run_record"), 1);
  } finally {
    s.cleanup();
  }
});

test("run without a bars file fails visibly (exit 1) and records it", async () => {
  const s = await setup();
  try {
    const code = await run(["run", "--bars", path.join(s.dir, "missing.json")], s.env, s.deps);
    assert.equal(code, 1);
    const rr = (await s.db.execute("SELECT status, error_summary FROM run_record")).rows[0];
    assert.equal(rr.status, "failed");
    assert.equal(rr.error_summary, "validate: bars file missing");
    assert.equal(await count(s.db, "SELECT COUNT(*) AS c FROM completion_marker"), 0);
  } finally {
    s.cleanup();
  }
});

test("run with market mode off is skipped with exit 0", async () => {
  const s = await setup();
  try {
    await s.db.execute("UPDATE market SET mode = 'off' WHERE code = 'AU'");
    assert.equal(await run(["run"], s.env, s.deps), 0);
    assert.match(s.lines.join("\n"), /^ingest-batch1: skipped \(market_off\)/);
  } finally {
    s.cleanup();
  }
});

test("a non-trading day writes the marker without any bars file", async () => {
  const s = await setup();
  try {
    const sat = { ...s.deps, nowMs: () => Date.parse("2026-10-17T06:30:00.000Z") };
    assert.equal(await run(["run"], s.env, sat), 0);
    assert.match(s.lines.join("\n"), /2026-10-17 non_trading/);
    const m = (await s.db.execute("SELECT kind FROM completion_marker")).rows;
    assert.deepEqual(
      m.map((r) => r.kind),
      ["non-trading"],
    );
  } finally {
    s.cleanup();
  }
});

test("a rate-limited fetch leaves no bars file: the run fails and the output stays clean", async () => {
  const s = await setup();
  try {
    assert.equal(await run(["run", "--bars", path.join(s.dir, "bars.json")], s.env, s.deps), 1);
    assert.match(s.lines.join("\n"), /ingest-batch1: failed \(validate\)/);
  } finally {
    s.cleanup();
  }
});

test("bad usage and missing configuration fail with fixed messages", async () => {
  const lines = [];
  const out = (s) => lines.push(s);
  assert.equal(await run([], {}, { out }), 1);
  assert.equal(await run(["frobnicate"], {}, { out }), 1);
  assert.equal(await run(["run"], {}, { out }), 1);
  assert.equal(await run(["prepare"], { TURSO_MAIN_URL: URL_MARK }, { out }), 1); // no token, not a file URL
  assert.equal(await run(["prepare", "--request", "x"], { TURSO_MAIN_URL: "  " }, { out }), 1);
  assert.ok(lines.every((l) => l.startsWith("ingest-batch1")));
  assert.ok(!lines.join("\n").includes(URL_MARK));
});

test("prepare needs --request", async () => {
  const s = await setup();
  try {
    assert.equal(await run(["prepare"], s.env, s.deps), 1);
    assert.match(s.lines.join("\n"), /--request <file> is required/);
  } finally {
    s.cleanup();
  }
});

test("a database failure prints a fixed message, never the driver error, URL or token", async () => {
  const lines = [];
  const boom = () => {
    throw new Error(`cannot reach ${URL_MARK} with ${TOKEN}`);
  };
  const failingDb = {
    execute: async () => boom(),
    batch: async () => boom(),
    close: () => {},
  };
  const env = { TURSO_MAIN_URL: URL_MARK, TURSO_MAIN_TOKEN: TOKEN };
  const out = (s) => lines.push(s);
  assert.equal(await run(["run"], env, { out, nowMs: () => NOW, openDb: () => failingDb }), 1);
  assert.equal(
    await run(["prepare", "--request", "r.json"], env, {
      out,
      nowMs: () => NOW,
      openDb: () => failingDb,
    }),
    1,
  );
  assert.equal(await run(["run"], env, { out, openDb: boom }), 1);
  const text = lines.join("\n");
  assert.match(text, /unexpected error/);
  assert.match(text, /cannot open database/);
  assert.ok(!text.includes(URL_MARK) && !text.includes(TOKEN));
});
