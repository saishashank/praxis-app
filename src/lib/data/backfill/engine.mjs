// History backfill engine (M2 T9): resumable, capped, idempotent jobs over `backfill_job`. HIGH-RISK
// (production writes). Pure rules and the spec quotes are in ./rules.mjs; the typed facade is
// ./engine.d.mts. No network except through the injected `store` (the private data repo client).
//
// Two jobs (design section 2, `backfill_job`):
//  - `asx_announcements`: one Sydney DATE per commit, newest first. The ASX fetch is NOT made here
//    and not by Actions (DAT-122: "GitHub Actions never waits on the ASX token"): the Worker's
//    slot (5) fetches through the rate token and hands the parsed items to `commitAsxDay` (see
//    docs/07_decision_log.md D-065). Rows go to `announcement` (Turso, ON CONFLICT DO NOTHING);
//    once a whole past month is in, `exportAsxMonths` writes it as a history file.
//  - `asic_short_interest`: one MONTH per commit, newest first, files only (decision 7). The ASIC
//    fetch happens in a no-secrets workflow step; `commitHistoryMonth` receives the parsed rows.
//
// Resumability: every commit is ONE database batch (data rows + cursor + run record + status), so
// a run killed at any point either committed a whole chunk or nothing. A history file is uploaded
// BEFORE its cursor moves and is byte-identical on a re-run, so a kill in between is repaired by
// the SHA-skip. The unique-success run record per chunk makes a second commit of the same chunk
// impossible even under a race (PLT-076).
//
// Cap (decision 13, D-057): `ingest-batch1` and `backfill-history` run records in the UTC quota
// month are summed (the same counter batch1 uses for its catch-up); before every chunk the chunk's
// counted writes are added and, if the total would pass the cap, the job stops with status
// `paused_cap` in `ingest_cursor` (job `backfill:<name>`). It resumes by itself in the next month.
import { HistoryConflict } from "./dataRepo.mjs";
import {
  ADMIN_WRITES,
  ANNOUNCEMENT_SOURCE,
  BACKFILL_WRITE_CAP_MONTH,
  BATCH1_JOB,
  EMPTY_MONTHS_DEPTH,
  JOB_ASIC,
  JOB_ASX,
  MARKET,
  MAX_ITEMS_PER_DAY,
  MAX_MONTHS_PER_RUN,
  RUN_JOB,
  STATUS_SOURCE,
  addDays,
  addMonths,
  announcementLine,
  announcementWrites,
  capDecision,
  floorDate,
  gzipDeterministic,
  historyLocation,
  isMonth,
  isRealDate,
  lastCompleteMonth,
  monthFirstDay,
  monthLastDay,
  monthOf,
  monthsToDo,
  previousWeekday,
  quotaMonth,
  sydneyDate,
  toJsonl,
  validateAnnouncement,
} from "./rules.mjs";

const ROWS_PER_STATEMENT = 100;
const MAX_EXPORT_ROWS = 400_000;
const cursorJob = (name) => `backfill:${name}`;
const mayFetchMode = (m) => m === "on" || m === "degraded";

/**
 * @typedef {import("@libsql/client").Client} Client
 * @typedef {import("@libsql/client").InStatement} Stmt
 */

/** Today's Sydney date. @param {number} nowMs */
const todayOf = (nowMs) => sydneyDate(nowMs);

/** The first-run cursor for a job (the newest date still to do). @param {string} name */
export function initialCursor(name, nowMs) {
  const today = todayOf(nowMs);
  return name === JOB_ASX ? previousWeekday(today) : monthLastDay(lastCompleteMonth(today));
}

/** Create the job rows if they are missing (idempotent, no write when present). */
export async function ensureJobs(db, nowMs) {
  const stmts = [JOB_ASX, JOB_ASIC].map((name) => ({
    sql: "INSERT INTO backfill_job (name, source, next_date, done, rows_written_month) VALUES (?, ?, ?, 0, 0) ON CONFLICT DO NOTHING",
    args: [name, STATUS_SOURCE[name], initialCursor(name, nowMs)],
  }));
  await db.batch(stmts, "write");
}

