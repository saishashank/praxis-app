// INFRA T5: choosing the newest of the three copies, and restoring from it. In-memory bucket and
// data repo; local libSQL files for the databases.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { exportEncrypted } from "../backup/core.mjs";
import { fetchNewest, listCandidates, orderCandidates, run } from "./latest-backup.mjs";
import { keyPair, memoryGh, memoryS3, seededDb, tempDir } from "./testkit.mjs";

const t = tempDir();
after(() => t.cleanup());
const D1 = "2026-01-02T03:04:05.678Z";
let n = 0;

const cand = (source, atMs, name = source) => ({
  source,
  db: "main",
  name,
  atMs,
  size: 1,
  fetch: async () => null,
});

test("orderCandidates: newest time first; ties go bucket-hourly, bucket-nightly, repo", () => {
  const list = [
    cand("repo-nightly", 100),
    cand("bucket-nightly", 100),
    cand("bucket-hourly", 100),
    cand("repo-nightly", 200, "newest"),
    cand("bucket-hourly", 50, "oldest"),
  ];
  assert.deepEqual(
    orderCandidates(list).map((c) => c.name),
    ["newest", "bucket-hourly", "bucket-nightly", "repo-nightly", "oldest"],
  );
});

/** A source DB, one encrypted export of it, and stores holding copies at chosen times. */
async function fixture() {
  const { identity, recipient } = await keyPair();
  const src = await seededDb(t, `lb-${++n}.db`, "main");
  const exp = await exportEncrypted(src, { name: "main", createdAt: D1, recipient });
  const authSrc = await seededDb(t, `lba-${n}.db`, "auth");
  const authExp = await exportEncrypted(authSrc, { name: "auth", createdAt: D1, recipient });
  return { identity, recipient, exp, authExp, s3: memoryS3(), gh: memoryGh() };
}
const at = (s3, key, bytes, iso) => {
  s3.objects.set(key, { bytes, lastModified: iso });
};
/** A client stand-in whose close() is a no-op (the test keeps the database). */
const keepOpen = (db) => ({
  execute: (...a) => db.execute(...a),
  batch: (...a) => db.batch(...a),
  transaction: (...a) => db.transaction(...a),
  close() {},
});

test("the newest copy wins across bucket hourly, bucket nightly and the data repo", async () => {
  const f = await fixture();
  at(f.s3, "nightly/main-2026-01-02.ndjson.gz.age", f.exp.data, "2026-01-01T16:10:00.000Z");
  at(f.s3, "hourly/main-20260102T0400Z.ndjson.gz.age", f.exp.data, "2026-01-02T04:00:30.000Z");
  at(f.s3, "hourly/main-20260102T0300Z.ndjson.gz.age", f.exp.data, "2026-01-02T03:00:30.000Z");
  f.gh.addRelease("backup-2026-01-02", "2026-01-01T16:05:00Z", {
    "main-2026-01-02.ndjson.gz.age": f.exp.data,
  });
  let { candidates } = await listCandidates("main", f);
  assert.equal(candidates[0].source, "bucket-hourly");
  assert.equal(candidates[0].name, "hourly/main-20260102T0400Z.ndjson.gz.age");
  assert.equal(candidates.length, 4);

  // No hourly copy: the nightly in the bucket (16:10Z) is newer than the repo's (16:05Z).
  for (const k of [...f.s3.objects.keys()].filter((k) => k.startsWith("hourly/"))) {
    f.s3.objects.delete(k);
  }
  ({ candidates } = await listCandidates("main", f));
  assert.equal(candidates[0].source, "bucket-nightly");

  // The repo's nightly is newer once the bucket's is older.
  at(f.s3, "nightly/main-2026-01-02.ndjson.gz.age", f.exp.data, "2026-01-01T10:00:00.000Z");
  ({ candidates } = await listCandidates("main", f));
  assert.equal(candidates[0].source, "repo-nightly");
});

test("the auth database has no hourly copy; a missing source is skipped, a failing one is reported", async () => {
  const f = await fixture();
  at(f.s3, "hourly/main-20260102T0400Z.ndjson.gz.age", f.exp.data, "2026-01-02T04:00:30.000Z");
  at(f.s3, "nightly/auth-2026-01-02.ndjson.gz.age", f.authExp.data, "2026-01-01T16:10:00.000Z");
  const r = await listCandidates("auth", { s3: f.s3, gh: null });
  assert.deepEqual(
    r.candidates.map((c) => c.source),
    ["bucket-nightly"],
  );
  const broken = {
    list: async () => {
      throw new Error("down");
    },
  };
  const r2 = await listCandidates("main", { s3: broken, gh: f.gh });
  assert.deepEqual(r2.unavailable, ["bucket"]);
});

