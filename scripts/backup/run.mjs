// Nightly encrypted backup (PLT-022, PLT-022a, PLT-022b, DAT-143, PLT-076). Runs in the
// `production` GitHub environment on the approved commit (SEC-108 c).
// Usage: node scripts/backup/run.mjs
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, BACKUP_PUBLIC_KEY, APP_BASE_URL, ACTIONS_HMAC_SECRET,
//      DATA_REPO_TOKEN, DATA_REPO (`<owner>/<repo>-data`)
// Steps: (a) dump the main DB -> gzip -> age-encrypt (in memory, plaintext never on disk);
// (b) fetch the already-encrypted auth export from the signed Vercel route (this job never holds
// the auth-DB token, ROL-101a); (c) upload both as assets of release `backup-<date>` in the DATA
// repo (idempotent: an asset that exists is skipped); (d) retention 14 daily / 8 weekly / 12
// monthly; (e) write run record `nightly-backup` (key `backup:<date>`) on the main DB.
// Output: statuses, counts and sizes only. Never a URL, a token, a key or any row content.
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { melbourneDate } from "../maintenance/run.mjs";
import { sign } from "../smoke/sign.mjs";
import {
  assetName,
  backupTag,
  exportEncrypted,
  looksLikeAge,
  parseRecipient,
  selectDeletions,
} from "./core.mjs";
import { createGithub, GithubError } from "./github.mjs";

export const JOB = "nightly-backup";
const TIMEOUT_MS = 120_000;
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
const MAX_DELETIONS_PER_RUN = 30; // a runaway-deletion guard; the rest goes the next night
const TAG_RE = /^backup-(\d{4}-\d{2}-\d{2})$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const REQUIRED = [
  "TURSO_MAIN_URL",
  "TURSO_MAIN_TOKEN",
  "APP_BASE_URL",
  "ACTIONS_HMAC_SECRET",
  "DATA_REPO_TOKEN",
  "DATA_REPO",
];
const has = (v) => typeof v === "string" && v.trim() !== "";
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

class StageError extends Error {
  /** @param {string} stage @param {string} [detail] */
  constructor(stage, detail) {
    super(detail ? `${stage}: ${detail}` : stage);
    this.stage = stage;
  }
}

// Only our own short messages (stage + HTTP status); never a driver error, URL or body.
const summaryOf = (e, stage) =>
  e instanceof StageError || e instanceof GithubError ? e.message : `${stage}: unexpected error`;

async function hasSuccess(db, key) {
  const r = await db.execute({
    sql: "SELECT 1 FROM run_record WHERE concurrency_key = ? AND status = 'success' LIMIT 1",
    args: [key],
  });
  return r.rows.length > 0;
}

async function startRun(db, key, date, nowIso, commitSha) {
  const r = await db.execute({
    sql: `INSERT INTO run_record (job, concurrency_key, scheduled_for, started_at, status, commit_sha)
          VALUES (?, ?, ?, ?, 'running', ?)`,
    args: [JOB, key, date, nowIso, commitSha ?? null],
  });
  return Number(r.lastInsertRowid);
}

async function finishRun(db, id, nowIso, r) {
  const cur = await db.execute({
    sql: "SELECT started_at FROM run_record WHERE id = ?",
    args: [id],
  });
  const duration = Math.max(0, Date.parse(nowIso) - Date.parse(String(cur.rows[0].started_at)));
  await db.execute({
    sql: `UPDATE run_record SET status = ?, ended_at = ?, duration_ms = ?, items_processed = ?,
          rows_read = ?, rows_written = 0, llm_tokens = 0, error_summary = ?, details_json = ? WHERE id = ?`,
    args: [
      r.status,
      nowIso,
      duration,
      r.items,
      r.rowsRead,
      r.error === undefined ? null : r.error.slice(0, 500),
      r.details === undefined ? null : JSON.stringify(r.details),
      id,
    ],
  });
}

