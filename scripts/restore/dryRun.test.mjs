// OPS-105 (D-962; AT-83 "restore dry run"): the restore drill into LOCAL libSQL files (TARGET=local), end
// to end on synthetic data with a throwaway key. No platform token, no organisation, no network (fetch is
// replaced by a function that fails the test if anything calls it), no secret name in the output.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { assetName } from "../backup/core.mjs";
import { SYNTH_MARKER, buildSynthetic } from "./synthetic.mjs";
import { parseConfig, readLocalBackup, record, run } from "./drill-turso.mjs";

let dir;
let synth;
const realFetch = globalThis.fetch;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "praxis-dryrun-"));
  synth = await buildSynthetic();
  globalThis.fetch = () => {
    throw new Error("network call in a local dry run");
  };
});
after(() => {
  globalThis.fetch = realFetch;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows may hold a lock briefly; the folder only ever held synthetic data.
  }
});

const lines = (fn) => {
  const out = [];
  return Promise.resolve(fn((l) => out.push(l))).then((code) => ({ code, out }));
};
const localEnv = (extra = {}) => ({
  MODE: "drill",
  KEY_MODE: "throwaway",
  TARGET: "local",
  TARGETS: "both",
  RUNNER_TEMP: dir,
  ...extra,
});
// Windows keeps a closed libSQL file locked until the process ends; the drill then removes the folder at exit
const leftovers = () =>
  process.platform === "win32"
    ? []
    : readdirSync(dir).filter((n) => n.startsWith("praxis-drill-local-"));

test("config: a local target needs no organisation and no platform token; restore is refused", () => {
  const cfg = parseConfig(localEnv());
  assert.equal(cfg.target, "local");
  assert.equal(cfg.org, "");
  assert.equal(cfg.platformToken, "");
  assert.throws(
    () => parseConfig(localEnv({ MODE: "restore", KEY_MODE: "real", CONFIRM: "RESTORE" })),
    /not possible into a local/,
  );
  // the default target is unchanged: Turso, which still needs both
  assert.throws(() => parseConfig({ MODE: "drill", KEY_MODE: "throwaway" }), /TURSO_ORG/);
  assert.throws(() => parseConfig(localEnv({ TARGET: "elsewhere" })), /unknown value/);
});

test("dry run: both databases restore from synthetic backups, the cohort replays, the files are removed", async () => {
  const { code, out } = await lines((o) => run(localEnv(), { out: o }));
  assert.equal(code, 0, out.join("\n"));
  const text = out.join("\n");
  assert.match(text, /source: synthetic build-phase data, throwaway key/);
  assert.match(text, /restore main: PASS/);
  assert.match(text, /restore auth: PASS/);
  assert.match(text, /cohort main: PASS NAV identical/);
  assert.match(text, /delete: 2\/2 local databases removed/);
  assert.match(text, /drill: PASS elapsed/);
  assert.deepEqual(leftovers(), []);
  // names and counts only: no row content, no secret name, no URL
  assert.ok(!text.includes(SYNTH_MARKER));
  assert.doesNotMatch(text, /TURSO_PLATFORM_TOKEN|BACKUP_PRIVATE_KEY|DATA_REPO|libsql:|https?:/);
});

test("dry run from a backup folder: the real-key path reads local files, nothing leaves the machine", async () => {
  const backups = path.join(dir, "backups");
  mkdirSync(backups);
  for (const db of ["main", "auth"]) {
    writeFileSync(path.join(backups, assetName(db, "2026-10-01")), synth.cipher[db]);
    writeFileSync(path.join(backups, assetName(db, "2026-10-02")), synth.cipher[db]);
  }
  writeFileSync(path.join(backups, assetName("main", "2026-10-03")), synth.cipher.main); // incomplete: no auth
  const env = localEnv({
    KEY_MODE: "real",
    BACKUP_DIR: backups,
    BACKUP_PRIVATE_KEY: synth.identity,
  });
  const { code, out } = await lines((o) => run(env, { out: o }));
  assert.equal(code, 0, out.join("\n"));
  const text = out.join("\n");
  assert.match(text, /source: backup-2026-10-02/); // the newest date with both files
  assert.match(text, /restore main: PASS/);
  assert.match(text, /delete: 2\/2 local databases removed/);
  assert.ok(!text.includes(synth.identity), "the key is scrubbed from every line");
  assert.ok(!text.includes(backups), "the folder path is never printed");
  assert.deepEqual(leftovers(), []);
  // a named tag selects that date; an unknown one is refused
  const named = await lines((o) => run({ ...env, BACKUP_TAG: "backup-2026-10-01" }, { out: o }));
  assert.equal(named.code, 0);
  assert.match(named.out.join("\n"), /source: backup-2026-10-01/);
  const missing = await lines((o) => run({ ...env, BACKUP_TAG: "backup-2025-01-01" }, { out: o }));
  assert.equal(missing.code, 1);
  assert.match(missing.out.join("\n"), /no backup found in the folder/);
});

