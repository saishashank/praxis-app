// INFRA T5 (REQ\infra\INFRA_REQUIREMENT.md §15.2 step 6): find the NEWEST backup among the three
// copies (bucket hourly, bucket nightly, data-repo nightly), fetch it, decrypt it and (optionally)
// restore it into a sqld namespace. Used by `praxis restore-latest` and bootstrap.sh.
//
// Usage: node scripts/selfhost/latest-backup.mjs --db main|auth|both [--restore]
//   without --restore it only lists the candidates found (source, name, time, size).
//   --restore: fetch newest -> age-decrypt in memory -> restoreVerified into the sqld namespace
//   (target must be EMPTY; counts + sha256 + foreign keys verified). A candidate that fails to
//   download, decrypt or verify is skipped and the next newest is tried.
// env: bucket (BACKUP_BUCKET_*) and/or data repo (DATA_REPO, DATA_REPO_TOKEN); a copy whose
//   configuration is absent is skipped. BACKUP_PRIVATE_KEY (AGE-SECRET-KEY-1..., supplied by the
//   operator for this command only; never stored on the server) or BACKUP_PRIVATE_KEY_FILE.
//   Target (--restore): SQLD_URL [+ SQLD_NS_MODE=subdomain|host] [+ SQLD_ADMIN_URL, SQLD_ADMIN_AUTH]
//   or TURSO_MAIN_URL / TURSO_AUTH_URL (the namespace URLs), token SQLD_TOKEN or TURSO_*_TOKEN.
// Output: sources, names, sizes, counts, PASS/FAIL. Never a URL, key or row content.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { assetName, decryptToText, parseBackup } from "../backup/core.mjs";
import { bucketFromEnv, parseHourlyKey, parseNightlyKey } from "../backup/bucket-copy.mjs";
import { createGithub, GithubError } from "../backup/github.mjs";
import { S3Error } from "../backup/s3.mjs";
import { ensureNamespace, openNamespace, restoreVerified, SqldError } from "./sqld.mjs";

const TAG_RE = /^backup-(\d{4}-\d{2}-\d{2})$/;
/** Tie-break when two copies have the same time: the faster, closer copy first. */
const RANK = { "bucket-hourly": 0, "bucket-nightly": 1, "repo-nightly": 2 };
const has = (v) => typeof v === "string" && v.trim() !== "";

/**
 * @typedef {{ source: "bucket-hourly" | "bucket-nightly" | "repo-nightly", db: "main" | "auth",
 *   name: string, atMs: number, size: number | null, fetch: () => Promise<Uint8Array | null> }} Candidate
 */

/** Newest first; equal times by source rank, then name. @param {Candidate[]} list */
export function orderCandidates(list) {
  return [...list].sort(
    (a, b) => b.atMs - a.atMs || RANK[a.source] - RANK[b.source] || (a.name < b.name ? -1 : 1),
  );
}

/**
 * All candidate copies of one database across the configured sources. A source that cannot be
 * listed is reported in `unavailable` and skipped.
 * @param {"main" | "auth"} db
 * @param {{ s3?: ReturnType<typeof import("../backup/s3.mjs").createS3> | null,
 *   gh?: ReturnType<typeof createGithub> | null }} deps
 * @returns {Promise<{ candidates: Candidate[], unavailable: string[] }>}
 */
export async function listCandidates(db, { s3, gh }) {
  /** @type {Candidate[]} */
  const candidates = [];
  const unavailable = [];
  if (s3) {
    try {
      for (const o of await s3.list("nightly/")) {
        const p = parseNightlyKey(o.key);
        if (!p || p.db !== db) continue;
        const lm = Date.parse(o.lastModified);
        candidates.push({
          source: "bucket-nightly",
          db,
          name: o.key,
          atMs: Number.isNaN(lm) ? Date.parse(`${p.date}T00:00:00Z`) : lm,
          size: o.size,
          fetch: () => s3.get(o.key),
        });
      }
      if (db === "main") {
        for (const o of await s3.list("hourly/")) {
          const at = parseHourlyKey(o.key);
          if (at === null) continue;
          const lm = Date.parse(o.lastModified);
          candidates.push({
            source: "bucket-hourly",
            db,
            name: o.key,
            atMs: Number.isNaN(lm) ? at : lm,
            size: o.size,
            fetch: () => s3.get(o.key),
          });
        }
      }
    } catch {
      unavailable.push("bucket");
    }
  }
  if (gh) {
    try {
      for (const r of await gh.listReleases()) {
        const m = TAG_RE.exec(r.tag);
        const name = m ? assetName(db, m[1]) : null;
        if (!m || !r.assets.includes(name)) continue;
        const created = r.createdAt ? Date.parse(r.createdAt) : NaN;
        candidates.push({
          source: "repo-nightly",
          db,
          name: `${r.tag}/${name}`,
          atMs: Number.isNaN(created) ? Date.parse(`${m[1]}T00:00:00Z`) : created,
          size: null,
          fetch: () => gh.downloadAsset(r.tag, name),
        });
      }
    } catch {
      unavailable.push("data-repo");
    }
  }
  return { candidates: orderCandidates(candidates), unavailable };
}

/**
 * The newest copy that downloads, decrypts and parses as the right database.
 * @param {"main" | "auth"} db @param {Candidate[]} ordered @param {string} identity
 * @returns {Promise<{ source: string, name: string, atMs: number, text: string, tried: number }>}
 */
