// M2 T9: the backfill CLIs against a local libSQL file, synthetic ASIC files and a fake data repo
// (no network, no real service, no secrets). Checks exit codes, step outputs, the files written,
// resume behaviour, and that only counts and statuses are printed (SEC-110 b).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { fromJsonlGz } from "../../src/lib/data/backfill/rules.mjs";
import { run } from "./run.mjs";
import { DEFAULT_USER_AGENT, run as fetchRun } from "./fetch-asic.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = Date.parse("2026-10-13T06:30:00.000Z"); // 17:30 Sydney, Tuesday 13 Oct 2026
const URL_MARK = "libsql://praxis-secret-host.turso.io";
const TOKEN = "eyJ-SECRET-TOKEN-do-not-print";
const GH_TOKEN = "ghp_SYNTHETIC-DATA-REPO-TOKEN";
const REPO = "synthetic-owner/praxis-app-data";
const HEAD =
  "Product,Product Code,Reported Short Positions,Total Product in Issue,% of Total Product in Issue Reported as Short Positions";
const CSV = [HEAD, "Synthetic ZZA Ltd,ZZA,1000,100000,1.00"].join("\r\n");

// Windows may keep a lock briefly; the temp folder holds synthetic data only.
function cleanDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // ignore
  }
}

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-bf-"));
  const db = createClient({ url: pathToFileURL(path.join(dir, "main.db")).href });
  await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", "main")));
  return { dir, db };
}

/** A fake of the two GitHub hosts: records uploads, optionally pre-seeded with assets. */
function fakeGithub(assets = {}) {
  const uploads = [];
  const hosts = new Set();
  const released = new Map(Object.entries(assets));
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    hosts.add(u.hostname);
    const m = /\/releases\/tags\/([^/]+)$/.exec(u.pathname);
    if (m && init.method === "GET") {
      const tag = decodeURIComponent(m[1]);
      if (!released.has(tag)) return new Response("{}", { status: 404 });
      return Response.json({ id: 1, tag_name: tag, assets: released.get(tag) });
    }
    if (u.pathname.endsWith("/releases") && init.method === "POST") {
      const body = JSON.parse(init.body);
      released.set(body.tag_name, []);
      return Response.json({ id: 1 }, { status: 201 });
    }
    if (u.pathname.endsWith("/assets") && init.method === "POST") {
      uploads.push({ name: u.searchParams.get("name"), bytes: new Uint8Array(init.body) });
      return Response.json({}, { status: 201 });
    }
    return new Response("{}", { status: 500 });
  };
  return { fetchImpl, uploads, hosts };
}

const envFor = (dir, extra = {}) => ({
  TURSO_MAIN_URL: pathToFileURL(path.join(dir, "main.db")).href,
  TURSO_MAIN_TOKEN: TOKEN,
  DATA_REPO: REPO,
  DATA_REPO_TOKEN: GH_TOKEN,
  ...extra,
});

function collect() {
  const lines = [];
  return { lines, out: (s) => lines.push(s) };
}

const noLeak = (lines) => {
  const text = lines.join("\n");
  for (const bad of [TOKEN, GH_TOKEN, URL_MARK, "github.com", "https://", "ZZA", "main.db"]) {
    assert.ok(!text.includes(bad), `output leaked ${bad}`);
  }
};

const chunk = (month, rows, complete = true) => ({
  month,
  complete,
  dates: 1,
  absent: 0,
  skipped: 0,
  rows,
});
const row = (asOf) => ({
  as_of: asOf,
  published_at: "2026-10-07T23:59:59.000Z",
  assumed_time: true,
  code: "ZZA",
  product: "p",
  short_positions: 1,
  total_in_issue: 10,
  pct_short: 10,
  source: "asic_short",
});

test("plan: writes plan.json, reports fetch=true, prints counts only", async () => {
  const { dir, db } = await setup();
  const c = collect();
  const outFile = path.join(dir, "out.txt");
  writeFileSync(outFile, "");
  const code = await run(
    ["plan", "--out", path.join(dir, "plan.json")],
    { ...envFor(dir), GITHUB_OUTPUT: outFile },
    { nowMs: () => NOW, out: c.out },
  );
  assert.equal(code, 0);
  assert.equal(readFileSync(outFile, "utf8"), "fetch=true\n");
  const plan = JSON.parse(readFileSync(path.join(dir, "plan.json"), "utf8"));
  assert.deepEqual(
    plan.months.map((m) => m.month),
    ["2026-09", "2026-08", "2026-07"],
  );
  assert.match(c.lines[0], /^backfill plan: fetch months=3 dates=\d+$/);
  noLeak(c.lines);
  db.close();
  cleanDir(dir);
});