test("a damaged key or an empty folder fails closed and leaves nothing behind", async () => {
  const empty = path.join(dir, "empty");
  mkdirSync(empty);
  const none = await lines((o) =>
    run(localEnv({ KEY_MODE: "real", BACKUP_DIR: empty, BACKUP_PRIVATE_KEY: synth.identity }), {
      out: o,
    }),
  );
  assert.equal(none.code, 1);
  assert.match(none.out.join("\n"), /run: FAIL no backup found in the folder/);
  assert.throws(() => readLocalBackup(path.join(dir, "missing"), { names: {} }), /not readable/);
  assert.deepEqual(leftovers(), []);
});

test("record: one run_record row per successful run; verify-removed only while both secrets are gone", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE run_record (id INTEGER PRIMARY KEY, job TEXT NOT NULL, market TEXT,
    concurrency_key TEXT NOT NULL, scheduled_for TEXT, started_at TEXT NOT NULL, ended_at TEXT,
    status TEXT NOT NULL, items_processed INTEGER NOT NULL DEFAULT 0, details_json TEXT)`);
  await db.execute(
    "CREATE UNIQUE INDEX uq ON run_record (concurrency_key) WHERE status = 'success'",
  );
  const now = () => new Date("2026-11-12T01:02:03.000Z");
  const env = { TURSO_MAIN_URL: "libsql://x", TURSO_MAIN_TOKEN: "t" };
  const go = (extra) =>
    lines((o) =>
      record({ ...env, ...extra }, o, {
        now,
        connect: () => ({ execute: (q) => db.execute(q), close() {} }),
      }),
    );

  let r = await go({ MODE: "drill", KEY_MODE: "real" });
  assert.equal(r.code, 0);
  assert.match(r.out.join(""), /record: ok \(drill, real key\)/);
  r = await go({ MODE: "drill", KEY_MODE: "real" }); // the same run twice writes one row
  const rows = (await db.execute("SELECT job, concurrency_key, details_json FROM run_record")).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].job, "restore-drill");
  assert.deepEqual(JSON.parse(String(rows[0].details_json)), { keyMode: "real", mode: "drill" });

  r = await go({
    MODE: "verify-removed",
    KEY_MODE: "real",
    BACKUP_PRIVATE_KEY: "AGE-SECRET-KEY-1X",
  });
  assert.match(r.out.join(""), /skipped \(a temporary restore secret is still present\)/);
  assert.equal((await db.execute("SELECT 1 FROM run_record")).rows.length, 1);
  r = await go({ MODE: "verify-removed", KEY_MODE: "real" });
  assert.equal(r.code, 0);
  assert.equal((await db.execute("SELECT 1 FROM run_record")).rows.length, 2);

  assert.equal((await go({ MODE: "bogus" })).code, 1);
  const none = await lines((o) => record({ MODE: "drill" }, o));
  assert.equal(none.code, 0); // no database access configured: said, not failed
  assert.match(none.out.join(""), /database access is not set/);
  const bad = await lines((o) =>
    record({ ...env, MODE: "drill", KEY_MODE: "throwaway" }, o, {
      now,
      connect: () => ({
        execute: async () => {
          throw new Error("boom");
        },
      }),
    }),
  );
  assert.equal(bad.code, 1);
  assert.match(bad.out.join(""), /could not be written/);
});
