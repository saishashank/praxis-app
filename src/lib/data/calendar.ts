// Trading calendar and DST library (M2 T2, docs/M2_design.md section 2 and 3, D-057 #1, #11, #12).
// Pure functions, no database and no network. Verbatim spec quotes (grep -n, spec/ folder):
//
// spec/06_data_layer.md:124 DAT-160:
//   "Calendars per market (sessions, holidays, early closes, announcement hours) refreshed
//   yearly" ... "the Owner only confirms it (one click, OPS-020)" ... "If next year's calendar
//   is still unconfirmed on 1 January, the system uses the provisional calendar, flags every
//   affected day 'calendar unconfirmed' and shows a daily P1 notice until the Owner confirms."
// spec/13_review_errata_and_addenda.md:53 DAT-160:
//   "ASX sessions, public holidays and early closes MUST come from configuration refreshed
//   yearly from ASX's published calendar [VERIFY at build]"
// spec/02_platform_hosting_auth.md:38 PLT-023:
//   "All timestamps MUST be stored in UTC and displayed in Australia/Melbourne."
// spec/10_nfr_testing.md:139 TST-103:
//   "Melbourne DST start (first Sunday in October) and end (first Sunday in April), plus US DST
//   changes, for every scheduled job and the 20:00 email; exchange holidays; early closes."
// spec/13_review_errata_and_addenda.md:121 TST-103:
//   "DST transition days (first Sunday in October, first Sunday in April) MUST be tested for the
//   20:00 email and every scheduled job."
// spec/14_system_acceptance.md:12 AT-05 (DST part):
//   "...; Worker dispatches use `ref: release`; DST cases pass; ..."
// spec/02_platform_hosting_auth.md:30 PLT-019 (DST and cron):
//   "the builder MUST convert Australia/Melbourne local times correctly across daylight-saving
//   changes" ... "never the wall-clock time at start, because scheduled runs start 5–30 min late."
// docs/M2_design.md:87 (AU slot schedule, PLT-073):
//   "The two zones share offset and DST dates (AEST UTC+10, AEDT UTC+11, changes first Sunday of
//   October and April), so one zone key serves both. The Worker ticks every minute in UTC and
//   decides on the local minute, which replaces the "which trigger fired" guard of PLT-019".
//
// Rules chosen here (documented, tested):
//  - The trading date is the exchange's local (Sydney) calendar date (D-057 #1).
//  - A local time that does not exist (spring-forward gap, 02:00..02:59 on the first Sunday in
//    October) is moved FORWARD by the gap length: 02:30 becomes 03:30 AEDT. The result is the
//    instant you get by reading the time with the offset that was in force before the change.
//  - A local time that happens twice (fall-back overlap, 02:00..02:59 on the first Sunday in
//    April) resolves to the FIRST occurrence (the earlier instant, still on daylight time), so a
//    daily job never runs later than its stated time.
//  - A weekday with no calendar row counts as a trading day (provisional), so callers decide
//    separately what to do about uncovered dates with `calendarCovers`.
import { formatTime, type TimeFormat } from "@/lib/health/format";

export type CalendarKind = "session" | "holiday" | "early_close";

export type CalendarRow = {
  d: string; // YYYY-MM-DD, exchange local date
  kind: CalendarKind;
  close_time: string | null; // HH:MM local, set for early_close
  confirmed?: 0 | 1;
};

export type MarketHours = { tz: string; open_time: string; close_time: string };

export type LocalStatus = "normal" | "gap" | "overlap";

export type SessionTimes = { date: string; open: Date; close: Date; early: boolean };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

function parseDate(date: string): { y: number; m: number; d: number } {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`bad date: ${date}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const back = new Date(Date.UTC(y, mo - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new RangeError(`bad date: ${date}`);
  }
  return { y, m: mo, d };
}

function parseTime(time: string): { h: number; min: number } {
  const m = TIME_RE.exec(time);
  if (!m) throw new RangeError(`bad time: ${time}`);
  return { h: Number(m[1]), min: Number(m[2]) };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormat(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

// Local wall clock of an instant, as UTC milliseconds of the same digits.
function wallMs(ms: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of zoneFormat(tz).formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

// Offset of the zone at an instant: local wall clock minus UTC, in ms.
function offsetMs(ms: number, tz: string): number {
  return wallMs(ms, tz) - Math.floor(ms / 1000) * 1000;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

// Local (exchange) calendar date YYYY-MM-DD of an instant (D-057 #1).
export function marketDate(utc: Date, tz: string): string {
  if (Number.isNaN(utc.getTime())) throw new RangeError("invalid date");
  const w = new Date(wallMs(utc.getTime(), tz));
  return `${pad(w.getUTCFullYear(), 4)}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
}

