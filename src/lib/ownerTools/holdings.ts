// The Owner's holdings (M21 B1, UXN-316, D-1220, AT-78). A manual table or a CSV import (code, quantity, average cost) is
// saved as a NEW `owner_holding` upload (append-only: nothing is updated or deleted; the newest upload of a market is the
// current set). Only this module and the Owner-tool pages name the table (the readers test of ARN-121 allow-lists them);
// no trading, learning or Cortex module reads it (D-1221), so a holding can never move a book, order, signal or alert.
// Limits are those of the reference-data import: at most 200 rows and 64 KB of text. Money is exact integer micro.
import type { Client } from "@libsql/client";
import { splitCsv } from "@/lib/data/universe/parse.mjs";
import { toMicro } from "@/lib/money/micro";

export const HOLDINGS_MAX_ROWS = 200; // threshold-ok: D-1220 input bound
export const HOLDINGS_MAX_CHARS = 65_536; // threshold-ok: D-1220 input bound (64 KB)
export const HOLDINGS_HEADER = ["code", "quantity", "average_cost"] as const;
const QTY_MAX_DIGITS = 12; // threshold-ok: input bound of a typed share count
const COST_RE = /^\d{1,12}(\.\d{1,6})?$/;
const CODE_RE = /^[A-Z0-9][A-Z0-9.&-]{0,31}$/;

export type HoldingRow = { code: string; qty: number; avgCostMicro: bigint };
export type HoldingsError =
  "empty" | "too_large" | "too_many_rows" | "bad_header" | "bad_row" | "duplicate" | "unavailable";
/** A refusal is a fixed word and, for a bad or repeated row, its 1-based row number (never the row's text). */
export type HoldingsParse =
  { ok: true; rows: HoldingRow[] } | { ok: false; error: HoldingsError; line?: number };

export const HOLDINGS_ERROR_TEXT: Readonly<Record<HoldingsError, string>> = {
  empty: "Add at least one holding.",
  too_large: "That file is too large (the limit is 64 KB).",
  too_many_rows: "That is too many rows (the limit is 200).",
  bad_header: "The first row must be: code, quantity, average_cost.",
  bad_row:
    "A row is not valid. Use a company code, a whole number of shares above 0 and an average cost above 0.",
  duplicate: "A company code appears twice.",
  unavailable: "The holdings could not be saved. Try again later.",
};

/** One row, or null when the code, the share count or the cost is not valid. */
export function parseHoldingRow(code: string, qty: string, cost: string): HoldingRow | null {
  const c = code.trim().toUpperCase();
  const q = qty.trim().replace(/,/g, "");
  const a = cost.trim().replace(/,/g, "");
  if (!CODE_RE.test(c)) return null;
  if (!new RegExp(`^[0-9]{1,${QTY_MAX_DIGITS}}$`).test(q)) return null;
  const qtyNum = Number(q); // money-float-ok: a share count, an integer of at most 12 digits
  if (!Number.isSafeInteger(qtyNum) || qtyNum <= 0) return null;
  if (!COST_RE.test(a)) return null;
  const micro = toMicro(a);
  if (micro <= 0n) return null;
  return { code: c, qty: qtyNum, avgCostMicro: micro };
}

function finish(rows: HoldingRow[], lines: number[]): HoldingsParse {
  if (rows.length === 0) return { ok: false, error: "empty" };
  if (rows.length > HOLDINGS_MAX_ROWS) return { ok: false, error: "too_many_rows" };
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    if (seen.has(rows[i]!.code)) return { ok: false, error: "duplicate", line: lines[i] };
    seen.add(rows[i]!.code);
  }
  return { ok: true, rows };
}

