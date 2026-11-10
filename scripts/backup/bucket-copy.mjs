// INFRA T5 (REQ\infra\INFRA_REQUIREMENT.md §8.2, §15.1): copy 2 of the data, an off-box bucket
// (Backblaze B2 or Cloudflare R2, S3 API). The bucket only ever holds the SAME age-encrypted files
// the data repo holds (or, for the hourly copy, a fresh encrypted dump of the main DB): the
// plaintext is never written anywhere.
//
// Usage:
//   node scripts/backup/bucket-copy.mjs [--date YYYY-MM-DD] [--dir <folder>]
//       nightly copy. Without --dir the encrypted assets of release `backup-<date>` are read from
//       the data repo (the file run.mjs just uploaded), so both copies are byte-identical.
//       With --dir the files `<db>-<date>.ndjson.gz.age` are read from that folder.
//       Then retention: 30 daily + 12 monthly (the earliest backup of each of the last 12 months,
//       i.e. the first-of-month one) per database; the rest is deleted (at most 30 per run).
//   node scripts/backup/bucket-copy.mjs --hourly
//       optional hourly copy while self-hosted is live: an encrypted dump of the main DB at
//       `hourly/main-<YYYYMMDD>T<HH>00Z.ndjson.gz.age`; objects older than 48 h are deleted.
// env: BACKUP_BUCKET_URL (S3 endpoint), BACKUP_BUCKET_NAME, BACKUP_BUCKET_KEY_ID,
//      BACKUP_BUCKET_SECRET, [BACKUP_BUCKET_REGION: default from the endpoint, else "auto"]
//   nightly from the repo: DATA_REPO, DATA_REPO_TOKEN
//   hourly: TURSO_MAIN_URL, TURSO_MAIN_TOKEN (the sqld main namespace), BACKUP_PUBLIC_KEY
// Output: statuses, counts and sizes only. Never a URL, a key, a token or row content.
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { melbourneDate } from "../maintenance/run.mjs";
import { assetName, exportEncrypted, isValidDate, looksLikeAge, parseRecipient } from "./core.mjs";
import { createGithub, GithubError } from "./github.mjs";
import { createS3, S3Error } from "./s3.mjs";

export const KEEP_DAILY = 30;
export const KEEP_MONTHLY = 12;
export const HOURLY_KEEP_HOURS = 48;
const MAX_DELETIONS_PER_RUN = 30; // a runaway-deletion guard; the rest goes the next run
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DBS = ["main", "auth"];
const has = (v) => typeof v === "string" && v.trim() !== "";

// ---------------------------------------------------------------------------------------------
// Key layout

export const nightlyKey = (db, date) => `nightly/${assetName(db, date)}`;
const NIGHTLY_RE = /^nightly\/(main|auth)-(\d{4}-\d{2}-\d{2})\.ndjson\.gz\.age$/;
const HOURLY_RE = /^hourly\/main-(\d{4})(\d{2})(\d{2})T(\d{2})00Z\.ndjson\.gz\.age$/;

/** @param {number} atMs a time; it is floored to its UTC hour */
export function hourlyKey(atMs) {
  const d = new Date(Math.floor(atMs / HOUR_MS) * HOUR_MS);
  const p = (n) => String(n).padStart(2, "0");
  return `hourly/main-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}00Z.ndjson.gz.age`;
}

/** @returns {{ db: "main" | "auth", date: string } | null} */
export function parseNightlyKey(key) {
  const m = NIGHTLY_RE.exec(key);
  return m && isValidDate(m[2]) ? { db: /** @type {"main" | "auth"} */ (m[1]), date: m[2] } : null;
}

/** @returns {number | null} the hour (UTC ms) an hourly key stands for */
export function parseHourlyKey(key) {
  const m = HOURLY_RE.exec(key);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]));
  return Number.isNaN(ms) || hourlyKey(ms) !== key ? null : ms;
}

// ---------------------------------------------------------------------------------------------
// Retention (30 daily + 12 monthly; hourly 48 h)

const dayNumber = (d) => Math.floor(Date.parse(`${d}T00:00:00.000Z`) / DAY_MS);
const monthIndex = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;

