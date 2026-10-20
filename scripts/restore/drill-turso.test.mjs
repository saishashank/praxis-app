// M8 T7: the Turso restore drill and guarded restore, with a FAKE Platform API, local libSQL files
// and a synthetic throwaway key. No network, no real secret, no production data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { createClient } from "@libsql/client";
import { identityToRecipient } from "age-encryption";
import { decryptToText, encryptBytes } from "../backup/core.mjs";
import {
  cleanup,
  extractIdentity,
  finalCheck,
  guard,
  parseConfig,
  run,
  SPILL_DIR,
} from "./drill-turso.mjs";
import { buildSynthetic, SYNTH_MARKER } from "./synthetic.mjs";

const PLATFORM_TOKEN = "fake-platform-token-ZZZ999";
const DATA_TOKEN = "fake-data-repo-token-QQQ777";
const FAKE_HOST = "fake-host-1234.turso.io";
let dir;
let synth; // { identity, cipher }
let n = 0;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "praxis-drill-turso-"));
  synth = await buildSynthetic();
});
after(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows may hold a lock briefly; the folder only ever held synthetic data.
  }
});

/** A fake Platform API that remembers what was created and deleted. */
function fakePlatform({ failDelete = false, failToken = false } = {}) {
  const created = [];
  const deleted = [];
  return {
    created,
    deleted,
    async createDatabase(name) {
      created.push(name);
      return { name, url: `libsql://${name}-${FAKE_HOST}` };
    },
    async deleteDatabase(name) {
      if (failDelete) throw new Error("boom");
      deleted.push(name);
    },
    async createDatabaseToken() {
      if (failToken) throw new Error("boom");
      return "fake-db-token-JWT-555";
    },
  };
}

/** openDb: every distinct URL gets its own local libSQL file. */
function fakeOpenDb() {
  const files = new Map();
  return (url) => {
    if (!files.has(url)) files.set(url, path.join(dir, `t${++n}.db`));
    return createClient({ url: pathToFileURL(files.get(url)).href });
  };
}

const baseEnv = (extra = {}) => ({
  MODE: "drill",
  KEY_MODE: "throwaway",
  BACKUP_ENV: "staging",
  TARGETS: "both",
  TURSO_ORG: "my-org",
  TURSO_PLATFORM_TOKEN_TEMP: PLATFORM_TOKEN,
  ...extra,
});

async function exec(env, deps = {}) {
  const lines = [];
  const platform = deps.platform ?? fakePlatform();
  const code = await run(env, {
    out: (l) => lines.push(l),
    openDb: fakeOpenDb(),
    synthetic: async () => synth,
    suffix: () => `s${++n}x${n}`.padEnd(6, "0"),
    ...deps,
    platform,
  });
  return { code, text: lines.join("\n"), lines, platform };
}

function assertClean(text) {
  assert.doesNotMatch(text, /libsql:|https?:|turso\.io|\.db\b/i, "no URL");
  for (const s of [
    PLATFORM_TOKEN,
    DATA_TOKEN,
    "fake-db-token",
    FAKE_HOST,
    SYNTH_MARKER,
    "AGE-SECRET-KEY",
    synth.identity,
  ]) {
    assert.ok(!text.includes(s), `output leaks ${s.slice(0, 12)}`);
  }
  assert.doesNotMatch(text, /drill-owner|example\.test|"values"|\bAAA\b/);
}

test("synthetic drill: two throwaway DBs created, restored, verified, cohort NAV identical, both deleted", async () => {
  const r = await exec(baseEnv());
  assert.equal(r.code, 0, r.text);
  assert.equal(r.platform.created.length, 2);
  assert.deepEqual([...r.platform.deleted].sort(), [...r.platform.created].sort());
  assert.ok(r.platform.created.every((x) => /^drill-(main|auth)-/.test(x)));
  assert.match(r.text, /verify main: .*checksums PASS/);
  assert.match(r.text, /restore main: PASS/);
  assert.match(r.text, /restore auth: PASS/);
  assert.match(r.text, /cohort main: PASS NAV identical sessions=60/);
  assert.match(r.text, /delete: 2\/2 throwaway databases deleted/);
  assert.match(r.text, /drill: PASS elapsed .* \(RTO 4h: within\)/);
  assertClean(r.text);
});

