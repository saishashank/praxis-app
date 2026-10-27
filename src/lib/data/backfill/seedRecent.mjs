// Seeds the database's recent price window from the history files (D-199, DAT-140, DAT-142).
// The design keeps the last `turso_recent_sessions` sessions of bars in Turso and the older years as
// write-once month files in the private data repo; the price backfill only ever wrote the files, so
// production held just the nightly bars since go-live. Too few sessions for the ARN-010 size groups
// (60) or the signal look-backs (F1 new high 250, SMA 200), so no tier, no signal and no pick.
// This copies the sessions before the oldest stored bar, newest first, from the month files:
// INSERT ... ON CONFLICT DO NOTHING (and the first-seen trigger), so a nightly bar is never replaced
// and a repeat writes nothing. The writes count against the backfill cap (decision 13) through a
// `backfill-history` run record. Pure apart from the database; the CLI supplies the files.
import { BACKFILL_WRITE_CAP_MONTH } from "../pipeline/rules.mjs";
import { monthUsage } from "./engine.mjs";
import { JOB_YAHOO, YAHOO_SOURCE } from "./priceHistory.mjs";
import {
  ADMIN_WRITES,
  INDEX_FACTOR,
  MARKET,
  RUN_JOB,
  addMonths,
  capDecision,
  fromJsonlGz,
  isValidCode,
  monthOf,
} from "./rules.mjs";

/** Sessions seeded: one more year than the longest look-back (F1 high 250) needs. */
export const SEED_SESSIONS = 270;
/** Month files read at most: 270 sessions are about 13 months, so missing months still stop. */
export const SEED_MAX_MONTHS = 24;
const CHUNK = 200; // rows per INSERT: 11 columns x 200 stays under the SQLite variable limit

/**
 * @param {import("@libsql/client").Client} db
 * @param {{ readMonth: (month: string) => Uint8Array | null, nowMs: number, sessions?: number,
 *   cap?: number, commitSha?: string }} o
 * @returns {Promise<{ status: "ok" | "nothing" | "paused_cap" | "no_files", sessions: number,
 *   rows: number, written: number, from?: string, to?: string, needed?: number, used?: number }>}
 */
export async function seedRecentBars(db, o) {
  const want = o.sessions ?? SEED_SESSIONS;
  const cap = o.cap ?? BACKFILL_WRITE_CAP_MONTH;
  const nowIso = new Date(o.nowMs).toISOString();
  const first = await db.execute({
    sql: "SELECT MIN(d) AS d, COUNT(DISTINCT d) AS n FROM price_bar WHERE market = ?",
    args: [MARKET],
  });
  const have = Number(first.rows[0]?.n ?? 0);
  if (have >= want) return { status: "nothing", sessions: 0, rows: 0, written: 0 };
  const before = first.rows[0]?.d == null ? nowIso.slice(0, 10) : String(first.rows[0].d);

  // newest month first, until enough distinct sessions before `before` are collected
  const byDate = new Map();
  let month = monthOf(before);
  let files = 0;
  for (let i = 0; i < SEED_MAX_MONTHS && byDate.size < want - have; i += 1) {
    const bytes = o.readMonth(month);
    if (bytes !== null) {
      files += 1;
      for (const r of fromJsonlGz(bytes)) {
        if (typeof r.d !== "string" || r.d >= before || !isValidCode(r.code)) continue;
        if (![r.o, r.h, r.l, r.c].every((v) => typeof v === "number" && v > 0)) continue;
        if (!Number.isInteger(r.volume) || r.volume < 0) continue;
        const list = byDate.get(r.d) ?? [];
        list.push(r);
        byDate.set(r.d, list);
      }
    }
    month = addMonths(month, -1);
  }
  if (files === 0) return { status: "no_files", sessions: 0, rows: 0, written: 0 };
  const dates = [...byDate.keys()].sort().slice(-(want - have));
  const bars = dates.flatMap((d) => byDate.get(d));
  if (bars.length === 0) return { status: "nothing", sessions: 0, rows: 0, written: 0 };

  const needed = Math.ceil(bars.length * INDEX_FACTOR) + ADMIN_WRITES;
  const used = await monthUsage(db, o.nowMs);
  if (!capDecision({ used, cap, needed }).ok) {
    return {
      status: "paused_cap",
      sessions: dates.length,
      rows: bars.length,
      written: 0,
      needed,
      used,
    };
  }

  let written = 0;
  for (let i = 0; i < bars.length; i += CHUNK) {
    const slice = bars.slice(i, i + CHUNK);
    const res = await db.execute({
      sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES ${slice.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")} ON CONFLICT DO NOTHING`,
      // DAT-001: no publication time is known for a back-filled bar, so published_at = ingested_at
      args: slice.flatMap((b) => [
        MARKET,
        b.code,
        b.d,
        b.o,
        b.h,
        b.l,
        b.c,
        b.volume,
        YAHOO_SOURCE,
        nowIso,
        nowIso,
      ]),
    });
    written += res.rowsAffected;
  }
  const from = dates[0];
  const to = dates[dates.length - 1];
  await db.execute({
    sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at,
            status, items_processed, rows_read, rows_written, llm_tokens, duration_ms, details_json, commit_sha)
          VALUES (?, ?, ?, NULL, ?, ?, 'success', ?, 0, ?, 0, 0, ?, ?)
          ON CONFLICT DO NOTHING`,
    args: [
      RUN_JOB,
      MARKET,
      `seed-recent:${MARKET}:${from}:${to}`,
      nowIso,
      nowIso,
      bars.length,
      Math.ceil(written * INDEX_FACTOR) + ADMIN_WRITES,
      JSON.stringify({ kind: "seed_recent", source: JOB_YAHOO, sessions: dates.length, from, to }),
      o.commitSha ?? null,
    ],
  });
  return { status: "ok", sessions: dates.length, rows: bars.length, written, from, to };
}
