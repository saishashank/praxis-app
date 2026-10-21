// History backfill: pure rules (M2 T9). No database, no network, no clock. Plain ESM + JSDoc so the
// Actions CLI (scripts/backfill/*.mjs) and the vitest suites import the same file. The database
// side is ./engine.mjs, the data-repo client is ./dataRepo.mjs, the polite ASIC fetcher is
// ./asicFetch.mjs.
//
// Verbatim quotes (grep -n; spec/ and docs/M2_design.md):
//
// spec/06_data_layer.md:71 DAT-125:
//   "**DAT-125 (s9) Historical announcement backfill.** From M2, announcement **metadata** (code,
//   time, type, price-sensitive flag, title) is backfilled over ≥ 6 years via DAT-122 slot (5),
//   **enumerated by date rather than by today's code list** so delisted codes are included
//   [VERIFY the ASX search supports this; otherwise record the gap]"
// spec/06_data_layer.md:72 DAT-125a:
//   "**DAT-125a (s9) Short-interest history.** From M2 the ASIC daily aggregated short-position
//   history (public, free [VERIFY archive depth]) is backfilled with `as_of` and `published_at`,
//   so F6's class (d) is replayable. If it cannot be backfilled, F6 replay is "not reachable" for
//   the missing years and the app says so; no substitute threshold is invented."
// spec/06_data_layer.md:73 DAT-126 (not built here; the raw-price reconstruction is T8):
//   "**DAT-126 (s9) Historical raw prices.** Vendor history is split-adjusted; for replays,
//   as-of-D raw prices are reconstructed by reversing vendor split events **cross-checked against
//   announcement titles** (consolidations, splits); mismatches flag the code."
// spec/06_data_layer.md:98 DAT-130:
//   "No free point-in-time membership or complete delisted history exists: the system stores its
//   own daily universe snapshot from day 1 of M2 for AU"
// spec/06_data_layer.md:99 DAT-131:
//   "Backtest reports state the share of the test period covered by own snapshots and by the
//   event backfill (DAT-125)."
// spec/06_data_layer.md:102 DAT-140:
//   "Full price history is appended nightly to compressed columnar files (one per market-year)
//   stored as **release assets of a separate private data repository** (`<repo>-data`, PLT-022a)
//   [VERIFY asset limits]. ... Backfills are staged to ≤ 50% of a month's write quota."
// spec/06_data_layer.md:103 DAT-141:
//   "Ceilings: storage ≤ 3 GB; writes ≤ 6M/month (staging ≤ 15% of that); reads ≤ 300M/month."
//   and "each job records rows read/written;"
// spec/06_data_layer.md:104 DAT-142:
//   "**DAT-142 (s9) Retention:** market data in Turso 500 sessions; logs 30 days; run records 180
//   days; news 400 days; **forever**: ..."
// spec/06_data_layer.md:9 DAT-001:
//   "**Historical (backfilled) rows** use an assumed publication time: bars = that session's close
//   + 30 min; announcements without a time follow ARN-020's session-level rule ... — flagged
//   `assumed_time` and disclosed in replay reports."
// spec/06_data_layer.md:68 DAT-122:
//   "All asx.com.au requests from every component are made **only on Worker cron ticks**, through
//   one database-backed rate token ... **GitHub Actions never waits on the ASX token.** ... (5)
//   history backfill (DAT-125)."
// spec/02_platform_hosting_auth.md:35 PLT-022a:
//   "Backups and `knowledge/` archives MUST go to a **separate private data repository**
//   (`<repo>-data`), never to the code repository, so they never trigger deployments"
// spec/14_system_acceptance.md:22 AT-09:
//   "| AT-09 | Point-in-time | Part A (staging): perturbing data after D leaves decisions up to D
//   unchanged. Part B (production): universe snapshots stored daily since M2 start | DAT-001,
//   DAT-130, TST-109 |"
// spec/00_README_and_progress.md:55 O-23:
//   "**ASX announcements: accept the risk of automated personal-use access; owner will seek
//   confirmation from ASX in parallel**"
// docs/M2_design.md section 7, T9 row:
//   "| T9 | History files, backfill jobs (announcements by date, ASIC), budget cap |
//   `.github/workflows/backfill-history.yml`, `src/lib/data/backfill/*` | AT-09 Part A and B; cap
//   test | Data-repo token (f) in `production` |"
// docs/M2_design.md section 6, architect decisions (D-057):
//   "7. **ASIC history:** history files in the data repo only; Turso keeps the current window."
//   "13. **Backfill cap:** 2M writes/month (stricter than the spec's 50 %)."
//
// Choices where the spec is silent (recorded in docs/07_decision_log.md, D-065):
//  - Files are RELEASE ASSETS (DAT-140), one release per source and year `history-<source>-<yyyy>`
//    holding one asset per month `<source>-<yyyy>-<mm>.jsonl.gz` (assets are write-once, so a
//    month is written only when it is complete; "one per market-year" becomes one release per
//    year with a file per month). The logical path is `history/<source>/<yyyy>/<mm>.jsonl.gz`.
//  - Newest month first (the most useful data, and the Turso window, arrive first); the cursor
//    `backfill_job.next_date` is the newest date still to do. Floor: HISTORY_YEARS back.
//  - Counted writes = rows x 2.5 for the indexed `announcement` table (design section 2).
//  - The file bytes are deterministic (sorted rows, fixed key order, gzip header mtime 0 and OS
//    byte 255), so an interrupted run that re-writes a month produces the same SHA-256 and the
//    upload is skipped.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  BACKFILL_WRITE_CAP_MONTH,
  MARKET,
  addDays,
  isRealDate,
  isValidCode,
  monthBoundsUtc,
  sydneyDate,
} from "../pipeline/rules.mjs";

