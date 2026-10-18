// ASIC daily aggregate short positions in the Batch 1 pipeline (M4 T3, design 2.5/3, decision 13,
// DAT-125a, D-065). The fetch (scripts/ingest/asic_fetch.mjs, no secrets) reuses the polite ASIC
// fetcher of the backfill and writes short.json; this module validates that file, writes
// `short_interest` first-seen (ON CONFLICT DO NOTHING) and reads it back look-ahead safe.
// The file carries no publication time: `published_at` is ASSUMED as as_of + 5 weekdays (end of
// day) and the row is flagged `assumed_time = 1` (D-065). Plain ESM + JSDoc.
import { addDays, isRealDate, isValidCode, isWeekend } from "./pipeline/rules.mjs";
import { asicPublishedAt } from "./backfill/rules.mjs";

export const SHORT_MARKET = "AU";
/** `source_status.source` id and the `short_interest.source` value. */
export const SHORT_SOURCE = "asic_short";
/** ASIC files are requested for the weekdays of the last N calendar days (the lag is ~T+4). */
export const SHORT_WINDOW_DAYS = 12;
export const SHORT_MAX_DATES = 8;
const ROWS_PER_STATEMENT = 100;
const STOPS = ["blocked", "rate_limited", "http_error", "malformed", "network"];

/** Parts per million of issued shares, clamped to the column's range. */
export const shortPpm = (/** @type {number} */ short, /** @type {number} */ total) =>
  Math.min(1_000_000, Math.max(0, Math.round((short / total) * 1_000_000)));

/** A source that is off, tripped or unknown is not written (DAT-123/127). */
export async function shortSourceMode(db) {
  const r = await db.execute({
    sql: "SELECT mode FROM source_status WHERE source = ?",
    args: [SHORT_SOURCE],
  });
  return r.rows.length ? String(r.rows[0].mode) : null;
}
export const shortModeAllowsFetch = (/** @type {string | null} */ m) =>
  m === "on" || m === "degraded";

/**
 * Weekdays in the window that have no stored row yet (oldest first, at most SHORT_MAX_DATES
 * newest ones). Used by `prepare` to build the no-secrets fetch request.
 * @param {import("@libsql/client").Client} db @param {{ target: string, market?: string }} o
 */
export async function planShortDates(db, o) {
  const from = addDays(o.target, -SHORT_WINDOW_DAYS);
  const have = await db.execute({
    sql: "SELECT DISTINCT as_of FROM short_interest WHERE market = ? AND as_of >= ? AND as_of <= ?",
    args: [o.market ?? SHORT_MARKET, from, o.target],
  });
  const stored = new Set(have.rows.map((r) => String(r.as_of)));
  const out = [];
  for (let d = from; d <= o.target; d = addDays(d, 1)) {
    if (!isWeekend(d) && !stored.has(d)) out.push(d);
  }
  return out.slice(-SHORT_MAX_DATES);
}

/**
 * Parse short.json: `{ stopped, dates, absent, skipped, rows: [...] }`. Rows come from the
 * shared ASIC parser; they are re-validated here and never trusted for the publication time.
 * @param {string | null | undefined} text
 * @returns {{ status: "no_file" | "invalid" | "ok", stopped: string | null, rows: object[],
 *   rejected: number, dates: number, absent: number }}
 */
export function parseShortText(text) {
  const bad = (status) => ({ status, stopped: null, rows: [], rejected: 0, dates: 0, absent: 0 });
  if (text == null) return bad("no_file");
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return bad("invalid");
  }
  if (typeof j !== "object" || j === null || !Array.isArray(j.rows)) return bad("invalid");
  const rows = [];
  const seen = new Set();
  let rejected = 0;
  for (const r of j.rows) {
    const ok =
      typeof r === "object" &&
      r !== null &&
      isRealDate(r.as_of) &&
      isValidCode(r.code) &&
      Number.isFinite(r.short_positions) &&
      Number.isFinite(r.total_in_issue) &&
      r.short_positions >= 0 &&
      r.total_in_issue > 0 &&
      !seen.has(`${r.code}|${r.as_of}`);
    if (!ok) {
      rejected++;
      continue;
    }
    seen.add(`${r.code}|${r.as_of}`);
    rows.push({
      code: r.code,
      as_of: r.as_of,
      short_ppm: shortPpm(r.short_positions, r.total_in_issue),
    });
  }
  const num = (v) => (Number.isFinite(v) ? Number(v) : 0);
  return {
    status: "ok",
    stopped: STOPS.includes(j.stopped) ? j.stopped : null,
    rows,
    rejected,
    dates: num(j.dates),
    absent: num(j.absent),
  };
}

/**
 * Insert first-seen with the assumed publication time. Returns rows inserted; a re-run writes 0.
 * @param {import("@libsql/client").Client} db
 * @param {{ market?: string, rows: { code: string, as_of: string, short_ppm: number }[], ingestedAt: string }} o
 */
export async function writeShortInterest(db, o) {
  if (o.rows.length === 0) return 0;
  const market = o.market ?? SHORT_MARKET;
  const cols = "market,code,as_of,short_ppm,published_at,ingested_at,assumed_time,source";
  const stmts = [];
  for (let i = 0; i < o.rows.length; i += ROWS_PER_STATEMENT) {
    const slice = o.rows.slice(i, i + ROWS_PER_STATEMENT);
    stmts.push({
      sql: `INSERT INTO short_interest (${cols}) VALUES ${slice.map(() => "(?,?,?,?,?,?,1,?)").join(",")} ON CONFLICT DO NOTHING`,
      args: slice.flatMap((r) => [
        market,
        r.code,
        r.as_of,
        r.short_ppm,
        asicPublishedAt(r.as_of),
        o.ingestedAt,
        SHORT_SOURCE,
      ]),
    });
  }
  const res = await db.batch(stmts, "write");
  return res.reduce((a, r) => a + r.rowsAffected, 0);
}

/**
 * Short-interest history for one code as known on decision date D: only rows with as_of <= D
 * whose (assumed) publication time is not after the end of D. Oldest first.
 * @param {import("@libsql/client").Client} db
 * @param {{ code: string, asOf: string, limit?: number, market?: string }} o
 */
export async function readShortInterest(db, o) {
  if (!isRealDate(o.asOf)) throw new RangeError("asOf must be YYYY-MM-DD");
  const limit = Math.max(1, Math.min(o.limit ?? 260, 2000));
  const r = await db.execute({
    sql: `SELECT as_of, short_ppm, published_at, assumed_time FROM short_interest
          WHERE market = ? AND code = ? AND as_of <= ? AND published_at <= ?
          ORDER BY as_of DESC LIMIT ?`,
    args: [o.market ?? SHORT_MARKET, o.code, o.asOf, `${o.asOf}T23:59:59.999Z`, limit],
  });
  return r.rows
    .map((x) => ({
      asOf: String(x.as_of),
      shortPpm: Number(x.short_ppm),
      publishedAt: String(x.published_at),
      assumedTime: Number(x.assumed_time) === 1,
    }))
    .reverse();
}
