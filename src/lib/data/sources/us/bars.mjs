// US daily bars (M20 US1; DAT-004, D-1132, D-1188). There is NO robots-permitted free price source for the US (D-1132:
// Yahoo, Stooq and the Nasdaq API disallow automated clients and the polite client obeys), so the bars of a night
// arrive as a FILE from whichever seam the Owner enables later (a keyed daily-bar API, a licensed vendor, a manual
// upload) or, in development, from a recorded fixture. The shape is one JSON array of rows
//   { code, date, open, high, low, close, volume, source }
// and this module validates it row by row without repairing anything (a bad row is rejected with a reason and counted,
// DAT-004). `source` names the seam (`[a-z0-9_]{1,32}`); the fixtures' synthetic rows carry `synthetic_fixture` so they
// can never be mistaken for market data. Also the Yahoo-shaped request (empty symbol suffix, the profile's currency)
// and the Stooq daily-file reader for the day a source passes its checks: both are builders and parsers only, the
// fetch itself goes through the polite client, which refuses them today.
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const SOURCE_RE = /^[a-z0-9_]{1,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {string} s */
const isRealDate = (s) =>
  DATE_RE.test(s) &&
  !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/**
 * @typedef {{ code: string, date: string, open: number, high: number, low: number, close: number, volume: number, source: string }} UsBar
 * @param {unknown} raw @param {{ from?: string, to?: string }} [opts]
 * @returns {{ row: UsBar } | { reason: string }}
 */
export function validateUsBar(raw, opts = {}) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { reason: "not_an_object" };
  const r = /** @type {Record<string, any>} */ (raw);
  if (typeof r.code !== "string" || !TICKER_RE.test(r.code)) return { reason: "bad_code" };
  if (typeof r.date !== "string" || !isRealDate(r.date)) return { reason: "bad_date" };
  if ((opts.from && r.date < opts.from) || (opts.to && r.date > opts.to))
    return { reason: "date_out_of_range" };
  const fin = (v) => typeof v === "number" && Number.isFinite(v);
  for (const f of ["open", "high", "low", "close"]) if (!fin(r[f])) return { reason: "bad_number" };
  if (r.open <= 0 || r.high <= 0 || r.low <= 0 || r.close <= 0)
    return { reason: "non_positive_price" };
  if (!Number.isInteger(r.volume) || r.volume < 0) return { reason: "bad_volume" };
  if (r.high < Math.max(r.open, r.close, r.low) || r.low > Math.min(r.open, r.close, r.high))
    return { reason: "ohlc_inconsistent" };
  if (typeof r.source !== "string" || !SOURCE_RE.test(r.source)) return { reason: "bad_source" };
  return {
    row: {
      code: r.code,
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      source: r.source,
    },
  };
}

export class UsBarsFormatError extends Error {
  constructor() {
    super("bars file is not a JSON array");
    this.name = "UsBarsFormatError";
  }
}

/**
 * @param {string} text @param {{ from?: string, to?: string }} [opts]
 * @returns {{ rows: UsBar[], rejected: { index: number, code: string | null, date: string | null, reason: string }[], total: number }}
 */
export function parseUsBarsText(text, opts = {}) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UsBarsFormatError();
  }
  if (!Array.isArray(json)) throw new UsBarsFormatError();
  const rows = [];
  const rejected = [];
  const seen = new Set();
  json.forEach((raw, index) => {
    const res = validateUsBar(raw, opts);
    if ("reason" in res)
      return void rejected.push({
        index,
        code: typeof raw?.code === "string" ? raw.code : null,
        date: typeof raw?.date === "string" ? raw.date : null,
        reason: res.reason,
      });
    const k = `${res.row.code}|${res.row.date}`;
    if (seen.has(k))
      return void rejected.push({
        index,
        code: res.row.code,
        date: res.row.date,
        reason: "duplicate_key",
      });
    seen.add(k);
    rows.push(res.row);
  });
  return { rows, rejected, total: json.length };
}

/** The request for a Yahoo-shaped fetch step: no symbol suffix for this market, the profile's currency (D-1034). @param {{ yahooSuffix?: string | null, currency: string | null }} profile @param {string[]} codes @param {string} start @param {string} end */
export function yahooRequestFor(profile, codes, start, end) {
  return { codes, start, end, suffix: profile.yahooSuffix ?? "", currency: profile.currency };
}

/**
 * A Yahoo chart answer for one code -> bars (timestamps are exchange-local session starts; `tz` is the profile's).
 * @param {any} json @param {string} code @param {string} tz
 * @returns {UsBar[]}
 */
export function barsFromChart(json, code, tz) {
  const res = json?.chart?.result?.[0];
  const ts = res?.timestamp;
  const q = res?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) return [];
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  /** @type {UsBar[]} */
  const out = [];
  for (let i = 0; i < ts.length; i += 1) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    const v = q.volume?.[i];
    if ([o, h, l, c, v].some((x) => typeof x !== "number")) continue;
    out.push({
      code,
      date: fmt.format(new Date(ts[i] * 1000)),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v,
      source: "yahoo",
    });
  }
  return out;
}

/**
 * A Stooq daily CSV (`Date,Open,High,Low,Close,Volume`) for one code -> bars.
 * @param {string} text @param {string} code @returns {UsBar[]}
 */
export function barsFromStooqCsv(text, code) {
  const out = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const f = line.trim().split(",");
    if (f.length < 6) continue;
    const [d, o, h, l, c, v] = f;
    const nums = [o, h, l, c, v].map(Number);
    if (nums.some((n) => !Number.isFinite(n))) continue;
    out.push({
      code,
      date: d,
      open: nums[0],
      high: nums[1],
      low: nums[2],
      close: nums[3],
      volume: Math.round(nums[4]),
      source: "stooq",
    });
  }
  return out;
}