/** @returns {Promise<Record<string, any>>} the stored state of a job (status plus counters) */
export async function readState(db, name) {
  const r = await db.execute({
    sql: "SELECT cursor_json FROM ingest_cursor WHERE job = ? AND market = ? AND source = ?",
    args: [cursorJob(name), MARKET, STATUS_SOURCE[name]],
  });
  if (!r.rows.length) return { status: "new" };
  try {
    const v = JSON.parse(String(r.rows[0].cursor_json));
    return v && typeof v === "object" && !Array.isArray(v) ? v : { status: "new" };
  } catch {
    return { status: "new" };
  }
}

/** The statement that stores a job state (shared by single writes and batches). */
function stateStmt(name, state, nowIso) {
  return {
    sql: `INSERT INTO ingest_cursor (job, market, source, cursor_json, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (job, market, source) DO UPDATE SET cursor_json = excluded.cursor_json,
          updated_at = excluded.updated_at`,
    args: [cursorJob(name), MARKET, STATUS_SOURCE[name], JSON.stringify(state), nowIso],
  };
}

/** Write a state only when the status or reason changed (no per-minute write churn). */
async function setStatus(db, name, state, status, reason, nowIso) {
  if (state.status === status && (state.reason ?? null) === (reason ?? null)) return state;
  const next = { ...state, status, reason: reason ?? null };
  await db.execute(stateStmt(name, next, nowIso));
  return next;
}

export async function getJob(db, name) {
  const r = await db.execute({
    sql: "SELECT name, next_date, done, rows_written_month FROM backfill_job WHERE name = ?",
    args: [name],
  });
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    name,
    nextDate: row.next_date === null ? null : String(row.next_date),
    done: Number(row.done) === 1,
    rowsWrittenMonth: Number(row.rows_written_month),
    state: await readState(db, name),
  };
}

/** Counted writes in the UTC quota month by batch1 and the backfill (decision 13, one counter). */
export async function monthUsage(db, nowMs) {
  const { start, end } = quotaMonth(nowMs);
  const r = await db.execute({
    sql: `SELECT COALESCE(SUM(rows_written), 0) AS w FROM run_record
          WHERE job IN (?, ?) AND started_at >= ? AND started_at < ?`,
    args: [BATCH1_JOB, RUN_JOB, start, end],
  });
  return Number(r.rows[0].w);
}

async function sourceMode(db, name) {
  const r = await db.execute({
    sql: "SELECT mode FROM source_status WHERE source = ?",
    args: [STATUS_SOURCE[name]],
  });
  return r.rows.length ? String(r.rows[0].mode) : null;
}

/** DAT-123/127: a source that is off, tripped or unknown is not fetched or written. */
async function gate(db, job, nowIso) {
  const mode = await sourceMode(db, job.name);
  if (!mayFetchMode(mode)) {
    job.state = await setStatus(db, job.name, job.state, "source_off", mode ?? "unknown", nowIso);
    return false;
  }
  return true;
}

function runRecordStmt(key, scheduledFor, nowIso, p) {
  return {
    sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at,
            status, items_processed, rows_read, rows_written, llm_tokens, duration_ms, details_json, commit_sha)
          VALUES (?, ?, ?, ?, ?, ?, 'success', ?, ?, ?, 0, 0, ?, ?)`,
    args: [
      RUN_JOB,
      MARKET,
      key,
      scheduledFor,
      nowIso,
      nowIso,
      p.items,
      p.rowsRead ?? 0,
      p.rowsWritten,
      JSON.stringify(p.details),
      p.commitSha ?? null,
    ],
  };
}

const insertAnnouncements = (rows, nowIso) => {
  const stmts = [];
  const ph = "(?,?,?,?,?,?,?,?,?,?)";
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const slice = rows.slice(i, i + ROWS_PER_STATEMENT);
    stmts.push({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type,
              price_sensitive, title, url, source) VALUES ${slice.map(() => ph).join(",")}
            ON CONFLICT DO NOTHING`,
      args: slice.flatMap((r) => [
        MARKET,
        r.code,
        r.annId,
        r.publishedAt,
        nowIso,
        r.type,
        r.priceSensitive,
        r.title,
        r.url,
        ANNOUNCEMENT_SOURCE,
      ]),
    });
  }
  return stmts;
};

/** Writes already counted for this job in the current quota month (resets when the month turns). */
const monthBase = (job, nowMs) =>
  job.state.writes_month === quotaMonth(nowMs).start.slice(0, 7) ? job.rowsWrittenMonth : 0;

const isConstraint = (e) =>
  /constraint|unique/i.test(String(e?.code ?? "") + String(e?.message ?? ""));

