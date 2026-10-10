// OPS-040, NFR-004, TST-108, AT-04: the local restore script. Local libSQL temp files only; no
// network, no credentials.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { createClient } from "@libsql/client";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { dumpDatabase } from "../backup/core.mjs";
import { run, sameDatabase } from "./restore.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const script = path.join(here, "restore.mjs");
const MARKER = "RESTORE-MARKER-5d2e91";
let dir;
let dumpFile; // main dump, gzip
let dump;
let n = 0;

const fileUrl = (name) => pathToFileURL(path.join(dir, name)).href;
const client = (name) => createClient({ url: fileUrl(name) });
const nextTarget = () => `target-${++n}.db`;

async function exec(argv, env, extra = {}) {
  const lines = [];
  const code = await run(argv, env, { out: (l) => lines.push(l), ...extra });
  return { code, text: lines.join("\n"), lines };
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "praxis-restore-"));
  const src = client("source.db");
  await migrateUp(src, await loadMigrations(path.join(root, "db", "migrations", "main")));
  await src.execute("CREATE TABLE misc (id INTEGER PRIMARY KEY, label TEXT, b BLOB, r REAL)");
  await src.execute({
    sql: "INSERT INTO misc (label, b, r) VALUES (?, ?, ?)",
    args: [`${MARKER} Zoë 日本語 "q"\nline`, new Uint8Array([0, 1, 255]), 2.5],
  });
  await src.execute({
    sql: "INSERT INTO misc (label, b, r) VALUES (?, ?, ?)",
    args: [null, null, null],
  });
  dump = await dumpDatabase(src, { name: "main", createdAt: "2026-01-02T03:04:05.678Z" });
  src.close();
  dumpFile = path.join(dir, "main-2026-01-02.ndjson.gz");
  writeFileSync(dumpFile, gzipSync(Buffer.from(dump.text, "utf8")));
});

after(() => {
  // Best effort: on Windows libsql may keep a handle on a temp file until the process exits.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // synthetic data only; the OS temp folder is cleaned later
  }
});

test("round trip into an empty file database: PASS, same counts and checksums, elapsed printed", async () => {
  const t = nextTarget();
  const r = await exec(["--file", dumpFile, "--db", "main"], { RESTORE_TARGET_URL: fileUrl(t) });
  assert.equal(r.code, 0);
  assert.match(r.text, /restore: PASS db=main/);
  assert.match(r.text, /elapsed \d+m\d{2}s/);
  assert.match(r.text, /misc\s+2\s+2\s+PASS/);
  const db = client(t);
  const again = await dumpDatabase(db, { name: "main", createdAt: "2026-01-02T03:04:05.678Z" });
  db.close();
  assert.deepEqual(again.counts, dump.counts);
  assert.deepEqual(again.sha256, dump.sha256);
});

test("elapsed time uses the injected clock", async () => {
  let t = 1_000_000;
  const r = await exec(
    ["--file", dumpFile, "--db", "main", "--dry-run"],
    {},
    { now: () => (t += 61_000) },
  );
  assert.equal(r.code, 0);
  assert.match(r.text, /elapsed 1m01s/);
});

test("refuses a non-empty target and leaves it unchanged", async () => {
  const t = nextTarget();
  const db = client(t);
  await db.execute("CREATE TABLE other (x INTEGER)");
  await db.execute("INSERT INTO other VALUES (1)");
  const r = await exec(["--file", dumpFile, "--db", "main"], { RESTORE_TARGET_URL: fileUrl(t) });
  assert.equal(r.code, 1);
  assert.match(r.text, /not empty/);
  const tables = await db.execute("SELECT name FROM sqlite_master");
  db.close();
  assert.deepEqual(
    tables.rows.map((x) => x.name),
    ["other"],
  );
});

test("refuses a target equal to a live URL (any case, trailing slash), writes nothing", async () => {
  const t = nextTarget();
  const live = fileUrl(t);
  for (const v of ["TURSO_MAIN_URL", "TURSO_AUTH_URL", "TURSO_MAIN_URL_PROD"]) {
    const r = await exec(["--file", dumpFile, "--db", "main"], {
      RESTORE_TARGET_URL: live,
      [v]: `${live.toUpperCase().replace(/^FILE/, "file")}/`,
    });
    assert.equal(r.code, 1, v);
    assert.match(r.text, /live database/);
  }
  assert.equal(sameDatabase("libsql://Abc-x.turso.io", "https://abc-x.turso.io/"), true);
  assert.equal(sameDatabase("libsql://a.turso.io", "libsql://b.turso.io"), false);
  const db = client(t);
  const r = await db.execute("SELECT COUNT(*) AS c FROM sqlite_master");
  db.close();
  assert.equal(Number(r.rows[0].c), 0);
});

