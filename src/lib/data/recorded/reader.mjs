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

export const RECORDED_ROOT = "recorded/au";
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
export function findRecordedDate(dir, date) {
  const base = path.join(path.resolve(dir), RECORDED_ROOT);
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
  const date = findRecordedDate(dir, opts.date);
  const root = path.resolve(dir);
  const folder = path.join(root, RECORDED_ROOT, date);
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
