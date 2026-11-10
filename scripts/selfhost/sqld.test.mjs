// INFRA T4: sqld helpers. A local `file:` libSQL database stands in for sqld (same driver, same
// `PRAGMA foreign_keys` semantics); when SQLD_TEST_URL is set (branch CI with a real sqld
// container) the same foreign-key check also runs against it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { dumpDatabase } from "../backup/core.mjs";
import {
  assertForeignKeys,
  connectionCheck,
  dropNamespace,
  ensureNamespace,
  foreignKeysEnabled,
  hostFetch,
  namespaceTarget,
  openNamespace,
  restoreVerified,
  SqldError,
  wipeDatabase,
} from "./sqld.mjs";
import { seededDb, tempDir } from "./testkit.mjs";

const t = tempDir();
after(() => t.cleanup());
const NOW = "2026-01-02T03:04:05.678Z";

test("namespaceTarget: subdomain mode, host mode, and bad input", () => {
  assert.deepEqual(namespaceTarget("http://sqld:8080", "main"), {
    url: "http://main.sqld:8080",
    host: null,
  });
  assert.deepEqual(namespaceTarget("http://sqld:8080/", "drill-ab12-auth", "host"), {
    url: "http://sqld:8080",
    host: "drill-ab12-auth.sqld",
  });
  assert.throws(() => namespaceTarget("http://sqld:8080", "Bad Name"), /bad namespace/);
  assert.throws(() => namespaceTarget("http://sqld:8080", "../x"), /bad namespace/);
  assert.throws(() => namespaceTarget("ftp://sqld", "main"), /http\(s\)/);
  assert.throws(() => namespaceTarget("not a url", "main"), /bad base URL/);
});

test("hostFetch forces the Host header on the request it forwards", async () => {
  let seen;
  const f = hostFetch("drill-1.sqld", async (req, host) => {
    seen = { req, host };
    return { status: 200 };
  });
  await f("http://sqld:8080/v2/pipeline", { method: "POST", body: "{}" });
  assert.equal(seen.host, "drill-1.sqld");
  assert.equal(seen.req.url, "http://sqld:8080/v2/pipeline");
});

