// Reading the Owner's trades (M21 B2, ARN-121, D-1221, D-1275). A typed form or a CSV with the same eight columns
// (market, code, side, date, quantity, price, fees, note). Pure: nothing here touches a database. A bad row is refused
// with a fixed sentence and its 1-based row number, never its text. Money is exact integer micro; a share count is a
// whole number. Limits are those of the holdings import: at most 200 rows and 64 KB.
import { splitCsv } from "@/lib/data/universe/parse.mjs";
import { toMicro } from "@/lib/money/micro";

export const TRADES_MAX_ROWS = 200; // threshold-ok: D-1275 input bound (as the holdings import)
export const TRADES_MAX_CHARS = 65_536; // threshold-ok: D-1275 input bound (64 KB)
export const NOTE_MAX = 200; // threshold-ok: the owner_trade note column's limit
export const REASON_MAX = 200; // threshold-ok: the owner_trade_void reason column's limit
export const TRADES_HEADER = [
  "market",
  "code",
  "side",
  "date",
  "quantity",
  "price",
  "fees",
  "note",
] as const;
const QTY_RE = /^[0-9]{1,12}$/;
const MONEY_RE = /^\d{1,12}(\.\d{1,6})?$/;
const CODE_RE = /^[A-Z0-9][A-Z0-9.&-]{0,31}$/;
const MARKET_RE = /^[A-Z]{2,8}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EARLIEST = "2000-01-01"; // threshold-ok: a typo guard, no real trade is older

export type TradeRow = {
  market: string;
  code: string;
  side: "buy" | "sell";
  d: string;
  qty: number;
  priceMicro: bigint;
  feesMicro: bigint;
  note: string | null;
};
export type TradesError =
  "empty" | "too_large" | "too_many_rows" | "bad_header" | "bad_row" | "unavailable";
export type TradesParse =
  { ok: true; rows: TradeRow[] } | { ok: false; error: TradesError; line?: number };

export const TRADES_ERROR_TEXT: Readonly<Record<TradesError, string>> = {
  empty: "Add at least one trade.",
  too_large: "That file is too large (the limit is 64 KB).",
  too_many_rows: "That is too many rows (the limit is 200).",
  bad_header: "The first row must be: market, code, side, date, quantity, price, fees, note.",
  bad_row:
    "A row is not valid. Use a market, a company code, buy or sell, a date that is not in the future, a whole number of shares above 0, a price above 0 and fees of 0 or more.",
  unavailable: "The trades could not be saved. Try again later.",
};

const validDate = (s: string): boolean => {
  const m = DATE_RE.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};

export type RowContext = {
  /** The markets that are enabled; a trade of any other market is refused. */
  markets: readonly string[];
  /** The market date today: a trade dated after it is a typo. */
  today: string;
};

/** One row, or null when any field is not valid. */
export function parseTradeRow(
  f: {
    market: string;
    code: string;
    side: string;
    date: string;
    qty: string;
    price: string;
    fees: string;
    note: string;
  },
  ctx: RowContext,
): TradeRow | null {
  const market = f.market.trim().toUpperCase();
  const code = f.code.trim().toUpperCase();
  const side = f.side.trim().toLowerCase();
  const d = f.date.trim();
  const qtyText = f.qty.trim().replace(/,/g, "");
  const price = f.price.trim().replace(/,/g, "");
  const fees = f.fees.trim().replace(/,/g, "") === "" ? "0" : f.fees.trim().replace(/,/g, "");
  const note = f.note.trim();
  if (!MARKET_RE.test(market) || !ctx.markets.includes(market)) return null;
  if (!CODE_RE.test(code)) return null;
  if (side !== "buy" && side !== "sell") return null;
  if (!validDate(d) || d < EARLIEST || d > ctx.today) return null;
  if (!QTY_RE.test(qtyText)) return null;
  const qty = Number(qtyText); // money-float-ok: a share count, an integer of at most 12 digits
  if (!Number.isSafeInteger(qty) || qty <= 0) return null;
  if (!MONEY_RE.test(price) || !MONEY_RE.test(fees)) return null;
  const priceMicro = toMicro(price);
  const feesMicro = toMicro(fees);
  if (priceMicro <= 0n || feesMicro < 0n) return null;
  if (note.length > NOTE_MAX || /[\u0000-\u001f\u007f]/.test(note)) return null;
  return {
    market,
    code,
    side,
    d,
    qty,
    priceMicro,
    feesMicro,
    note: note === "" ? null : note,
  };
}

/** The CSV of an import: the header above then one trade per row; blank rows are skipped. */
export function parseTradesCsv(text: unknown, ctx: RowContext): TradesParse {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, error: "empty" };
  if (text.length > TRADES_MAX_CHARS) return { ok: false, error: "too_large" };
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = splitCsv(src).filter((r) => !r.every((x) => x.trim() === ""));
  const head = records[0];
  if (
    head === undefined ||
    head.length !== TRADES_HEADER.length ||
    !head.every((x, i) => x.trim().toLowerCase() === TRADES_HEADER[i])
  ) {
    return { ok: false, error: "bad_header" };
  }
  const data = records.slice(1);
  if (data.length === 0) return { ok: false, error: "empty" };
  if (data.length > TRADES_MAX_ROWS) return { ok: false, error: "too_many_rows" };
  const rows: TradeRow[] = [];
  for (let i = 0; i < data.length; i++) {
    const r = data[i]!;
    const row =
      r.length === TRADES_HEADER.length
        ? parseTradeRow(
            {
              market: r[0]!,
              code: r[1]!,
              side: r[2]!,
              date: r[3]!,
              qty: r[4]!,
              price: r[5]!,
              fees: r[6]!,
              note: r[7]!,
            },
            ctx,
          )
        : null;
    if (row === null) return { ok: false, error: "bad_row", line: i + 2 };
    rows.push(row);
  }
  return { ok: true, rows };
}

/** The typed form: one trade per submission (the fields are the same eight). */
export function parseTypedTrade(
  f: Parameters<typeof parseTradeRow>[0],
  ctx: RowContext,
): TradesParse {
  const row = parseTradeRow(f, ctx);
  return row === null ? { ok: false, error: "bad_row" } : { ok: true, rows: [row] };
}

/** A void's reason: 1 to 200 characters of plain text, or null. */
export function parseReason(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (t.length < 1 || t.length > REASON_MAX || /[\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}
