// PLT-022, PLT-022a, PLT-022b, DAT-143, PLT-076: the nightly backup caller, with a fake fetch
// (GitHub + Vercel) and a local libSQL file as the "main DB". No real services, no secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import {
  assetName,
  decryptToText,
  exportEncrypted,
  parseBackup,
  selectDeletions,
} from "./core.mjs";
import { JOB, run } from "./run.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW_MS = Date.parse("2026-10-10T20:30:00Z"); // 11 Oct in Melbourne
const TODAY = "2026-10-11";
const TOKEN = "ghp_SECRETTOKEN_do_not_print";
const HMAC = "a".repeat(64);
const HOST = "https://praxis-secret-host.vercel.app";
const MARK = "MAIN-ROW-MARKER-31ab";

const identity = await generateIdentity();
const recipient = await identityToRecipient(identity);

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-bk-"));
  const url = pathToFileURL(path.join(dir, "main.db")).href;
  const db = createClient({ url });
  await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", "main")));
  await db.execute({
    sql: "INSERT INTO app_log (at, level, source, message) VALUES ('2026-10-10T00:00:00.000Z', 'info', 's', ?)",
    args: [MARK],
  });
  // The auth DB lives elsewhere (Vercel); this stands in for what its route would return.
  const authDb = createClient({ url: pathToFileURL(path.join(dir, "auth.db")).href });
  await migrateUp(authDb, await loadMigrations(path.join(root, "db", "migrations", "auth")));
  const authExport = await exportEncrypted(authDb, {
    name: "auth",
    createdAt: "2026-10-11T00:00:00.000Z",
    recipient,
  });
  const reader = createClient({ url });
  const openDb = () => createClient({ url });
  const cleanup = () => {
    db.close();
    authDb.close();
    reader.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows lock: temp folder only ever holds synthetic data
    }
  };
  return { reader, openDb, authExport, cleanup };
}

const env = (over = {}) => ({
  TURSO_MAIN_URL: "libsql://unused.example",
  TURSO_MAIN_TOKEN: "TURSO-SECRET",
  BACKUP_PUBLIC_KEY: recipient,
  APP_BASE_URL: HOST,
  ACTIONS_HMAC_SECRET: HMAC,
  DATA_REPO_TOKEN: TOKEN,
  DATA_REPO: "owner/praxis-app-data",
  COMMIT_SHA: "c".repeat(40),
  ...over,
});