test("plan: source off or cap reached means fetch=false and exit 0", async () => {
  const { dir, db } = await setup();
  await db.execute("UPDATE source_status SET mode = 'off' WHERE source = 'asic_short'");
  const c = collect();
  assert.equal(
    await run(["plan", "--out", path.join(dir, "p.json")], envFor(dir), {
      nowMs: () => NOW,
      out: c.out,
    }),
    0,
  );
  assert.deepEqual(c.lines, ["backfill plan: no fetch (source_off)"]);
  db.close();
  cleanDir(dir);
});

test("commit: writes the ASIC month file, moves the cursor, second run is a no-op", async () => {
  const { dir, db } = await setup();
  const chunks = path.join(dir, "chunks.json");
  writeFileSync(
    chunks,
    JSON.stringify({ stopped: null, months: [chunk("2026-09", [row("2026-09-30")])] }),
  );
  const gh = fakeGithub();
  const c = collect();
  const go = () =>
    run(
      ["commit", "--chunks", chunks],
      { ...envFor(dir), COMMIT_SHA: "a".repeat(40) },
      {
        nowMs: () => NOW,
        out: c.out,
        fetchImpl: gh.fetchImpl,
      },
    );
  assert.equal(await go(), 0);
  assert.equal(gh.uploads.length, 1);
  assert.equal(gh.uploads[0].name, "asic_short_interest-2026-09.jsonl.gz");
  assert.equal(fromJsonlGz(gh.uploads[0].bytes)[0].code, "ZZA");
  assert.deepEqual([...gh.hosts].sort(), ["api.github.com", "uploads.github.com"]);
  const job = (await db.execute("SELECT * FROM backfill_job WHERE name = 'asic_short_interest'"))
    .rows[0];
  assert.equal(job.next_date, "2026-08-31");

  // a re-run of the same chunks: already done, nothing uploaded, still exit 0
  assert.equal(await go(), 0);
  assert.equal(gh.uploads.length, 1);
  assert.ok(c.lines.some((l) => /asic 2026-09 already_done/.test(l)));
  assert.ok(c.lines.some((l) => /asx export uploaded=0 skipped=0 conflicts=0/.test(l)));
  noLeak(c.lines);
  db.close();
  cleanDir(dir);
});

test("commit: incomplete months are ignored; several months are committed newest first", async () => {
  const { dir, db } = await setup();
  const chunks = path.join(dir, "chunks.json");
  writeFileSync(
    chunks,
    JSON.stringify({
      stopped: null,
      months: [
        chunk("2026-08", [row("2026-08-31")]),
        chunk("2026-09", [row("2026-09-30")]),
        chunk("2026-07", [row("2026-07-31")], false),
      ],
    }),
  );
  const gh = fakeGithub();
  const c = collect();
  assert.equal(
    await run(["commit", "--chunks", chunks], envFor(dir), {
      nowMs: () => NOW,
      out: c.out,
      fetchImpl: gh.fetchImpl,
    }),
    0,
  );
  assert.deepEqual(
    gh.uploads.map((u) => u.name),
    ["asic_short_interest-2026-09.jsonl.gz", "asic_short_interest-2026-08.jsonl.gz"],
  );
  db.close();
  cleanDir(dir);
});

test("commit: a fetch that stopped keeps the finished months but fails the step", async () => {
  const { dir, db } = await setup();
  const chunks = path.join(dir, "chunks.json");
  writeFileSync(
    chunks,
    JSON.stringify({ stopped: "rate_limited", months: [chunk("2026-09", [row("2026-09-30")])] }),
  );
  const gh = fakeGithub();
  const c = collect();
  assert.equal(
    await run(["commit", "--chunks", chunks], envFor(dir), {
      nowMs: () => NOW,
      out: c.out,
      fetchImpl: gh.fetchImpl,
    }),
    1,
  );
  assert.equal(gh.uploads.length, 1);
  assert.ok(c.lines.some((l) => /fetch had stopped \(rate_limited\)/.test(l)));
  db.close();
  cleanDir(dir);
});