test("fetchNewest falls back to the next copy when the newest is damaged or the wrong database", async () => {
  const f = await fixture();
  at(
    f.s3,
    "hourly/main-20260102T0500Z.ndjson.gz.age",
    new Uint8Array([1, 2, 3]),
    "2026-01-02T05:00:30.000Z",
  ); // junk
  at(f.s3, "hourly/main-20260102T0400Z.ndjson.gz.age", f.authExp.data, "2026-01-02T04:00:30.000Z"); // an auth dump
  at(f.s3, "nightly/main-2026-01-02.ndjson.gz.age", f.exp.data, "2026-01-01T16:10:00.000Z");
  const { candidates } = await listCandidates("main", f);
  const got = await fetchNewest("main", candidates, f.identity);
  assert.equal(got.source, "bucket-nightly");
  assert.equal(got.tried, 3);
  assert.match(got.text, /^\{"kind":"meta"/);
  await assert.rejects(
    fetchNewest("main", candidates, (await keyPair()).identity),
    /no usable backup/,
  );
});

test("run: lists, and restores the newest copy of main and auth into empty databases", async () => {
  const f = await fixture();
  at(f.s3, "hourly/main-20260102T0400Z.ndjson.gz.age", f.exp.data, "2026-01-02T04:00:30.000Z");
  f.gh.addRelease("backup-2026-01-01", "2026-01-01T16:05:00Z", {
    "main-2026-01-01.ndjson.gz.age": f.exp.data,
    "auth-2026-01-01.ndjson.gz.age": f.authExp.data,
  });
  const lines = [];
  const deps = { s3: f.s3, gh: f.gh, out: (s) => lines.push(s) };
  assert.equal(await run(["--db", "both"], {}, deps), 0);
  assert.match(lines[0], /main: newest bucket-hourly hourly\/main-20260102T0400Z/);
  assert.match(lines[1], /auth: newest repo-nightly backup-2026-01-01\/auth-2026-01-01/);

  const targets = {
    main: t.open(`lb-restore-main-${n}.db`),
    auth: t.open(`lb-restore-auth-${n}.db`),
  };
  const lines2 = [];
  const code = await run(
    ["--db", "both", "--restore"],
    { BACKUP_PRIVATE_KEY: f.identity },
    { ...deps, out: (s) => lines2.push(s), openTarget: (db) => keepOpen(targets[db]) },
  );
  assert.equal(code, 0, lines2.join("\n"));
  assert.match(
    lines2.join("\n"),
    /main: restore PASS from bucket-hourly .*foreign keys ON, no orphans/,
  );
  assert.match(lines2.join("\n"), /auth: restore PASS from repo-nightly/);
  assert.equal(lines2.join("\n").includes(f.identity), false); // the key is never printed
  const c = await targets.main.execute("SELECT COUNT(*) AS c FROM app_log");
  assert.ok(Number(c.rows[0].c) >= 1);

  // A second restore into the now non-empty target is refused (it never overwrites).
  const lines3 = [];
  const again = await run(
    ["--db", "main", "--restore"],
    { BACKUP_PRIVATE_KEY: f.identity },
    { ...deps, out: (s) => lines3.push(s), openTarget: () => keepOpen(targets.main) },
  );
  assert.equal(again, 1);
  assert.match(lines3.at(-1), /target database is not empty/);
});

test("run: usage, no source, no key, nothing found", async () => {
  const lines = [];
  const out = (s) => lines.push(s);
  assert.equal(await run([], {}, { out }), 1);
  assert.equal(await run(["--db", "main"], {}, { out }), 1); // no sources
  assert.match(lines[1], /no backup source is configured/);
  assert.equal(await run(["--db", "main", "--restore"], {}, { out, s3: memoryS3(), gh: null }), 1);
  assert.match(lines[2], /BACKUP_PRIVATE_KEY is not set/);
  assert.equal(await run(["--db", "main"], {}, { out, s3: memoryS3(), gh: null }), 1);
  assert.match(lines[3], /FAIL no backup found/);
});

test("S12: --restore needs SQLD_URL and never falls back to TURSO_MAIN_URL; a Turso address is refused", async () => {
  const f = await fixture();
  at(f.s3, "hourly/main-20260102T0400Z.ndjson.gz.age", f.exp.data, "2026-01-02T04:00:30.000Z");
  for (const [env, why] of [
    [
      { TURSO_MAIN_URL: "libsql://x.turso.io", TURSO_MAIN_TOKEN: "tok-123456" },
      /SQLD_URL is not set/,
    ],
    [{ SQLD_URL: "libsql://x.turso.io" }, /not a Turso address/],
    [{ SQLD_URL: "https://praxis-main.turso.io" }, /not a Turso address/],
  ]) {
    const lines = [];
    const code = await run(
      ["--db", "main", "--restore"],
      { BACKUP_PRIVATE_KEY: f.identity, ...env },
      { s3: f.s3, gh: f.gh, out: (s) => lines.push(s) },
    );
    assert.equal(code, 1, lines.join("\n"));
    assert.match(lines.at(-1), why);
  }
});