/**
 * Which nightly dates to KEEP: the 30 most recent days (age 0..29), the earliest backup of each of
 * the last 12 calendar months (the first-of-month one when it exists), and anything dated after
 * `today` (clock anomaly: never delete what cannot be placed). Invalid dates are ignored.
 * @param {string[]} dates YYYY-MM-DD @param {string} today YYYY-MM-DD
 */
export function selectBucketRetained(dates, today) {
  if (!isValidDate(today)) throw new Error("today is not a valid date");
  const all = [...new Set(dates.filter(isValidDate))].sort();
  const t = dayNumber(today);
  const tMonth = monthIndex(today);
  const keep = new Set();
  const monthly = new Map(); // months ago -> earliest date
  for (const d of all) {
    const n = dayNumber(d);
    if (n > t || t - n < KEEP_DAILY) keep.add(d);
    const m = tMonth - monthIndex(d);
    if (m >= 0 && m < KEEP_MONTHLY && !monthly.has(m)) monthly.set(m, d); // ascending: first wins
  }
  for (const d of monthly.values()) keep.add(d);
  return [...keep].sort();
}

/** Valid dates not retained. */
export function selectBucketDeletions(dates, today) {
  const keep = new Set(selectBucketRetained(dates, today));
  return [...new Set(dates.filter(isValidDate))].filter((d) => !keep.has(d)).sort();
}

/** Hourly keys older than 48 h at `nowMs` (keys that do not parse are never returned). */
export function selectHourlyDeletions(keys, nowMs) {
  return keys.filter((k) => {
    const at = parseHourlyKey(k);
    return at !== null && nowMs - at > HOURLY_KEEP_HOURS * HOUR_MS;
  });
}

// ---------------------------------------------------------------------------------------------
// Config

/** The bucket client from env, or null when the configuration is incomplete. */
export function bucketFromEnv(env, fetchImpl = fetch) {
  const need = [
    "BACKUP_BUCKET_URL",
    "BACKUP_BUCKET_NAME",
    "BACKUP_BUCKET_KEY_ID",
    "BACKUP_BUCKET_SECRET",
  ];
  if (!need.every((k) => has(env[k]))) return null;
  try {
    return createS3({
      endpoint: env.BACKUP_BUCKET_URL,
      bucket: env.BACKUP_BUCKET_NAME.trim(),
      keyId: env.BACKUP_BUCKET_KEY_ID.trim(),
      secret: env.BACKUP_BUCKET_SECRET.trim(),
      region: env.BACKUP_BUCKET_REGION,
      fetchImpl,
    });
  } catch {
    return null;
  }
}