/** Fake GitHub data repo + Vercel route. */
function fakeWorld({
  authExport,
  releases = [],
  vercel = "ok",
  failUpload = null,
  failDelete = null,
  hideToday = false,
}) {
  let nextId = 1000;
  const rels = new Map(
    releases.map((r) => [
      r.tag,
      { id: r.id ?? nextId++, tag: r.tag, assets: [...(r.assets ?? [])] },
    ]),
  );
  const calls = [];
  const uploads = new Map();
  const deleted = { releases: [], tags: [] };
  const res = (status, body, headers = {}) => ({
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    arrayBuffer: async () => body,
  });
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ url, method, headers: init.headers ?? {}, init });
    if (u.origin === HOST) {
      assert.equal(u.pathname, "/api/internal/backup-export");
      assert.equal(init.headers.Authorization, undefined); // the data-repo token never goes to Vercel
      assert.deepEqual(JSON.parse(init.body), { purpose: "backup-export", date: TODAY });
      if (vercel === "500") return res(500, new ArrayBuffer(0));
      if (vercel === "throw") throw new Error(`connect ECONNREFUSED ${HOST} ${TOKEN}`);
      if (vercel === "plaintext") {
        const b = new TextEncoder().encode('{"kind":"meta"}\nplain\n');
        return res(200, b.buffer, { "content-type": "application/octet-stream" });
      }
      if (vercel === "json")
        return res(200, new TextEncoder().encode("{}").buffer, {
          "content-type": "application/json",
        });
      const buf = authExport.data.buffer.slice(
        authExport.data.byteOffset,
        authExport.data.byteOffset + authExport.data.byteLength,
      );
      return res(200, buf, {
        "content-type": "application/octet-stream",
        "x-praxis-backup-counts": JSON.stringify(authExport.counts),
      });
    }
    // GitHub: the token only goes to the two fixed hosts
    assert.ok(["https://api.github.com", "https://uploads.github.com"].includes(u.origin));
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.redirect, "error");
    const rel = /^\/repos\/owner\/praxis-app-data\/releases\/tags\/(.+)$/.exec(u.pathname);
    if (rel && method === "GET") {
      const r = rels.get(decodeURIComponent(rel[1]));
      return r ? res(200, r2j(r)) : res(404, {});
    }
    if (u.pathname === "/repos/owner/praxis-app-data/releases" && method === "POST") {
      const b = JSON.parse(init.body);
      assert.equal(b.draft, false);
      const r = { id: nextId++, tag: b.tag_name, assets: [] };
      rels.set(r.tag, r);
      return res(201, r2j(r));
    }
    if (u.pathname === "/repos/owner/praxis-app-data/releases" && method === "GET") {
      assert.equal(u.searchParams.get("per_page"), "100");
      const page = Number(u.searchParams.get("page"));
      const all = [...rels.values()]
        .filter((r) => !(hideToday && r.tag === `backup-${TODAY}`))
        .map(r2j);
      return res(200, all.slice((page - 1) * 100, page * 100));
    }
    const up = /^\/repos\/owner\/praxis-app-data\/releases\/(\d+)\/assets$/.exec(u.pathname);
    if (up && method === "POST") {
      assert.equal(u.origin, "https://uploads.github.com");
      assert.equal(init.headers["Content-Type"], "application/octet-stream");
      if (failUpload) return res(failUpload, {});
      const r = [...rels.values()].find((x) => x.id === Number(up[1]));
      const name = u.searchParams.get("name");
      r.assets.push(name);
      uploads.set(name, init.body);
      return res(201, {});
    }
    const del = /^\/repos\/owner\/praxis-app-data\/releases\/(\d+)$/.exec(u.pathname);
    if (del && method === "DELETE") {
      if (failDelete) return res(failDelete, {});
      const r = [...rels.values()].find((x) => x.id === Number(del[1]));
      deleted.releases.push(r.tag);
      rels.delete(r.tag);
      return res(204, null);
    }
    const tag = /^\/repos\/owner\/praxis-app-data\/git\/refs\/tags\/(.+)$/.exec(u.pathname);
    if (tag && method === "DELETE") {
      deleted.tags.push(decodeURIComponent(tag[1]));
      return res(204, null);
    }
    throw new Error(`unexpected request ${method} ${u.pathname}`);
  };
  const r2j = (r) => ({ id: r.id, tag_name: r.tag, assets: r.assets.map((name) => ({ name })) });
  return { f, calls, uploads, deleted, rels };
}

const exec = async (e, world, openDb) => {
  const lines = [];
  const code = await run(e, {
    fetchImpl: world.f,
    openDb,
    nowMs: () => NOW_MS,
    out: (s) => lines.push(s),
  });
  return { code, text: lines.join("\n") };
};
const runRows = async (reader) =>
  (await reader.execute({ sql: "SELECT * FROM run_record WHERE job = ? ORDER BY id", args: [JOB] }))
    .rows;

const addDays = (d, n) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