export async function fetchNewest(db, ordered, identity) {
  let tried = 0;
  for (const c of ordered) {
    tried += 1;
    try {
      const bytes = await c.fetch();
      if (!bytes) continue;
      const text = await decryptToText(bytes, identity);
      if (parseBackup(text).meta.db !== db) continue; // structure, counts and sha256 verified
      return { source: c.source, name: c.name, atMs: c.atMs, text, tried };
    } catch {
      // unreadable, wrong key or damaged: try the next newest
    }
  }
  throw new SqldError(`${db}: no usable backup found (${ordered.length} candidate(s) tried)`);
}

/** Sources from env: a copy whose configuration is absent is skipped. */
export function sourcesFromEnv(env, fetchImpl = fetch) {
  const s3 = bucketFromEnv(env, fetchImpl);
  const gh =
    has(env.DATA_REPO) && has(env.DATA_REPO_TOKEN)
      ? createGithub({ repo: env.DATA_REPO.trim(), token: env.DATA_REPO_TOKEN.trim(), fetchImpl })
      : null;
  return { s3, gh };
}

function identityFrom(env) {
  if (has(env.BACKUP_PRIVATE_KEY)) return env.BACKUP_PRIVATE_KEY.trim();
  if (has(env.BACKUP_PRIVATE_KEY_FILE)) {
    try {
      return (
        readFileSync(env.BACKUP_PRIVATE_KEY_FILE.trim(), "utf8").match(
          /AGE-SECRET-KEY-1[A-Z0-9]+/,
        )?.[0] ?? ""
      );
    } catch {
      return "";
    }
  }
  return "";
}

/** The namespace client for the restore target (the same rules as scripts/restore/restore.mjs). */
function openTarget(env, db) {
  const token = has(env.SQLD_TOKEN)
    ? env.SQLD_TOKEN
    : env[db === "main" ? "TURSO_MAIN_TOKEN" : "TURSO_AUTH_TOKEN"];
  if (has(env.SQLD_URL)) {
    return openNamespace({
      base: env.SQLD_URL,
      ns: db,
      token,
      mode: env.SQLD_NS_MODE === "host" ? "host" : "subdomain",
      intMode: "bigint",
    });
  }
  const url = env[db === "main" ? "TURSO_MAIN_URL" : "TURSO_AUTH_URL"];
  if (!has(url)) throw new SqldError("target is not configured (SQLD_URL or TURSO_*_URL)");
  return createClient({
    url: url.trim(),
    authToken: has(token) ? token.trim() : undefined,
    intMode: "bigint",
  });
}

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ s3?: any, gh?: any, openTarget?: (db: "main" | "auth") => any,
 *   ensureNs?: (db: string) => Promise<unknown>, out?: (s: string) => void, fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  try {
    let which = "";
    let restore = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--db" && i + 1 < argv.length) which = argv[++i];
      else if (argv[i] === "--restore") restore = true;
      else throw new SqldError("usage: --db main|auth|both [--restore]");
    }
    if (!["main", "auth", "both"].includes(which))
      throw new SqldError("usage: --db main|auth|both [--restore]");
    const dbs = which === "both" ? ["main", "auth"] : [which];
    const src = {
      s3: deps.s3 !== undefined ? deps.s3 : sourcesFromEnv(env, deps.fetchImpl).s3,
      gh: deps.gh !== undefined ? deps.gh : sourcesFromEnv(env, deps.fetchImpl).gh,
    };
    if (!src.s3 && !src.gh) throw new SqldError("no backup source is configured");
    const identity = restore ? identityFrom(env) : "";
    if (restore && identity === "") throw new SqldError("BACKUP_PRIVATE_KEY is not set");

    let code = 0;
    for (const db of dbs) {
      const { candidates, unavailable } = await listCandidates(db, src);
      for (const u of unavailable) out(`latest-backup: ${db}: source ${u} unavailable (skipped)`);
      if (candidates.length === 0) {
        out(`latest-backup: ${db}: FAIL no backup found`);
        code = 1;
        continue;
      }
      const top = candidates[0];
      out(
        `latest-backup: ${db}: newest ${top.source} ${top.name} at ${new Date(top.atMs).toISOString()} (${candidates.length} candidate(s))`,
      );
      if (!restore) continue;
      const got = await fetchNewest(db, candidates, identity);
      const target = deps.openTarget ? deps.openTarget(db) : openTarget(env, db);
      try {
        if (!deps.openTarget && has(env.SQLD_ADMIN_URL)) {
          await ensureNamespace(env.SQLD_ADMIN_URL, db, { adminAuth: env.SQLD_ADMIN_AUTH });
        }
        if (deps.ensureNs) await deps.ensureNs(db);
        const r = await restoreVerified(target, got.text, { expectDb: db });
        out(
          `latest-backup: ${db}: restore PASS from ${got.source} ${got.name} (schema v${r.schemaVersion}, tables=${r.tables}, rows=${r.rows}, foreign keys ON, no orphans)`,
        );
      } finally {
        target.close();
      }
    }
    return code;
  } catch (e) {
    const msg =
      e instanceof SqldError || e instanceof S3Error || e instanceof GithubError
        ? e.message
        : /^backup stream rejected:/.test(String(e?.message))
          ? e.message
          : "unexpected error";
    out(`latest-backup: FAIL ${msg}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