/**
 * Commit one ASX date (called by the Worker's slot 5 path after the token was granted and the
 * page parsed). All or nothing.
 * @param {Client} db
 * @param {{ date: string, items: unknown[], nowMs: number, cap?: number, commitSha?: string }} o
 */
export async function commitAsxDay(db, o) {
  const cap = o.cap ?? BACKFILL_WRITE_CAP_MONTH;
  const nowIso = new Date(o.nowMs).toISOString();
  if (!isRealDate(o.date) || !Array.isArray(o.items))
    return { status: "rejected", reason: "bad_input" };
  if (o.items.length > MAX_ITEMS_PER_DAY) return { status: "rejected", reason: "too_many_items" };
  let job = await getJob(db, JOB_ASX);
  if (job === null) {
    await ensureJobs(db, o.nowMs);
    job = await getJob(db, JOB_ASX);
  }
  if (job.done || job.nextDate === null) return { status: "done" };
  if (!(await gate(db, job, nowIso))) return { status: "source_off" };
  if (o.date > job.nextDate) return { status: "already_done" };
  if (o.date < job.nextDate) return { status: "out_of_order", expected: job.nextDate };

  const rows = [];
  const seen = new Set();
  /** @type {Record<string, number>} */
  const rejected = {};
  for (const raw of o.items) {
    const v = validateAnnouncement(raw, o.date);
    const reason = "reason" in v ? v.reason : seen.has(v.row.annId) ? "duplicate" : null;
    if (reason !== null) {
      rejected[reason] = (rejected[reason] ?? 0) + 1;
      continue;
    }
    seen.add(/** @type {any} */ (v).row.annId);
    rows.push(/** @type {any} */ (v).row);
  }

  const needed = announcementWrites(rows.length);
  const used = await monthUsage(db, o.nowMs);
  if (!capDecision({ used, cap, needed }).ok) {
    job.state = await setStatus(db, JOB_ASX, job.state, "paused_cap", "write_cap", nowIso);
    return { status: "paused_cap", used, cap, needed };
  }

  const today = todayOf(o.nowMs);
  const nextDate = previousWeekday(o.date);
  const done = nextDate < floorDate(today);
  const counted = needed;
  const state = {
    ...job.state,
    status: done ? "done" : "active",
    reason: done ? "floor" : null,
    writes_month: quotaMonth(o.nowMs).start.slice(0, 7),
    last_date: o.date,
  };
  const stmts = [
    ...insertAnnouncements(rows, nowIso),
    {
      sql: "UPDATE backfill_job SET next_date = ?, done = ?, rows_written_month = ? WHERE name = ?",
      args: [done ? null : nextDate, done ? 1 : 0, monthBase(job, o.nowMs) + counted, JOB_ASX],
    },
    runRecordStmt(`${RUN_JOB}:${JOB_ASX}:${o.date}`, o.date, nowIso, {
      items: rows.length,
      rowsRead: 0,
      rowsWritten: counted,
      details: { kind: "asx_day", date: o.date, rows: rows.length, rejected },
      commitSha: o.commitSha,
    }),
    stateStmt(JOB_ASX, state, nowIso),
  ];
  try {
    await db.batch(stmts, "write");
  } catch (e) {
    // A second commit of the same date lost the race: the first one is the record.
    if (isConstraint(e)) return { status: "already_done" };
    throw e;
  }
  return {
    status: "ok",
    rows: rows.length,
    rejected,
    counted,
    nextDate: done ? null : nextDate,
    done,
  };
}

/**
 * Commit one ASIC month: upload the month file (write-once, SHA-skip), then move the cursor.
 * `rows` are the parsed rows of EVERY weekday of the month up to the cursor (an absent day is
 * simply missing). A conflicting existing file stops the job (nothing is overwritten).
 * @param {Client} db
 * @param {{ month: string, rows: object[], store: { put: Function }, nowMs: number, cap?: number,
 *   commitSha?: string }} o
 */