test("happy path: uploads both encrypted files, applies retention exactly, writes a run record", async () => {
  const s = await setup();
  try {
    const old = Array.from({ length: 200 }, (_, i) => addDays(TODAY, -(i + 1)));
    const world = fakeWorld({
      authExport: s.authExport,
      releases: old.map((d) => ({
        tag: `backup-${d}`,
        assets: [assetName("main", d), assetName("auth", d)],
      })),
    });
    // two unrelated releases must never be touched
    world.rels.set("v1.0.0", { id: 5, tag: "v1.0.0", assets: [] });
    world.rels.set("backup-notadate", { id: 6, tag: "backup-notadate", assets: [] });
    const { code, text } = await exec(env(), world, s.openDb);
    assert.equal(code, 0);
    assert.match(text, /^backup: ok main=\d+B auth=\d+B uploaded=2 skipped=0 deleted=\d+$/);

    // uploads: two assets, ciphertext only, main decrypts and verifies
    assert.deepEqual([...world.uploads.keys()].sort(), [
      assetName("auth", TODAY),
      assetName("main", TODAY),
    ]);
    const mainBytes = world.uploads.get(assetName("main", TODAY));
    assert.equal(Buffer.from(mainBytes).includes(MARK), false);
    const plain = await decryptToText(mainBytes, identity);
    assert.ok(plain.includes(MARK));
    parseBackup(plain); // checksums verify
    assert.deepEqual(world.uploads.get(assetName("auth", TODAY)), s.authExport.data);

    // retention: exactly selectDeletions of all backup dates (cap 30 per run), nothing else
    const all = [TODAY, ...old];
    const expected = selectDeletions(all, TODAY).slice(0, 30);
    assert.ok(expected.length > 0);
    assert.deepEqual(world.deleted.releases.sort(), expected.map((d) => `backup-${d}`).sort());
    assert.deepEqual(world.deleted.tags.sort(), expected.map((d) => `backup-${d}`).sort());
    assert.ok(world.rels.has("v1.0.0") && world.rels.has("backup-notadate"));
    assert.ok(world.rels.has(`backup-${TODAY}`));

    // output never leaks a token, URL host, key or row text
    for (const bad of [
      TOKEN,
      HMAC,
      "praxis-secret-host",
      "TURSO-SECRET",
      recipient,
      MARK,
      "https://",
    ]) {
      assert.equal(text.includes(bad), false, bad);
    }

    // run record
    const rows = await runRows(s.reader);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "success");
    assert.equal(rows[0].concurrency_key, `backup:${TODAY}`);
    assert.equal(rows[0].scheduled_for, TODAY);
    assert.equal(rows[0].commit_sha, "c".repeat(40));
    const details = JSON.parse(rows[0].details_json);
    assert.equal(details.main.counts.app_log, 1);
    assert.match(details.main.sha256, /^[0-9a-f]{64}$/);
    assert.equal(details.deleted, expected.length);
    assert.equal(rows[0].details_json.includes(MARK), false);
    assert.equal(rows[0].details_json.includes("praxis-secret-host"), false);

    // second run the same day: skipped, no network at all
    const world2 = fakeWorld({ authExport: s.authExport });
    const again = await exec(env(), world2, s.openDb);
    assert.equal(again.code, 0);
    assert.match(again.text, /skipped \(already done for 2026-10-11\)/);
    assert.equal(world2.calls.length, 0);
    assert.equal((await runRows(s.reader)).length, 1);
  } finally {
    s.cleanup();
  }
});

test("idempotent: an asset that already exists is skipped, the missing one is uploaded", async () => {
  const s = await setup();
  try {
    const world = fakeWorld({
      authExport: s.authExport,
      releases: [{ tag: `backup-${TODAY}`, assets: [assetName("main", TODAY)] }],
    });
    const { code, text } = await exec(env(), world, s.openDb);
    assert.equal(code, 0);
    assert.match(text, /uploaded=1 skipped=1 deleted=0/);
    assert.deepEqual([...world.uploads.keys()], [assetName("auth", TODAY)]);
    const posts = world.calls.filter((c) => c.method === "POST" && c.url.endsWith("/releases"));
    assert.equal(posts.length, 0); // release existed: not created again
  } finally {
    s.cleanup();
  }
});

test("a release created by a parallel run (422 on create) is reused", async () => {
  const s = await setup();
  try {
    const world = fakeWorld({ authExport: s.authExport });
    let first = true;
    const inner = world.f;
    world.f = async (url, init = {}) => {
      if ((init.method ?? "GET") === "GET" && url.includes("/releases/tags/") && first) {
        first = false;
        const r = await inner(url, init);
        // race: the release appears right after our lookup said 404
        world.rels.set(`backup-${TODAY}`, { id: 77, tag: `backup-${TODAY}`, assets: [] });
        return r;
      }
      if ((init.method ?? "GET") === "POST" && url.endsWith("/releases")) {
        return { status: 422, headers: { get: () => null }, json: async () => ({}) };
      }
      return inner(url, init);
    };
    const { code } = await exec(env(), world, s.openDb);
    assert.equal(code, 0);
    assert.equal(world.uploads.size, 2);
  } finally {
    s.cleanup();
  }
});

