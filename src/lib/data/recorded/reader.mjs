// Recorded-day reader (M8 T9, decision 31). Reads ONE recorded AU trading day from the private
// fixtures repo checkout (SEC-110: the data never enters the code repo):
//   <fixtures>/recorded/au/<YYYY-MM-DD>/bars.json              required  array of bar rows
//                                      /index.json             optional  array of index bars
//                                      /short.json             optional  { rows: [...], ... }
//                                      /announcements.json     optional  array
//                                      /corporate_actions.json optional  array
// With no date given the newest folder is used (deterministic). Errors carry a fixed code and
// never a path, a row or a file content (SEC-110).
import fs from "node:fs";
import path from "node:path";
import { HOME_MARKET } from "../../market/profileCore.mjs";

export const RECORDED_ROOT = "recorded/au";
/** The recorded root of a market: the home market keeps `recorded/au` (byte for byte), any other is `recorded/<code lower case>` (D-1180). */
export function recordedRootOf(market) {
  return market === undefined || market === HOME_MARKET
    ? RECORDED_ROOT
    : `recorded/${String(market).toLowerCase()}`;
}
/** The day files of a non-home market, by key (names as written by record-day --market, D-1177). */
export const MARKET_DAY_FILES = Object.freeze({
  bhavcopy: "bhavcopy.csv",
  bands: "bands.csv",
  asm: "asm.json",
  gsm: "gsm.json",
  announcements_nse: "announcements_nse.json",
  announcements_bse: "announcements_bse.json",
  insider: "insider.csv",
  fo_oi: "fo_oi.csv",
  classification: "classification.csv",
  macro: "macro.csv",
  index: "index.csv",
});
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class RecordedDayError extends Error {
  /** @param {string} code a short fixed code */
  constructor(code) {
    super(code);
    this.name = "RecordedDayError";
    this.code = code;
  }
}

/** @param {string} dir fixtures checkout @param {string} [date] */
export function findRecordedDate(dir, date, market) {
  const base = path.join(path.resolve(dir), recordedRootOf(market));
  if (date !== undefined) {
    if (!DATE_RE.test(date)) throw new RecordedDayError("bad_date");
    return date;
  }
  let names;
  try {
    names = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    throw new RecordedDayError("no_recorded_root");
  }
  const dates = names
    .filter((e) => e.isDirectory() && DATE_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  if (dates.length === 0) throw new RecordedDayError("no_recorded_day");
  return /** @type {string} */ (dates[dates.length - 1]);
}

function readJson(file, required) {
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new RecordedDayError("bad_file");
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e instanceof RecordedDayError) throw e;
    if (required) throw new RecordedDayError("missing_file");
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RecordedDayError("bad_json");
  }
}

const rowsOf = (v, required) => {
  if (v === undefined) return [];
  if (
    !Array.isArray(v) ||
    !v.every((r) => typeof r === "object" && r !== null && !Array.isArray(r))
  ) {
    throw new RecordedDayError(required ? "bad_bars" : "bad_rows");
  }
  return v;
};

/**
 * @param {string} dir the fixtures checkout @param {{ date?: string }} [opts]
 * @returns {{ date: string, bars: object[], index: object[], short: (object & { rows: object[] }) | null,
 *   announcements: object[], corporateActions: object[] }}
 */
export function readRecordedDay(dir, opts = {}) {
  const date = findRecordedDate(dir, opts.date, opts.market);
  const root = path.resolve(dir);
  const folder = path.join(root, recordedRootOf(opts.market), date);
  if (opts.market !== undefined && opts.market !== HOME_MARKET) {
    // another market: the exchange files of the day, as text, by key; bhavcopy is required
    /** @type {Record<string, string>} */
    const files = {};
    for (const [k, n] of Object.entries(MARKET_DAY_FILES)) {
      const f = path.join(folder, n);
      try {
        const st = fs.statSync(f);
        if (st.isFile() && st.size <= MAX_FILE_BYTES) files[k] = fs.readFileSync(f, "utf8");
      } catch {
        // an absent optional file
      }
    }
    if (files.bhavcopy === undefined) throw new RecordedDayError("missing_file");
    return { date, market: opts.market, files };
  }
  const file = (n) => path.join(folder, n);
  const bars = rowsOf(readJson(file("bars.json"), true), true);
  if (bars.length === 0) throw new RecordedDayError("empty_bars");
  const shortRaw = readJson(file("short.json"), false);
  let short = null;
  if (shortRaw !== undefined) {
    if (typeof shortRaw !== "object" || shortRaw === null || !Array.isArray(shortRaw.rows)) {
      throw new RecordedDayError("bad_short");
    }
    short = shortRaw;
  }
  return {
    date,
    bars,
    index: rowsOf(readJson(file("index.json"), false), false),
    short,
    announcements: rowsOf(readJson(file("announcements.json"), false), false),
    corporateActions: rowsOf(readJson(file("corporate_actions.json"), false), false),
  };
}
