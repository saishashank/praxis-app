// Small parsing helpers shared by the India source parsers (M20 IN1). Plain ESM so the Actions step runs it without a
// build. No network, no database: text in, rows out.

/**
 * RFC 4180-style CSV: quoted fields, doubled quotes, CRLF or LF. Returns one object per data row keyed by the
 * trimmed header names. A blank line is skipped; a row shorter than the header gets empty strings.
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
export function csvObjects(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    /** @type {Record<string, string>} */
    const o = {};
    header.forEach((h, i) => {
      o[h] = (r[i] ?? "").trim();
    });
    return o;
  });
}

/** True for a real calendar date YYYY-MM-DD. @param {string} s */
export function isIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
}

/**
 * Decimal text with at most 6 places to integer micro, exactly (no float). Returns null when the text is not a
 * non-negative decimal.
 * @param {string} s @returns {bigint | null}
 */
export function microOfDecimal(s) {
  const t = s.trim().replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d{1,6})\d*)?$/.exec(t);
  if (m === null) return null;
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * An NSE style date-time "12-Nov-2026 18:30:10" (or "12-Nov-2026") to { d, time }; null when unreadable.
 * @param {string} s @returns {{ d: string, time: string } | null}
 */
export function nseDateTime(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
  if (m === null) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return null;
  const d = `${m[3]}-${String(mon).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if (!isIsoDate(d)) return null;
  return { d, time: `${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}` };
}

/**
 * Asia/Kolkata wall time to a UTC ISO instant (IST is UTC+05:30 all year, no DST).
 * @param {string} d YYYY-MM-DD @param {string} time HH:MM or HH:MM:SS
 */
export function istToUtcIso(d, time) {
  const hms = time.length === 5 ? `${time}:00` : time;
  return new Date(Date.parse(`${d}T${hms}Z`) - 330 * 60_000).toISOString();
}