test("nodeHttpFetch really sends the Host header (global fetch would drop it) and returns a Response", async () => {
  const { createServer } = await import("node:http");
  const seen = [];
  const srv = createServer((q, r) => {
    let b = "";
    q.on("data", (c) => (b += c));
    q.on("end", () => {
      seen.push({ host: q.headers.host, method: q.method, url: q.url, body: b });
      r.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    });
  });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  try {
    const port = srv.address().port;
    const f = hostFetch("scratch-ns.sqld");
    const res = await f(`http://127.0.0.1:${port}/v2/pipeline?x=1`, {
      method: "POST",
      body: '{"a":1}',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(seen[0], {
      host: "scratch-ns.sqld",
      method: "POST",
      url: "/v2/pipeline?x=1",
      body: '{"a":1}',
    });
  } finally {
    srv.close();
  }
});

test("openNamespace builds a client without touching the network", async () => {
  const c = openNamespace({ base: "http://sqld:8080", ns: "main", mode: "host" });
  assert.equal(typeof c.execute, "function");
  c.close();
});

test("ensureNamespace / dropNamespace: statuses and fixed error text", async () => {
  const calls = [];
  const mk = (status) => async (url, init) => {
    calls.push([init.method, new URL(url).pathname, init.headers.Authorization]);
    return { status };
  };
  assert.equal(
    await ensureNamespace("http://sqld:8081", "main", { fetchImpl: mk(200) }),
    "created",
  );
  assert.equal(await ensureNamespace("http://sqld:8081", "main", { fetchImpl: mk(409) }), "exists");
  // real sqld: 400 with an "already exists" body is the same as 409; any other 400 is an error
  const mk400 = (body) => async () => ({ status: 400, text: async () => body });
  assert.equal(
    await ensureNamespace("http://sqld:8081", "main", {
      fetchImpl: mk400('{"error":"Namespace `main` already exists"}'),
    }),
    "exists",
  );
  await assert.rejects(
    ensureNamespace("http://sqld:8081", "main", { fetchImpl: mk400('{"error":"bad body"}') }),
    /create namespace failed .HTTP 400./,
  );
  assert.equal(
    await dropNamespace("http://sqld:8081", "drill-1-main", {
      fetchImpl: mk(404),
      adminAuth: "Bearer x",
    }),
    "absent",
  );
  assert.deepEqual(calls[0], ["POST", "/v1/namespaces/main/create", undefined]);
  assert.deepEqual(calls[2], ["DELETE", "/v1/namespaces/drill-1-main", "Bearer x"]);
  await assert.rejects(
    ensureNamespace("http://sqld:8081", "main", { fetchImpl: mk(500) }),
    (e) => e instanceof SqldError && e.message === "sqld: create namespace failed (HTTP 500)",
  );
  const down = async () => {
    throw new Error("ECONNREFUSED http://sqld:8081 secret");
  };
  await assert.rejects(ensureNamespace("http://sqld:8081", "main", { fetchImpl: down }), (e) => {
    assert.equal(e.message, "sqld: admin API unreachable");
    return true;
  });
});

test("foreign_keys = 1 on a libSQL connection, and in a transaction (D-713)", async () => {
  const db = t.open("fk.db");
  assert.equal(await foreignKeysEnabled(db), true);
  await assertForeignKeys(db, "file");
  const tx = await db.transaction("write");
  try {
    assert.equal(await foreignKeysEnabled(tx), true);
  } finally {
    tx.close();
  }
});

test("assertForeignKeys fails when the pragma reads 0", async () => {
  const off = { execute: async () => ({ rows: [{ foreign_keys: 0 }] }) };
  await assert.rejects(
    assertForeignKeys(off, "sqld main"),
    /sqld main: PRAGMA foreign_keys is not 1/,
  );
  assert.equal(
    (
      await connectionCheck({
        execute: async (q) =>
          q === "PRAGMA foreign_keys" ? { rows: [{ foreign_keys: 1 }] } : { rows: [{}] },
      })
    ).violations,
    1,
  );
});

test("connectionCheck reports orphan rows", async () => {
  const db = t.open("orphan.db");
  await db.execute("CREATE TABLE p (id INTEGER PRIMARY KEY)");
  await db.execute("CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p(id))");
  assert.deepEqual(await connectionCheck(db), { foreignKeys: true, violations: 0 });
  await db.execute("PRAGMA foreign_keys = OFF");
  await db.execute("INSERT INTO c (p_id) VALUES (99)");
  assert.equal((await connectionCheck(db)).violations, 1);
});

test("restoreVerified restores a real schema dump and checks counts, sha256 and FKs", async () => {
  for (const name of ["main", "auth"]) {
    const src = await seededDb(t, `rv-${name}-src.db`, name);
    const dump = await dumpDatabase(src, { name, createdAt: NOW });
    const target = t.open(`rv-${name}-target.db`);
    const r = await restoreVerified(target, dump.text, { expectDb: name });
    assert.equal(r.db, name);
    assert.equal(r.tables, dump.meta.tables.length);
    assert.equal(
      r.rows,
      Object.values(dump.counts).reduce((a, b) => a + b, 0),
    );
    assert.deepEqual(await connectionCheck(target), { foreignKeys: true, violations: 0 });
  }
});

test("restoreVerified refuses the wrong database, a bad stream and a non-empty target", async () => {
  const src = await seededDb(t, "rv-wrong-src.db", "main");
  const dump = await dumpDatabase(src, { name: "main", createdAt: NOW });
  await assert.rejects(
    restoreVerified(t.open("rv-wrong-1.db"), dump.text, { expectDb: "auth" }),
    /not auth/,
  );
  await assert.rejects(
    restoreVerified(t.open("rv-wrong-2.db"), dump.text.replace("drill", "DRILL")),
    /backup stream rejected/,
  );
  const target = t.open("rv-wrong-3.db");
  await restoreVerified(target, dump.text);
  await assert.rejects(restoreVerified(target, dump.text), /target database is not empty/);
});

test("wipeDatabase empties a migrated database (children before parents), then it restores again", async () => {
  const src = await seededDb(t, "wipe-src.db", "auth");
  const dump = await dumpDatabase(src, { name: "auth", createdAt: NOW });
  const target = await seededDb(t, "wipe-target.db", "auth"); // non-empty, with FK children
  const dropped = await wipeDatabase(target);
  assert.ok(dropped > 3);
  const left = await target.execute(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  );
  assert.equal(Number(left.rows[0].c), 0);
  await restoreVerified(target, dump.text, { expectDb: "auth" });
  assert.equal(await wipeDatabase(t.open("wipe-empty.db")), 0);
});

test(
  "real sqld (branch CI): foreign_keys = 1 on the main namespace",
  { skip: !process.env.SQLD_TEST_URL },
  async () => {
    const db = openNamespace({
      base: process.env.SQLD_TEST_URL,
      ns: process.env.SQLD_TEST_NS || "main",
      token: process.env.SQLD_TEST_TOKEN,
      mode: process.env.SQLD_NS_MODE === "host" ? "host" : "subdomain",
    });
    try {
      await assertForeignKeys(db, "sqld");
    } finally {
      db.close();
    }
  },
);

test(
  "real sqld (branch CI): scratch namespace create, host-mode access, foreign keys, drop",
  { skip: !process.env.SQLD_TEST_URL || !process.env.SQLD_TEST_ADMIN_URL },
  async () => {
    const ns = `t4-${Date.now().toString(36)}`;
    const admin = process.env.SQLD_TEST_ADMIN_URL;
    assert.equal(await ensureNamespace(admin, ns), "created");
    assert.equal(await ensureNamespace(admin, ns), "exists");
    const db = openNamespace({ base: process.env.SQLD_TEST_URL, ns, mode: "host" });
    const other = openNamespace({
      base: process.env.SQLD_TEST_URL,
      ns: "main",
      mode: "host",
    });
    try {
      // The Host header must really route: a table made here must not show up in the main namespace.
      const before = (await other.execute("SELECT COUNT(*) AS n FROM sqlite_master")).rows[0].n;
      await assertForeignKeys(db, "sqld scratch");
      await db.execute("CREATE TABLE p (id INTEGER PRIMARY KEY)");
      await db.execute("CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p(id))");
      await assert.rejects(db.execute("INSERT INTO c (p_id) VALUES (99)"));
      const after = (await other.execute("SELECT COUNT(*) AS n FROM sqlite_master")).rows[0].n;
      assert.equal(after, before, "a scratch namespace leaked into main");
    } finally {
      db.close();
      other.close();
    }
    assert.equal(await dropNamespace(admin, ns), "dropped");
    assert.equal(await dropNamespace(admin, ns), "absent");
  },
);