test("commit: a different file already in the data repo fails the step and is not replaced", async () => {
  const { dir, db } = await setup();
  const chunks = path.join(dir, "chunks.json");
  writeFileSync(
    chunks,
    JSON.stringify({ stopped: null, months: [chunk("2026-09", [row("2026-09-30")])] }),
  );
  const gh = fakeGithub({
    "history-asic_short_interest-2026": [
      {
        name: "asic_short_interest-2026-09.jsonl.gz",
        size: 3,
        digest: "sha256:" + "0".repeat(64),
        state: "uploaded",
      },
    ],
  });
  const c = collect();
  assert.equal(
    await run(["commit", "--chunks", chunks], envFor(dir), {
      nowMs: () => NOW,
      out: c.out,
      fetchImpl: gh.fetchImpl,
    }),
    1,
  );
  assert.equal(gh.uploads.length, 0);
  assert.ok(c.lines.some((l) => /asic 2026-09 conflict/.test(l)));
  noLeak(c.lines);
  db.close();
  cleanDir(dir);
});

test("commit: without a chunks file only the announcement export runs", async () => {
  const { dir, db } = await setup();
  const gh = fakeGithub();
  const c = collect();
  assert.equal(
    await run(["commit"], envFor(dir), { nowMs: () => NOW, out: c.out, fetchImpl: gh.fetchImpl }),
    0,
  );
  assert.equal(gh.uploads.length, 0);
  assert.ok(c.lines.some((l) => /asx export .*stopped=no_job/.test(l)));
  // a missing or unreadable chunks file is the same
  assert.equal(
    await run(["commit", "--chunks", path.join(dir, "missing.json")], envFor(dir), {
      nowMs: () => NOW,
      out: c.out,
      fetchImpl: gh.fetchImpl,
    }),
    0,
  );
  db.close();
  cleanDir(dir);
});

test("commit: the write cap pauses the job, uploads nothing and still exits 0", async () => {
  const { dir, db } = await setup();
  await db.execute(
    "INSERT INTO run_record (job, market, concurrency_key, started_at, status, rows_written) VALUES ('ingest-batch1','AU','k','2026-10-13T00:00:00.000Z','success',2000000)",
  );
  const chunks = path.join(dir, "chunks.json");
  writeFileSync(
    chunks,
    JSON.stringify({ stopped: null, months: [chunk("2026-09", [row("2026-09-30")])] }),
  );
  const gh = fakeGithub();
  const c = collect();
  assert.equal(
    await run(["commit", "--chunks", chunks], envFor(dir), {
      nowMs: () => NOW,
      out: c.out,
      fetchImpl: gh.fetchImpl,
    }),
    0,
  );
  assert.equal(gh.uploads.length, 0);
  assert.ok(c.lines.some((l) => /asic 2026-09 paused_cap/.test(l)));
  const st = (
    await db.execute(
      "SELECT cursor_json FROM ingest_cursor WHERE job = 'backfill:asic_short_interest'",
    )
  ).rows[0];
  assert.equal(JSON.parse(st.cursor_json).status, "paused_cap");
  db.close();
  cleanDir(dir);
});

test("configuration and usage errors fail without printing a secret", async () => {
  const { dir, db } = await setup();
  const c = collect();
  const base = envFor(dir);
  assert.equal(await run([], base, { out: c.out }), 1);
  assert.equal(await run(["nope"], base, { out: c.out }), 1);
  assert.equal(
    await run(["plan", "--out", "x"], { ...base, TURSO_MAIN_URL: "" }, { out: c.out }),
    1,
  );
  assert.equal(
    await run(
      ["plan", "--out", "x"],
      { ...base, TURSO_MAIN_URL: "libsql://h", TURSO_MAIN_TOKEN: "" },
      { out: c.out },
    ),
    1,
  );
  assert.equal(await run(["plan"], base, { out: c.out, nowMs: () => NOW }), 1); // no --out
  assert.equal(
    await run(["commit"], { ...base, DATA_REPO: "owner/praxis-app" }, { out: c.out }),
    1,
  );
  assert.equal(await run(["commit"], { ...base, DATA_REPO_TOKEN: "" }, { out: c.out }), 1);
  assert.equal(
    await run(["plan", "--out", "x"], base, {
      out: c.out,
      openDb: () => {
        throw new Error(`cannot open ${URL_MARK} ${TOKEN}`);
      },
    }),
    1,
  );
  // a driver error is never printed
  assert.equal(
    await run(["plan", "--out", path.join(dir, "p.json")], base, {
      out: c.out,
      nowMs: () => NOW,
      openDb: () => ({
        execute: async () => {
          throw new Error(`boom ${URL_MARK} ${TOKEN}`);
        },
        batch: async () => {
          throw new Error(`boom ${URL_MARK} ${TOKEN}`);
        },
        close: () => {},
      }),
    }),
    1,
  );
  noLeak(c.lines);
  assert.ok(c.lines.every((l) => /^backfill/.test(l)));
  db.close();
  cleanDir(dir);
});

