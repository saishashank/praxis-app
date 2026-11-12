// The Worker's view of the `market` table (M19 C1, MKT-110 a, D-994, D-996). The clock, the route poster and
// the run-now handler build their slot tables from the ENABLED market rows only: a market that is not enabled
// gets no slot, no dispatch and no run-now. One statement reads them (<= 3 rows); the rows are cached per
// isolate for MARKETS_TTL_MS so an idle minute still costs no database request, and every tick that reads
// anyway re-reads them in the same request (a changed row is picked up at once, see `sameShape`).
import { pipeline, type DbEnv, type Row, type Stmt } from "./db";
import { hhmm } from "./localtime";
import { isTradingDayKind } from "../../src/lib/data/calendarCore.mjs";

/** One `market` row with `enabled = 1`. */
export type MarketRow = {
  code: string;
  tz: string;
  open_time: string;
  close_time: string;
  cutoff_time: string;
  currency: string;
  mode: string;
  enabled: number;
  slots_json: string | null;
  /** M20 (D-1101): the instant of a full -> off switch; set only while the market awaits its rollback kill. */
  rollback_at?: string | null;
};

/** The slot anchors of `market.slots_json` (D-1012): local HH:MM of the market's own zone. */
export type SlotAnchors = {
  b1: string;
  b2a: string;
  b2b: string;
  late_2a_after: string;
  cutoff: string;
  cutoff_poll: string;
  preopen_recheck: [string, string];
  quote_from: string;
  quote_until: string;
  intraday_scan_from: string;
  intraday_scan_until: string;
};

/** The per-tick read: every enabled market, one statement (D-996). */
export const MARKETS_SQL =
  "SELECT code, tz, open_time, close_time, cutoff_time, currency, mode, enabled, slots_json, rollback_at FROM market WHERE enabled = 1";
export const MARKETS_STMT: Stmt = { sql: MARKETS_SQL };
/** Trading-day kind of a date for every enabled market: one probe per market on the (market, d) key. */
export const CALENDAR_SQL =
  "SELECT market, kind FROM trading_calendar WHERE d = ? AND market IN (SELECT code FROM market WHERE enabled = 1)";
/** How long an isolate trusts the rows it read for building the slot table. */
export const MARKETS_TTL_MS = 10 * 60_000;

const ANCHOR_KEYS = [
  "b1",
  "b2a",
  "b2b",
  "late_2a_after",
  "cutoff",
  "cutoff_poll",
  "quote_from",
  "quote_until",
  "intraday_scan_from",
  "intraday_scan_until",
] as const;

/** The anchors of a row; throws RangeError when `slots_json` is absent or malformed (never guesses). */
export function anchorsOf(row: MarketRow): SlotAnchors {
  if (row.slots_json === null) throw new RangeError("no slots_json");
  let v: unknown;
  try {
    v = JSON.parse(row.slots_json);
  } catch {
    throw new RangeError("bad slots_json");
  }
  if (v === null || typeof v !== "object") throw new RangeError("bad slots_json");
  const o = v as Record<string, unknown>;
  for (const k of ANCHOR_KEYS) {
    if (typeof o[k] !== "string") throw new RangeError("bad slots_json");
    hhmm(o[k] as string);
  }
  const pre = o.preopen_recheck;
  if (!Array.isArray(pre) || pre.length !== 2 || pre.some((x) => typeof x !== "string")) {
    throw new RangeError("bad slots_json");
  }
  hhmm(pre[0] as string);
  hhmm(pre[1] as string);
  return o as unknown as SlotAnchors;
}

