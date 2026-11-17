// The Owner's trade log store (M21 B2, ARN-121, D-1221, D-1275). Append-only: a trade is a new `owner_trade` row, a mistyped
// one is voided by a new `owner_trade_void` row, and nothing is ever updated or deleted (the 0041 triggers refuse both).
// With src/lib/tax/fromLog.ts, this is the only module that names `owner_trade` or `owner_trade_void` (the readers test
// of ARN-121 allow-lists the two files); no trading, learning or Cortex module reads either table, so a trade can never
// move a book, order, signal or alert. Every read is bounded and keyset-paged; no OFFSET.
import type { Client } from "@libsql/client";
import type { CalendarKind, CalendarRow } from "@/lib/data/calendar";
import { getConfig } from "@/lib/config/store";
import { loadMarketSplits } from "@/lib/tax/splits";
import { compareLog, type LogTrade, type LogView, type PaperPick } from "./match";
import type { TradeRow } from "./parse";

const PAGE = 500; // threshold-ok: rows per keyset page of the log
const MAX_PAGES = 10; // threshold-ok: at most 5,000 trades of one market are read
const MAX_PICKS = 2000; // threshold-ok: bound of the pick read for the codes of the buys
const MAX_CODES = 200; // threshold-ok: codes per pick query (SQLite variable limit stays far away)
const SHOWN = 100; // threshold-ok: the newest trades listed on the page

export type SaveTrades =
  { ok: true; uploadId: string | null } | { ok: false; error: "unavailable" };

/** The sortable id of a CSV import: the instant (compact ISO) then a random suffix. */
export function newUploadId(now: Date, suffix: string): string {
  return `${now.toISOString().replace(/[-:.]/g, "")}-${suffix}`;
}

