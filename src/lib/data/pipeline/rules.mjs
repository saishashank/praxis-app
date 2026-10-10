// Batch 1 pure rules (M2 T6): Sydney dates and the trading calendar, bar validation, the re-fetch
// compare, the catch-up plan and the throttle bounds. Plain ESM + JSDoc (no TS build) so the Actions
// CLI (scripts/ingest/batch1.mjs) and the vitest suites import the same file, like migrate-core.mjs.
// No database, no network, no clock: every function is a pure function of its arguments.
//
// This module mirrors src/lib/data/calendar.ts (isTradingDay, previousTradingDay, marketDate) and
// src/lib/data/sources/yahoo.ts (validateBar, parseYahooBars) because plain Node cannot import the
// TS files. tests/pipeline/rules.test.ts checks both pairs against each other, so a drift fails CI.
import { createHash } from "node:crypto";

export const MARKET = "AU";
export const TZ = "Australia/Sydney";
export const SOURCE = "yahoo_eod";

/** Catch-up bounds (design section 3: "bounded, for example 5"). The target date always counts. */
export const MAX_DATES_PER_RUN = 5;
export const LOOKBACK_DAYS = 30;
/** Decision 13 (D-057): backfill and catch-up writes stay under 2M rows per UTC month. */
export const BACKFILL_WRITE_CAP_MONTH = 2_000_000;
/** DAT-002 / ch.15 refetch_diff_flag: a difference above 0.1 % on any field is recorded. */
export const REFETCH_DIFF_PCT = 0.1;

export const DEFAULT_CHUNK_SIZE = 100;
export const DEFAULT_MIN_GAP_S = 5;
const CHUNK_BOUNDS = [10, 500];
const GAP_BOUNDS = [1, 60];

const DAY_MS = 86_400_000;
const CODE_RE = /^[A-Z0-9]{2,6}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FETCHED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const FIELDS = ["open", "high", "low", "close", "adj_close"];
const SEARCH_LIMIT = 30;

/** @param {unknown} s @returns {s is string} */
export function isRealDate(s) {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** @param {unknown} code */
export const isValidCode = (code) => typeof code === "string" && CODE_RE.test(code);

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** Sydney local calendar date of an instant, as YYYY-MM-DD (D-057 #1). @param {number} ms */
export function sydneyDate(ms) {
  if (!Number.isFinite(ms)) throw new RangeError("invalid time");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** @param {string} date @param {number} n */
export function addDays(date, n) {
  if (!isRealDate(date)) throw new RangeError(`bad date: ${date}`);
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** @param {string} date */
export function isWeekend(date) {
  if (!isRealDate(date)) throw new RangeError(`bad date: ${date}`);
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * A weekday without a holiday row is a trading day (provisional, as calendar.ts).
 * @param {string} date @param {readonly { d: string, kind: string }[]} rows
 */
export function isTradingDay(date, rows) {
  return !isWeekend(date) && !rows.some((r) => r.kind === "holiday" && r.d === date);
}

/** @param {string} date @param {readonly { d: string, kind: string }[]} rows */
export function previousTradingDay(date, rows) {
  for (let i = 1; i <= SEARCH_LIMIT; i++) {
    const d = addDays(date, -i);
    if (isTradingDay(d, rows)) return d;
  }
  throw new RangeError(`no trading day within ${SEARCH_LIMIT} days before ${date}`);
}

/**
 * Trading days from..to inclusive, oldest first.
 * @param {string} from @param {string} to @param {readonly { d: string, kind: string }[]} rows
 */
export function tradingDaysBetween(from, to, rows) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isTradingDay(d, rows)) out.push(d);
  return out;
}

/**
 * Which dates this run processes (PLT-016 catch-up). `markers` is the set of dates that already
 * have a `data` or `non-trading` completion marker. Missing trading dates inside the look-back
 * window are processed oldest first; the window starts at the first marker ever written (nothing
 * before the pipeline existed is "missed"; history is the backfill's job, T9). With no marker at
 * all only the target date is planned. The target date always makes the plan (a live day is never
 * pushed back by old backlog), so at most `maxDates - 1` older dates join it. A target that is not
 * a trading day gets a `non-trading` marker.
 * @param {{ target: string, markers: ReadonlySet<string>, firstMarker: string | null,
 *   rows: readonly { d: string, kind: string }[], maxDates?: number, lookbackDays?: number }} p
 * @returns {{ dates: { d: string, trading: boolean }[], remaining: number }}
 */
export function planDates(p) {
  const { target, markers, firstMarker, rows } = p;
  const maxDates = p.maxDates ?? MAX_DATES_PER_RUN;
  const lookback = p.lookbackDays ?? LOOKBACK_DAYS;
  const targetTrading = isTradingDay(target, rows);
  const older = [];
  if (firstMarker !== null) {
    const floor = addDays(target, -lookback);
    const from = firstMarker > floor ? firstMarker : floor;
    for (const d of tradingDaysBetween(from, addDays(target, -1), rows)) {
      if (!markers.has(d)) older.push(d);
    }
  }
  const targetMissing = !markers.has(target);
  const room = Math.max(0, maxDates - (targetMissing ? 1 : 0));
  const picked = older.slice(0, room);
  const dates = picked.map((d) => ({ d, trading: true }));
  if (targetMissing) dates.push({ d: target, trading: targetTrading });
  return { dates, remaining: older.length - picked.length };
}

/**
 * One raw bar (the shape written by scripts/ingest/yahoo_fetch.py) -> typed row or a reason.
 * @param {unknown} raw @param {{ from?: string, to?: string }} [opts]
 * @returns {{ row: Record<string, any> } | { reason: string }}
 */
export function validateBar(raw, opts = {}) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { reason: "not_an_object" };
  }
  const r = /** @type {Record<string, any>} */ (raw);
  if (typeof r.code !== "string" || !CODE_RE.test(r.code)) return { reason: "bad_code" };
  if (!isRealDate(r.date)) return { reason: "bad_date" };
  if ((opts.from && r.date < opts.from) || (opts.to && r.date > opts.to)) {
    return { reason: "date_out_of_range" };
  }
  const fin = (v) => typeof v === "number" && Number.isFinite(v);
  for (const f of FIELDS) if (!fin(r[f])) return { reason: "bad_number" };
  if (!fin(r.volume)) return { reason: "bad_number" };
  const [open, high, low, close, adj] = FIELDS.map((f) => r[f]);
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || adj <= 0) {
    return { reason: "non_positive_price" };
  }
  const volume = r.volume;
  if (!Number.isInteger(volume) || volume < 0) return { reason: "bad_volume" };
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
    return { reason: "ohlc_inconsistent" };
  }
  if (r.source !== "yahoo") return { reason: "bad_source" };
  if (r.published_at !== null) return { reason: "bad_published_at" };
  if (
    typeof r.fetched_at !== "string" ||
    !FETCHED_RE.test(r.fetched_at) ||
    Number.isNaN(Date.parse(r.fetched_at))
  ) {
    return { reason: "bad_fetched_at" };
  }
  return {
    row: {
      code: r.code,
      date: r.date,
      open,
      high,
      low,
      close,
      volume,
      adj_close: adj,
      source: "yahoo",
      published_at: null,
      fetched_at: r.fetched_at,
    },
  };
}