test("auth export failure: main is still uploaded, run is recorded failed, exit 1, nothing leaks", async () => {
  for (const vercel of ["500", "throw", "plaintext", "json"]) {
    const s = await setup();
    try {
      const world = fakeWorld({ authExport: s.authExport, vercel });
      const { code, text } = await exec(env(), world, s.openDb);
      assert.equal(code, 1, vercel);
      assert.match(text, /^backup: failed \(auth_export: /, vercel);
      assert.deepEqual([...world.uploads.keys()], [assetName("main", TODAY)], vercel);
      for (const bad of [TOKEN, HMAC, "praxis-secret-host", "ECONNREFUSED", "plain"]) {
        assert.equal(text.includes(bad), false, `${vercel}: ${bad}`);
      }
      const rows = await runRows(s.reader);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "failed");
      assert.match(rows[0].error_summary, /^auth_export: /);
      assert.equal(world.deleted.releases.length, 0); // no retention after a failed run
    } finally {
      s.cleanup();
    }
  }
});

test("a failed run does not block a retry the same day (no success record), which uploads only the gap", async () => {
  const s = await setup();
  try {
    const bad = fakeWorld({ authExport: s.authExport, vercel: "500" });
    assert.equal((await exec(env(), bad, s.openDb)).code, 1);
    const good = fakeWorld({
      authExport: s.authExport,
      releases: [{ tag: `backup-${TODAY}`, assets: [assetName("main", TODAY)] }],
    });
    const r = await exec(env(), good, s.openDb);
    assert.equal(r.code, 0);
    assert.match(r.text, /uploaded=1 skipped=1/);
    const rows = await runRows(s.reader);
    assert.deepEqual(
      rows.map((x) => x.status),
      ["failed", "success"],
    );
  } finally {
    s.cleanup();
  }
});

test("upload failure prints the step and HTTP status only", async () => {
  const s = await setup();
  try {
    const world = fakeWorld({ authExport: s.authExport, failUpload: 403 });
    const { code, text } = await exec(env(), world, s.openDb);
    assert.equal(code, 1);
    assert.equal(text, "backup: failed (github upload_asset failed (HTTP 403))");
    assert.equal(text.includes(TOKEN), false);
    const rows = await runRows(s.reader);
    assert.equal(rows[0].status, "failed");
    assert.equal(rows[0].error_summary, "github upload_asset failed (HTTP 403)");
  } finally {
    s.cleanup();
  }
});

test("GitHub network errors and malformed responses fail with a generic summary", async () => {
  const s = await setup();
  try {
    const world = fakeWorld({ authExport: s.authExport });
    const boom = async () => {
      throw new Error(`socket hang up ${TOKEN} https://api.github.com/x`);
    };
    const lines = [];
    const code = await run(env(), {
      fetchImpl: async (url, init) => (url.startsWith(HOST) ? world.f(url, init) : boom()),
      openDb: s.openDb,
      nowMs: () => NOW_MS,
      out: (l) => lines.push(l),
    });
    assert.equal(code, 1);
    assert.equal(lines.join(""), "backup: failed (github get_release failed)");
    // list_releases returning garbage
    const w2 = fakeWorld({ authExport: s.authExport });
    const inner = w2.f;
    w2.f = async (url, init = {}) =>
      (init.method ?? "GET") === "GET" && url.includes("/releases?per_page")
        ? { status: 200, headers: { get: () => null }, json: async () => ({ not: "array" }) }
        : inner(url, init);
    const r2 = await exec(env(), w2, s.openDb);
    assert.equal(r2.code, 1);
    assert.match(r2.text, /list_releases/);
  } finally {
    s.cleanup();
  }
});

test("a failed retention deletion marks the run degraded but the backup stands (exit 0)", async () => {
  const s = await setup();
  try {
    const old = Array.from({ length: 40 }, (_, i) => addDays(TODAY, -(i + 1)));
    const world = fakeWorld({
      authExport: s.authExport,
      releases: old.map((d) => ({ tag: `backup-${d}`, assets: [] })),
      failDelete: 500,
    });
    const { code, text } = await exec(env(), world, s.openDb);
    assert.equal(code, 0);
    assert.match(text, /^backup: degraded /);
    const rows = await runRows(s.reader);
    assert.equal(rows[0].status, "degraded");
    assert.match(rows[0].error_summary, /^retention: \d+ deletion\(s\) failed$/);
  } finally {
    s.cleanup();
  }
});