// ---- fetch-asic CLI ----------------------------------------------------------------------------

test("fetch-asic: writes chunks.json from the plan, prints counts only, exit 0", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-bf-"));
  writeFileSync(
    path.join(dir, "plan.json"),
    JSON.stringify({ months: [{ month: "2026-09", dates: ["2026-09-29", "2026-09-30"] }] }),
  );
  const seen = [];
  const c = collect();
  const code = await fetchRun(
    ["--plan", path.join(dir, "plan.json"), "--output", path.join(dir, "chunks.json")],
    { TURSO_MAIN_TOKEN: TOKEN },
    {
      out: c.out,
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        seen.push(init.headers["User-Agent"]);
        return new Response(CSV, { status: 200, headers: { "content-type": "text/csv" } });
      },
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(seen, [DEFAULT_USER_AGENT, DEFAULT_USER_AGENT]);
  const out = JSON.parse(readFileSync(path.join(dir, "chunks.json"), "utf8"));
  assert.equal(out.stopped, null);
  assert.equal(out.months[0].rows.length, 2);
  assert.deepEqual(c.lines, ["backfill fetch: ok months=1/1 rows=2"]);
  cleanDir(dir);
});

test("fetch-asic: a custom identifying User-Agent is used; a stop exits 1 but still writes the file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-bf-"));
  writeFileSync(
    path.join(dir, "plan.json"),
    JSON.stringify({ months: [{ month: "2026-09", dates: ["2026-09-30"] }] }),
  );
  const seen = [];
  const c = collect();
  const code = await fetchRun(
    ["--plan", path.join(dir, "plan.json"), "--output", path.join(dir, "chunks.json")],
    { BACKFILL_USER_AGENT: "my-research-client" },
    {
      out: c.out,
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        seen.push(init.headers["User-Agent"]);
        return new Response("", { status: 429 });
      },
    },
  );
  assert.equal(code, 1);
  assert.deepEqual(seen, ["my-research-client"]);
  assert.equal(
    JSON.parse(readFileSync(path.join(dir, "chunks.json"), "utf8")).stopped,
    "rate_limited",
  );
  assert.deepEqual(c.lines, ["backfill fetch: stopped (rate_limited) months=0/1 rows=0"]);
  cleanDir(dir);
});

test("fetch-asic: usage errors and a bad plan never reach the network", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-bf-"));
  const c = collect();
  const fetchImpl = async () => {
    throw new Error("network must not be used");
  };
  assert.equal(await fetchRun([], {}, { out: c.out, fetchImpl }), 1);
  const bad = [
    "not json",
    JSON.stringify({}),
    JSON.stringify({ months: [{ month: "2026-9", dates: [] }] }),
    JSON.stringify({ months: [{ month: "2026-09", dates: ["2026-08-31"] }] }), // wrong month
    JSON.stringify({ months: [{ month: "2026-09", dates: ["2026-09-31"] }] }), // not a date
    JSON.stringify({ months: Array.from({ length: 13 }, () => ({ month: "2026-09", dates: [] })) }),
  ];
  for (const plan of bad) {
    writeFileSync(path.join(dir, "plan.json"), plan);
    assert.equal(
      await fetchRun(
        ["--plan", path.join(dir, "plan.json"), "--output", path.join(dir, "o.json")],
        {},
        { out: c.out, fetchImpl },
      ),
      1,
    );
  }
  assert.equal(
    await fetchRun(
      ["--plan", path.join(dir, "missing.json"), "--output", path.join(dir, "o.json")],
      {},
      { out: c.out, fetchImpl },
    ),
    1,
  );
  assert.ok(c.lines.every((l) => l.startsWith("backfill fetch: failed")));
  cleanDir(dir);
});