// Local date + HH:MM in a zone -> UTC instant, with the gap/overlap rules in the header.
export function resolveLocal(
  date: string,
  time: string,
  tz: string,
): { utc: Date; status: LocalStatus } {
  const { y, m, d } = parseDate(date);
  const { h, min } = parseTime(time);
  const wall = Date.UTC(y, m - 1, d, h, min);
  const before = offsetMs(wall - DAY_MS, tz);
  const after = offsetMs(wall + DAY_MS, tz);
  const valid = [...new Set([wall - before, wall - after])]
    .filter((c) => wallMs(c, tz) === wall)
    .sort((a, b) => a - b);
  if (valid.length === 0) return { utc: new Date(wall - before), status: "gap" };
  if (valid.length === 1) return { utc: new Date(valid[0]), status: "normal" };
  return { utc: new Date(valid[0]), status: "overlap" };
}

export function localToUtc(date: string, time: string, tz: string): Date {
  return resolveLocal(date, time, tz).utc;
}

export function addDays(date: string, n: number): string {
  const { y, m, d } = parseDate(date);
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function isWeekend(date: string): boolean {
  const { y, m, d } = parseDate(date);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

function holidaySet(rows: readonly CalendarRow[]): Set<string> {
  return new Set(rows.filter((r) => r.kind === "holiday").map((r) => r.d));
}

// True when the calendar has a row for the date (weekends carry no rows).
export function calendarCovers(date: string, rows: readonly CalendarRow[]): boolean {
  return rows.some((r) => r.d === date);
}

export function isTradingDay(date: string, rows: readonly CalendarRow[]): boolean {
  return !isWeekend(date) && !holidaySet(rows).has(date);
}

export function sessionTimes(
  date: string,
  market: MarketHours,
  rows: readonly CalendarRow[],
): SessionTimes | null {
  if (!isTradingDay(date, rows)) return null;
  const row = rows.find((r) => r.d === date);
  const early = row?.kind === "early_close" && row.close_time !== null;
  const closeAt = early && row?.close_time ? row.close_time : market.close_time;
  return {
    date,
    open: localToUtc(date, market.open_time, market.tz),
    close: localToUtc(date, closeAt, market.tz),
    early,
  };
}

// A holiday run longer than this many days is a data error, not a calendar.
const SEARCH_LIMIT = 30;

export function nextTradingDay(date: string, rows: readonly CalendarRow[]): string {
  const hol = holidaySet(rows);
  for (let i = 1; i <= SEARCH_LIMIT; i++) {
    const d = addDays(date, i);
    if (!isWeekend(d) && !hol.has(d)) return d;
  }
  throw new RangeError(`no trading day within ${SEARCH_LIMIT} days after ${date}`);
}

export function previousTradingDay(date: string, rows: readonly CalendarRow[]): string {
  const hol = holidaySet(rows);
  for (let i = 1; i <= SEARCH_LIMIT; i++) {
    const d = addDays(date, -i);
    if (!isWeekend(d) && !hol.has(d)) return d;
  }
  throw new RangeError(`no trading day within ${SEARCH_LIMIT} days before ${date}`);
}

// Trading days from..to inclusive, oldest first.
export function sessionsBetween(from: string, to: string, rows: readonly CalendarRow[]): string[] {
  parseDate(from);
  parseDate(to);
  const hol = holidaySet(rows);
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!isWeekend(d) && !hol.has(d)) out.push(d);
  }
  return out;
}

export type CalendarSummary = {
  market: string;
  year: number;
  tradingDays: number; // session + early_close rows
  holidays: number;
  unconfirmed: number;
  total: number;
};

// Counts for System Health ("AU trading calendar 2026: 254 days, NOT CONFIRMED").
export function summariseCalendar(
  market: string,
  year: number,
  rows: readonly CalendarRow[],
): CalendarSummary {
  const prefix = `${pad(year, 4)}-`;
  const mine = rows.filter((r) => r.d.startsWith(prefix));
  return {
    market,
    year,
    tradingDays: mine.filter((r) => r.kind !== "holiday").length,
    holidays: mine.filter((r) => r.kind === "holiday").length,
    unconfirmed: mine.filter((r) => r.confirmed !== 1).length,
    total: mine.length,
  };
}

// PLT-023: stored in UTC, shown in Australia/Melbourne (same patterns as the Health page).
export function displayMelbourne(utc: Date, timeFormat: TimeFormat = "24h"): string {
  return formatTime(utc, { time_format: timeFormat });
}