export { BACKFILL_WRITE_CAP_MONTH, MARKET, addDays, isRealDate, isValidCode, sydneyDate };

/** Run-record job name; the cap counter sums this job and `ingest-batch1` (same 2M, decision 13). */
export const RUN_JOB = "backfill-history";
export const BATCH1_JOB = "ingest-batch1";
export const JOB_ASIC = "asic_short_interest";
export const JOB_ASX = "asx_announcements";
export const JOB_NAMES = [JOB_ASIC, JOB_ASX];
/** `source_status.source` ids. */
export const STATUS_SOURCE = { [JOB_ASIC]: "asic_short", [JOB_ASX]: "asx_announcements" };
/** `source` column value written to announcement rows and used in file names. */
export const ANNOUNCEMENT_SOURCE = "asx_announcements";
export const HISTORY_SOURCES = [JOB_ASIC, JOB_ASX];

export const HISTORY_YEARS = 6;
/** Design section 2: an indexed row counts about 2.5 writes ([VERIFY] Turso metering). */
export const INDEX_FACTOR = 2.5;
/** Cursor update + run record + status row: what a chunk costs besides its data rows. */
export const ADMIN_WRITES = 4;
/** News class retention in Turso (DAT-142); older rows only live in history files. */
export const NEWS_RETENTION_DAYS = 400;
export const MAX_MONTHS_PER_RUN = 3;
export const MAX_ITEMS_PER_DAY = 5000;
/** ASIC months with no file at all in a row: the archive has no more depth (DAT-125a). */
export const EMPTY_MONTHS_DEPTH = 3;
/**
 * ASIC publishes the aggregate with a lag; the true publication time is not in the file, so
 * `published_at` is assumed as as_of + this many weekdays at end of day (DAT-001: flagged
 * `assumed_time`). One weekday more than the stated T+4 for safety. [VERIFY]
 */
export const ASIC_PUBLISH_LAG_WEEKDAYS = 5;
export const ASIC_MIN_GAP_MS = 1500;
export const ASIC_HOST = "download.asic.gov.au";
// TODO(fixtures): unconfirmed file name pattern; confirm against a real recorded response.
export const ASIC_URL_TEMPLATE = `https://${ASIC_HOST}/short-selling/RR{yyyymmdd}-001-SSDailyAggShortPos.csv`;

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const pad = (n, w = 2) => String(n).padStart(w, "0");

