// Local database restore (OPS-040, NFR-004, TST-108, AT-04). Run by the Owner on their own PC
// (or by the build agent with the Owner present). NEVER runs in GitHub Actions: the backup is
// encrypted to the Owner's OFFLINE key and the private key is never stored on GitHub
// (SEC-108 f, PLT-022b), so decryption happens locally first (owner guide, section I) and this
// script only reads the resulting plaintext `<db>-<date>.ndjson.gz`.
// Usage: node scripts/restore/restore.mjs --file main-2026-01-02.ndjson.gz --db main|auth [--dry-run]
//          [--target turso|sqld] [--namespace <ns>]
// --target sqld (INFRA T4): the target is a namespace of the self-hosted sqld. Give the full
//   RESTORE_TARGET_URL (e.g. http://main.sqld:8080), or SQLD_URL + --namespace (default: the --db
//   name; SQLD_NS_MODE=subdomain|host). The token is optional (only when sqld verifies JWTs). The
//   live-URL refusal below is for Turso; on sqld the "target must be EMPTY" rule is the guard (a
//   fresh server's main namespace is the very thing a bootstrap restores into). After the restore
//   the foreign-key pragma and foreign_key_check are verified. The default target stays turso.
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
import { connectionCheck, namespaceTarget, NS_RE, openNamespace } from "../selfhost/sqld.mjs";

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
  const out = { file: "", db: "", dryRun: false, target: "turso", namespace: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--file" && i + 1 < argv.length) out.file = argv[++i];
    else if (a === "--db" && i + 1 < argv.length) out.db = argv[++i];
    else if (a === "--target" && i + 1 < argv.length) out.target = argv[++i];
    else if (a === "--namespace" && i + 1 < argv.length) out.namespace = argv[++i];
    else
      refuse(
        "usage: --file <db>-<date>.ndjson.gz --db main|auth [--dry-run] [--target turso|sqld] [--namespace <ns>]",
      );
  }
  if (!has(out.file)) refuse("usage: --file is required");
  if (out.db !== "main" && out.db !== "auth") refuse("usage: --db must be main or auth");
  if (out.target !== "turso" && out.target !== "sqld") {
    refuse("usage: --target must be turso or sqld");
  }
  if (out.namespace !== "" && (out.target !== "sqld" || !NS_RE.test(out.namespace))) {
    refuse("usage: --namespace needs --target sqld and a plain namespace name");
  }
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
  const openDb =
    deps.openDb ??
    // Lossless integers (D-175): the restore re-dumps to verify, and cohort.rng_seed is 64-bit.
    ((url, authToken, host) =>
      host
        ? openNamespace({
            base: url,
            ns: host.split(".")[0],
            token: authToken,
            mode: "host",
            intMode: "bigint",
          })
        : createClient({ url, authToken, intMode: "bigint" }));
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

    const sqld = args.target === "sqld";
    let url = env.RESTORE_TARGET_URL;
    const token = env.RESTORE_TARGET_TOKEN;
    let host = null; // sqld host mode: the Host header that selects the namespace
    // RESTORE_TARGET_URL names the target in full; a --namespace next to it would be ignored silently (review S11)
    if (sqld && args.namespace !== "" && has(url)) {
      refuse("--namespace cannot be combined with RESTORE_TARGET_URL (use SQLD_URL + --namespace)");
    }
    if (sqld && !has(url) && has(env.SQLD_URL)) {
      const mode = env.SQLD_NS_MODE === "host" ? "host" : "subdomain";
      const t = namespaceTarget(env.SQLD_URL, args.namespace || args.db, mode);
      url = t.url;
      host = t.host;
    }
    if (!has(url)) refuse("RESTORE_TARGET_URL is not set");
    // --target sqld skips the live-URL check below, so it must never point at Turso.
    if (sqld && /turso\.io/i.test(url))
      refuse("--target sqld cannot restore into a Turso database");
    if (!sqld) {
      for (const v of LIVE_URL_VARS) {
        if (has(env[v]) && sameDatabase(url, env[v])) {
          refuse("the target is the live database; create a NEW empty database for the restore");
        }
      }
      if (!/^file:/i.test(url.trim()) && !has(token)) refuse("RESTORE_TARGET_TOKEN is not set");
    }

    db = openDb(url.trim(), has(token) ? token.trim() : "", host);
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
    if (sqld) {
      const fk = await connectionCheck(db);
      const fkOk = fk.foreignKeys && fk.violations === 0;
      ok &&= fkOk;
      out(
        `restore: foreign keys ${fk.foreignKeys ? "ON" : "OFF"}, orphan rows ${fk.violations} ${fkOk ? "PASS" : "FAIL"}`,
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
