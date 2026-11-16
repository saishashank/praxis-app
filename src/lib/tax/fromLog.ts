// The tax report on the Owner's own trade log (M21 B3; ARN-122, D-1221, D-1223). Loaded only through a lazy import,
// and only when the pinned Owner has the tools switch on (the page and the CSV route decide). Reads `owner_trade`
// minus the rows that have an `owner_trade_void` row; it writes nothing, and no trading, learning or Cortex path reads
// what it reads. Bounded, keyset-paged by trade id (no OFFSET).
import type { Client } from "@libsql/client";
import type { Stream } from "./report";
import { loadMarketSplits } from "./splits";
import type { TaxFill } from "./types";

const PAGE = 500;
const MAX_PAGES = 40;
/** Trade ids sort as text in the matcher, so they are zero-padded to a fixed width (a numeric id 10 sorts after 9). */
const ID_WIDTH = 12;

export const LOG_EXECUTION = "log";

export async function loadLogStreams(
  db: Client,
  market: string,
  end: string,
): Promise<{ streams: Stream[]; truncated: boolean }> {
  const byCode = new Map<string, TaxFill[]>();
  let after = 0;
  let truncated = true;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // rows-ok: keyset by id, LIMIT PAGE, at most MAX_PAGES pages; voided rows are left out in the query
    const r = await db.execute({
      sql: `SELECT t.id, t.code, t.side, t.d, t.qty, t.price_micro, t.fees_micro
            FROM owner_trade t
            WHERE t.market = ? AND t.d <= ? AND t.id > ?
              AND NOT EXISTS (SELECT 1 FROM owner_trade_void v WHERE v.trade_id = t.id)
            ORDER BY t.id LIMIT ?`,
      args: [market, end, after, PAGE],
    });
    for (const x of r.rows) {
      const qty = BigInt(String(x.qty));
      const fill: TaxFill = {
        id: String(x.id).padStart(ID_WIDTH, "0"),
        d: String(x.d),
        code: String(x.code),
        side: String(x.side) === "sell" ? "sell" : "buy",
        qty,
        valueMicro: qty * BigInt(String(x.price_micro)),
        feeMicro: BigInt(String(x.fees_micro)),
      };
      const list = byCode.get(fill.code) ?? [];
      list.push(fill);
      byCode.set(fill.code, list);
    }
    if (r.rows.length < PAGE) {
      truncated = false;
      break;
    }
    after = Number(r.rows[r.rows.length - 1]!.id);
  }
  // the market's own public split / consolidation / bonus ratios (not Owner data), applied by the matcher
  const splits = await loadMarketSplits(db, market, [...byCode.keys()], end);
  const streams: Stream[] = [...byCode.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([code, fills]) => ({
      executionId: LOG_EXECUTION,
      fills,
      splits: splits.filter((x) => x.code === code),
    }));
  return { streams, truncated };
}
