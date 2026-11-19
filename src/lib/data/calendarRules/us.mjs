// The NYSE (US) trading-calendar rules (M20 A3; OPS-103, D-1097). Pure: no clock, network or database. Computed,
// not typed, and checked against the exchange's published 2026 and 2027 list (the public holiday page, read in the
// A3 verification pass; source report row `us_nyse_holidays`):
//   New Year Day (1 Jan): Sunday moves to Monday; a Saturday has NO observed day (the Friday before is open)
//   Martin Luther King Jr. Day: third Monday of January. Washington Birthday: third Monday of February
//   Good Friday (Gregorian Easter). Memorial Day: last Monday of May
//   Juneteenth (19 Jun, from 2022): Saturday moves to Friday, Sunday to Monday
//   Independence Day (4 Jul): Saturday moves to Friday, Sunday to Monday. Labor Day: first Monday of September
//   Thanksgiving: fourth Thursday of November. Christmas Day (25 Dec): Saturday moves to Friday, Sunday to Monday
//   One-off closure: 9 Jan 2025 (National Day of Mourning for President Carter)
// Early closes at 13:00 (the late sessions of the secondary venues run to 17:00; the arena trades the regular
// session, so only the 13:00 close matters): the day after Thanksgiving; 3 Jul when it and 4 Jul are both weekdays;
// 24 Dec when it is a weekday and not itself the observed Christmas holiday.
import { addDays, easterSunday, isWeekend, iso, lastWeekday, nthWeekday, utc } from "./dates.mjs";

export const EARLY_CLOSE_TIME = "13:00";
export const SOURCE = "nyse-rules-v1";
/** One-off NYSE closures the rules cannot compute (day -> reason). */
export const ONE_OFF_CLOSURES = Object.freeze({
  "2025-01-09": "National Day of Mourning for President Jimmy Carter",
});

/** Saturday -> Friday, Sunday -> Monday. @param {Date} t */
function observed(t) {
  const dow = t.getUTCDay();
  return dow === 6 ? addDays(t, -1) : dow === 0 ? addDays(t, 1) : t;
}

/** Weekday market holidays as a sorted array of YYYY-MM-DD. @param {number} year */
export function holidays(year) {
  const out = new Set();
  const ny = utc(year, 1, 1);
  if (ny.getUTCDay() !== 6) out.add(iso(ny.getUTCDay() === 0 ? addDays(ny, 1) : ny));
  out.add(iso(nthWeekday(year, 1, 1, 3)));
  out.add(iso(nthWeekday(year, 2, 1, 3)));
  out.add(iso(addDays(easterSunday(year), -2)));
  out.add(iso(lastWeekday(year, 5, 1)));
  if (year >= 2022) out.add(iso(observed(utc(year, 6, 19))));
  out.add(iso(observed(utc(year, 7, 4))));
  out.add(iso(nthWeekday(year, 9, 1, 1)));
  out.add(iso(nthWeekday(year, 11, 4, 4)));
  out.add(iso(observed(utc(year, 12, 25))));
  for (const d of Object.keys(ONE_OFF_CLOSURES)) if (d.startsWith(`${year}-`)) out.add(d);
  return [...out].sort();
}

/** The early-close days (13:00) of a year as a sorted array. @param {number} year */
export function earlyCloses(year) {
  const hol = new Set(holidays(year));
  const out = [iso(addDays(nthWeekday(year, 11, 4, 4), 1))];
  const jul3 = utc(year, 7, 3);
  const jul4 = utc(year, 7, 4);
  if (!isWeekend(jul3) && !isWeekend(jul4)) out.push(iso(jul3));
  const dec24 = utc(year, 12, 24);
  if (!isWeekend(dec24) && !hol.has(iso(dec24))) out.push(iso(dec24));
  return out.filter((d) => !hol.has(d)).sort();
}

/** One row per weekday of the year: [d, kind, close_time]. Weekends carry no rows. @param {number} year */
export function yearRows(year) {
  const hol = new Set(holidays(year));
  const early = new Set(earlyCloses(year));
  const rows = [];
  for (let t = utc(year, 1, 1); t.getUTCFullYear() === year; t = addDays(t, 1)) {
    if (isWeekend(t)) continue;
    const d = iso(t);
    if (hol.has(d)) rows.push([d, "holiday", null]);
    else if (early.has(d)) rows.push([d, "early_close", EARLY_CLOSE_TIME]);
    else rows.push([d, "session", null]);
  }
  return rows;
}