export class BarsFormatError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "BarsFormatError";
  }
}

/**
 * Parse the decoded contents of bars.json. A non-array is a format error (the whole stage fails
 * visibly); row problems are returned in `rejected` (first row of a code+date wins).
 * @param {unknown} json @param {{ from?: string, to?: string }} [opts]
 */
export function parseBars(json, opts = {}) {
  if (!Array.isArray(json)) throw new BarsFormatError("bars file must be a JSON array");
  const rows = [];
  const rejected = [];
  const seen = new Set();
  json.forEach((raw, index) => {
    const res = validateBar(raw, opts);
    const o = typeof raw === "object" && raw !== null ? /** @type {any} */ (raw) : {};
    const code = typeof o.code === "string" ? o.code : null;
    const date = typeof o.date === "string" ? o.date : null;
    if ("reason" in res) {
      rejected.push({ index, code, date, reason: res.reason });
      return;
    }
    const key = `${res.row.code}|${res.row.date}`;
    if (seen.has(key)) {
      rejected.push({ index, code, date, reason: "duplicate_key" });
      return;
    }
    seen.add(key);
    rows.push(res.row);
  });
  return { rows, rejected, total: json.length };
}

/** @param {string} text @param {{ from?: string, to?: string }} [opts] */
export function parseBarsText(text, opts = {}) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BarsFormatError("bars file is not valid JSON");
  }
  return parseBars(json, opts);
}

/** Counts by reason (counts only, SEC-110 b). @param {{ reason: string }[]} rejected */
export function rejectSummary(rejected) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const r of rejected) out[r.reason] = (out[r.reason] ?? 0) + 1;
  return out;
}

const pct = (stored, fetched) => {
  if (stored === fetched) return 0;
  if (stored === 0) return 100;
  return (Math.abs(fetched - stored) / Math.abs(stored)) * 100;
};

/**
 * DAT-002 re-fetch compare: the largest percentage difference over open, high, low, close and
 * volume. `differs` is true when it is above the threshold.
 * @param {{ o: number, h: number, l: number, c: number, volume: number }} stored
 * @param {{ open: number, high: number, low: number, close: number, volume: number }} fetched
 * @param {number} [threshold]
 */
export function compareBar(stored, fetched, threshold = REFETCH_DIFF_PCT) {
  const maxDiffPct = Math.max(
    pct(stored.o, fetched.open),
    pct(stored.h, fetched.high),
    pct(stored.l, fetched.low),
    pct(stored.c, fetched.close),
    pct(stored.volume, fetched.volume),
  );
  return { differs: maxDiffPct > threshold, maxDiffPct: Math.round(maxDiffPct * 1e6) / 1e6 };
}

/**
 * The nightly hash of one session's re-fetched bars (decision 4): sorted by code, fixed field
 * order, so the same data always gives the same hash.
 * @param {{ code: string, open: number, high: number, low: number, close: number, volume: number }[]} rows
 */
export function refetchHash(rows) {
  const lines = [...rows]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((r) => `${r.code}|${r.open}|${r.high}|${r.low}|${r.close}|${r.volume}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Throttle value from the config store, or the default when absent or out of bounds. */
function bounded(raw, def, [lo, hi]) {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : def;
}

/** @param {unknown} chunkRaw @param {unknown} gapRaw */
export function throttleFrom(chunkRaw, gapRaw) {
  return {
    chunkSize: bounded(chunkRaw, DEFAULT_CHUNK_SIZE, CHUNK_BOUNDS),
    minGapS: bounded(gapRaw, DEFAULT_MIN_GAP_S, GAP_BOUNDS),
  };
}

/**
 * UTC calendar month bounds of an instant (the Turso quota month, as usage/meters.ts).
 * @param {number} ms
 */
export function monthBoundsUtc(ms) {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