test("checksum mismatch fails before any database is created", async () => {
  const recipient = await identityToRecipient(synth.identity);
  const text = await decryptToText(synth.cipher.main, synth.identity);
  const tampered = text.replace('"AAA"', '"ZZZ"'); // changes a row, keeps the stored checksum
  assert.notEqual(tampered, text);
  const cipher = {
    main: await encryptBytes(gzipSync(Buffer.from(tampered)), recipient),
    auth: synth.cipher.auth,
  };
  const r = await exec(baseEnv(), {
    synthetic: async () => ({ identity: synth.identity, cipher }),
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /run: FAIL backup stream rejected: checksum mismatch/);
  assert.equal(r.platform.created.length, 0);
  assert.match(r.text, /drill: FAIL/);
  assertClean(r.text);
});

test("a wrong key fails with a fixed message and creates nothing", async () => {
  const other = await buildSynthetic();
  const r = await exec(baseEnv(), {
    synthetic: async () => ({ identity: other.identity, cipher: synth.cipher }),
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /decryption failed/);
  assert.equal(r.platform.created.length, 0);
  assertClean(r.text);
});

test("a failed restore step still deletes the databases it created", async () => {
  const r = await exec(baseEnv(), { platform: fakePlatform({ failToken: true }) });
  assert.equal(r.code, 1);
  assert.equal(r.platform.created.length, 1);
  assert.equal(r.platform.deleted.length, 1);
  assert.match(r.text, /run: FAIL unexpected error/);
  assert.match(r.text, /delete: 1\/1 throwaway databases deleted/);
});

test("a database that cannot be deleted fails the run and is named for manual deletion", async () => {
  const r = await exec(baseEnv(), { platform: fakePlatform({ failDelete: true }) });
  assert.equal(r.code, 1);
  assert.match(r.text, /delete: FAIL delete these databases by hand .*drill-main-.*drill-auth-/);
  assert.match(r.text, /0\/2 throwaway databases deleted/);
  assertClean(r.text);
});

test("the platform token never appears even if a library error carries it", async () => {
  const platform = fakePlatform();
  platform.createDatabase = async () => {
    throw new Error(`HTTP failure for ${PLATFORM_TOKEN} at https://api.turso.tech`);
  };
  const r = await exec(baseEnv(), { platform });
  assert.equal(r.code, 1);
  assert.match(r.text, /unexpected error/);
  assertClean(r.text);
});

test("real-key drill: fake data repo, key from env, restore into throwaway DBs, then delete", async () => {
  const real = await buildSynthetic(); // plays the role of the real backups and the real key
  const reader = {
    async fetchBackup({ tag, names }) {
      assert.equal(tag, "");
      assert.equal(names.main("backup-2026-01-02"), "main-2026-01-02.ndjson.gz.age");
      return { tag: "backup-2026-01-02", data: real.cipher };
    },
  };
  const env = baseEnv({
    KEY_MODE: "real",
    BACKUP_ENV: "production",
    BACKUP_PRIVATE_KEY: `# created: x\n${real.identity}\n`,
    DATA_REPO: "me/praxis-app-data",
    DATA_REPO_TOKEN: DATA_TOKEN,
  });
  const r = await exec(env, { reader });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /source: backup-2026-01-02/);
  assert.equal(r.platform.deleted.length, 2);
  assertClean(r.text);
  assert.ok(!r.text.includes(real.identity));
});

test("restore mode is refused without the exact confirmation, with the throwaway key, or in staging", async () => {
  const env = baseEnv({
    MODE: "restore",
    KEY_MODE: "real",
    BACKUP_ENV: "production",
    BACKUP_PRIVATE_KEY: synth.identity,
    DATA_REPO: "me/praxis-app-data",
    DATA_REPO_TOKEN: DATA_TOKEN,
  });
  for (const confirm of [undefined, "", "restore", "yes"]) {
    const r = await exec({ ...env, CONFIRM: confirm });
    assert.equal(r.code, 1, `confirm=${confirm}`);
    assert.match(r.text, /confirm input must be exactly RESTORE/);
    assert.equal(r.platform.created.length, 0);
  }
  const t = await exec({ ...env, CONFIRM: "RESTORE", KEY_MODE: "throwaway" });
  assert.match(t.text, /not the throwaway key/);
  const s = await exec({ ...env, CONFIRM: "RESTORE", BACKUP_ENV: "staging" });
  assert.match(s.text, /production environment only/);
  assert.equal(
    guard({ ...env, CONFIRM: "" }, () => {}),
    1,
  );
});

test("confirmed restore keeps the NEW databases, prints their names only, deletes nothing", async () => {
  const reader = {
    async fetchBackup() {
      return { tag: "backup-2026-01-02", data: synth.cipher };
    },
  };
  const env = baseEnv({
    MODE: "restore",
    KEY_MODE: "real",
    BACKUP_ENV: "production",
    CONFIRM: "RESTORE",
    BACKUP_PRIVATE_KEY: synth.identity,
    DATA_REPO: "me/praxis-app-data",
    DATA_REPO_TOKEN: DATA_TOKEN,
  });
  const r = await exec(env, { reader });
  assert.equal(r.code, 0, r.text);
  assert.equal(r.platform.created.length, 2);
  assert.ok(r.platform.created.every((x) => /^restore-(main|auth)-20260102/.test(x)));
  assert.equal(r.platform.deleted.length, 0);
  assert.match(r.text, /new database\(s\) kept: main=restore-main-.*, auth=restore-auth-/);
  assert.match(r.text, /restore: PASS/);
  assert.doesNotMatch(r.text, /cohort/, "no check cohort on a real restore");
  assertClean(r.text);
});

test("a failed restore deletes the half-created new databases", async () => {
  const env = baseEnv({
    MODE: "restore",
    KEY_MODE: "real",
    BACKUP_ENV: "production",
    CONFIRM: "RESTORE",
    BACKUP_PRIVATE_KEY: synth.identity,
    DATA_REPO: "me/praxis-app-data",
    DATA_REPO_TOKEN: DATA_TOKEN,
  });
  const reader = {
    async fetchBackup() {
      return { tag: "backup-2026-01-02", data: synth.cipher };
    },
  };
  const r = await exec(env, { reader, platform: fakePlatform({ failToken: true }) });
  assert.equal(r.code, 1);
  assert.equal(r.platform.deleted.length, r.platform.created.length);
  assert.doesNotMatch(r.text, /kept/);
});

test("parseConfig rejects bad inputs with fixed messages", () => {
  assert.throws(() => parseConfig(baseEnv({ MODE: "other" })), /mode must be/);
  assert.throws(() => parseConfig(baseEnv({ TARGETS: "x" })), /unknown value/);
  assert.throws(() => parseConfig(baseEnv({ BACKUP_TAG: "latest" })), /backup-YYYY-MM-DD/);
  assert.throws(
    () => parseConfig(baseEnv({ TURSO_PLATFORM_TOKEN_TEMP: "" })),
    /TURSO_PLATFORM_TOKEN_TEMP is missing/,
  );
  assert.throws(
    () => parseConfig(baseEnv({ KEY_MODE: "real", BACKUP_ENV: "production" })),
    /BACKUP_PRIVATE_KEY is missing/,
  );
  const ok = parseConfig(baseEnv({ TARGETS: "main" }));
  assert.deepEqual(ok.targets, ["main"]);
});

test("extractIdentity takes the secret key line and nothing else", () => {
  assert.equal(extractIdentity(`# comment\n${synth.identity}\n`), synth.identity);
  assert.equal(extractIdentity("age1publickeyonly"), null);
  assert.equal(extractIdentity(""), null);
});

test("guard: missing secrets fail with names only; present secrets pass and write outputs", () => {
  const lines = [];
  const outFile = path.join(dir, "gh-output.txt");
  writeFileSync(outFile, "");
  assert.equal(
    guard({ MODE: "drill", KEY_MODE: "real" }, (l) => lines.push(l)),
    1,
  );
  assert.match(lines.join(), /missing secret\(s\): TURSO_PLATFORM_TOKEN_TEMP, BACKUP_PRIVATE_KEY/);
  const ok = guard(
    {
      MODE: "drill",
      KEY_MODE: "real",
      BACKUP_PRIVATE_KEY: "k-secret",
      TURSO_PLATFORM_TOKEN_TEMP: "t-secret",
      GITHUB_OUTPUT: outFile,
    },
    (l) => lines.push(l),
  );
  assert.equal(ok, 0);
  assert.equal(readFileSync(outFile, "utf8"), "key=present\ntoken=present\n");
  assert.ok(!lines.join().includes("k-secret") && !lines.join().includes("t-secret"));
  // throwaway: the private key is not required
  assert.equal(
    guard({ MODE: "drill", KEY_MODE: "throwaway", TURSO_PLATFORM_TOKEN_TEMP: "t" }, () => {}),
    0,
  );
});

test("final check: FAILS while the temporary key or token exists, passes when both are gone", () => {
  const lines = [];
  const out = (l) => lines.push(l);
  assert.equal(
    finalCheck({ BACKUP_PRIVATE_KEY: "k-secret", TURSO_PLATFORM_TOKEN_TEMP: "" }, out),
    1,
  );
  assert.equal(
    finalCheck({ BACKUP_PRIVATE_KEY: "", TURSO_PLATFORM_TOKEN_TEMP: "t-secret" }, out),
    1,
  );
  assert.equal(finalCheck({ BACKUP_PRIVATE_KEY: "k", TURSO_PLATFORM_TOKEN_TEMP: "t" }, out), 1);
  assert.match(lines[2], /BACKUP_PRIVATE_KEY, TURSO_PLATFORM_TOKEN_TEMP/);
  assert.ok(!lines.join().includes("k-secret") && !lines.join().includes("t-secret"));
  assert.equal(finalCheck({}, out), 0);
  assert.equal(
    finalCheck({ BACKUP_PRIVATE_KEY: "  ", TURSO_PLATFORM_TOKEN_TEMP: undefined }, out),
    0,
  );
});

test("cleanup removes the plaintext temp folder and is harmless when absent", () => {
  const temp = mkdtempSync(path.join(dir, "runner-"));
  const spill = path.join(temp, SPILL_DIR);
  mkdirSync(spill);
  writeFileSync(path.join(spill, "main.ndjson"), "plaintext");
  assert.equal(
    cleanup({ RUNNER_TEMP: temp }, () => {}),
    0,
  );
  assert.equal(existsSync(spill), false);
  assert.equal(
    cleanup({ RUNNER_TEMP: temp }, () => {}),
    0,
  );
  assert.equal(
    cleanup({}, () => {}),
    0,
  );
});

test("the run writes no plaintext file: the temp folders stay empty", async () => {
  const temp = mkdtempSync(path.join(dir, "runner2-"));
  const before = existsSync(path.join(temp, SPILL_DIR));
  const r = await exec(baseEnv({ RUNNER_TEMP: temp }));
  assert.equal(r.code, 0);
  assert.equal(before, false);
  assert.equal(existsSync(path.join(temp, SPILL_DIR)), false);
});
