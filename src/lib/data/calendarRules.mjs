// Trading-calendar rule module (OPS-103, D-961): the computed holiday rules of a market, shared by the
// seed generator (scripts/data/make-au-calendar.mjs, which re-exports these names unchanged) and the
// yearly draft job (scripts/calendar/draft.mjs). Pure: no clock, no network, no database.
//
// Holiday rules (standard national / NSW rules as observed by ASX), computed, not typed:
//   New Year's Day (1 Jan) and Australia Day (26 Jan): Saturday or Sunday moves to Monday.
//   Good Friday and Easter Monday: from the Gregorian Easter algorithm.
//   Anzac Day (25 Apr): weekday only, no substitute day.
//   King's Birthday: second Monday of June.
//   Christmas Day (25 Dec) and Boxing Day (26 Dec): the pair is observed on the next two
//   weekdays that are free (25 Fri + 26 Sat -> Fri 25 and Mon 28; 25 Sat + 26 Sun -> Mon 27 and
//   Tue 28; 25 Sun + 26 Mon -> Mon 26 and Tue 27; 25 Mon -> Mon 25 and Tue 26).
// Early closes: 24 December and 31 December when they are trading weekdays, close 14:10.
// [VERIFY] The Owner confirms this list (decision 11) and it must be checked against the ASX
// trading calendar before the Owner confirms (DAT-160, spec/13 "[VERIFY at build]").

export const EARLY_CLOSE_TIME = "14:10";

/** One-off ASX closures the rules cannot compute (day -> reason). */
export const ONE_OFF_CLOSURES = Object.freeze({
  "2022-09-22": "National Day of Mourning for Queen Elizabeth II",
});

const DAY_MS = 86_400_000;
const pad = (n) => String(n).padStart(2, "0");
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const iso = (t) => `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
const addDays = (t, n) => new Date(t.getTime() + n * DAY_MS);
const isWeekend = (t) => t.getUTCDay() === 0 || t.getUTCDay() === 6;

/** Gregorian Easter Sunday (anonymous / Meeus algorithm). */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

function mondayOnOrAfterIfWeekend(t) {
  if (t.getUTCDay() === 6) return addDays(t, 2);
  if (t.getUTCDay() === 0) return addDays(t, 1);
  return t;
}

/** Weekday public holidays on which ASX is closed, as a sorted array of YYYY-MM-DD. */
export function holidays(year) {
  const out = new Set();
  out.add(iso(mondayOnOrAfterIfWeekend(utc(year, 1, 1))));
  out.add(iso(mondayOnOrAfterIfWeekend(utc(year, 1, 26))));
  const easter = easterSunday(year);
  out.add(iso(addDays(easter, -2)));
  out.add(iso(addDays(easter, 1)));
  const anzac = utc(year, 4, 25);
  if (!isWeekend(anzac)) out.add(iso(anzac));
  const june1 = utc(year, 6, 1);
  out.add(iso(addDays(june1, ((8 - june1.getUTCDay()) % 7) + 7))); // second Monday
  // Christmas and Boxing Day: two observed weekdays, never the same day.
  const xmas = utc(year, 12, 25);
  const dow = xmas.getUTCDay();
  const pair =
    dow === 6 // Sat: Mon 27, Tue 28
      ? [addDays(xmas, 2), addDays(xmas, 3)]
      : dow === 0 // Sun: Mon 26 (Boxing Day), Tue 27 (Christmas substitute)
        ? [addDays(xmas, 1), addDays(xmas, 2)]
        : dow === 5 // Fri: Fri 25, Mon 28
          ? [xmas, addDays(xmas, 3)]
          : [xmas, addDays(xmas, 1)];
  for (const t of pair) out.add(iso(t));
  for (const d of Object.keys(ONE_OFF_CLOSURES)) if (d.startsWith(`${year}-`)) out.add(d);
  return [...out].sort();
}

/** One row per weekday of the year: [d, kind, close_time]. Weekends carry no rows. */
export function yearRows(year) {
  const hol = new Set(holidays(year));
  const rows = [];
  for (let t = utc(year, 1, 1); t.getUTCFullYear() === year; t = addDays(t, 1)) {
    if (isWeekend(t)) continue;
    const d = iso(t);
    if (hol.has(d)) rows.push([d, "holiday", null]);
    else if (d === `${year}-12-24` || d === `${year}-12-31`) {
      rows.push([d, "early_close", EARLY_CLOSE_TIME]);
    } else rows.push([d, "session", null]);
  }
  return rows;
}

/**
 * The rule module of each market that has computed rules: market code -> { yearRows, source }.
 * `source` names the rule set and is stored on every drafted row (`draft:<source>`). A market without an
 * entry here cannot be drafted (the draft job refuses it); M19 adds an entry per market it builds.
 */
export const CALENDAR_RULE_MODULES = Object.freeze({
  AU: Object.freeze({ yearRows, source: "nsw-asx-rules-v1" }),
});

/** Prefix of the `source` column of a drafted row (provisional until the Owner confirms it). */
export const DRAFT_SOURCE_PREFIX = "draft:";
