// OPS-104 / PLT-080 (D-958, D-963): the daily Turso usage sample. No network: fetch is a stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { describe, parsePlan, parseUsage, run, sample, store } from "./turso-sample.mjs";

const NOW = "2026-11-12T06:40:00.000Z";
const TOKEN = "TOKEN-SENTINEL-8f3a";
const ENV = { TURSO_PLATFORM_TOKEN_USAGE: TOKEN, TURSO_ORG: "praxis-org" };

const json = (status, body) => ({ status, json: async () => body });
const USAGE = {
  organization: {
    uuid: "u",
    usage: { rows_read: 1200, rows_written: 34, storage_bytes: 4096, databases: 2 },
    databases: [],
  },
};
const ORG = { organization: { name: "p", slug: "praxis-org", plan_id: "free" } };

function stubFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), init });
    const u = new URL(String(url));
    const hit = routes[u.pathname.endsWith("/usage") ? "usage" : "org"];
    if (hit instanceof Error) throw hit;
    return hit;
  };
  f.calls = calls;
  return f;
}

test("parseUsage: organization figures, else the sum over database instances, else null", () => {
  assert.deepEqual(parseUsage(USAGE), { rowsRead: 1200, rowsWritten: 34, storageBytes: 4096 });
  const summed = {
    organization: {
      databases: [
        { instances: [{ usage: { rows_read: 5, rows_written: 1, storage_bytes: 10 } }] },
        { instances: [{ usage: { rows_read: 7, rows_written: 2, storage_bytes: 20 } }] },
      ],
    },
  };
  assert.deepEqual(parseUsage(summed), { rowsRead: 12, rowsWritten: 3, storageBytes: 30 });
  for (const bad of [
    null,
    {},
    { organization: {} },
    { organization: { usage: { rows_read: "1" } } },
  ]) {
    assert.equal(parseUsage(bad), null);
  }
});

test("parsePlan accepts a plan id and nothing odd", () => {
  assert.equal(parsePlan(ORG), "free");
  assert.equal(parsePlan({ organization: { plan_id: "<script>" } }), null);
  assert.equal(parsePlan({}), null);
});

test("sample: a platform row when both calls answer; the token goes only to api.turso.tech", async () => {
  const f = stubFetch({ usage: json(200, USAGE), org: json(200, ORG) });
  const row = await sample(ENV, f, NOW);
  assert.deepEqual(row, {
    sampled_at: NOW,
    rows_read_month: 1200,
    rows_written_month: 34,
    storage_bytes: 4096,
    plan_name: "free",
    source: "platform",
    reason: "ok",
  });
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) {
    assert.match(c.url, /^https:\/\/api\.turso\.tech\/v1\/organizations\/praxis-org(\/usage)?$/);
    assert.equal(c.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(c.init.redirect, "error"); // a redirect is refused, the token never follows one
  }
});

test("sample: no token or no organization is 'unavailable' without any request", async () => {
  const f = stubFetch({});
  for (const env of [{}, { TURSO_ORG: "x" }, { TURSO_PLATFORM_TOKEN_USAGE: " " }]) {
    const row = await sample(env, f, NOW);
    assert.equal(row.source, "unavailable");
    assert.equal(row.rows_read_month, null);
  }
  assert.equal(
    (await sample({ TURSO_PLATFORM_TOKEN_USAGE: TOKEN }, f, NOW)).reason,
    "no_organization",
  );
  assert.equal(f.calls.length, 0);
});