class StageError extends Error {}
const stageFail = (m) => {
  throw new StageError(m);
};

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { hourly: false, date: "", dir: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hourly") out.hourly = true;
    else if (a === "--date" && i + 1 < argv.length) out.date = argv[++i];
    else if (a === "--dir" && i + 1 < argv.length) out.dir = argv[++i];
    else stageFail("usage: [--hourly] | [--date YYYY-MM-DD] [--dir <folder>]");
  }
  if (out.date !== "" && !isValidDate(out.date)) stageFail("usage: --date must be YYYY-MM-DD");
  if (out.hourly && (out.date !== "" || out.dir !== "")) {
    stageFail("usage: --hourly takes no --date or --dir");
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Runs

async function nightly(s3, args, env, deps, nowMs, out) {
  const date = args.date || melbourneDate(nowMs);
  /** @type {{ db: "main" | "auth", bytes: Uint8Array }[]} */
  const files = [];
  if (args.dir) {
    for (const db of DBS) {
      try {
        files.push({
          db,
          bytes: new Uint8Array(readFileSync(path.join(args.dir, assetName(db, date)))),
        });
      } catch {
        // a missing auth file is tolerated below; a missing main file is not
      }
    }
  } else {
    if (!has(env.DATA_REPO) || !has(env.DATA_REPO_TOKEN)) stageFail("data repo access is missing");
    const gh =
      deps.gh ??
      createGithub({ repo: env.DATA_REPO, token: env.DATA_REPO_TOKEN, fetchImpl: deps.fetchImpl });
    for (const db of DBS) {
      const bytes = await gh.downloadAsset(`backup-${date}`, assetName(db, date));
      if (bytes) files.push({ db, bytes });
    }
  }
  if (!files.some((f) => f.db === "main")) stageFail(`no main backup for ${date}`);
  for (const f of files) {
    if (!looksLikeAge(f.bytes)) stageFail(`${f.db}: the file is not age ciphertext`);
  }

  // Upload (idempotent: an object that is already there with the same size is skipped).
  const existing = await s3.list("nightly/");
  const sizeOf = new Map(existing.map((o) => [o.key, o.size]));
  let uploaded = 0;
  let skipped = 0;
  for (const f of files) {
    const key = nightlyKey(f.db, date);
    if (sizeOf.get(key) === f.bytes.length) {
      skipped += 1;
    } else {
      await s3.put(key, f.bytes);
      uploaded += 1;
    }
  }
  // Verify: every file is listed with its exact size before anything is deleted.
  const after = new Map((await s3.list("nightly/")).map((o) => [o.key, o]));
  for (const f of files) {
    if (after.get(nightlyKey(f.db, date))?.size !== f.bytes.length)
      stageFail("upload not verified");
  }

  // Retention per database, only after a verified upload.
  let deleted = 0;
  let failed = 0;
  for (const db of DBS) {
    const dates = [];
    for (const k of after.keys()) {
      const p = parseNightlyKey(k);
      if (p && p.db === db) dates.push(p.date);
    }
    for (const d of selectBucketDeletions(dates, date)) {
      if (deleted + failed >= MAX_DELETIONS_PER_RUN) break;
      try {
        await s3.delete(nightlyKey(db, d));
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
  }
  out(
    `bucket-copy: ${failed ? "degraded" : "ok"} date=${date} files=${files.length} bytes=${files.reduce((n, f) => n + f.bytes.length, 0)} uploaded=${uploaded} skipped=${skipped} deleted=${deleted}${failed ? ` delete_failed=${failed}` : ""}`,
  );
  return 0;
}

async function hourly(s3, env, deps, nowMs, out) {
  const recipient = parseRecipient(env.BACKUP_PUBLIC_KEY);
  if (recipient === null || !has(env.TURSO_MAIN_URL))
    stageFail("configuration incomplete or invalid");
  // Lossless client (D-175): cohort.rng_seed is a 64-bit integer.
  const db = (
    deps.openDb ?? ((url, authToken) => createClient({ url, authToken, intMode: "bigint" }))
  )(env.TURSO_MAIN_URL.trim(), has(env.TURSO_MAIN_TOKEN) ? env.TURSO_MAIN_TOKEN.trim() : undefined);
  let exp;
  try {
    exp = await exportEncrypted(db, {
      name: "main",
      createdAt: new Date(nowMs).toISOString(),
      recipient,
    });
  } finally {
    db.close();
  }
  const key = hourlyKey(nowMs);
  await s3.put(key, exp.data); // overwriting the same hour is fine
  const listed = await s3.list("hourly/");
  if (listed.find((o) => o.key === key)?.size !== exp.data.length) stageFail("upload not verified");
  let deleted = 0;
  for (const k of selectHourlyDeletions(
    listed.map((o) => o.key),
    nowMs,
  ).slice(0, MAX_DELETIONS_PER_RUN)) {
    try {
      await s3.delete(k);
      deleted += 1;
    } catch {
      // the next hour retries
    }
  }
  out(`bucket-copy: ok hourly main=${exp.data.length}B deleted=${deleted}`);
  return 0;
}

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ s3?: ReturnType<typeof createS3>, gh?: ReturnType<typeof createGithub>,
 *   fetchImpl?: typeof fetch, openDb?: Function, nowMs?: () => number, out?: (s: string) => void }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  try {
    const args = parseArgs(argv);
    const s3 = deps.s3 ?? bucketFromEnv(env, deps.fetchImpl ?? fetch);
    if (!s3) stageFail("bucket configuration incomplete or invalid");
    return args.hourly
      ? await hourly(s3, env, deps, nowMs, out)
      : await nightly(s3, args, env, deps, nowMs, out);
  } catch (e) {
    // Only our own short messages (stage + HTTP status); never a driver error, URL or body.
    const msg =
      e instanceof StageError || e instanceof S3Error || e instanceof GithubError
        ? e.message
        : "unexpected error";
    out(`bucket-copy: failed (${msg})`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