async function fetchAuthExport(env, fetchImpl, nowMs, date) {
  const body = JSON.stringify({ purpose: "backup-export", date });
  const headers = {
    "Content-Type": "application/json",
    ...sign(
      env.ACTIONS_HMAC_SECRET,
      body,
      Math.floor(nowMs / 1000),
      randomBytes(16).toString("hex"),
    ),
  };
  const base = env.APP_BASE_URL.trim().replace(/\/+$/, "");
  let res;
  try {
    res = await fetchImpl(`${base}/api/internal/backup-export`, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new StageError("auth_export", "request failed");
  }
  if (res.status !== 200) throw new StageError("auth_export", `HTTP ${res.status}`);
  if (!String(res.headers.get("content-type") ?? "").startsWith("application/octet-stream")) {
    throw new StageError("auth_export", "unexpected content type");
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Never store anything that is not age ciphertext (a plaintext body must not reach the repo).
  if (!looksLikeAge(bytes)) throw new StageError("auth_export", "response is not age ciphertext");
  if (bytes.length > MAX_EXPORT_BYTES) throw new StageError("auth_export", "response too large");
  let counts = {};
  try {
    const c = JSON.parse(res.headers.get("x-praxis-backup-counts") ?? "{}");
    if (c && typeof c === "object" && Object.values(c).every(Number.isInteger)) counts = c;
  } catch {
    // counts are informational only
  }
  return { bytes, counts };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   openDb?: (url: string, token: string) => import("@libsql/client").Client,
 *   nowMs?: () => number,
 *   out?: (s: string) => void,
 * }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(env, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const openDb = deps.openDb ?? ((url, authToken) => createClient({ url, authToken }));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const out = deps.out ?? ((s) => console.log(s));

  const recipient = parseRecipient(env.BACKUP_PUBLIC_KEY);
  if (recipient === null || !REQUIRED.every((k) => has(env[k])) || !REPO_RE.test(env.DATA_REPO)) {
    out("backup: failed (configuration incomplete or invalid)");
    return 1;
  }

  const startedMs = nowMs();
  const date = melbourneDate(startedMs);
  const key = `backup:${date}`;
  const gh = createGithub({ repo: env.DATA_REPO, token: env.DATA_REPO_TOKEN, fetchImpl });
  const db = openDb(env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN);
  let runId = null;
  let stage = "run_record";
  try {
    if (await hasSuccess(db, key)) {
      out(`backup: skipped (already done for ${date})`);
      return 0;
    }
    runId = await startRun(db, key, date, new Date(startedMs).toISOString(), env.COMMIT_SHA);

    stage = "main_dump";
    const main = await exportEncrypted(db, {
      name: "main",
      createdAt: new Date(startedMs).toISOString(),
      recipient,
    });
    const files = [{ name: assetName("main", date), bytes: main.data }];

    // A failed auth export does not stop the main backup from being uploaded (RPO); the run is
    // then recorded as failed so the workflow goes red, and a re-run uploads only what is missing.
    stage = "auth_export";
    let auth = null;
    let authFailure = null;
    try {
      auth = await fetchAuthExport(env, fetchImpl, nowMs(), date);
      files.push({ name: assetName("auth", date), bytes: auth.bytes });
    } catch (e) {
      authFailure = e;
    }

    stage = "upload";
    const release = await gh.ensureRelease(backupTag(date));
    const uploaded = [];
    const skipped = [];
    for (const f of files) {
      if (release.assets.includes(f.name)) {
        skipped.push(f.name);
      } else {
        await gh.uploadAsset(release.id, f.name, f.bytes);
        uploaded.push(f.name);
      }
    }
    if (authFailure) {
      stage = "auth_export";
      throw authFailure;
    }

    const details = {
      date,
      main: {
        bytes: main.data.length,
        sha256: sha256(main.data),
        schemaVersion: main.schemaVersion,
        counts: main.counts,
        tableSha256: main.sha256,
      },
      auth: {
        bytes: auth.bytes.length,
        sha256: sha256(auth.bytes),
        counts: auth.counts,
      },
      uploaded,
      skipped,
      deleted: 0,
    };

    // (d) Retention, only after a complete backup, and only if today's release is in the list.
    stage = "retention";
    let retentionFailed = 0;
    const releases = (await gh.listReleases()).filter((r) => TAG_RE.test(r.tag));
    const byDate = new Map(releases.map((r) => [TAG_RE.exec(r.tag)[1], r]));
    if (byDate.has(date)) {
      const doomed = selectDeletions([...byDate.keys()], date).slice(0, MAX_DELETIONS_PER_RUN);
      for (const d of doomed) {
        const r = byDate.get(d);
        try {
          await gh.deleteRelease(r.id, r.tag);
          details.deleted += 1;
        } catch {
          retentionFailed += 1;
        }
      }
    }

    const status = retentionFailed > 0 ? "degraded" : "success";
    await finishRun(db, runId, new Date(nowMs()).toISOString(), {
      status,
      items: uploaded.length + skipped.length,
      rowsRead: Object.values(main.counts).reduce((a, b) => a + b, 0),
      error: retentionFailed > 0 ? `retention: ${retentionFailed} deletion(s) failed` : undefined,
      details,
    });
    out(
      `backup: ${status === "success" ? "ok" : "degraded"} main=${main.data.length}B auth=${auth.bytes.length}B uploaded=${uploaded.length} skipped=${skipped.length} deleted=${details.deleted}`,
    );
    return 0;
  } catch (e) {
    const summary = summaryOf(e, stage);
    if (runId !== null) {
      try {
        await finishRun(db, runId, new Date(nowMs()).toISOString(), {
          status: "failed",
          items: 0,
          rowsRead: 0,
          error: summary,
        });
      } catch {
        // best effort: the exit code below still fails the workflow
      }
    }
    out(`backup: failed (${summary})`);
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.env));
}
