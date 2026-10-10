// Local database restore (OPS-040, NFR-004, TST-108, AT-04). Run by the Owner on their own PC
// (or by the build agent with the Owner present). NEVER runs in GitHub Actions: the backup is
// encrypted to the Owner's OFFLINE key and the private key is never stored on GitHub
// (SEC-108 f, PLT-022b), so decryption happens locally first (owner guide, section I) and this
// script only reads the resulting plaintext `<db>-<date>.ndjson.gz`.
// Usage: node scripts/restore/restore.mjs --file main-2026-01-02.ndjson.gz --db main|auth [--dry-run]
// env (real run only): RESTORE_TARGET_URL, RESTORE_TARGET_TOKEN = a NEW EMPTY database created
//   at Turso for this restore. Refused when the URL equals the live database of this shell
//   (TURSO_MAIN_URL / TURSO_AUTH_URL and their *_PROD forms) when those variables are present.
// Steps: read -> gunzip (size capped) -> parseBackup (structure, counts, sha256; nothing written)
//   -> check --db matches the dump -> target must be EMPTY -> restoreDatabase (one atomic batch,
//   re-reads and compares counts + sha256) -> PASS/FAIL table.
// Output: table names, counts, status, elapsed time. Never a URL, a token, a path of the key or
// any row content. Opus reviews every line (production data).
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { looksLikeAge, parseBackup, restoreDatabase } from "../backup/core.mjs";

const MAX_PLAINTEXT_BYTES = 2 ** 30;
const LIVE_URL_VARS = [
  "TURSO_MAIN_URL",
  "TURSO_AUTH_URL",
  "TURSO_MAIN_URL_PROD",
  "TURSO_AUTH_URL_PROD",
];
const has = (v) => typeof v === "string" && v.trim() !== "";
const safeName = (s) =>
  String(s)
    .replace(/[^A-Za-z0-9_.-]/g, "?")
    .slice(0, 64);

class RestoreError extends Error {}
const refuse = (why) => {
  throw new RestoreError(why);
};

/** Compare two database URLs ignoring scheme, case, query and trailing slashes. */
export function sameDatabase(a, b) {
  const norm = (u) =>
    String(u)
      .trim()
      .toLowerCase()
      .replace(/^(libsql|https|http|wss|ws):\/\//, "")
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "");
  return norm(a) !== "" && norm(a) === norm(b);
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { file: "", db: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--file" && i + 1 < argv.length) out.file = argv[++i];
    else if (a === "--db" && i + 1 < argv.length) out.db = argv[++i];
    else refuse("usage: --file <db>-<date>.ndjson.gz --db main|auth [--dry-run]");
  }
  if (!has(out.file)) refuse("usage: --file is required");
  if (out.db !== "main" && out.db !== "auth") refuse("usage: --db must be main or auth");
  return out;
}

function readDump(file) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    refuse("cannot read the file");
  }
  if (looksLikeAge(bytes)) {
    refuse("the file is still encrypted (.age): decrypt it locally first (owner guide, section I)");
  }
  try {
    return gunzipSync(bytes, { maxOutputLength: MAX_PLAINTEXT_BYTES }).toString("utf8");
  } catch {
    return refuse("the file is not a gzip file (expected <db>-<date>.ndjson.gz)");
  }
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {{
 *   openDb?: (url: string, token: string) => import("@libsql/client").Client,
 *   now?: () => number,
 *   out?: (s: string) => void,
 * }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, env, deps = {}) {
  const openDb = deps.openDb ?? ((url, authToken) => createClient({ url, authToken }));
  const now = deps.now ?? (() => Date.now());
  const out = deps.out ?? ((s) => console.log(s));
  const started = now();
  const elapsed = () => {
    const s = Math.round((now() - started) / 1000);
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  };
  let db;
  try {
    const args = parseArgs(argv);
    const text = readDump(args.file);
    const parsed = parseBackup(text); // throws BackupError: class only, no rows
    if (parsed.meta.db !== args.db)
      refuse(`the dump is the ${parsed.meta.db} database, not ${args.db}`);
    const tables = parsed.meta.tables;
    const total = tables.reduce((n, t) => n + parsed.end.counts[t], 0);

    if (args.dryRun) {
      out(
        `restore: DRY RUN ok db=${args.db} schema_version=${parsed.meta.schema_version} tables=${tables.length} rows=${total}`,
      );
      for (const t of tables)
        out(`  ${safeName(t)}  rows=${parsed.end.counts[t]}  checksum=verified`);
      out(`restore: nothing was written. elapsed ${elapsed()}`);
      return 0;
    }

    const url = env.RESTORE_TARGET_URL;
    const token = env.RESTORE_TARGET_TOKEN;
    if (!has(url)) refuse("RESTORE_TARGET_URL is not set");
    for (const v of LIVE_URL_VARS) {
      if (has(env[v]) && sameDatabase(url, env[v])) {
        refuse("the target is the live database; create a NEW empty database for the restore");
      }
    }
    if (!/^file:/i.test(url.trim()) && !has(token)) refuse("RESTORE_TARGET_TOKEN is not set");

    db = openDb(url.trim(), has(token) ? token.trim() : "");
    let existing;
    try {
      existing = await db.execute(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
      );
    } catch {
      refuse("cannot reach the target database (check the URL and token)");
    }
    if (Number(existing.rows[0].c) !== 0) refuse("the target database is not empty");

    let result;
    try {
      result = await restoreDatabase(db, text);
    } catch (e) {
      if (e instanceof RestoreError || /^backup stream rejected:/.test(String(e?.message))) throw e;
      return refuse("the restore failed and was rolled back (the batch is atomic)");
    }

    let ok = true;
    out(`restore: table                      dump_rows  restored_rows  sha256`);
    for (const t of tables) {
      const same =
        result.counts[t] === parsed.end.counts[t] && result.sha256[t] === parsed.end.sha256[t];
      ok &&= same;
      out(
        `  ${safeName(t).padEnd(26)} ${String(parsed.end.counts[t]).padStart(9)}  ${String(result.counts[t]).padStart(13)}  ${same ? "PASS" : "FAIL"}`,
      );
    }
    out(
      `restore: ${ok ? "PASS" : "FAIL"} db=${args.db} tables=${tables.length} rows=${total} elapsed ${elapsed()}`,
    );
    return ok ? 0 : 1;
  } catch (e) {
    const msg =
      e instanceof RestoreError || /^backup stream rejected:/.test(String(e?.message))
        ? e.message
        : "unexpected error";
    out(`restore: FAIL ${msg}. elapsed ${elapsed()}`);
    return 1;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
