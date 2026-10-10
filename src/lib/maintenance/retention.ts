// Nightly retention / maintenance job (M1). Runs on Vercel because only Vercel holds the auth-DB
// token (ROL-101a); GitHub Actions only triggers it through the signed route (SEC-017).
//
// Requirements relied on (quoted verbatim from the spec):
// - DAT-142: "Retention: market data in Turso 500 sessions; logs 30 days; run records 180 days;
//   news 400 days; **forever**: ... audit events (user identity hashed after 90 days per NFR-030)."
// - PLT-060: "the app MUST keep its own structured logs (job runs, errors, provider calls,
//   decisions) in the database with 30-day retention."
// - NFR-030: "90 days after revocation the user record's email/name are hashed and
//   IP/user-agent fields in that user's audit rows are nulled (audit rows themselves are kept)."
//   and "'Hashed' means HMAC-SHA-256 keyed with `PII_HASH_KEY` (SEC-017); a plain unsalted hash
//   MUST NOT be used."
// - PLT-016: "Every job MUST be **idempotent** (safe to run twice), **short** (respect platform
//   time limits), and MUST support **catch-up** of missed periods."
// - PLT-017: "Every scheduled run MUST write a run record: job name, scheduled time, start/end,
//   status, items processed, duration, token usage, error summary."
// - PLT-076: "Every workflow declares a concurrency key (job, market, local date) without
//   cancelling in-progress runs, and exits in its first step if a success run record already
//   exists for that key."
// - PLT-071: "The Worker's per-minute cron is the master clock: at configured local times it
//   triggers GitHub Actions via `workflow_dispatch` **with `ref: release`**". Until the Worker
//   exists (M2) the workflow is workflow_dispatch only.
// - Ch. 15 (retention keys): "retention (logs 30 d, runs 180 d, news 400 d) | as DAT-142 | O"
//   -> config keys retention_logs_days / retention_runs_days. The 90-day value is the fixed key
//   pii_hash_after_revocation_days (NFR-030).
//
// Every step is idempotent: a second run on the same data changes nothing. A step that throws is
// recorded by NAME only (never a value or an error message) and the other steps still run, so one
// bad step cannot block the rest (catch-up).
import type { Client, Transaction } from "@libsql/client";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { getConfig } from "@/lib/config/store";
import { localToUtc } from "@/lib/data/calendar";
import {
  ANNOUNCEMENT_SOURCE,
  JOB_ASX,
  MARKET as BACKFILL_MARKET,
  NEWS_RETENTION_DAYS,
  RUN_JOB as BACKFILL_RUN_JOB,
  addMonths,
  isMonth,
  monthFirstDay,
} from "@/lib/data/backfill/rules.mjs";
import { readState } from "@/lib/data/backfill/engine.mjs";
import { appendAuditTx, auditKey, hashUserPii, nullAuditPii } from "@/lib/db/audit";
import { finishRun, hasSuccess, pruneRuns, startRun } from "@/lib/runs/runRecord";

export const MAINTENANCE_JOB = "maintenance-nightly";
export const PII_HASHED_ACTION = "user.pii_hashed";

const DAY_MS = 86_400_000;
const HEX64 = /^[0-9a-f]{64}$/;

export type MaintenanceCounts = {
  prunedRuns: number;
  prunedLogs: number;
  prunedNonces: number;
  prunedFlags: number;
  prunedAnnouncements: number;
  hashedUsers: number;
};

export type MaintenanceOutcome =
  | { status: "skipped" }
  | { status: "success"; counts: MaintenanceCounts }
  | { status: "failed"; counts: MaintenanceCounts };

export function concurrencyKeyFor(date: string): string {
  return `maintenance:${date}`;
}