/** The enabled rows of a `MARKETS_SQL` result, in code order; malformed rows are dropped (fail safe). */
export function parseMarketRows(rows: readonly Row[]): MarketRow[] {
  const out: MarketRow[] = [];
  for (const r of rows) {
    const [code, tz, open, close, cutoff, currency, mode, enabled, slots, rollback] = r;
    if (
      typeof code !== "string" ||
      typeof tz !== "string" ||
      typeof mode !== "string" ||
      Number(enabled) !== 1
    ) {
      continue;
    }
    out.push({
      code,
      tz,
      open_time: String(open),
      close_time: String(close),
      cutoff_time: String(cutoff),
      currency: String(currency),
      mode,
      enabled: 1,
      slots_json: typeof slots === "string" ? slots : null,
      // the key exists only while a rollback is pending, so an ordinary row is the row it always was
      ...(typeof rollback === "string" && rollback !== "" ? { rollback_at: rollback } : {}),
    });
  }
  return out.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/** True when two row lists build the same slot table (the mode may differ: it is read fresh every tick). */
export function sameShape(a: readonly MarketRow[], b: readonly MarketRow[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) =>
        x.code === b[i].code &&
        x.tz === b[i].tz &&
        x.slots_json === b[i].slots_json &&
        (x.rollback_at ?? null) === (b[i].rollback_at ?? null),
    )
  );
}

// ---- the isolate cache -------------------------------------------------------------------------------------

let cache: { rows: MarketRow[]; at: number; pinned?: boolean } | null = null;

/** Test hook: forget the rows this isolate knows. */
export function resetMarketCache(): void {
  cache = null;
}

/** The rows read within MARKETS_TTL_MS, or null (cold isolate or expired). */
export function cachedMarkets(nowMs: number): MarketRow[] | null {
  if (cache === null) return null;
  if (cache.pinned === true) return cache.rows;
  return nowMs - cache.at < MARKETS_TTL_MS && nowMs >= cache.at ? cache.rows : null;
}

/** Test hook: a warm isolate whose rows never expire (until resetMarketCache). Never used in production. */
export function pinMarkets(rows: MarketRow[]): void {
  cache = { rows, at: 0, pinned: true };
}

export function rememberMarkets(rows: MarketRow[], nowMs: number): void {
  cache = { rows, at: nowMs };
}

/** One request that reads the enabled markets. Throws DbError. */
export async function readMarkets(
  env: DbEnv,
  f: typeof fetch,
  nowMs: number,
): Promise<MarketRow[]> {
  const [res] = await pipeline(env, [MARKETS_STMT], f);
  const rows = parseMarketRows(res.rows);
  rememberMarkets(rows, nowMs);
  return rows;
}

// ---- per-market facts --------------------------------------------------------------------------------------

export type MarketFacts = {
  /** Mode of the table's first market (the one untagged slots belong to), or null when there is none. */
  marketMode: string | null;
  /** True when the first market trades on `date`. */
  tradingDay: boolean;
  /** Mode and trading day by market code, for tagged slots (D-1045). */
  marketModes: Readonly<Record<string, string>>;
  tradingDays: Readonly<Record<string, boolean>>;
};

/**
 * The facts from the market rows and the calendar rows of the tick. Fail safe like the single-market code:
 * a weekday with no calendar row is not a trading day (V1-S3, D-711); a market that is not among the rows
 * has no mode, so its market-bound slots are skipped.
 */
export function marketFacts(
  rows: readonly MarketRow[],
  calendar: readonly Row[],
  date: string,
): MarketFacts {
  const kinds = new Map<string, string>();
  for (const r of calendar)
    if (typeof r[0] === "string" && typeof r[1] === "string") kinds.set(r[0], r[1]);
  const marketModes: Record<string, string> = {};
  const tradingDays: Record<string, boolean> = {};
  for (const m of rows) {
    marketModes[m.code] = m.mode;
    tradingDays[m.code] = isTradingDayKind(date, kinds.get(m.code) ?? null);
  }
  const first = rows[0];
  return {
    marketMode: first === undefined ? null : first.mode,
    tradingDay: first === undefined ? false : tradingDays[first.code],
    marketModes,
    tradingDays,
  };
}