test("no retention deletions unless today's release is in the list", async () => {
  const s = await setup();
  try {
    const old = Array.from({ length: 60 }, (_, i) => addDays(TODAY, -(i + 1)));
    const world = fakeWorld({
      authExport: s.authExport,
      releases: old.map((d) => ({ tag: `backup-${d}`, assets: [] })),
      hideToday: true,
    });
    const { code } = await exec(env(), world, s.openDb);
    assert.equal(code, 0);
    assert.equal(world.deleted.releases.length, 0);
  } finally {
    s.cleanup();
  }
});

test("pages through more than 100 releases", async () => {
  const s = await setup();
  try {
    const old = Array.from({ length: 150 }, (_, i) => addDays(TODAY, -(i + 1)));
    const world = fakeWorld({
      authExport: s.authExport,
      releases: old.map((d) => ({ tag: `backup-${d}`, assets: [] })),
    });
    const { code } = await exec(env(), world, s.openDb);
    assert.equal(code, 0);
    const pages = world.calls.filter((c) => c.url.includes("/releases?per_page=100"));
    assert.ok(pages.length >= 2);
  } finally {
    s.cleanup();
  }
});

test("configuration problems fail before any network or database access", async () => {
  const s = await setup();
  try {
    for (const over of [
      { BACKUP_PUBLIC_KEY: undefined },
      { BACKUP_PUBLIC_KEY: "age1" + "q".repeat(58) },
      { BACKUP_PUBLIC_KEY: "AGE-SECRET-KEY-1ABC" },
      { TURSO_MAIN_URL: "" },
      { TURSO_MAIN_TOKEN: undefined },
      { APP_BASE_URL: " " },
      { ACTIONS_HMAC_SECRET: undefined },
      { DATA_REPO_TOKEN: undefined },
      { DATA_REPO: "not a repo" },
      { DATA_REPO: undefined },
    ]) {
      const world = fakeWorld({ authExport: s.authExport });
      let opened = 0;
      const { code, text } = await exec(env(over), world, () => {
        opened++;
        return s.openDb();
      });
      assert.equal(code, 1, JSON.stringify(Object.keys(over)));
      assert.equal(text, "backup: failed (configuration incomplete or invalid)");
      assert.equal(world.calls.length, 0);
      assert.equal(opened, 0);
    }
  } finally {
    s.cleanup();
  }
});

test("a main-DB failure is reported without the driver message", async () => {
  const s = await setup();
  try {
    const world = fakeWorld({ authExport: s.authExport });
    const lines = [];
    const code = await run(env(), {
      fetchImpl: world.f,
      openDb: () => ({
        execute: async () => {
          throw new Error("libsql://secret.turso.io unreachable TURSO-SECRET");
        },
        close() {},
      }),
      nowMs: () => NOW_MS,
      out: (l) => lines.push(l),
    });
    assert.equal(code, 1);
    assert.equal(lines.join(""), "backup: failed (run_record: unexpected error)");
    assert.equal(world.calls.length, 0);
  } finally {
    s.cleanup();
  }
});

test("the workflow file is dispatch-only, uses the approved commit and holds no private key", async () => {
  const { readFileSync } = await import("node:fs");
  const wf = readFileSync(path.join(root, ".github/workflows/backup.yml"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#")) // comments may mention schedule / keys
    .join("\n");
  assert.match(wf, /^on: workflow_dispatch$/m);
  assert.equal(/schedule:/.test(wf), false);
  assert.match(wf, /approved-commit\.mjs/);
  assert.match(wf, /deployment: false/);
  assert.match(wf, /group: backup/);
  assert.match(wf, /cancel-in-progress: false/);
  assert.match(wf, /if: github\.ref == 'refs\/heads\/release'/);
  assert.equal(/PRIVATE|AGE-SECRET-KEY|BACKUP_PRIVATE/i.test(wf), false); // SEC-108 f
  // secrets only in env: blocks, never inside run: scripts
  assert.equal(/run:[^\n]*\$\{\{\s*secrets\./.test(wf), false);
  assert.match(wf, /node scripts\/backup\/drill\.mjs/);
});
