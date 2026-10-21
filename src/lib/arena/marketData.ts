// Guarded market-data access for the daily orchestrator (M3 T10; TST-109 no look-ahead; M3 design
// 4.2 and 4.6). Closing day D may read price_bar / universe_snapshot rows dated on or before D and
// nothing later: every query carries a `d <= guard` bound and every date argument is checked
// before it reaches SQL, so a bug that asks for tomorrow's bar fails loudly instead of leaking the
// future into a fill or a mark. Prices are read as vendor REALs and converted once through the
// decimal string (toMicroFromVendor), never through float arithmetic.
import type { Client } from "@libsql/client";
import { MICRO_PER_DOLLAR, toMicroFromVendor, type Micro } from "@/lib/money/micro";
import { divFloor } from "@/lib/money/rational";
import { nextTradingDay, type CalendarRow } from "@/lib/data/calendar";
import { assertBar, type Bar } from "./fills";

/** Thrown when a read would pass the closing day. */
export class LookAheadError extends Error {
  constructor(requested: string, guardD: string) {
    super(`look-ahead refused: ${requested} is after the closing day ${guardD}`);
    this.name = "LookAheadError";
  }
}

export const ADV_SESSIONS = 20;

type Reader = Pick<Client, "execute">;

/** A raw price column as micro-AUD: a REAL goes through its decimal text, an INTEGER is whole dollars. */
export function priceMicro(value: unknown): Micro {
  if (typeof value === "bigint") return value * MICRO_PER_DOLLAR;
  if (typeof value === "number") return toMicroFromVendor(value);
  throw new TypeError("price column is not numeric");
}

function wholeNumber(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError("expected an integer column value");
}

export type MarketData = {
  /** The last date this object may read. */
  readonly guardD: string;
  /** The raw bar of `code` on `d`, or null (no bar, or a bar that fails the OHLC sanity check). */
  bar(code: string, d: string): Promise<Bar | null>;
  /** The last raw close on or before `asOfD`, or null. */
  lastClose(code: string, asOfD: string): Promise<Micro | null>;
  /** 20-session average traded value (close x volume) ending on `asOfD`; 0 with no history. */
  adv(code: string, asOfD: string): Promise<Micro>;
  /** universe_snapshot.halted on `d` (absent row = not halted). */
  halted(code: string, d: string): Promise<boolean>;
  /** First session of the current halted stretch ending at `d` (the day after the last unhalted row). */
  haltStart(code: string, d: string, calendar: readonly CalendarRow[]): Promise<string>;
  /** max(ingested_at) over the bars of `d`; null when there are none. */
  ingestedAt(d: string): Promise<string | null>;
};

export function createMarketData(db: Reader, market: string, guardD: string): MarketData {
  const check = (d: string): void => {
    if (d > guardD) throw new LookAheadError(d, guardD);
  };
  const bars = new Map<string, Bar | null>();
  const advs = new Map<string, Micro>();
  const halts = new Map<string, boolean>();

  return {
    guardD,
    async bar(code, d) {
      check(d);
      const key = `${code}|${d}`;
      if (bars.has(key)) return bars.get(key) ?? null;
      const rs = await db.execute({
        sql: `SELECT o, h, l, c FROM price_bar WHERE market = ? AND code = ? AND d = ? AND d <= ?`,
        args: [market, code, d, guardD],
      });
      let bar: Bar | null = null;
      if (rs.rows.length > 0) {
        const r = rs.rows[0];
        const candidate: Bar = {
          openMicro: priceMicro(r.o),
          highMicro: priceMicro(r.h),
          lowMicro: priceMicro(r.l),
          closeMicro: priceMicro(r.c),
        };
        try {
          assertBar(candidate);
          bar = candidate;
        } catch {
          bar = null; // a malformed bar is unusable evidence (DAT-200 flags it)
        }
      }
      bars.set(key, bar);
      return bar;
    },
    async lastClose(code, asOfD) {
      check(asOfD);
      const rs = await db.execute({
        sql: `SELECT c FROM price_bar WHERE market = ? AND code = ? AND d <= ? AND d <= ?
              ORDER BY d DESC LIMIT 1`,
        args: [market, code, asOfD, guardD],
      });
      return rs.rows.length === 0 ? null : priceMicro(rs.rows[0].c);
    },
    async adv(code, asOfD) {
      check(asOfD);
      const key = `${code}|${asOfD}`;
      const cached = advs.get(key);
      if (cached !== undefined) return cached;
      const rs = await db.execute({
        sql: `SELECT c, volume FROM price_bar WHERE market = ? AND code = ? AND d <= ? AND d <= ?
              ORDER BY d DESC LIMIT ${ADV_SESSIONS}`,
        args: [market, code, asOfD, guardD],
      });
      let total = 0n;
      for (const r of rs.rows) total += priceMicro(r.c) * wholeNumber(r.volume);
      const value = rs.rows.length === 0 ? 0n : divFloor(total, BigInt(rs.rows.length));
      advs.set(key, value);
      return value;
    },
    async halted(code, d) {
      check(d);
      const key = `${code}|${d}`;
      const cached = halts.get(key);
      if (cached !== undefined) return cached;
      const rs = await db.execute({
        sql: `SELECT halted FROM universe_snapshot WHERE market = ? AND d = ? AND code = ? AND d <= ?`,
        args: [market, d, code, guardD],
      });
      const halted = rs.rows.length > 0 && wholeNumber(rs.rows[0].halted) === 1n;
      halts.set(key, halted);
      return halted;
    },
    async haltStart(code, d, calendar) {
      check(d);
      const rs = await db.execute({
        sql: `SELECT MAX(d) AS last_ok FROM universe_snapshot
              WHERE market = ? AND code = ? AND halted = 0 AND d <= ? AND d <= ?`,
        args: [market, code, d, guardD],
      });
      const lastOk = rs.rows.length === 0 ? null : rs.rows[0].last_ok;
      if (lastOk === null || lastOk === undefined) return d;
      const start = nextTradingDay(String(lastOk), calendar);
      return start > d ? d : start;
    },
    async ingestedAt(d) {
      check(d);
      const rs = await db.execute({
        sql: `SELECT MAX(ingested_at) AS at FROM price_bar WHERE market = ? AND d = ? AND d <= ?`,
        args: [market, d, guardD],
      });
      const at = rs.rows.length === 0 ? null : rs.rows[0].at;
      return at === null || at === undefined ? null : String(at);
    },
  };
}
