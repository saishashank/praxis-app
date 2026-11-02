// Benchmark index bars (M4 T3, design 2.4/3, decision 12): the S&P/ASX 200 into `index_bar`, one
// row per session, first-seen and append-only, kept forever. The fetch is the existing Yahoo path
// (`^AXJO` [VERIFY]); the python step writes index.json, this module validates it, writes it and
// reads it back. Plain ESM + JSDoc so the Actions CLI runs it without a build.
// Look-ahead rule: every reader takes the decision date D and returns only rows with d <= D.
import { isRealDate } from "../pipeline/rules.mjs";

export const INDEX_MARKET = "AU";
/** Stored index code, and the Yahoo symbol the python step asks for (decision 12, [VERIFY]). */
export const INDEX_CODE = "AXJO";
export const INDEX_YAHOO_SYMBOL = "^AXJO";
/**
 * M15 (D-290): the US S&P 500 and VIX closes ride the same Yahoo source (no new register row). The
 * stored code is the bare name; the Yahoo symbol is listed for the fetch step. They are accepted
 * here so the rows validate and store; known-time rule `index_us` (D+1 09:00 Melbourne) applies when
 * the Cortex reads them. The nightly request asks for all three (batch1-core, D-308).
 */
export const US_INDEX_YAHOO_SYMBOLS = { GSPC: "^GSPC", VIX: "^VIX" };
export const INDEX_CODES = [INDEX_CODE, ...Object.keys(US_INDEX_YAHOO_SYMBOLS)];
export const INDEX_SOURCE = "yahoo_eod";
const FETCHED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const MICRO = 1_000_000;
const ROWS_PER_STATEMENT = 100;

/** @param {number} x level in index points -> integer micro units */
export const toMicro = (x) => Math.round(x * MICRO);

/**
 * One raw index row (python `index.json`) -> typed row or a reason.
 * @param {unknown} raw @param {{ from?: string, to?: string }} [opts]
 */
export function validateIndexRow(raw, opts = {}) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { reason: "not_an_object" };
  }
  const r = /** @type {Record<string, any>} */ (raw);
  if (typeof r.code !== "string" || !INDEX_CODES.includes(r.code)) return { reason: "bad_code" };
  if (!isRealDate(r.date)) return { reason: "bad_date" };
  if ((opts.from && r.date < opts.from) || (opts.to && r.date > opts.to)) {
    return { reason: "date_out_of_range" };
  }
  const fin = (v) => typeof v === "number" && Number.isFinite(v);
  for (const f of ["open", "high", "low", "close"]) if (!fin(r[f])) return { reason: "bad_number" };
  if (r.open <= 0 || r.high <= 0 || r.low <= 0 || r.close <= 0) return { reason: "non_positive" };
  if (r.high < Math.max(r.open, r.close, r.low) || r.low > Math.min(r.open, r.close, r.high)) {
    return { reason: "ohlc_inconsistent" };
  }
  if (r.source !== "yahoo") return { reason: "bad_source" };
  if (
    typeof r.fetched_at !== "string" ||
    !FETCHED_RE.test(r.fetched_at) ||
    Number.isNaN(Date.parse(r.fetched_at))
  ) {
    return { reason: "bad_fetched_at" };
  }
  return {
    row: {
      index_code: r.code,
      d: r.date,
      o_micro: toMicro(r.open),
      h_micro: toMicro(r.high),
      l_micro: toMicro(r.low),
      c_micro: toMicro(r.close),
      fetched_at: r.fetched_at,
    },
  };
}

/**
 * Parse the contents of index.json. `null` text = no file. Bad rows are counted by reason, never
 * stored; the first row of an (index, date) wins.
 * @param {string | null | undefined} text @param {{ from?: string, to?: string }} [opts]
 * @returns {{ status: "no_file" | "invalid" | "ok", rows: object[], rejected: Record<string, number> }}
 */
export function parseIndexText(text, opts = {}) {
  if (text == null) return { status: "no_file", rows: [], rejected: {} };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { status: "invalid", rows: [], rejected: {} };
  }
  if (!Array.isArray(json)) return { status: "invalid", rows: [], rejected: {} };
  /** @type {Record<string, number>} */
  const rejected = {};
  const rows = [];
  const seen = new Set();
  for (const raw of json) {
    const res = validateIndexRow(raw, opts);
    if ("reason" in res) {
      rejected[res.reason] = (rejected[res.reason] ?? 0) + 1;
      continue;
    }
    const key = `${res.row.index_code}|${res.row.d}`;
    if (seen.has(key)) {
      rejected.duplicate_key = (rejected.duplicate_key ?? 0) + 1;
      continue;
    }
    seen.add(key);
    rows.push(res.row);
  }
  return { status: "ok", rows, rejected };
}

/**
 * Insert index bars first-seen (ON CONFLICT DO NOTHING). Returns rows inserted. A re-run writes 0.
 * @param {import("@libsql/client").Client} db
 * @param {{ market?: string, rows: any[], source?: string, ingestedAt: string }} o
 */
export async function writeIndexBars(db, o) {
  if (o.rows.length === 0) return 0;
  const market = o.market ?? INDEX_MARKET;
  const cols = [
    "market",
    "index_code",
    "d",
    "o_micro",
    "h_micro",
    "l_micro",
    "c_micro",
    "source",
    "published_at",
    "ingested_at",
  ];
  const ph = `(${cols.map(() => "?").join(",")})`;
  const stmts = [];
  for (let i = 0; i < o.rows.length; i += ROWS_PER_STATEMENT) {
    const slice = o.rows.slice(i, i + ROWS_PER_STATEMENT);
    stmts.push({
      sql: `INSERT INTO index_bar (${cols.join(",")}) VALUES ${slice.map(() => ph).join(",")} ON CONFLICT DO NOTHING`,
      args: slice.flatMap((r) => [
        market,
        r.index_code,
        r.d,
        r.o_micro,
        r.h_micro,
        r.l_micro,
        r.c_micro,
        o.source ?? INDEX_SOURCE,
        o.ingestedAt, // no publication time is known (as price_bar): published_at = ingested_at
        o.ingestedAt,
      ]),
    });
  }
  const res = await db.batch(stmts, "write");
  return res.reduce((a, r) => a + r.rowsAffected, 0);
}

/**
 * The newest `limit` index bars with d <= asOf (oldest first). Never returns a later session
 * (look-ahead safe). `asOf` is the decision date D.
 * @param {import("@libsql/client").Client} db
 * @param {{ asOf: string, limit?: number, market?: string, indexCode?: string }} o
 */
export async function readIndexBars(db, o) {
  if (!isRealDate(o.asOf)) throw new RangeError("asOf must be YYYY-MM-DD");
  const limit = Math.max(1, Math.min(o.limit ?? 1281, 5000));
  const r = await db.execute({
    sql: `SELECT d, o_micro, h_micro, l_micro, c_micro, published_at FROM index_bar
          WHERE market = ? AND index_code = ? AND d <= ? ORDER BY d DESC LIMIT ?`,
    args: [o.market ?? INDEX_MARKET, o.indexCode ?? INDEX_CODE, o.asOf, limit],
  });
  return r.rows
    .map((x) => ({
      d: String(x.d),
      o: Number(x.o_micro),
      h: Number(x.h_micro),
      l: Number(x.l_micro),
      c: Number(x.c_micro),
      publishedAt: String(x.published_at),
    }))
    .reverse();
}