/** @param {unknown} m @returns {m is string} */
export function isMonth(m) {
  if (typeof m !== "string") return false;
  const x = MONTH_RE.exec(m);
  return x !== null && Number(x[2]) >= 1 && Number(x[2]) <= 12;
}

/** @param {string} date `YYYY-MM-DD` */
export const monthOf = (date) => date.slice(0, 7);

/** @param {string} month */
export function monthFirstDay(month) {
  if (!isMonth(month)) throw new RangeError("bad month");
  return `${month}-01`;
}

/** @param {string} month */
export function monthLastDay(month) {
  if (!isMonth(month)) throw new RangeError("bad month");
  const [y, m] = month.split("-").map(Number);
  return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/** @param {string} month @param {number} n */
export function addMonths(month, n) {
  if (!isMonth(month)) throw new RangeError("bad month");
  const [y, m] = month.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${pad(Math.floor(t / 12), 4)}-${pad((t % 12) + 1)}`;
}

/** The newest fully past Sydney month relative to `today`. @param {string} today */
export const lastCompleteMonth = (today) => addMonths(monthOf(today), -1);

/** Days after a month's last day before its history file is written (late corrections settle). */
export const EXPORT_SETTLE_DAYS = 7;

/**
 * A month is settled (forward export may write its history file) when today (Sydney) is more than
 * EXPORT_SETTLE_DAYS past the month's last day: last day Sep 30 -> settled from Oct 8.
 */
export const monthSettled = (month, today) =>
  today > addDays(monthLastDay(month), EXPORT_SETTLE_DAYS);

/** @param {string} date */
function isWeekday(date) {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow !== 0 && dow !== 6;
}

/** The weekday strictly before `date`. @param {string} date */
export function previousWeekday(date) {
  let d = addDays(date, -1);
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
}

/** `date` plus n weekdays. @param {string} date @param {number} n */
export function addWeekdays(date, n) {
  let d = date;
  for (let i = 0; i < n; i++) {
    d = addDays(d, 1);
    while (!isWeekday(d)) d = addDays(d, 1);
  }
  return d;
}

/**
 * Weekdays of a month from its first day to `upTo` (inclusive), oldest first.
 * @param {string} month @param {string} [upTo]
 */
export function weekdaysOfMonth(month, upTo = monthLastDay(month)) {
  const out = [];
  const last = monthLastDay(month);
  const end = upTo < last ? upTo : last;
  for (let d = monthFirstDay(month); d <= end; d = addDays(d, 1)) if (isWeekday(d)) out.push(d);
  return out;
}

/** Oldest date a job reaches: HISTORY_YEARS back (29 Feb becomes 28 Feb). @param {string} today */
export function floorDate(today) {
  const [y, m, d] = today.split("-").map(Number);
  const fy = y - HISTORY_YEARS;
  const leap = (fy % 4 === 0 && fy % 100 !== 0) || fy % 400 === 0;
  const day = m === 2 && d === 29 && !leap ? 28 : d;
  return `${pad(fy, 4)}-${pad(m)}-${pad(day)}`;
}

/**
 * Where a month's file lives in the private data repo (DAT-140 release assets).
 * @param {string} source one of HISTORY_SOURCES @param {string} month
 */
export function historyLocation(source, month) {
  if (!HISTORY_SOURCES.includes(source) || !isMonth(month)) {
    throw new RangeError("bad history key");
  }
  const [yyyy, mm] = month.split("-");
  return {
    tag: `history-${source}-${yyyy}`,
    asset: `${source}-${yyyy}-${mm}.jsonl.gz`,
    path: `history/${source}/${yyyy}/${mm}.jsonl.gz`,
  };
}

/** JSON Lines, one object per line, keys in insertion order. @param {object[]} rows */
export const toJsonl = (rows) =>
  rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");

/** Deterministic gzip: header mtime 0 and OS byte 255, so the SHA-256 is stable. */
export function gzipDeterministic(/** @type {string} */ text) {
  const out = new Uint8Array(gzipSync(Buffer.from(text, "utf8"), { level: 9 }));
  out[4] = out[5] = out[6] = out[7] = 0;
  out[9] = 255;
  return out;
}

/** Rows of a history file (the inverse of toJsonl + gzipDeterministic). @param {Uint8Array} bytes */
export const fromJsonlGz = (bytes) =>
  gunzipSync(bytes)
    .toString("utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));

/**
 * Point-in-time view (DAT-001, AT-09, TST-109): only rows published at or before the decision
 * cut-off are visible. Backfilled ASIC rows carry an ASSUMED `published_at` after `as_of`, so the
 * report of day D is not visible on day D.
 * @template {{ published_at: string }} T
 * @param {readonly T[]} rows @param {string} cutoffIso
 */
export const visibleAt = (rows, cutoffIso) => rows.filter((r) => r.published_at <= cutoffIso);

/** @param {Uint8Array} bytes */
export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Counted Turso writes for `rows` announcement rows plus the chunk's own bookkeeping. */
export const announcementWrites = (/** @type {number} */ rows) =>
  Math.ceil(rows * INDEX_FACTOR) + ADMIN_WRITES;

/**
 * Decision 13 cap check. `needed` counts this chunk only.
 * @param {{ used: number, cap: number, needed: number }} p
 */
export function capDecision({ used, cap, needed }) {
  return { ok: used + needed <= cap, remaining: Math.max(0, cap - used) };
}

/**
 * Months to do next, newest first, from the cursor (the newest date still to do) down to the
 * floor. Each entry lists the weekdays of that month that are on or before the cursor and on or
 * after the floor. `complete` is false only for a month the cursor cuts in the middle.
 * @param {string | null} cursor @param {string} floor @param {number} [max]
 */
export function monthsToDo(cursor, floor, max = MAX_MONTHS_PER_RUN) {
  if (cursor === null || cursor < floor) return [];
  const out = [];
  let month = monthOf(cursor);
  let upTo = cursor;
  while (out.length < max && monthLastDay(month) >= floor) {
    const dates = weekdaysOfMonth(month, upTo).filter((d) => d >= floor);
    out.push({ month, dates, complete: upTo === monthLastDay(month) });
    month = addMonths(month, -1);
    upTo = monthLastDay(month);
  }
  return out;
}

// ---- ASIC short positions ------------------------------------------------------------------

/** @param {string} date `YYYY-MM-DD` */
export const asicUrl = (date) => ASIC_URL_TEMPLATE.replace("{yyyymmdd}", date.replaceAll("-", ""));

/** Assumed publication time for a short-position report (DAT-001 `assumed_time`). */
export const asicPublishedAt = (/** @type {string} */ asOf) =>
  `${addWeekdays(asOf, ASIC_PUBLISH_LAG_WEEKDAYS)}T23:59:59.000Z`;

/** Minimal RFC 4180 record splitter; quoted fields may hold commas. @param {string} line */
function splitCsv(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const normHeader = (/** @type {string} */ h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const HEADERS = {
  product: ["product"],
  code: ["product code", "code"],
  short: ["reported short positions", "short positions"],
  total: ["total product in issue", "total in issue"],
  pct: ["of total product in issue reported as short positions"],
};

/** First header cell that equals or ends with one of the names. */
const findCol = (/** @type {string[]} */ cells, /** @type {string[]} */ names) =>
  cells.findIndex((c) => names.some((n) => c === n || c.endsWith(n)));

const num = (/** @type {string | undefined} */ s) => Number((s ?? "").replaceAll(",", "").trim());

/**
 * Parse one ASIC daily file. Bad rows are counted, never stored. `asOf` comes from the file name.
 * @param {string} text @param {string} asOf
 * @returns {{ rows: object[], skipped: number } | { error: "no_header" }}
 */
export function parseAsicCsv(text, asOf) {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  const head = lines.length ? splitCsv(lines[0]).map(normHeader) : [];
  const col = Object.fromEntries(Object.entries(HEADERS).map(([k, n]) => [k, findCol(head, n)]));
  if (col.code < 0 || col.short < 0 || col.total < 0) return { error: "no_header" };
  const published = asicPublishedAt(asOf);
  const rows = [];
  const seen = new Set();
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const c = splitCsv(line);
    const code = (c[col.code] ?? "").trim();
    const short = num(c[col.short]);
    const total = num(c[col.total]);
    if (
      !isValidCode(code) ||
      seen.has(code) ||
      !Number.isFinite(short) ||
      !Number.isFinite(total) ||
      short < 0 ||
      total <= 0
    ) {
      skipped++;
      continue;
    }
    seen.add(code);
    const pct = col.pct >= 0 ? num(c[col.pct]) : NaN;
    rows.push({
      as_of: asOf,
      published_at: published,
      assumed_time: true,
      code,
      product: col.product >= 0 ? (c[col.product] ?? "").trim().slice(0, 120) : "",
      short_positions: short,
      total_in_issue: total,
      pct_short: Number.isFinite(pct) ? pct : Math.round((short / total) * 1e8) / 1e6,
      source: "asic_short",
    });
  }
  rows.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return { rows, skipped };
}

// ---- ASX announcement metadata ---------------------------------------------------------------

const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/**
 * One announcement metadata item (DAT-125: code, time, type, price-sensitive flag, title) for the
 * Sydney date `date` -> a table row or a reason. The id must be a stable hash.
 * @param {unknown} raw @param {string} date
 * @returns {{ row: Record<string, any> } | { reason: string }}
 */
export function validateAnnouncement(raw, date) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { reason: "not_an_object" };
  }
  const r = /** @type {Record<string, any>} */ (raw);
  if (!isValidCode(r.code)) return { reason: "bad_code" };
  if (typeof r.annId !== "string" || !/^[0-9a-f]{16,64}$/.test(r.annId)) {
    return { reason: "bad_id" };
  }
  if (
    typeof r.publishedAt !== "string" ||
    !ISO_Z_RE.test(r.publishedAt) ||
    Number.isNaN(Date.parse(r.publishedAt))
  ) {
    return { reason: "bad_time" };
  }
  if (sydneyDate(Date.parse(r.publishedAt)) !== date) return { reason: "wrong_date" };
  if (typeof r.title !== "string" || r.title.trim() === "" || r.title.length > 1000) {
    return { reason: "bad_title" };
  }
  if (typeof r.type !== "string" || r.type.length > 100) return { reason: "bad_type" };
  if (typeof r.priceSensitive !== "boolean") return { reason: "bad_flag" };
  let url = null;
  if (typeof r.pdfUrl === "string") {
    try {
      const u = new URL(r.pdfUrl);
      if (u.protocol === "https:") url = u.toString();
    } catch {
      /* link dropped, metadata kept */
    }
  }
  return {
    row: {
      code: r.code,
      annId: r.annId,
      publishedAt: new Date(r.publishedAt).toISOString(),
      type: r.type,
      priceSensitive: r.priceSensitive ? 1 : 0,
      title: r.title.trim(),
      url,
    },
  };
}

/**
 * The line written to a month file for a stored `announcement` row. Key order is fixed.
 * @param {Record<string, any>} r
 */
export const announcementLine = (r) => ({
  source: String(r.source),
  ann_id: String(r.ann_id),
  code: String(r.code),
  published_at: String(r.published_at),
  type: r.type === null ? null : String(r.type),
  price_sensitive: Number(r.price_sensitive),
  title: String(r.title),
  url: r.url === null ? null : String(r.url),
  assumed_time: false,
});

/** UTC bounds of the quota month containing `ms` (the Turso metering month). */
export const quotaMonth = monthBoundsUtc;