/** Appends rows in ONE write batch, so an import is all there or not at all. `source` csv needs an upload id. */
export async function appendTrades(
  db: Pick<Client, "batch">,
  rows: readonly TradeRow[],
  source: "typed" | "csv",
  enteredBy: string,
  now: Date,
  uploadId: string | null,
): Promise<SaveTrades> {
  if (rows.length === 0 || (source === "csv") !== (uploadId !== null)) {
    return { ok: false, error: "unavailable" };
  }
  const at = now.toISOString();
  try {
    await db.batch(
      rows.map((r) => ({
        sql: `INSERT INTO owner_trade (market, code, side, d, qty, price_micro, fees_micro, note, source, upload_id, entered_at, entered_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          r.market,
          r.code,
          r.side,
          r.d,
          r.qty,
          r.priceMicro,
          r.feesMicro,
          r.note,
          source,
          uploadId,
          at,
          enteredBy,
        ],
      })),
      "write",
    );
    return { ok: true, uploadId };
  } catch {
    return { ok: false, error: "unavailable" }; // e.g. a market that is not enabled (the 0041 guard)
  }
}

export type VoidResult =
  { ok: true } | { ok: false; error: "not_found" | "already" | "unavailable" };

/** Voids one trade with a reason: a new row. A second void of the same trade is refused by the primary key. */
export async function voidTrade(
  db: Pick<Client, "execute">,
  tradeId: number,
  reason: string,
  now: Date,
): Promise<VoidResult> {
  try {
    // rows-ok: primary-key read of one trade, then of its void row
    const t = await db.execute({
      sql: `SELECT t.id, (SELECT COUNT(*) FROM owner_trade_void v WHERE v.trade_id = t.id) AS voided
            FROM owner_trade t WHERE t.id = ?`,
      args: [tradeId],
    });
    const row = t.rows[0];
    if (row === undefined) return { ok: false, error: "not_found" };
    if (Number(row.voided) > 0) return { ok: false, error: "already" };
    await db.execute({
      sql: "INSERT INTO owner_trade_void (trade_id, voided_at, reason) VALUES (?, ?, ?)",
      args: [tradeId, now.toISOString(), reason],
    });
    return { ok: true };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/** Every trade of the market, voided ones flagged, oldest id first: keyset by id, at most MAX_PAGES pages. */
export async function loadTrades(
  db: Pick<Client, "execute">,
  market: string,
): Promise<{ trades: LogTrade[]; truncated: boolean }> {
  const trades: LogTrade[] = [];
  let after = 0;
  let truncated = true;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // rows-ok: market prefix of idx (market, code, d, id) with a keyset on id, LIMIT PAGE, at most MAX_PAGES pages
    const r = await db.execute({
      sql: `SELECT t.id, t.market, t.code, t.side, t.d, t.qty, t.price_micro, t.fees_micro, t.note, t.source, v.reason
            FROM owner_trade t LEFT JOIN owner_trade_void v ON v.trade_id = t.id
            WHERE t.market = ? AND t.id > ? ORDER BY t.id LIMIT ?`,
      args: [market, after, PAGE],
    });
    for (const x of r.rows) {
      trades.push({
        id: Number(x.id),
        market: String(x.market),
        code: String(x.code),
        side: String(x.side) === "sell" ? "sell" : "buy",
        d: String(x.d),
        qty: BigInt(String(x.qty)),
        priceMicro: BigInt(String(x.price_micro)),
        feesMicro: BigInt(String(x.fees_micro)),
        note: x.note === null ? null : String(x.note),
        source: String(x.source) === "csv" ? "csv" : "typed",
        voidReason: x.reason === null ? null : String(x.reason),
      });
    }
    if (r.rows.length < PAGE) {
      truncated = false;
      break;
    }
    after = Number(r.rows[r.rows.length - 1]!.id);
  }
  return { trades, truncated };
}

/** The stored picks of the given codes with their paper outcomes (display only; the pick tables are not touched). */
export async function loadPaperPicks(
  db: Pick<Client, "execute">,
  market: string,
  codes: readonly string[],
): Promise<PaperPick[]> {
  const out: PaperPick[] = [];
  for (let i = 0; i < codes.length && out.length < MAX_PICKS; i += MAX_CODES) {
    const part = codes.slice(i, i + MAX_CODES);
    // rows-ok: idx_pick_code (market, code, d) for the listed codes, LIMIT MAX_PICKS
    const r = await db.execute({
      sql: `SELECT p.d, p.profile, p.rank, p.code, o.state, o.entry_d, o.entry_micro, o.exit_d, o.exit_micro, o.net_ppm
            FROM pick p LEFT JOIN pick_outcome o
              ON o.market = p.market AND o.d = p.d AND o.profile = p.profile AND o.rank = p.rank AND o.kind = 'pick'
            WHERE p.market = ? AND p.code IN (${part.map(() => "?").join(", ")})
            ORDER BY p.code, p.d DESC LIMIT ?`,
      args: [market, ...part, MAX_PICKS],
    });
    for (const x of r.rows) {
      const state = x.state === null ? null : String(x.state);
      out.push({
        d: String(x.d),
        profile: String(x.profile),
        rank: Number(x.rank),
        code: String(x.code),
        state:
          state === "waiting" || state === "bought" || state === "missed" || state === "closed"
            ? state
            : null,
        entryD: x.entry_d === null ? null : String(x.entry_d),
        entryMicro: x.entry_micro === null ? null : BigInt(String(x.entry_micro)),
        exitD: x.exit_d === null ? null : String(x.exit_d),
        exitMicro: x.exit_micro === null ? null : BigInt(String(x.exit_micro)),
        netPpm: x.net_ppm === null ? null : BigInt(String(x.net_ppm)),
      });
    }
  }
  return out;
}

/** The market's holiday rows between two dates: all the session arithmetic needs (weekends are known). */
async function loadHolidays(
  db: Pick<Client, "execute">,
  market: string,
  from: string,
  to: string,
): Promise<CalendarRow[]> {
  // rows-ok: primary-key range of one market between two dates, holidays only (a few per year)
  const r = await db.execute({
    sql: `SELECT d, kind, close_time, confirmed FROM trading_calendar
          WHERE market = ? AND kind = 'holiday' AND d >= ? AND d <= ? ORDER BY d LIMIT 400`,
    args: [market, from, to],
  });
  return r.rows.map((x) => ({
    d: String(x.d),
    kind: String(x.kind) as CalendarKind,
    close_time: x.close_time === null ? null : String(x.close_time),
    confirmed: Number(x.confirmed) === 1 ? 1 : 0, // money-float-ok: a flag
  }));
}

export type TradeLogModel = {
  view: LogView;
  /** The newest trades, voided ones included, newest first (at most SHOWN). */
  listed: LogTrade[];
  /** How many live trades there are, and whether the read stopped at the bound. */
  liveCount: number;
  truncated: boolean;
  maxSessions: number;
  currencyMarket: string;
};

/** Everything `/trades` shows: the log, its comparison with the paper picks and the monthly table. */
export async function loadTradeLog(db: Client, market: string): Promise<TradeLogModel> {
  const { trades, truncated } = await loadTrades(db, market);
  const live = trades.filter((t) => t.voidReason === null);
  const maxSessions = Number(await getConfig(db, "pick_alert_max_sessions"));
  const buyCodes = [...new Set(live.filter((t) => t.side === "buy").map((t) => t.code))].sort();
  const picks = buyCodes.length === 0 ? [] : await loadPaperPicks(db, market, buyCodes);
  const dates = live.map((t) => t.d).sort();
  const calendar =
    dates.length === 0
      ? []
      : await loadHolidays(
          db,
          market,
          picks.reduce((m, p) => (p.d < m ? p.d : m), dates[0]!),
          dates[dates.length - 1]!,
        );
  const end = dates.length === 0 ? "" : dates[dates.length - 1]!;
  const codes = [...new Set(live.map((t) => t.code))].sort();
  let splits: Awaited<ReturnType<typeof loadMarketSplits>> = [];
  try {
    splits = codes.length === 0 ? [] : await loadMarketSplits(db as Client, market, codes, end);
  } catch {
    splits = []; // the comparison still shows, on the share counts as typed
  }
  const view = compareLog(trades, picks, maxSessions, calendar, splits);
  return {
    view,
    listed: [...trades].sort((a, b) => b.id - a.id).slice(0, SHOWN),
    liveCount: live.length,
    truncated,
    maxSessions,
    currencyMarket: market,
  };
}
