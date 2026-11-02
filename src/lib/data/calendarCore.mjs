// The ONE definition of "is this date a trading day" (V1-S3, D-711). Plain ESM + JSDoc with a .d.mts
// twin so the Next app, the Actions CLIs (rules.mjs), the Cloudflare Worker (relative import, bundled
// by wrangler) and the heartbeat all import the same file. No imports, no database, no clock.
//
// Rule (fail safe): a date is a trading day only when it is a weekday AND the trading_calendar has a
// row for it of kind `session` or `early_close`. A weekday with NO row is "missing", never a session:
// the seed carries a row for every weekday (weekends carry none), so a missing weekday means the
// calendar ran out or has a gap, and treating it as a session would fetch nothing, fill and mark on
// stale bars and invent phantom sessions. Callers turn "missing" into a `calendar_missing` skip plus
// an incident (heartbeat S2) instead of silently trading.

/** Days before the last calendar row at which the horizon alarm fires (DAT-160 drafts next year). */
export const CALENDAR_HORIZON_ALARM_DAYS = 60;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** @param {string} date */
function parse(date) {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`bad date: ${date}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new RangeError(`bad date: ${date}`);
  }
  return dt;
}

/** @param {string} date */
export function isWeekendDate(date) {
  const dow = parse(date).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * @param {string} date
 * @param {string | null | undefined} kind the trading_calendar.kind for the date, or null/undefined
 *   when there is no row.
 * @returns {"open" | "closed" | "missing"}
 */
export function dayStatus(date, kind) {
  if (isWeekendDate(date)) return "closed";
  if (kind === undefined || kind === null) return "missing";
  return kind === "session" || kind === "early_close" ? "open" : "closed";
}

/** @param {string} date @param {string | null | undefined} kind */
export function isTradingDayKind(date, kind) {
  return dayStatus(date, kind) === "open";
}

/**
 * Status of a date against a loaded calendar (any row shape with d and kind).
 * @param {string} date @param {readonly { d: string, kind: string }[]} rows
 * @returns {"open" | "closed" | "missing"}
 */
export function dayStatusRows(date, rows) {
  const row = rows.find((r) => r.d === date);
  return dayStatus(date, row ? row.kind : null);
}

/** @param {string} date @param {readonly { d: string, kind: string }[]} rows */
export function isTradingDayRows(date, rows) {
  return dayStatusRows(date, rows) === "open";
}

/**
 * Arithmetic walk only (nextTradingDay / previousTradingDay / sessionsBetween / the catch-up plan):
 * a weekday that is not a holiday row. Looser than the gate on purpose: it steps over a range the
 * caller has already gated, with calendars that may be partial (tests, replay fixtures), and the
 * replay goldens depend on it. NEVER use it to decide whether to trade, fetch, fill or mark.
 * @param {string} date @param {readonly { d: string, kind: string }[]} rows
 */
export function isWalkDay(date, rows) {
  return !isWeekendDate(date) && !rows.some((r) => r.kind === "holiday" && r.d === date);
}

/**
 * Whole days from `today` to the last calendar date (negative once past it).
 * @param {string} maxD @param {string} today
 */
export function horizonDaysLeft(maxD, today) {
  return Math.round((parse(maxD).getTime() - parse(today).getTime()) / 86_400_000);
}

/**
 * True when the calendar ends within `days` of today (or already ended): time to draft next year.
 * @param {string | null} maxD null = no rows at all @param {string} today @param {number} [days]
 */
export function horizonAlarm(maxD, today, days = CALENDAR_HORIZON_ALARM_DAYS) {
  if (maxD === null) return true;
  return horizonDaysLeft(maxD, today) < days;
}
