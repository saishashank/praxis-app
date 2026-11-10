// INFRA T5: the bucket copy: key layout, retention (30 daily + 12 monthly, hourly 48 h), and the
// nightly/hourly runs against a fake S3 endpoint. No network, no credentials.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { exportEncrypted } from "./core.mjs";
import {
  bucketFromEnv,
  hourlyKey,
  nightlyKey,
  parseArgs,
  parseHourlyKey,
  parseNightlyKey,
  run,
  selectBucketDeletions,
  selectBucketRetained,
  selectHourlyDeletions,
} from "./bucket-copy.mjs";
import {
  BUCKET_ENV,
  fakeBucketFetch,
  keyPair,
  memoryGh,
  seededDb,
  tempDir,
} from "../selfhost/testkit.mjs";

const t = tempDir();
after(() => t.cleanup());

const day = (n, from = "2026-03-31") => {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

test("key layout round trips and rejects look-alikes", () => {
  assert.equal(nightlyKey("main", "2026-01-02"), "nightly/main-2026-01-02.ndjson.gz.age");
  assert.deepEqual(parseNightlyKey("nightly/auth-2026-01-02.ndjson.gz.age"), {
    db: "auth",
    date: "2026-01-02",
  });
  assert.equal(parseNightlyKey("nightly/main-2026-13-02.ndjson.gz.age"), null);
  assert.equal(parseNightlyKey("nightly/other-2026-01-02.ndjson.gz.age"), null);
  assert.equal(parseNightlyKey("hourly/main-2026-01-02.ndjson.gz.age"), null);
  const at = Date.UTC(2026, 0, 2, 3, 45, 10);
  assert.equal(hourlyKey(at), "hourly/main-20260102T0300Z.ndjson.gz.age");
  assert.equal(parseHourlyKey("hourly/main-20260102T0300Z.ndjson.gz.age"), Date.UTC(2026, 0, 2, 3));
  assert.equal(parseHourlyKey("hourly/main-20260102T2500Z.ndjson.gz.age"), null);
  assert.equal(parseHourlyKey("hourly/auth-20260102T0300Z.ndjson.gz.age"), null);
});

test("retention: 30 daily + the first backup of each of the last 12 months", () => {
  const today = "2026-03-31";
  // every day for 400 days back
  const dates = Array.from({ length: 400 }, (_, i) => day(i));
  const keep = selectBucketRetained(dates, today);
  // 30 daily (age 0..29 = Mar 2 .. Mar 31)
  for (let i = 0; i < 30; i++) assert.ok(keep.includes(day(i)), `daily ${day(i)}`);
  // day(30) is 2026-03-01: older than 30 days, but the first of its month, so kept as the monthly one
  assert.ok(keep.includes("2026-03-01"));
  // first-of-month for the 12 months Apr 2025 .. Mar 2026
  const months = [
    "2025-04-01",
    "2025-05-01",
    "2025-06-01",
    "2025-07-01",
    "2025-08-01",
    "2025-09-01",
    "2025-10-01",
    "2025-11-01",
    "2025-12-01",
    "2026-01-01",
    "2026-02-01",
    "2026-03-01",
  ];
  for (const m of months) assert.ok(keep.includes(m), `monthly ${m}`);
  assert.equal(keep.includes("2025-03-01"), false); // 13 months back
  assert.equal(keep.includes("2026-02-15"), false);
  assert.equal(keep.length, 30 + 12); // Mar 2..31, plus the 12 month-starts (Apr 2025 .. Mar 2026)
});

test("retention: a missing first-of-month keeps the earliest backup of that month", () => {
  const keep = selectBucketRetained(
    ["2025-12-03", "2025-12-20", "2026-01-05", "2026-03-31"],
    "2026-03-31",
  );
  assert.deepEqual(keep, ["2025-12-03", "2026-01-05", "2026-03-31"]);
});

test("retention: deletions are the valid dates not kept; future and invalid dates are never deleted", () => {
  const today = "2026-03-31";
  const dates = [
    "2026-03-31",
    "2026-03-15",
    "2026-02-10",
    "2026-02-01",
    "2024-01-01",
    "2026-04-02",
    "junk",
  ];
  assert.deepEqual(selectBucketDeletions(dates, today), ["2024-01-01", "2026-02-10"]);
  assert.deepEqual(selectBucketDeletions([], today), []);
  assert.throws(() => selectBucketRetained(["2026-01-01"], "nope"), /valid date/);
});

test("hourly retention: only keys strictly older than 48 h are deleted", () => {
  const now = Date.UTC(2026, 0, 10, 12, 30);
  const keys = [
    hourlyKey(now),
    hourlyKey(now - 47 * 3_600_000),
    hourlyKey(Date.UTC(2026, 0, 8, 12)), // exactly 48 h + 30 min old
    hourlyKey(Date.UTC(2026, 0, 8, 13)), // 47.5 h old: kept
    hourlyKey(Date.UTC(2026, 0, 1, 0)),
    "hourly/garbage",
  ];
  assert.deepEqual(selectHourlyDeletions(keys, now), [
    hourlyKey(Date.UTC(2026, 0, 8, 12)),
    hourlyKey(Date.UTC(2026, 0, 1, 0)),
  ]);
});

test("parseArgs and bucketFromEnv", () => {
  assert.deepEqual(parseArgs([]), { hourly: false, date: "", dir: "" });
  assert.deepEqual(parseArgs(["--hourly"]), { hourly: true, date: "", dir: "" });
  assert.throws(() => parseArgs(["--date", "2026-02-30"]), /YYYY-MM-DD/);
  assert.throws(() => parseArgs(["--hourly", "--dir", "x"]), /no --date or --dir/);
  assert.throws(() => parseArgs(["--nope"]), /usage/);
  assert.equal(bucketFromEnv({}), null);
  assert.equal(
    bucketFromEnv({ ...BUCKET_ENV, BACKUP_BUCKET_URL: "http://insecure.example" }),
    null,
  );
  assert.equal(typeof bucketFromEnv(BUCKET_ENV).put, "function");
});

async function encrypted(name, recipient) {
  const src = await seededDb(t, `bc-${name}-${Math.random().toString(36).slice(2)}.db`, name);
  return (await exportEncrypted(src, { name, createdAt: "2026-01-02T03:04:05.678Z", recipient }))
    .data;
}

test("nightly from the data repo: uploads the same bytes, verifies, is idempotent, prunes", async () => {
  const { recipient } = await keyPair();
  const main = await encrypted("main", recipient);
  const auth = await encrypted("auth", recipient);
  const gh = memoryGh();
  gh.addRelease("backup-2026-03-31", "2026-03-30T16:00:00Z", {
    "main-2026-03-31.ndjson.gz.age": main,
    "auth-2026-03-31.ndjson.gz.age": auth,
  });
  const bucket = fakeBucketFetch();
  // Old objects: one kept (first-of-month), several to prune.
  const old = new Uint8Array([9]);
  for (const d of ["2024-01-01", "2025-06-01", "2025-06-15", "2026-02-10", "2026-03-30"]) {
    bucket.objects.set(nightlyKey("main", d), { bytes: old, lastModified: "2026-01-01T00:00:00Z" });
  }
  const lines = [];
  const deps = {
    gh,
    fetchImpl: bucket.fetchImpl,
    nowMs: () => Date.parse("2026-03-31T00:00:00Z"),
    out: (s) => lines.push(s),
  };
  const env = { ...BUCKET_ENV, DATA_REPO: "o/r-data", DATA_REPO_TOKEN: "ghp_SECRET" };
  assert.equal(await run(["--date", "2026-03-31"], env, deps), 0, lines.join("\n"));
  assert.match(
    lines[0],
    /^bucket-copy: ok date=2026-03-31 files=2 bytes=\d+ uploaded=2 skipped=0 deleted=2$/,
  );
  assert.deepEqual([...bucket.objects.get(nightlyKey("main", "2026-03-31")).bytes], [...main]); // same file
  assert.deepEqual([...bucket.objects.get(nightlyKey("auth", "2026-03-31")).bytes], [...auth]);
  assert.equal(bucket.objects.has(nightlyKey("main", "2024-01-01")), false); // pruned
  assert.equal(bucket.objects.has(nightlyKey("main", "2025-06-15")), false);
  assert.ok(bucket.objects.has(nightlyKey("main", "2026-02-10"))); // the only (so first) one of its month
  assert.ok(bucket.objects.has(nightlyKey("main", "2025-06-01"))); // first of its month
  assert.ok(bucket.objects.has(nightlyKey("main", "2026-03-30"))); // daily

  // A second run uploads nothing.
  const again = [];
  assert.equal(await run(["--date", "2026-03-31"], env, { ...deps, out: (s) => again.push(s) }), 0);
  assert.match(again[0], /uploaded=0 skipped=2 deleted=0/);
  assert.equal(/SECRET|ghp_|KEYID|s3\./.test(lines.join("") + again.join("")), false);
});

test("nightly from a folder; plaintext and a missing main file are refused", async () => {
  const { recipient } = await keyPair();
  const main = await encrypted("main", recipient);
  const dir = path.join(t.dir, "files");
  mkdirSync(dir);
  const bucket = fakeBucketFetch();
  const lines = [];
  const deps = {
    fetchImpl: bucket.fetchImpl,
    nowMs: () => Date.parse("2026-03-31T00:00:00Z"),
    out: (s) => lines.push(s),
  };
  // no files at all
  assert.equal(await run(["--date", "2026-03-31", "--dir", dir], BUCKET_ENV, deps), 1);
  assert.match(lines[0], /no main backup for 2026-03-31/);
  // plaintext main
  writeFileSync(path.join(dir, "main-2026-03-31.ndjson.gz.age"), '{"kind":"meta"}');
  assert.equal(await run(["--date", "2026-03-31", "--dir", dir], BUCKET_ENV, deps), 1);
  assert.match(lines[1], /main: the file is not age ciphertext/);
  assert.equal(bucket.objects.size, 0);
  // ciphertext main only: auth is optional
  writeFileSync(path.join(dir, "main-2026-03-31.ndjson.gz.age"), main);
  assert.equal(await run(["--date", "2026-03-31", "--dir", dir], BUCKET_ENV, deps), 0);
  assert.match(lines[2], /files=1 /);
});

test("failures print the stage and status only", async () => {
  const lines = [];
  const code = await run(
    [],
    { ...BUCKET_ENV, DATA_REPO: "o/r", DATA_REPO_TOKEN: "ghp_SECRET" },
    {
      fetchImpl: async () => ({ status: 403, text: async () => "KEYID-SECRET" }),
      gh: { downloadAsset: async () => new Uint8Array([1]) },
      out: (s) => lines.push(s),
    },
  );
  assert.equal(code, 1);
  assert.equal(/SECRET|KEYID|ghp_/.test(lines[0]), false);
  assert.equal(await run([], {}, { out: (s) => lines.push(s) }), 1);
  assert.match(lines.at(-1), /bucket configuration incomplete or invalid/);
});

test("hourly: an encrypted main dump at the hour's key; older than 48 h is pruned", async () => {
  const { recipient } = await keyPair();
  const src = await seededDb(t, "hourly-src.db", "main");
  const bucket = fakeBucketFetch();
  const now = Date.UTC(2026, 0, 10, 12, 30);
  bucket.objects.set(hourlyKey(now - 60 * 3_600_000), {
    bytes: new Uint8Array([1]),
    lastModified: "x",
  });
  bucket.objects.set(hourlyKey(now - 3_600_000), { bytes: new Uint8Array([1]), lastModified: "x" });
  const lines = [];
  const code = await run(
    ["--hourly"],
    {
      ...BUCKET_ENV,
      TURSO_MAIN_URL: "http://main.sqld:8080",
      TURSO_MAIN_TOKEN: "x",
      BACKUP_PUBLIC_KEY: recipient,
    },
    {
      fetchImpl: bucket.fetchImpl,
      nowMs: () => now,
      openDb: () => ({
        ...Object.create(null),
        transaction: (...a) => src.transaction(...a),
        execute: (...a) => src.execute(...a),
        close() {},
      }),
      out: (s) => lines.push(s),
    },
  );
  assert.equal(code, 0, lines.join("\n"));
  assert.match(lines[0], /^bucket-copy: ok hourly main=\d+B deleted=1$/);
  assert.ok(bucket.objects.has("hourly/main-20260110T1200Z.ndjson.gz.age"));
  assert.ok(bucket.objects.has(hourlyKey(now - 3_600_000)));
  assert.equal(bucket.objects.has(hourlyKey(now - 60 * 3_600_000)), false);
  // ciphertext only
  const got = bucket.objects.get("hourly/main-20260110T1200Z.ndjson.gz.age").bytes;
  assert.equal(Buffer.from(got).includes("DRILL-MARKER"), false);
});