// A real calendar date written YYYY-MM-DD (the Melbourne local date chosen by the caller).
export function isValidDate(d: unknown): d is string {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00.000Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

const cutoffIso = (nowIso: string, days: number): string =>
  new Date(Date.parse(nowIso) - days * DAY_MS).toISOString();

// A stored value that is not a positive whole number falls back to the registry default.
function positiveDays(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : fallback;
}

// Rows strictly older than the cutoff go; a row exactly `days` old is kept (same as pruneRuns).
export async function pruneLogs(db: Client, nowIso: string, days: number): Promise<number> {
  const res = await db.execute({
    sql: "DELETE FROM app_log WHERE at < ?",
    args: [cutoffIso(nowIso, days)],
  });
  return res.rowsAffected;
}

// D-057 decision 5 (DAT-142): data-quality flags older than the retention are deleted unless they
// blocked a decision (blocks_entries = 1, kept forever). The table trigger refuses anything else.
// Decision-blocking flags are never touched here, whatever their age or state.
export async function pruneQualityFlags(db: Client, nowIso: string, days: number): Promise<number> {
  const res = await db.execute({
    sql: "DELETE FROM data_quality_flag WHERE blocks_entries = 0 AND raised_at < ?",
    args: [cutoffIso(nowIso, days)],
  });
  return res.rowsAffected;
}

// DAT-142 (news 400 days) with the T9 guard (docs/M2_design.md T9 open question 4): an announcement
// older than the retention is deleted ONLY when its Sydney month has already been written to a
// history file, and never otherwise. "Exported" is proved, not assumed:
//  - a successful export run record `backfill-history:export:asx_announcements:<month>` exists
//    for the month (the engine writes it after the file is uploaded and before the cursor moves;
//    pruneRuns keeps these records past the 180-day run retention, otherwise the proof would be
//    gone long before the announcements become prunable);
//  - the month is on or after the cursor `exported_down_to` (the export runs newest month first,
//    so every exported month is >= that boundary) and is not listed in the state's `conflicts`
//    nor recorded with `file: conflict` (the stored file differs from the database, so those rows
//    are NOT safely in a file);
//  - the row was ingested at or before the export started (a later arrival is not in the file).
// Only market AU and source `asx_announcements` rows are touched (the only ones exported). The
// database trigger refuses a delete inside 400 days, so the cutoff never goes below that.
// Months are deleted one at a time inside one write batch; a second run finds nothing more.
export async function pruneAnnouncements(
  db: Client,
  nowIso: string,
  days: number,
): Promise<number> {
  const state = await readState(db, JOB_ASX);
  const boundary = state.exported_down_to;
  if (!isMonth(boundary)) return 0; // nothing has been exported yet
  const conflicts = new Set(
    Array.isArray(state.conflicts) ? state.conflicts.filter((m) => isMonth(m)) : [],
  );
  const cutoff = cutoffIso(nowIso, Math.max(days, NEWS_RETENTION_DAYS));
  const prefix = `${BACKFILL_RUN_JOB}:export:${JOB_ASX}:`;
  const exports = await db.execute({
    sql: `SELECT concurrency_key, started_at, json_extract(details_json, '$.file') AS file
          FROM run_record
          WHERE job = ? AND status = 'success' AND concurrency_key LIKE ? ORDER BY concurrency_key`,
    args: [BACKFILL_RUN_JOB, `${prefix}%`],
  });
  const stmts = [];
  for (const r of exports.rows) {
    const month = String(r.concurrency_key).slice(prefix.length);
    if (!isMonth(month) || month < boundary || conflicts.has(month)) continue;
    if (r.file === "conflict") continue;
    const start = localToUtc(monthFirstDay(month), "00:00", "Australia/Sydney").toISOString();
    const next = localToUtc(
      monthFirstDay(addMonths(month, 1)),
      "00:00",
      "Australia/Sydney",
    ).toISOString();
    stmts.push({
      sql: `DELETE FROM announcement
            WHERE market = ? AND source = ? AND published_at >= ? AND published_at < ?
              AND published_at < ? AND ingested_at <= ?`,
      args: [BACKFILL_MARKET, ANNOUNCEMENT_SOURCE, start, next, cutoff, String(r.started_at)],
    });
  }
  if (stmts.length === 0) return 0;
  const results = await db.batch(stmts, "write");
  return results.reduce((n, x) => n + x.rowsAffected, 0);
}

export async function pruneNonces(db: Client, nowSec: number): Promise<number> {
  const res = await db.execute({
    sql: "DELETE FROM request_nonce WHERE expires_at < ?",
    args: [nowSec],
  });
  return res.rowsAffected;
}

// Runs on the caller's transaction so the user row, the audit rows and the audit event commit
// together. The HMAC / nulling logic lives in db/audit.ts (hashUserPii, nullAuditPii).
async function hashOneUser(
  tx: Transaction,
  piiHashKey: string,
  chainKey: Buffer,
  userId: number,
  nowIso: string,
  cutoff: string,
): Promise<{ done: boolean; auditRowsNulled: number }> {
  // Re-checked inside the transaction: a user re-invited since the candidate query is left alone.
  const u = await tx.execute({
    sql: `SELECT id FROM app_user
          WHERE id = ? AND status = 'revoked' AND revoked_at IS NOT NULL AND revoked_at < ?
            AND pii_hashed_at IS NULL`,
    args: [userId, cutoff],
  });
  if (!u.rows.length) return { done: false, auditRowsNulled: 0 };
  await hashUserPii(tx, piiHashKey, userId, nowIso);
  const auditRowsNulled = await nullAuditPii(tx, userId);
  await appendAuditTx(tx, chainKey, {
    at: nowIso,
    actorUserId: null,
    action: PII_HASHED_ACTION,
    targetType: "app_user",
    targetId: String(userId),
    detail: { auditRowsNulled },
  });
  await tx.commit();
  return { done: true, auditRowsNulled };
}

// NFR-030. One write transaction per user: if any statement fails nothing of that user changes.
export async function hashRevokedUsers(
  authDb: Client,
  piiHashKey: string,
  nowIso: string,
  days: number,
): Promise<{ hashed: number; failed: number; rowsWritten: number }> {
  if (!HEX64.test(piiHashKey)) throw new Error("pii key invalid");
  const cutoff = cutoffIso(nowIso, days);
  const chainKey = auditKey(piiHashKey);
  const candidates = await authDb.execute({
    sql: `SELECT id FROM app_user
          WHERE status = 'revoked' AND revoked_at IS NOT NULL AND revoked_at < ?
            AND pii_hashed_at IS NULL ORDER BY id`,
    args: [cutoff],
  });
  let hashed = 0;
  let failed = 0;
  let rowsWritten = 0;
  for (const row of candidates.rows) {
    let tx: Transaction | undefined;
    try {
      tx = await authDb.transaction("write");
      const r = await hashOneUser(tx, piiHashKey, chainKey, Number(row.id), nowIso, cutoff);
      if (r.done) {
        hashed += 1;
        rowsWritten += 2 + r.auditRowsNulled; // user row + audit event + nulled audit rows
      }
    } catch {
      failed += 1;
    } finally {
      // close() rolls back anything not committed.
      tx?.close();
    }
  }
  return { hashed, failed, rowsWritten };
}

export type MaintenanceDeps = {
  mainDb: Client;
  authDb: Client;
  piiHashKey: string | undefined;
  now: Date;
};

export async function runMaintenance(
  deps: MaintenanceDeps,
  date: string,
): Promise<MaintenanceOutcome> {
  const { mainDb, authDb } = deps;
  const key = concurrencyKeyFor(date);
  // PLT-076: a success record for this key means there is nothing to do.
  if (await hasSuccess(mainDb, key)) return { status: "skipped" };

  const nowIso = deps.now.toISOString();
  const runId = await startRun(mainDb, {
    job: MAINTENANCE_JOB,
    concurrencyKey: key,
    scheduledFor: date,
    now: nowIso,
  });

  const counts: MaintenanceCounts = {
    prunedRuns: 0,
    prunedLogs: 0,
    prunedNonces: 0,
    prunedFlags: 0,
    prunedAnnouncements: 0,
    hashedUsers: 0,
  };
  const failedSteps: string[] = [];
  let rowsRead = 0;
  let rowsWritten = 0;

  // Run records and logs (DAT-142, PLT-060). The current run started "now", so it is never pruned.
  try {
    const days = positiveDays(
      await getConfig(mainDb, "retention_runs_days"),
      CONFIG_KEYS.retention_runs_days.default,
    );
    counts.prunedRuns = await pruneRuns(mainDb, nowIso, days);
    rowsRead += 1;
    rowsWritten += counts.prunedRuns;
  } catch {
    failedSteps.push("prune_runs");
  }
  try {
    const days = positiveDays(
      await getConfig(mainDb, "retention_logs_days"),
      CONFIG_KEYS.retention_logs_days.default,
    );
    counts.prunedLogs = await pruneLogs(mainDb, nowIso, days);
    rowsRead += 1;
    rowsWritten += counts.prunedLogs;
  } catch {
    failedSteps.push("prune_logs");
  }
  try {
    counts.prunedNonces = await pruneNonces(mainDb, Math.floor(deps.now.getTime() / 1000));
    rowsWritten += counts.prunedNonces;
  } catch {
    failedSteps.push("prune_nonces");
  }
  // Data-quality flags (D-057 #5): the trigger keeps a 180-day floor, the key cannot go below it.
  try {
    const days = positiveDays(
      await getConfig(mainDb, "retention_flag_days"),
      CONFIG_KEYS.retention_flag_days.default,
    );
    counts.prunedFlags = await pruneQualityFlags(mainDb, nowIso, days);
    rowsRead += 1;
    rowsWritten += counts.prunedFlags;
  } catch {
    failedSteps.push("prune_flags");
  }
  // News class (DAT-142, 400 days) with the T9 guard: only months already exported to history files.
  try {
    const days = positiveDays(
      await getConfig(mainDb, "retention_news_days"),
      CONFIG_KEYS.retention_news_days.default,
    );
    counts.prunedAnnouncements = await pruneAnnouncements(mainDb, nowIso, days);
    rowsRead += 1;
    rowsWritten += counts.prunedAnnouncements;
  } catch {
    failedSteps.push("prune_announcements");
  }
  // NFR-030: the 90-day value is fixed (no stored override).
  try {
    const r = await hashRevokedUsers(
      authDb,
      deps.piiHashKey ?? "",
      nowIso,
      CONFIG_KEYS.pii_hash_after_revocation_days.default,
    );
    counts.hashedUsers = r.hashed;
    rowsRead += r.hashed + r.failed;
    rowsWritten += r.rowsWritten;
    if (r.failed > 0) failedSteps.push(`pii_hash(${r.failed})`);
  } catch {
    failedSteps.push("pii_hash");
  }

  const itemsProcessed =
    counts.prunedRuns +
    counts.prunedLogs +
    counts.prunedNonces +
    counts.prunedFlags +
    counts.prunedAnnouncements +
    counts.hashedUsers;
  const ok = failedSteps.length === 0;
  const finish = (status: "success" | "failed") =>
    finishRun(mainDb, runId, {
      status,
      itemsProcessed,
      rowsRead,
      rowsWritten,
      errorSummary: status === "failed" ? `failed steps: ${failedSteps.join(", ")}` : undefined,
      details: { ...counts, ...(status === "failed" ? { failedSteps } : {}) },
    });
  try {
    await finish(ok ? "success" : "failed");
  } catch {
    // e.g. a concurrent run already holds the success for this key: record this run as failed.
    failedSteps.push("finish");
    await finish("failed");
    return { status: "failed", counts };
  }
  return { status: ok ? "success" : "failed", counts };
}