export async function commitHistoryMonth(db, o) {
  const cap = o.cap ?? BACKFILL_WRITE_CAP_MONTH;
  const nowIso = new Date(o.nowMs).toISOString();
  if (!isMonth(o.month) || !Array.isArray(o.rows))
    return { status: "rejected", reason: "bad_input" };
  let job = await getJob(db, JOB_ASIC);
  if (job === null) {
    await ensureJobs(db, o.nowMs);
    job = await getJob(db, JOB_ASIC);
  }
  if (job.done || job.nextDate === null) return { status: "done" };
  if (!(await gate(db, job, nowIso))) return { status: "source_off" };
  const expected = monthOf(job.nextDate);
  if (o.month > expected) return { status: "already_done" };
  if (o.month < expected) return { status: "out_of_order", expected };

  const used = await monthUsage(db, o.nowMs);
  if (!capDecision({ used, cap, needed: ADMIN_WRITES }).ok) {
    job.state = await setStatus(db, JOB_ASIC, job.state, "paused_cap", "write_cap", nowIso);
    return { status: "paused_cap", used, cap, needed: ADMIN_WRITES };
  }

  let file = null;
  if (o.rows.length > 0) {
    const sorted = [...o.rows].sort((a, b) => {
      const ka = `${a.as_of}|${a.code}`;
      const kb = `${b.as_of}|${b.code}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const bytes = gzipDeterministic(toJsonl(sorted));
    try {
      file = await o.store.put(historyLocation(JOB_ASIC, o.month), bytes);
    } catch (e) {
      if (e instanceof HistoryConflict) {
        job.state = await setStatus(db, JOB_ASIC, job.state, "failed", "history_conflict", nowIso);
        return { status: "conflict" };
      }
      throw e;
    }
  }

  const today = todayOf(o.nowMs);
  const nextDate = addDays(monthFirstDay(o.month), -1);
  const streak = o.rows.length === 0 ? Number(job.state.empty_streak ?? 0) + 1 : 0;
  const depth = streak >= EMPTY_MONTHS_DEPTH;
  const atFloor = nextDate < floorDate(today);
  const done = depth || atFloor;
  const state = {
    ...job.state,
    status: done ? "done" : "active",
    reason: depth ? "archive_depth" : atFloor ? "floor" : null,
    empty_streak: streak,
    oldest_data_month: o.rows.length > 0 ? o.month : (job.state.oldest_data_month ?? null),
    writes_month: quotaMonth(o.nowMs).start.slice(0, 7),
    last_month: o.month,
  };
  const counted = ADMIN_WRITES;
  const stmts = [
    {
      sql: "UPDATE backfill_job SET next_date = ?, done = ?, rows_written_month = ? WHERE name = ?",
      args: [done ? null : nextDate, done ? 1 : 0, monthBase(job, o.nowMs) + counted, JOB_ASIC],
    },
    runRecordStmt(`${RUN_JOB}:${JOB_ASIC}:${o.month}`, nextDate, nowIso, {
      items: o.rows.length,
      rowsWritten: counted,
      details: {
        kind: "asic_month",
        month: o.month,
        rows: o.rows.length,
        file: file === null ? null : { result: file.result, sha256: file.sha256 },
      },
      commitSha: o.commitSha,
    }),
    stateStmt(JOB_ASIC, state, nowIso),
  ];
  try {
    await db.batch(stmts, "write");
  } catch (e) {
    if (isConstraint(e)) return { status: "already_done" };
    throw e;
  }
  return {
    status: "ok",
    rows: o.rows.length,
    file: file === null ? "none" : file.result,
    nextDate: done ? null : nextDate,
    done,
    reason: state.reason,
  };
}

/**
 * What the no-secrets ASIC fetch step should do this run (read-only apart from a status change).
 * @param {Client} db @param {{ nowMs: number, cap?: number, maxMonths?: number }} o
 */
export async function planAsic(db, o) {
  const cap = o.cap ?? BACKFILL_WRITE_CAP_MONTH;
  const nowIso = new Date(o.nowMs).toISOString();
  await ensureJobs(db, o.nowMs);
  const job = await getJob(db, JOB_ASIC);
  if (job.done || job.nextDate === null) return { action: "none", reason: "done" };
  if (!(await gate(db, job, nowIso))) return { action: "none", reason: "source_off" };
  const used = await monthUsage(db, o.nowMs);
  if (!capDecision({ used, cap, needed: ADMIN_WRITES }).ok) {
    await setStatus(db, JOB_ASIC, job.state, "paused_cap", "write_cap", nowIso);
    return { action: "none", reason: "paused_cap" };
  }
  const months = monthsToDo(
    job.nextDate,
    floorDate(todayOf(o.nowMs)),
    o.maxMonths ?? MAX_MONTHS_PER_RUN,
  );
  return { action: "fetch", months };
}

/**
 * Write every complete past month of announcement history that has no file yet (oldest data last).
 * A month is complete when the cursor is below its first day (or the job is done) and the month
 * is before the current Sydney month. An existing file with other content is a conflict: it is
 * reported, never replaced, and the export moves on.
 * @param {Client} db
 * @param {{ store: { put: Function }, nowMs: number, cap?: number, maxMonths?: number,
 *   commitSha?: string }} o
 */
export async function exportAsxMonths(db, o) {
  const cap = o.cap ?? BACKFILL_WRITE_CAP_MONTH;
  const nowIso = new Date(o.nowMs).toISOString();
  const max = o.maxMonths ?? MAX_MONTHS_PER_RUN;
  const res = {
    exported: [],
    skipped: [],
    conflicts: [],
    stopped: /** @type {string | null} */ (null),
  };
  const job = await getJob(db, JOB_ASX);
  if (job === null) return { ...res, stopped: "no_job" };
  const today = todayOf(o.nowMs);
  const floorMonth = monthOf(floorDate(today));
  let state = job.state;
  for (let i = 0; i < max; i++) {
    const month = state.exported_down_to
      ? addMonths(state.exported_down_to, -1)
      : lastCompleteMonth(today);
    if (month < floorMonth) {
      res.stopped = "all_exported";
      break;
    }
    const complete = job.done || (job.nextDate !== null && job.nextDate < monthFirstDay(month));
    if (!complete) {
      res.stopped = "not_complete";
      break;
    }
    const used = await monthUsage(db, o.nowMs);
    if (!capDecision({ used, cap, needed: ADMIN_WRITES }).ok) {
      await setStatus(db, JOB_ASX, state, "paused_cap", "write_cap", nowIso);
      res.stopped = "paused_cap";
      break;
    }
    // Sydney months do not line up with UTC days: read a day either side, keep the right month.
    const sel = await db.execute({
      sql: `SELECT source, ann_id, code, published_at, type, price_sensitive, title, url FROM announcement
            WHERE market = ? AND source = ? AND published_at >= ? AND published_at < ?
            ORDER BY published_at, ann_id LIMIT ?`,
      args: [
        MARKET,
        ANNOUNCEMENT_SOURCE,
        `${addDays(monthFirstDay(month), -1)}T00:00:00.000Z`,
        `${addDays(monthLastDay(month), 2)}T00:00:00.000Z`,
        MAX_EXPORT_ROWS + 1,
      ],
    });
    if (sel.rows.length > MAX_EXPORT_ROWS) {
      res.stopped = "too_many_rows";
      break;
    }
    const lines = sel.rows
      .filter((r) => monthOf(sydneyDate(Date.parse(String(r.published_at)))) === month)
      .map((r) => announcementLine(r));
    let fileResult = "none";
    let sha = null;
    if (lines.length > 0) {
      try {
        const f = await o.store.put(
          historyLocation(JOB_ASX, month),
          gzipDeterministic(toJsonl(lines)),
        );
        fileResult = f.result;
        sha = f.sha256;
        (f.result === "uploaded" ? res.exported : res.skipped).push(month);
      } catch (e) {
        if (!(e instanceof HistoryConflict)) throw e;
        fileResult = "conflict";
        res.conflicts.push(month);
      }
    }
    state = {
      ...state,
      exported_down_to: month,
      conflicts:
        fileResult === "conflict" ? [...(state.conflicts ?? []), month] : (state.conflicts ?? []),
    };
    try {
      await db.batch(
        [
          runRecordStmt(`${RUN_JOB}:export:${JOB_ASX}:${month}`, monthLastDay(month), nowIso, {
            items: lines.length,
            rowsRead: sel.rows.length,
            rowsWritten: ADMIN_WRITES,
            details: {
              kind: "asx_export",
              month,
              rows: lines.length,
              file: fileResult,
              sha256: sha,
            },
            commitSha: o.commitSha,
          }),
          stateStmt(JOB_ASX, state, nowIso),
        ],
        "write",
      );
    } catch (e) {
      if (!isConstraint(e)) throw e;
      // The record already exists (an earlier run lost its state write): only advance the state.
      await db.execute(stateStmt(JOB_ASX, state, nowIso));
    }
  }
  return res;
}
