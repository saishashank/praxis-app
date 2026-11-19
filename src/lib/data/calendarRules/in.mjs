// The NSE (India) trading-calendar rules (M20 A3; OPS-103, D-1097, D-1140). Pure: no clock, network or database.
// India's holidays are lunar and announced by the exchange each December, so they are a table, not a computation:
//   2026  the exchange's published list (cash market), read once from its public holiday data in the A3
//         verification pass (the source report row `in_nse_holidays`); source `nse-holiday-list-2026`
//   2025  the list as announced for 2025, entered from the exchange circular; source `nse-holiday-list-2025`
//         [VERIFY against the exchange page when it is next read: the page serves the current year only]
//   other years  the FIXED-date subset only (26 Jan, 14 Apr, 1 May, 15 Aug, 2 Oct, 25 Dec and Good Friday from the
//         Gregorian Easter), source `nse-holiday-list-<year>-pending`: the lunar holidays are missing, so the
//         rows are provisional. The 1 November draft job (OPS-103) drafts the next year from this rule and the
//         Owner confirms it on the calendar page against the exchange's list once it is published (December).
// Weekend holidays carry no row (the table has weekday rows only). The Diwali Laxmi Pujan evening session
// (Muhurat trading) is a special session on a day the regular session is shut: it is recorded as `early_close`
// with the close of the special session (D-1140), when it falls on a weekday; the 2026 session is on a Sunday and
// has no row.
import { addDays, easterSunday, isWeekend, iso, utc } from "./dates.mjs";

/** year -> [date, name] of every cash-market holiday (weekends included for the record). */
export const HOLIDAY_LISTS = Object.freeze({
  2025: Object.freeze([
    ["2025-02-26", "Mahashivratri"],
    ["2025-03-14", "Holi"],
    ["2025-03-31", "Id-Ul-Fitr (Ramadan Eid)"],
    ["2025-04-10", "Shri Mahavir Jayanti"],
    ["2025-04-14", "Dr. Baba Saheb Ambedkar Jayanti"],
    ["2025-04-18", "Good Friday"],
    ["2025-05-01", "Maharashtra Day"],
    ["2025-08-15", "Independence Day"],
    ["2025-08-27", "Ganesh Chaturthi"],
    ["2025-10-02", "Mahatma Gandhi Jayanti and Dussehra"],
    ["2025-10-21", "Diwali Laxmi Pujan"],
    ["2025-10-22", "Diwali-Balipratipada"],
    ["2025-11-05", "Prakash Gurpurb Sri Guru Nanak Dev"],
    ["2025-12-25", "Christmas"],
  ]),
  2026: Object.freeze([
    ["2026-01-15", "Municipal Corporation Election - Maharashtra"],
    ["2026-01-26", "Republic Day"],
    ["2026-02-15", "Mahashivratri"],
    ["2026-03-03", "Holi"],
    ["2026-03-21", "Id-Ul-Fitr (Ramadan Eid)"],
    ["2026-03-26", "Shri Ram Navami"],
    ["2026-03-31", "Shri Mahavir Jayanti"],
    ["2026-04-03", "Good Friday"],
    ["2026-04-14", "Dr. Baba Saheb Ambedkar Jayanti"],
    ["2026-05-01", "Maharashtra Day"],
    ["2026-05-28", "Bakri Id"],
    ["2026-06-26", "Muharram"],
    ["2026-08-15", "Independence Day"],
    ["2026-09-14", "Ganesh Chaturthi"],
    ["2026-10-02", "Mahatma Gandhi Jayanti"],
    ["2026-10-20", "Dussehra"],
    ["2026-11-08", "Diwali Laxmi Pujan"],
    ["2026-11-10", "Diwali-Balipratipada"],
    ["2026-11-24", "Prakash Gurpurb Sri Guru Nanak Dev"],
    ["2026-12-25", "Christmas"],
  ]),
});

/** The special evening session of Diwali Laxmi Pujan on a weekday: date -> the session (local time). */
export const SPECIAL_SESSIONS = Object.freeze({
  "2025-10-21": Object.freeze({ from: "13:45", to: "14:45", name: "Muhurat trading" }),
});

/** Source name of the rule set (the per-year name is `sourceOf(year)`). */
export const SOURCE = "nse-holiday-list-v1";

/** The `source` of the rows of one year (the draft prefix is added by the caller). @param {number} year */
export function sourceOf(year) {
  return Object.hasOwn(HOLIDAY_LISTS, year)
    ? `nse-holiday-list-${year}`
    : `nse-holiday-list-${year}-pending`;
}

/** The fixed-date holidays of a year with no published list: [date, name]. @param {number} year */
export function fixedDateHolidays(year) {
  return [
    [`${year}-01-26`, "Republic Day"],
    [`${year}-04-14`, "Dr. Baba Saheb Ambedkar Jayanti"],
    [`${year}-05-01`, "Maharashtra Day"],
    [`${year}-08-15`, "Independence Day"],
    [`${year}-10-02`, "Mahatma Gandhi Jayanti"],
    [`${year}-12-25`, "Christmas"],
    [iso(addDays(easterSunday(year), -2)), "Good Friday"],
  ];
}

/** Weekday holidays of a year as a sorted array of YYYY-MM-DD. @param {number} year */
export function holidays(year) {
  const list = Object.hasOwn(HOLIDAY_LISTS, year) ? HOLIDAY_LISTS[year] : fixedDateHolidays(year);
  const out = new Set();
  for (const [d] of list) {
    const [y, m, day] = d.split("-").map(Number);
    if (!isWeekend(utc(y, m, day))) out.add(d);
  }
  return [...out].sort();
}

/** One row per weekday of the year: [d, kind, close_time]. Weekends carry no rows. @param {number} year */
export function yearRows(year) {
  const hol = new Set(holidays(year));
  const rows = [];
  for (let t = utc(year, 1, 1); t.getUTCFullYear() === year; t = addDays(t, 1)) {
    if (isWeekend(t)) continue;
    const d = iso(t);
    if (Object.hasOwn(SPECIAL_SESSIONS, d)) rows.push([d, "early_close", SPECIAL_SESSIONS[d].to]);
    else if (hol.has(d)) rows.push([d, "holiday", null]);
    else rows.push([d, "session", null]);
  }
  return rows;
}
