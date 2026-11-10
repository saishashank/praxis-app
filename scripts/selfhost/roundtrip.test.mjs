// INFRA T5 acceptance ("a restore from each copy succeeds"): backup -> bucket (real createS3 over a
// fake S3 endpoint, real SigV4) -> latest-backup -> restore into a local libSQL file, for each of
// the three copies on its own, with checksums and foreign keys verified.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { dumpDatabase, exportEncrypted } from "../backup/core.mjs";
import { run as bucketCopy } from "../backup/bucket-copy.mjs";
import { run as latest } from "./latest-backup.mjs";
import { connectionCheck } from "./sqld.mjs";
import { createS3 } from "../backup/s3.mjs";
import { BUCKET_ENV, fakeBucketFetch, keyPair, memoryGh, seededDb, tempDir } from "./testkit.mjs";

const t = tempDir();
after(() => t.cleanup());
const NOW = "2026-03-31T03:00:00.000Z";

test("a restore from each copy (bucket hourly, bucket nightly, data repo) reproduces the source", async () => {
  const { identity, recipient } = await keyPair();
  const src = await seededDb(t, "rt-src.db", "main");
  const authSrc = await seededDb(t, "rt-auth-src.db", "auth");
  const want = await dumpDatabase(src, { name: "main", createdAt: NOW });
  const wantAuth = await dumpDatabase(authSrc, { name: "auth", createdAt: NOW });

  // The nightly backup: encrypted once, uploaded to the data repo (what run.mjs does).
  const main = await exportEncrypted(src, { name: "main", createdAt: NOW, recipient });
  const auth = await exportEncrypted(authSrc, { name: "auth", createdAt: NOW, recipient });
  const gh = memoryGh();
  gh.addRelease("backup-2026-03-31", "2026-03-30T16:00:00Z", {
    "main-2026-03-31.ndjson.gz.age": main.data,
    "auth-2026-03-31.ndjson.gz.age": auth.data,
  });

  // Copy 2: the same files into the bucket; plus the optional hourly copy.
  const bucket = fakeBucketFetch();
  const lines = [];
  const common = {
    fetchImpl: bucket.fetchImpl,
    nowMs: () => Date.parse(NOW),
    out: (s) => lines.push(s),
  };
  const env = { ...BUCKET_ENV, DATA_REPO: "o/r-data", DATA_REPO_TOKEN: "ghp_x" };
  assert.equal(
    await bucketCopy(["--date", "2026-03-31"], env, { ...common, gh }),
    0,
    lines.join("\n"),
  );
  assert.equal(
    await bucketCopy(
      ["--hourly"],
      { ...env, TURSO_MAIN_URL: "http://main.sqld:8080", BACKUP_PUBLIC_KEY: recipient },
      {
        ...common,
        openDb: () => ({
          execute: (...a) => src.execute(...a),
          transaction: (...a) => src.transaction(...a),
          close() {},
        }),
      },
    ),
    0,
    lines.join("\n"),
  );
  assert.ok([...bucket.objects.keys()].some((k) => k.startsWith("hourly/")));
  assert.ok(bucket.objects.has("nightly/main-2026-03-31.ndjson.gz.age"));

  const s3 = createS3({
    endpoint: BUCKET_ENV.BACKUP_BUCKET_URL,
    bucket: BUCKET_ENV.BACKUP_BUCKET_NAME,
    keyId: BUCKET_ENV.BACKUP_BUCKET_KEY_ID,
    secret: BUCKET_ENV.BACKUP_BUCKET_SECRET,
    fetchImpl: bucket.fetchImpl,
  });

  // Restore from each copy on its own.
  const copies = [
    { label: "bucket-hourly", s3: createOnly(s3, "hourly/"), gh: null },
    { label: "bucket-nightly", s3: createOnly(s3, "nightly/"), gh: null },
    { label: "repo-nightly", s3: null, gh },
  ];
  let i = 0;
  for (const c of copies) {
    const target = t.open(`rt-restore-${++i}.db`);
    const out = [];
    const code = await latest(
      ["--db", "main", "--restore"],
      { BACKUP_PRIVATE_KEY: identity },
      {
        s3: c.s3,
        gh: c.gh,
        out: (s) => out.push(s),
        openTarget: () => ({
          execute: (...a) => target.execute(...a),
          batch: (...a) => target.batch(...a),
          transaction: (...a) => target.transaction(...a),
          close() {},
        }),
      },
    );
    assert.equal(code, 0, `${c.label}: ${out.join("\n")}`);
    assert.match(out.join("\n"), new RegExp(`restore PASS from ${c.label}`));
    const got = await dumpDatabase(target, { name: "main", createdAt: NOW });
    assert.deepEqual(got.counts, want.counts, c.label);
    assert.deepEqual(got.sha256, want.sha256, c.label);
    assert.deepEqual(await connectionCheck(target), { foreignKeys: true, violations: 0 });
  }

  // The auth copy (bucket nightly and repo) restores too.
  for (const c of [copies[1], copies[2]]) {
    const target = t.open(`rt-auth-${c.label}.db`);
    const out = [];
    const code = await latest(
      ["--db", "auth", "--restore"],
      { BACKUP_PRIVATE_KEY: identity },
      {
        s3: c.s3,
        gh: c.gh,
        out: (s) => out.push(s),
        openTarget: () => ({
          execute: (...a) => target.execute(...a),
          batch: (...a) => target.batch(...a),
          transaction: (...a) => target.transaction(...a),
          close() {},
        }),
      },
    );
    assert.equal(code, 0, out.join("\n"));
    const got = await dumpDatabase(target, { name: "auth", createdAt: NOW });
    assert.deepEqual(got.sha256, wantAuth.sha256, c.label);
  }

  // A wrong key restores nothing.
  const other = (await keyPair()).identity;
  const out = [];
  assert.equal(
    await latest(
      ["--db", "main", "--restore"],
      { BACKUP_PRIVATE_KEY: other },
      {
        s3,
        gh,
        out: (s) => out.push(s),
        openTarget: () => t.open("rt-wrongkey.db"),
      },
    ),
    1,
  );
  assert.match(out.at(-1), /no usable backup found/);
});

/** A view of the bucket that lists only one prefix (so a copy can be tried alone). */
function createOnly(s3, prefix) {
  return {
    get: (k) => s3.get(k),
    list: async (p) => (p === prefix ? s3.list(p) : []),
  };
}
