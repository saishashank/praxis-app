// INFRA T7: scripts/selfhost/smoke.mjs (the pre-deploy smoke test) and scripts/selfhost/predeploy-copy.mjs
// (snapshot of prod / load into the check). Fake fetch and local libSQL files; no network.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main, runSmoke } from "./smoke.mjs";
import { run as copy } from "./predeploy-copy.mjs";
import { ciEnv } from "./predeploy-ci-env.mjs";
import { seededDb, tempDir } from "./testkit.mjs";

const COOKIE = "authjs.session-token=abc.def-1";
const res = (status, headers = {}, body = "") => new Response(body, { status, headers });

/** @param {Record<string, [number, Record<string, string>?]>} routes */
const fake =
  (routes, seen = []) =>
  async (url, init) => {
    const p = new URL(url).pathname;
    seen.push({ p, cookie: init?.headers?.Cookie });
    const r = routes[p] ?? [404];
    return res(r[0], r[1] ?? {}, "x");
  };
const GATE = { Location: "http://web:3000/signin?callbackUrl=%2F" };
const healthy = {
  "/api/health": [200],
  "/signin": [200, { "content-type": "text/html; charset=utf-8" }],
  "/": [307, GATE],
  "/picks": [307, GATE],
  "/market": [307, GATE],
};

test("anonymous: health, sign-in page and the sign-in gate on Home, Picks, Market", async () => {
  const r = await runSmoke("http://web:3000/", { fetchImpl: fake(healthy), healthWaitMs: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.checks.length, 5);
});

test("a broken web (health 500) fails the smoke test", async () => {
  const r = await runSmoke("http://web:3000", {
    fetchImpl: fake({ ...healthy, "/api/health": [500] }),
    healthWaitMs: 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.checks[0].ok, false);
  assert.match(r.checks[0].detail, /HTTP 500/);
});

test("a protected page that answers 200 to an anonymous visitor fails (the gate is open)", async () => {
  const r = await runSmoke("http://web:3000", {
    fetchImpl: fake({ ...healthy, "/picks": [200] }),
    healthWaitMs: 0,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.checks.filter((c) => !c.ok).map((c) => c.name),
    ["Picks (anonymous gate)"],
  );
});

test("a failing health check is retried until the wait runs out", async () => {
  let n = 0;
  const f = async (url) => {
    const p = new URL(url).pathname;
    if (p === "/api/health") return res(++n < 3 ? 503 : 200);
    return fake(healthy)(url);
  };
  const r = await runSmoke("http://web:3000", {
    fetchImpl: f,
    healthWaitMs: 60_000,
    sleepImpl: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(n, 3);
});

test("with a session cookie Home, Picks and Market must answer 200; the cookie shape is checked", async () => {
  const seen = [];
  const ok = await runSmoke("http://web:3000", {
    cookie: COOKIE,
    healthWaitMs: 0,
    fetchImpl: fake({ ...healthy, "/": [200], "/picks": [200], "/market": [200] }, seen),
  });
  assert.equal(ok.ok, true);
  assert.equal(seen.filter((s) => s.cookie === COOKIE).length, 3);
  const redirected = await runSmoke("http://web:3000", {
    cookie: COOKIE,
    healthWaitMs: 0,
    fetchImpl: fake(healthy),
  });
  assert.equal(
    redirected.ok,
    false,
    "a signed-in visitor sent to sign-in means the session was refused",
  );
  const bad = await runSmoke("http://web:3000", {
    cookie: "x=y",
    healthWaitMs: 0,
    fetchImpl: fake(healthy),
  });
  assert.equal(bad.ok, false);
});

test("main: a usage error is exit 2", async () => {
  const out = [];
  assert.equal(await main([], {}, (s) => out.push(s)), 2);
  assert.equal(await main(["not a url"], {}, (s) => out.push(s)), 2);
});

const t = tempDir();
after(() => t.cleanup());

test("predeploy-copy: dump a database to a folder, load it into an empty one, verified", async () => {
  const mainSrc = await seededDb(t, "src-main.db", "main");
  const authSrc = await seededDb(t, "src-auth.db", "auth");
  const snap = path.join(t.dir, "snap");
  const out = [];
  const dump = await copy(
    ["dump", "--out", snap],
    {},
    {
      out: (s) => out.push(s),
      open: (db) => (db === "main" ? mainSrc : authSrc),
    },
  );
  assert.equal(dump, 0, out.join("\n"));
  assert.ok(readFileSync(path.join(snap, "main.ndjson"), "utf8").startsWith("{"));

  const mainDst = t.open("dst-main.db");
  const authDst = t.open("dst-auth.db");
  const load = await copy(
    ["load", "--in", snap],
    {},
    {
      out: (s) => out.push(s),
      open: (db) => (db === "main" ? mainDst : authDst),
    },
  );
  assert.equal(load, 0, out.join("\n"));
  const a = await t.open("src-main.db").execute("SELECT count(*) AS n FROM schema_migrations");
  const b = await t.open("dst-main.db").execute("SELECT count(*) AS n FROM schema_migrations");
  assert.equal(Number(a.rows[0].n), Number(b.rows[0].n));
  assert.ok(out.some((l) => /load PASS/.test(l)));
  assert.ok(out.every((l) => !/http|token/i.test(l)));
});

test("predeploy-copy: loading into a non-empty database, a missing file and bad usage are refused", async () => {
  const snap = path.join(t.dir, "snap");
  const out = [];
  const nonEmpty = await seededDb(t, "busy-main.db", "main");
  const refused = await copy(
    ["load", "--in", snap],
    {},
    { out: (s) => out.push(s), open: () => nonEmpty },
  );
  assert.equal(refused, 1);
  writeFileSync(path.join(t.dir, "empty-marker"), "");
  assert.equal(
    await copy(
      ["load", "--in", path.join(t.dir, "nothing")],
      {},
      { out: (s) => out.push(s), open: () => nonEmpty },
    ),
    1,
  );
  assert.equal(await copy(["dump"], {}, { out: (s) => out.push(s) }), 1);
  assert.equal(await copy(["dump", "--in", "x"], {}, { out: (s) => out.push(s) }), 1);
  assert.ok(out.some((l) => /usage/.test(l)));
});

test("predeploy-ci-env: random per-run secrets, the check network's addresses, an empty sqld.env", () => {
  const a = ciEnv();
  const b = ciEnv();
  assert.match(a.web, /^AUTH_SECRET=[0-9a-f]{64}$/m);
  assert.notEqual(a.web.match(/^AUTH_SECRET=.*$/m)[0], b.web.match(/^AUTH_SECRET=.*$/m)[0]);
  assert.ok(a.jobs.split("\n").includes("SQLD_URL=http://sqld:8080"));
  assert.match(a.web, /^EMAIL_LIVE=0$/m);
  assert.equal(a.sqld, "");
});
