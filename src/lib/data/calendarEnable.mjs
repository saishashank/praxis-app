// Calendar rows are written when a market becomes enabled, never by a migration (M20 A3; D-1097, OPS-103).
// Rules are code (src/lib/data/calendarRules/{in,us}.mjs); rows are data. `ensureCalendarYears(db, market, years)` writes
// the rows of each year that has none, as PROVISIONAL rows (`confirmed = 0`, source `draft:<rule set>`, the same
// shape as the yearly draft job); a year that already has any row is never touched, so a second call, or a call after
// the market was switched off and on again, writes nothing. The market must be enabled first: the guard triggers of
// `trading_calendar` (migration 0035) refuse a row of any other, and this function says so before writing, with the
// typed `MarketNotEnabled`. So production holds no IN or US calendar row while a market is off.
// Callers: the switch-on writer (task S1) after the `market` update, the development states (e2e/seed/states/
// markets-dev.mjs) and the `recorded-day-dev` setup. No network, no clock beyond the optional `now`.
import { CALENDAR_RULE_MODULES, DRAFT_SOURCE_PREFIX } from "./calendarRules.mjs";
import { assertMarketEnabled } from "../market/scriptMarket.mjs";

/** The default years: the year of `now` and the next (two years of rows). @param {Date} now */
export function defaultCalendarYears(now) {
  const y = now.getUTCFullYear();
  return [y, y + 1];
}

/**
 * @param {{ execute: Function, batch: Function }} db
 * @param {string} market
 * @param {readonly number[]} [years] default: this year and the next
 * @param {{ now?: () => Date }} [o]
 * @returns {Promise<{ status: "written" | "exists" | "no_rules", market: string, years: number[], inserted: number }>}
 */
export async function ensureCalendarYears(db, market, years, o = {}) {
  const rules = Object.hasOwn(CALENDAR_RULE_MODULES, market) ? CALENDAR_RULE_MODULES[market] : null;
  if (rules === null) return { status: "no_rules", market, years: [], inserted: 0 };
  await assertMarketEnabled(db, market);
  const wanted = [...(years ?? defaultCalendarYears(o.now?.() ?? new Date()))];
  for (const y of wanted) {
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new RangeError("bad calendar year");
  }
  /** @type {{ sql: string, args: (string | number | null)[] }[]} */
  const stmts = [];
  const written = [];
  for (const year of wanted) {
    // rows-ok: one key-range count over a year of trading_calendar (about 260 rows)
    const have = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM trading_calendar WHERE market = ? AND d >= ? AND d <= ?",
      args: [market, `${year}-01-01`, `${year}-12-31`],
    });
    if (Number(have.rows[0].n) > 0) continue;
    const source = `${DRAFT_SOURCE_PREFIX}${rules.sourceOf?.(year) ?? rules.source}`;
    for (const [d, kind, closeTime] of rules.yearRows(year)) {
      stmts.push({
        // rows-ok: one insert per weekday of a year the market has no rows for (about 260 a year)
        sql: `INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source)
              VALUES (?, ?, ?, ?, 0, ?)`,
        args: [market, d, kind, closeTime, source],
      });
    }
    written.push(year);
  }
  if (stmts.length === 0) return { status: "exists", market, years: [], inserted: 0 };
  await db.batch(stmts, "write");
  return { status: "written", market, years: written, inserted: stmts.length };
}
