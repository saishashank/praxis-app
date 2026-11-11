// D-900 (O-80): the newest delayed quote per code (table quote_latest, migration 0028), for display
// only. The two M17 routes store what they already fetched; the UI loaders read it and show it beside
// the last close, with its quote time and the word "delayed". Nothing in the books, the Cortex or the
// exits reads this table: stops and exits stay at the close (ARN-021).
import type { Exec } from "@/lib/cortex/store/common";
import { marketDate } from "@/lib/data/calendar";
import { OWNER_TZ } from "@/lib/market/profileCore.mjs";
import { homeProfile } from "@/lib/market/staticProfile.mjs";
import type { DelayedQuote } from "./types";

/** The quote date is the exchange's own date (the ASX trades on Sydney time). */
export const QUOTE_TZ: string = homeProfile().tz!;
/** Codes per read (SQLite host-parameter headroom). */
export const LATEST_READ_MAX = 200; // threshold-ok: query parameter cap

export type LatestQuote = {
  code: string;
  lastMicro: bigint;
  prevCloseMicro: bigint | null;
  quoteAt: string;
  /** The exchange date of the quote (Sydney), YYYY-MM-DD. */
  quoteD: string;
};

/**
 * Upsert the quotes; a row is replaced only by a strictly later quote time, so an out-of-order or
 * repeated run never moves the shown price back. Returns the number of statements sent.
 */
export async function storeLatestQuotes(
  db: Exec,
  market: string,
  quotes: readonly DelayedQuote[],
): Promise<number> {
  let n = 0;
  for (const q of quotes) {
    await db.execute({
      sql:
        "INSERT INTO quote_latest (market, code, last_micro, prev_close_micro, quote_at, fetched_at) " +
        "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (market, code) DO UPDATE SET " +
        // M18 (OPS-109 c starvation check): a re-fetch with the same quote time (an untraded stock)
        // moves only fetched_at, so a quiet held stock is not reported as starved; the price never
        // moves back.
        "last_micro = CASE WHEN excluded.quote_at > quote_latest.quote_at " +
        "THEN excluded.last_micro ELSE quote_latest.last_micro END, " +
        "prev_close_micro = CASE WHEN excluded.quote_at > quote_latest.quote_at " +
        "THEN excluded.prev_close_micro ELSE quote_latest.prev_close_micro END, " +
        "quote_at = excluded.quote_at, fetched_at = excluded.fetched_at " +
        "WHERE excluded.quote_at >= quote_latest.quote_at",
      args: [market, q.code, q.lastMicro, q.prevCloseMicro, q.quoteAt, q.fetchedAt],
    });
    n += 1;
  }
  return n;
}

/**
 * Store without ever failing the caller: the routes' alerts and candidates matter more than the
 * display cache. Returns false when the write failed (the caller may count it).
 */
export async function storeLatestQuotesSoft(
  db: Exec,
  market: string,
  quotes: readonly DelayedQuote[],
): Promise<boolean> {
  try {
    await storeLatestQuotes(db, market, quotes);
    return true;
  } catch {
    return false;
  }
}

/** The stored quotes of these codes (unknown codes are absent). Read only. */
export async function readLatestQuotes(
  db: Exec,
  market: string,
  codes: readonly string[],
): Promise<Map<string, LatestQuote>> {
  const out = new Map<string, LatestQuote>();
  const uniq = [...new Set(codes)].slice(0, LATEST_READ_MAX);
  if (uniq.length === 0) return out;
  const r = await db.execute({
    sql:
      "SELECT code, last_micro, prev_close_micro, quote_at FROM quote_latest " +
      `WHERE market = ? AND code IN (${uniq.map(() => "?").join(",")})`,
    args: [market, ...uniq],
  });
  for (const row of r.rows) {
    const quoteAt = String(row.quote_at);
    const t = new Date(quoteAt);
    if (Number.isNaN(t.getTime())) continue;
    out.set(String(row.code), {
      code: String(row.code),
      lastMicro: BigInt(String(row.last_micro)),
      prevCloseMicro:
        row.prev_close_micro === null || row.prev_close_micro === undefined
          ? null
          : BigInt(String(row.prev_close_micro)),
      quoteAt,
      quoteD: marketDate(t, QUOTE_TZ),
    });
  }
  return out;
}

/**
 * The quote to show instead of the last close: only when it is from a later exchange date than that
 * close (a quote of the same day as the stored close adds nothing; an older one is stale). Pure.
 */
export function newerThanClose(
  q: LatestQuote | undefined,
  closeD: string | null,
): LatestQuote | null {
  if (q === undefined) return null;
  if (closeD === null) return q;
  return q.quoteD > closeD ? q : null;
}

/** "11:35" in Melbourne time, for the "delayed, as of" label. Pure. */
export function quoteTimeMelbourne(quoteAt: string): string {
  const t = new Date(quoteAt);
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: OWNER_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(t);
}