test("refuses a tampered dump before writing anything", async () => {
  const bad = dump.text.replace(MARKER, "TAMPERED-MARKER-xxxxx");
  assert.notEqual(bad, dump.text);
  const f = path.join(dir, "main-tampered.ndjson.gz");
  writeFileSync(f, gzipSync(Buffer.from(bad, "utf8")));
  const t = nextTarget();
  const r = await exec(["--file", f, "--db", "main"], { RESTORE_TARGET_URL: fileUrl(t) });
  assert.equal(r.code, 1);
  assert.match(r.text, /checksum mismatch/);
  const db = client(t);
  const c = await db.execute("SELECT COUNT(*) AS c FROM sqlite_master");
  db.close();
  assert.equal(Number(c.rows[0].c), 0);
});

test("refuses wrong --db, an encrypted file, a non-gzip file, a missing file and missing env", async () => {
  const env = { RESTORE_TARGET_URL: fileUrl(nextTarget()) };
  assert.match(
    (await exec(["--file", dumpFile, "--db", "auth"], env)).text,
    /main database, not auth/,
  );
  const age = path.join(dir, "x.age");
  writeFileSync(age, Buffer.concat([Buffer.from("age-encryption.org/v1\n"), Buffer.alloc(40)]));
  assert.match((await exec(["--file", age, "--db", "main"], env)).text, /still encrypted/);
  const plain = path.join(dir, "plain.txt");
  writeFileSync(plain, "hello");
  assert.match((await exec(["--file", plain, "--db", "main"], env)).text, /not a gzip/);
  assert.match(
    (await exec(["--file", path.join(dir, "nope.gz"), "--db", "main"], env)).text,
    /cannot read/,
  );
  assert.match(
    (await exec(["--file", dumpFile, "--db", "main"], {})).text,
    /RESTORE_TARGET_URL is not set/,
  );
  assert.match(
    (
      await exec(["--file", dumpFile, "--db", "main"], {
        RESTORE_TARGET_URL: "libsql://x.turso.io",
      })
    ).text,
    /RESTORE_TARGET_TOKEN is not set/,
  );
  assert.match((await exec(["--db", "main"], env)).text, /usage/);
  assert.match((await exec(["--file", dumpFile, "--db", "main", "--bogus"], env)).text, /usage/);
});

test("dry-run verifies and touches nothing (no database opened, no env needed)", async () => {
  let opened = 0;
  const r = await exec(
    ["--file", dumpFile, "--db", "main", "--dry-run"],
    {},
    {
      openDb: () => {
        opened++;
        throw new Error("must not open");
      },
    },
  );
  assert.equal(r.code, 0);
  assert.equal(opened, 0);
  assert.match(r.text, /DRY RUN ok db=main/);
  assert.match(r.text, /nothing was written/);
  // a dry run of a tampered file fails too
  const bad = path.join(dir, "main-tampered-dry.ndjson.gz");
  writeFileSync(bad, gzipSync(Buffer.from(dump.text.replace(MARKER, "TAMPERED-MARKER-xxxxx"))));
  assert.equal((await exec(["--file", bad, "--db", "main", "--dry-run"], {})).code, 1);
});

test("output never contains the URL, token or row content (success and failures)", async () => {
  // Generated per run so no token-shaped literal sits in the repo (gitleaks).
  const SECRET_TOKEN = `fake-${randomBytes(24).toString("hex")}`;
  const env = { RESTORE_TARGET_URL: fileUrl(nextTarget()), RESTORE_TARGET_TOKEN: SECRET_TOKEN };
  const outs = [
    await exec(["--file", dumpFile, "--db", "main"], env), // success
    await exec(["--file", dumpFile, "--db", "main"], env), // now non-empty
    await exec(["--file", dumpFile, "--db", "main", "--dry-run"], env),
    await exec(["--file", dumpFile, "--db", "main"], {
      RESTORE_TARGET_URL: "libsql://nowhere-secret-host.invalid",
      RESTORE_TARGET_TOKEN: SECRET_TOKEN,
    }),
  ];
  assert.equal(outs[0].code, 0);
  assert.equal(outs[1].code, 1);
  assert.equal(outs[3].code, 1);
  for (const o of outs) {
    assert.equal(o.text.includes(SECRET_TOKEN), false);
    assert.equal(o.text.includes(MARKER) || o.text.includes("Zoë"), false);
    assert.equal(/file:|libsql:|nowhere-secret-host|praxis-restore-/.test(o.text), false);
  }
});

test("CLI: exits 0 on a good restore, non-zero on failure, prints no URL", () => {
  const url = fileUrl(nextTarget());
  const out = execFileSync(process.execPath, [script, "--file", dumpFile, "--db", "main"], {
    encoding: "utf8",
    env: { ...process.env, RESTORE_TARGET_URL: url, TURSO_MAIN_URL: "", TURSO_AUTH_URL: "" },
  });
  assert.match(out, /restore: PASS/);
  assert.equal(out.includes(url), false);
  assert.throws(() =>
    execFileSync(process.execPath, [script, "--file", dumpFile, "--db", "main"], {
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, RESTORE_TARGET_URL: url },
    }),
  );
});
