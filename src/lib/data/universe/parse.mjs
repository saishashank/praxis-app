// Parser for the ASX listed-companies CSV (M2 T11, D-067). Pure: text in, rows out, no I/O. Opus
// reviews every line.
//
// Expected shape (TODO(fixtures) [VERIFY]: confirm against a recorded real file; the real file
// stays in the private fixtures repo, SEC-110): an optional preamble line (e.g. a title and date),
// optional blank lines, one header row "Company name, ASX code, GICS industry group", then one
// row per listed security. Anything else is `unrecognised_format`. The parser never throws on
// input text and never returns any part of a rejected file (callers log fixed words only).
//
// Row rules: exactly 3 fields; code matches the pipeline's CODE_RE (A-Z0-9, 2..6, no case
// folding); name non-empty, no control characters; industry may be empty (null). A duplicate code
// keeps the first row. Malformed rows, bad codes and duplicates are skipped and counted; more
// than 5 % of the data records being skipped means the file is not the expected one.

export const MAX_CSV_CHARS = 1_000_000;
export const MAX_RECORDS = 20_000;
export const MAX_NAME = 200;
export const MAX_INDUSTRY = 100;
/** The header row may follow at most this many non-empty preamble records. */
export const MAX_PREAMBLE = 2;
/** Skipped records above this share (1 in 20) reject the whole file. */
export const MAX_SKIPPED_RATIO = 0.05;

const CODE_RE = /^[A-Z0-9]{2,6}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const HEADER = ["company name", "asx code", "gics industry group"];

/**
 * RFC 4180 style records: commas, double-quoted fields with "" escapes, CRLF or LF.
 * @param {string} text @returns {string[][]}
 */
export function splitCsv(text) {
  /** @type {string[][]} */
  const records = [];
  /** @type {string[]} */
  let rec = [];
  let field = "";
  let quoted = false;
  let pending = false; // something has been read for the current record
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      pending = true;
    } else if (ch === ",") {
      rec.push(field);
      field = "";
      pending = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (pending || field !== "") {
        rec.push(field);
        records.push(rec);
      }
      rec = [];
      field = "";
      pending = false;
    } else {
      field += ch;
      pending = true;
    }
  }
  if (pending || field !== "") {
    rec.push(field);
    records.push(rec);
  }
  return records;
}

const isBlank = (/** @type {string[]} */ r) => r.every((f) => f.trim() === "");
const fail = () => /** @type {const} */ ({ ok: false, error: "unrecognised_format" });

/**
 * @param {unknown} text
 * @returns {{ ok: true, rows: { code: string, name: string, industry: string | null }[],
 *   stats: { records: number, valid: number, duplicates: number, badCodes: number, malformed: number } }
 *   | { ok: false, error: "unrecognised_format" }}
 */
export function parseListedCompanies(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_CSV_CHARS) return fail();
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = splitCsv(src).filter((r) => !isBlank(r));
  if (records.length > MAX_RECORDS + MAX_PREAMBLE + 1) return fail();

  let h = -1;
  for (let i = 0; i <= MAX_PREAMBLE && i < records.length; i++) {
    const r = records[i];
    if (r.length === 3 && r.every((f, k) => f.trim().toLowerCase() === HEADER[k])) {
      h = i;
      break;
    }
  }
  if (h < 0) return fail();

  const data = records.slice(h + 1);
  /** @type {{ code: string, name: string, industry: string | null }[]} */
  const rows = [];
  const seen = new Set();
  let duplicates = 0;
  let badCodes = 0;
  let malformed = 0;
  for (const r of data) {
    if (r.length !== 3) {
      malformed++;
      continue;
    }
    const name = r[0].trim();
    const code = r[1].trim();
    const industry = r[2].trim();
    if (!CODE_RE.test(code)) {
      badCodes++;
      continue;
    }
    if (
      name === "" ||
      name.length > MAX_NAME ||
      industry.length > MAX_INDUSTRY ||
      CONTROL_RE.test(name) ||
      CONTROL_RE.test(industry)
    ) {
      malformed++;
      continue;
    }
    if (seen.has(code)) {
      duplicates++;
      continue;
    }
    seen.add(code);
    rows.push({ code, name, industry: industry === "" ? null : industry });
  }
  const skipped = duplicates + badCodes + malformed;
  if (rows.length === 0 || skipped > MAX_SKIPPED_RATIO * data.length) return fail();
  return {
    ok: true,
    rows,
    stats: { records: data.length, valid: rows.length, duplicates, badCodes, malformed },
  };
}
