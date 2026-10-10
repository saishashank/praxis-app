// Yahoo EOD adapter, Node side (M2 T5, design decision 2 / D-057). Pure: no DB, no network.
// scripts/ingest/yahoo_fetch.py writes `bars.json`; this module parses and validates it into typed
// rows for the writer (T6). Nothing is ever repaired or filled (DAT-004): a bad row is rejected with
// a reason so the stage can count it, flag the code and block entries (DAT-210).
// Sources: DAT-103 (Yahoo via yfinance `.AX`, O-26), DAT-002/DAT-003 (idempotent writes).

export type BarRow = {
  code: string;
  date: string; // Sydney trading date YYYY-MM-DD (decision 1)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adj_close: number;
  source: "yahoo";
  published_at: null;
  fetched_at: string; // ISO-8601 UTC with Z (D-031)
};

export type RejectReason =
  | "not_an_object"
  | "bad_code"
  | "bad_date"
  | "date_out_of_range"
  | "bad_number"
  | "non_positive_price"
  | "bad_volume"
  | "ohlc_inconsistent"
  | "bad_source"
  | "bad_published_at"
  | "bad_fetched_at"
  | "duplicate_key";

export type RejectedBar = {
  index: number;
  code: string | null;
  date: string | null;
  reason: RejectReason;
};

export type ParsedBars = { rows: BarRow[]; rejected: RejectedBar[]; total: number };

export class YahooFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YahooFormatError";
  }
}

export type ParseOptions = { from?: string; to?: string }; // inclusive bounds, YYYY-MM-DD

const CODE_RE = /^[A-Z0-9]{2,6}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FETCHED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const FIELDS = ["open", "high", "low", "close", "adj_close"] as const;

export function isRealDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isIsoUtc(s: unknown): s is string {
  return typeof s === "string" && FETCHED_RE.test(s) && !Number.isNaN(Date.parse(s));
}

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validate one raw bar. Returns the typed row or the first failing reason. */
export function validateBar(
  raw: unknown,
  opts: ParseOptions = {},
): { row: BarRow } | { reason: RejectReason } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { reason: "not_an_object" };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.code !== "string" || !CODE_RE.test(r.code)) return { reason: "bad_code" };
  if (!isRealDate(r.date)) return { reason: "bad_date" };
  if ((opts.from && r.date < opts.from) || (opts.to && r.date > opts.to)) {
    return { reason: "date_out_of_range" };
  }
  for (const f of FIELDS) if (!isFiniteNum(r[f])) return { reason: "bad_number" };
  if (!isFiniteNum(r.volume)) return { reason: "bad_number" };
  const [open, high, low, close, adj] = FIELDS.map((f) => r[f] as number);
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || adj <= 0) {
    return { reason: "non_positive_price" };
  }
  const volume = r.volume as number;
  if (!Number.isInteger(volume) || volume < 0) return { reason: "bad_volume" };
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
    return { reason: "ohlc_inconsistent" };
  }
  if (r.source !== "yahoo") return { reason: "bad_source" };
  if (r.published_at !== null) return { reason: "bad_published_at" };
  if (!isIsoUtc(r.fetched_at)) return { reason: "bad_fetched_at" };
  return {
    row: {
      code: r.code,
      date: r.date as string,
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

/**
 * Parse the contents of `bars.json` (already JSON-decoded). The file must be an array; anything
 * else is a format error (the whole stage fails visibly). Row-level problems are returned in
 * `rejected`; the first row for a (code, date) key wins and later ones are `duplicate_key`.
 */
export function parseYahooBars(json: unknown, opts: ParseOptions = {}): ParsedBars {
  if (!Array.isArray(json)) throw new YahooFormatError("bars.json must be a JSON array");
  const rows: BarRow[] = [];
  const rejected: RejectedBar[] = [];
  const seen = new Set<string>();
  json.forEach((raw, index) => {
    const res = validateBar(raw, opts);
    const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
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

/** Parse the text of bars.json. Invalid JSON is a format error. */
export function parseYahooBarsText(text: string, opts: ParseOptions = {}): ParsedBars {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new YahooFormatError("bars.json is not valid JSON");
  }
  return parseYahooBars(json, opts);
}

/** Counts by reason, for run-record notes (counts only, SEC-110 b). */
export function rejectSummary(rejected: RejectedBar[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rejected) out[r.reason] = (out[r.reason] ?? 0) + 1;
  return out;
}