/** The CSV of an import: a header `code,quantity,average_cost` then one holding per row; blank rows are skipped. */
export function parseHoldingsCsv(text: unknown): HoldingsParse {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, error: "empty" };
  if (text.length > HOLDINGS_MAX_CHARS) return { ok: false, error: "too_large" };
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = splitCsv(src).filter((r) => !r.every((f) => f.trim() === ""));
  const head = records[0];
  if (
    head === undefined ||
    head.length !== HOLDINGS_HEADER.length ||
    !head.every((f, i) => f.trim().toLowerCase() === HOLDINGS_HEADER[i])
  ) {
    return { ok: false, error: "bad_header" };
  }
  const data = records.slice(1);
  if (data.length > HOLDINGS_MAX_ROWS) return { ok: false, error: "too_many_rows" };
  const rows: HoldingRow[] = [];
  const lines: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const r = data[i]!;
    const row = r.length === 3 ? parseHoldingRow(r[0]!, r[1]!, r[2]!) : null;
    if (row === null) return { ok: false, error: "bad_row", line: i + 2 };
    rows.push(row);
    lines.push(i + 2);
  }
  return finish(rows, lines);
}

/** The manual table of the page: three fields per row; a row with all three empty is skipped. */
export function parseManualRows(
  entries: ReadonlyArray<{ code: string; qty: string; cost: string }>,
): HoldingsParse {
  if (entries.length > HOLDINGS_MAX_ROWS * 2) return { ok: false, error: "too_many_rows" };
  const rows: HoldingRow[] = [];
  const lines: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.code.trim() === "" && e.qty.trim() === "" && e.cost.trim() === "") continue;
    const row = parseHoldingRow(e.code, e.qty, e.cost);
    if (row === null) return { ok: false, error: "bad_row", line: i + 1 };
    rows.push(row);
    lines.push(i + 1);
  }
  return finish(rows, lines);
}

/** The sortable id of an upload: the instant (compact ISO) then a random suffix; the newest sorts last. */
export function newUploadId(now: Date, suffix: string): string {
  return `${now.toISOString().replace(/[-:.]/g, "")}-${suffix}`;
}

export type SaveHoldings = { ok: true; uploadId: string } | { ok: false; error: "unavailable" };

/** Saves rows as ONE new upload (a single write batch, so a set is all there or not at all). */
export async function saveHoldings(
  db: Pick<Client, "batch">,
  market: string,
  rows: readonly HoldingRow[],
  now: Date,
  suffix: string,
): Promise<SaveHoldings> {
  if (rows.length === 0 || rows.length > HOLDINGS_MAX_ROWS)
    return { ok: false, error: "unavailable" };
  const uploadId = newUploadId(now, suffix);
  const at = now.toISOString();
  try {
    await db.batch(
      rows.map((r) => ({
        sql: `INSERT INTO owner_holding (upload_id, market, code, qty, avg_cost_micro, uploaded_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [uploadId, market, r.code, r.qty, r.avgCostMicro, at],
      })),
      "write",
    );
    return { ok: true, uploadId };
  } catch {
    return { ok: false, error: "unavailable" }; // e.g. a market that is not enabled (the 0038 guard)
  }
}

export type CurrentHoldings = { uploadId: string; uploadedAt: string; rows: HoldingRow[] };

/** The newest upload of a market (the current set), or null when none was ever saved. */
export async function loadCurrentHoldings(
  db: Pick<Client, "execute">,
  market: string,
): Promise<CurrentHoldings | null> {
  // rows-ok: walks the primary key from its end and stops at the first row of the market (LIMIT 1)
  const head = await db.execute({
    sql: "SELECT upload_id, uploaded_at FROM owner_holding WHERE market = ? ORDER BY upload_id DESC LIMIT 1",
    args: [market],
  });
  const h = head.rows[0];
  if (h === undefined) return null;
  // rows-ok: primary-key prefix (upload_id, market), at most 200 rows by the write limit; LIMIT 201 bounds it
  const r = await db.execute({
    sql: `SELECT code, qty, avg_cost_micro FROM owner_holding WHERE upload_id = ? AND market = ?
          ORDER BY code LIMIT ?`,
    args: [String(h.upload_id), market, HOLDINGS_MAX_ROWS + 1],
  });
  return {
    uploadId: String(h.upload_id),
    uploadedAt: String(h.uploaded_at),
    rows: r.rows.map((x) => ({
      code: String(x.code),
      qty: Number(x.qty), // money-float-ok: a stored share count, integer
      avgCostMicro: BigInt(String(x.avg_cost_micro)),
    })),
  };
}
