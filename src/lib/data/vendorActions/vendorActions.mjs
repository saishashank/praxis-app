// Vendor corporate-action rows (DAT-231, D-207 item 12): dividends and splits the nightly Yahoo
// request returns together with the bars. The Python step writes actions.json, this module
// validates it, upserts it into `vendor_action` and reads it back. Plain ESM + JSDoc so the
// Actions CLI runs it without a build. Evidence only: nothing here adjusts a price or decides an
// action (the GL-01 veto and the GL-10 total-return benchmark read these rows in later tasks).
import { isRealDate } from "../pipeline/rules.mjs";

export const VENDOR_ACTION_MARKET = "AU";
export const VENDOR_ACTION_SOURCE = "yahoo";
export const VENDOR_ACTION_CURRENCY = "AUD";
const CODE_RE = /^[A-Z0-9]{2,6}$/;
const FETCHED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const MICRO = 1_000_000;
const ROWS_PER_STATEMENT = 100;

/**
 * One raw action (python `actions.json`): {code, ex_date, kind, ratio|amount, currency, source,
 * fetched_at} -> typed row or a reason.
 * @param {unknown} raw @param {{ from?: string, to?: string }} [opts]
 * @returns {{ row: Record<string, any> } | { reason: string }}
 */
export function validateVendorAction(raw, opts = {}) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { reason: "not_an_object" };
  }
  const r = /** @type {Record<string, any>} */ (raw);
  if (typeof r.code !== "string" || !CODE_RE.test(r.code)) return { reason: "bad_code" };
  if (!isRealDate(r.ex_date)) return { reason: "bad_date" };
  if ((opts.from && r.ex_date < opts.from) || (opts.to && r.ex_date > opts.to)) {
    return { reason: "date_out_of_range" };
  }
  if (r.kind !== "split" && r.kind !== "dividend") return { reason: "bad_kind" };
  if (typeof r.currency !== "string" || !/^[A-Z]{3}$/.test(r.currency)) {
    return { reason: "bad_currency" };
  }
  if (r.source !== VENDOR_ACTION_SOURCE) return { reason: "bad_source" };
  if (
    typeof r.fetched_at !== "string" ||
    !FETCHED_RE.test(r.fetched_at) ||
    Number.isNaN(Date.parse(r.fetched_at))
  ) {
    return { reason: "bad_fetched_at" };
  }
  const fin = (v) => typeof v === "number" && Number.isFinite(v);
  let ratio = null;
  let amountMicro = null;
  if (r.kind === "split") {
    if (!fin(r.ratio) || r.ratio <= 0 || r.ratio === 1) return { reason: "bad_ratio" };
    ratio = r.ratio;
  } else {
    if (!fin(r.amount) || r.amount <= 0) return { reason: "bad_amount" };
    amountMicro = Math.round(r.amount * MICRO); // money-float-ok: vendor amount to micro
    if (amountMicro <= 0) return { reason: "bad_amount" };
  }
  return {
    row: {
      code: r.code,
      ex_date: r.ex_date,
      kind: r.kind,
      ratio,
      amount_micro: amountMicro,
      currency: r.currency,
      source: VENDOR_ACTION_SOURCE,
      fetched_at: r.fetched_at,
    },
  };
}

/**
 * Parse the contents of actions.json. `null` text = no file. Bad rows are counted by reason, never
 * stored; the first row of a (code, ex_date, kind) wins.
 * @param {string | null | undefined} text @param {{ from?: string, to?: string }} [opts]
 * @returns {{ status: "no_file" | "invalid" | "ok", rows: Record<string, any>[], rejected: Record<string, number> }}
 */
export function parseVendorActionsText(text, opts = {}) {
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
    const res = validateVendorAction(raw, opts);
    if ("reason" in res) {
      rejected[res.reason] = (rejected[res.reason] ?? 0) + 1;
      continue;
    }
    const key = `${res.row.code}|${res.row.ex_date}|${res.row.kind}`;
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
 * Idempotent upsert: a re-run with the same figures changes nothing but fetched_at; a revised
 * figure replaces the old one. Returns the number of rows written (inserted or updated).
 * @param {import("@libsql/client").Client} db
 * @param {{ market?: string, rows: Record<string, any>[] }} o
 */
export async function writeVendorActions(db, o) {
  if (o.rows.length === 0) return 0;
  const market = o.market ?? VENDOR_ACTION_MARKET;
  const cols = [
    "market",
    "code",
    "ex_date",
    "kind",
    "ratio",
    "amount_micro",
    "currency",
    "source",
    "fetched_at",
  ];
  const ph = `(${cols.map(() => "?").join(",")})`;
  const stmts = [];
  for (let i = 0; i < o.rows.length; i += ROWS_PER_STATEMENT) {
    const slice = o.rows.slice(i, i + ROWS_PER_STATEMENT);
    stmts.push({
      sql: `INSERT INTO vendor_action (${cols.join(",")}) VALUES ${slice.map(() => ph).join(",")}
            ON CONFLICT (market, code, ex_date, kind, source) DO UPDATE SET
              ratio = excluded.ratio, amount_micro = excluded.amount_micro,
              currency = excluded.currency, fetched_at = excluded.fetched_at`,
      args: slice.flatMap((r) => [
        market,
        r.code,
        r.ex_date,
        r.kind,
        r.ratio,
        r.amount_micro,
        r.currency,
        r.source ?? VENDOR_ACTION_SOURCE,
        r.fetched_at,
      ]),
    });
  }
  const res = await db.batch(stmts, "write");
  return res.reduce((a, r) => a + r.rowsAffected, 0);
}

/**
 * Vendor actions of one code with ex_date in [from, to] (inclusive, YYYY-MM-DD), oldest first.
 * Look-ahead rule: the caller passes the decision date as `to`.
 * @param {import("@libsql/client").Client} db
 * @param {string} code @param {string} from @param {string} to @param {string} [market]
 */
export async function readVendorActions(db, code, from, to, market = VENDOR_ACTION_MARKET) {
  const r = await db.execute({
    sql: `SELECT code, ex_date, kind, ratio, amount_micro, currency, source, fetched_at
          FROM vendor_action WHERE market = ? AND code = ? AND ex_date >= ? AND ex_date <= ?
          ORDER BY ex_date, kind`,
    args: [market, code, from, to],
  });
  return r.rows.map((x) => ({
    code: String(x.code),
    exDate: String(x.ex_date),
    kind: /** @type {"split" | "dividend"} */ (String(x.kind)),
    ratio: x.ratio === null ? null : Number(x.ratio),
    amountMicro: x.amount_micro === null ? null : BigInt(/** @type {number} */ (x.amount_micro)),
    currency: String(x.currency),
    source: String(x.source),
    fetchedAt: String(x.fetched_at),
  }));
}