test("sample: HTTP errors, a thrown fetch (a refused redirect) and odd shapes are 'unavailable'", async () => {
  for (const [routes, reason] of [
    [{ usage: json(401, {}), org: json(200, ORG) }, "usage_http_401"],
    [{ usage: json(429, {}), org: json(200, ORG) }, "usage_http_429"],
    [{ usage: new TypeError("redirect"), org: json(200, ORG) }, "usage_http_error"],
    [{ usage: json(200, { organization: {} }), org: json(200, ORG) }, "usage_shape"],
  ]) {
    const row = await sample(ENV, stubFetch(routes), NOW);
    assert.equal(row.source, "unavailable");
    assert.equal(row.reason, reason);
    assert.equal(row.rows_read_month, null);
    assert.equal(row.plan_name, "free"); // the plan is still recorded when it was read
  }
  // the plan call failing alone keeps the platform figures and leaves the plan unknown
  const row = await sample(ENV, stubFetch({ usage: json(200, USAGE), org: json(500, {}) }), NOW);
  assert.equal(row.source, "platform");
  assert.equal(row.plan_name, null);
});

test("the log line never carries the token, the organization or a URL", async () => {
  const lines = [];
  const dir = mkdtempSync(path.join(tmpdir(), "usage-"));
  const out = path.join(dir, "s.json");
  const f = stubFetch({ usage: json(200, USAGE), org: json(200, ORG) });
  assert.equal(
    await run(["sample", "--out", out], ENV, (l) => lines.push(l), {
      fetchImpl: f,
      now: () => new Date(NOW),
    }),
    0,
  );
  const saved = readFileSync(out, "utf8");
  for (const text of [...lines, saved]) {
    assert.ok(!text.includes(TOKEN), "token");
    assert.ok(!text.includes("praxis-org"), "organization");
    assert.ok(!text.includes("api.turso.tech"), "host");
  }
  assert.match(
    lines[0],
    /source=platform reason=ok plan=free reads=1200 writes=34 storage_bytes=4096/,
  );
});

test("sample without the secret exits 0 and writes an unavailable row (the build needs no Owner action)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "usage-"));
  const out = path.join(dir, "s.json");
  const lines = [];
  assert.equal(
    await run(["sample", "--out", out], {}, (l) => lines.push(l), { now: () => new Date(NOW) }),
    0,
  );
  const row = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(row.source, "unavailable");
  assert.equal(row.reason, "no_token");
  assert.match(describe(row), /source=unavailable reason=no_token plan=unknown reads=n\/a/);
});

test("store writes one usage_sample row to the database (unavailable rows carry no figures)", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE usage_sample (sampled_at TEXT PRIMARY KEY, rows_read_month INTEGER,
    rows_written_month INTEGER, storage_bytes INTEGER, plan_name TEXT, source TEXT NOT NULL)`);
  const dir = mkdtempSync(path.join(tmpdir(), "usage-"));
  const file = path.join(dir, "s.json");
  writeFileSync(
    file,
    JSON.stringify(
      await sample(ENV, stubFetch({ usage: json(200, USAGE), org: json(200, ORG) }), NOW),
    ),
  );
  const lines = [];
  const env = { TURSO_MAIN_URL: "libsql://x", TURSO_MAIN_TOKEN: "t" };
  const code = await run(["store", "--file", file], env, (l) => lines.push(l), {
    connect: async () => ({ execute: (q) => db.execute(q) }),
  });
  assert.equal(code, 0);
  const r = await db.execute("SELECT * FROM usage_sample");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].source, "platform");
  assert.equal(Number(r.rows[0].rows_read_month), 1200);
  assert.ok(lines.every((l) => !l.includes("libsql://")));
  // a bad file shape is refused before any connection is made
  writeFileSync(file, JSON.stringify({ source: "guess" }));
  assert.equal(
    await run(["store", "--file", file], env, () => {}, {
      connect: async () => assert.fail("no connect"),
    }),
    1,
  );
  // a store call without the file flag is a usage error
  assert.equal(await run(["store"], env, () => {}), 2);
  await store(db, {
    sampled_at: "2026-11-13",
    rows_read_month: null,
    rows_written_month: null,
    storage_bytes: null,
    plan_name: null,
    source: "unavailable",
  });
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM usage_sample")).rows[0].n, 2);
});
