// Generates db/migrations/main/0005_au_calendar_seed.sql deterministically (M2 T2, D-057 #11).
//   node scripts/data/make-au-calendar.mjs           write the migration file
//   node scripts/data/make-au-calendar.mjs --check  exit 1 if the file on disk differs
// No network, no clock: the output depends only on the constants below.
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
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKET = "AU";
export const FIRST_YEAR = 2026;
export const LAST_YEAR = 2027;
export const SOURCE = "seed:nsw-asx-rules-v1";
export const EARLY_CLOSE_TIME = "14:10";
export const MIGRATION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "db",
  "migrations",
  "main",
  "0005_au_calendar_seed.sql",
);

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

export function allRows() {
  const rows = [];
  for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) rows.push(...yearRows(y));
  return rows;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const NO_DELETE_TRIGGER = `CREATE TRIGGER trading_calendar_no_delete BEFORE DELETE ON trading_calendar
BEGIN
  SELECT RAISE(ABORT, 'forever table');
END;`;

/** The full text of the migration file. Deterministic. */
export function renderMigration() {
  const rows = allRows();
  const lines = [];
  lines.push("-- +up");
  lines.push(
    `-- AU trading calendar seed ${FIRST_YEAR}-01-01..${LAST_YEAR}-12-31 (M2 T2, docs/M2_design.md section 6,`,
    "-- decision 11, D-057, DAT-160). GENERATED by scripts/data/make-au-calendar.mjs: do not edit by",
    "-- hand; change the script and regenerate (a test compares this file byte for byte).",
    "-- Every row is confirmed = 0: the Owner confirms one year at a time on System Health (decision 11).",
    "-- [VERIFY] The holiday list follows the standard national / NSW rules as observed by ASX and the",
    "-- early closes (24 and 31 December, 14:10 Sydney) are the usual ASX pattern. It MUST be checked",
    "-- against the ASX trading calendar before the Owner confirms it.",
    "-- Weekends carry no row. `kind`: session (full day), holiday (closed), early_close (close_time).",
    "-- Holidays in the seed:",
  );
  for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) lines.push(`--   ${y}: ${holidays(y).join(" ")}`);
  lines.push("");
  for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) {
    for (let m = 1; m <= 12; m++) {
      const prefix = `${y}-${pad(m)}-`;
      const month = rows.filter((r) => r[0].startsWith(prefix));
      lines.push(`-- ${MONTHS[m - 1]} ${y}`);
      lines.push(
        "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES",
      );
      month.forEach((r, i) => {
        const ct = r[2] === null ? "NULL" : `'${r[2]}'`;
        const end = i === month.length - 1 ? ";" : ",";
        lines.push(`  ('${MARKET}', '${r[0]}', '${r[1]}', ${ct}, 0, '${SOURCE}')${end}`);
      });
    }
  }
  lines.push("");
  lines.push("-- +down");
  lines.push(
    "-- The table refuses DELETE (forever table), so the guard is lifted for this one statement and",
  );
  lines.push("-- restored with the identical definition from migration 0004.");
  lines.push("DROP TRIGGER trading_calendar_no_delete;");
  lines.push(`DELETE FROM trading_calendar WHERE source = '${SOURCE}';`);
  lines.push(NO_DELETE_TRIGGER);
  return lines.join("\n") + "\n";
}

function main() {
  const text = renderMigration();
  if (process.argv.includes("--check")) {
    let disk = "";
    try {
      disk = readFileSync(MIGRATION_PATH, "utf8").replace(/\r\n/g, "\n");
    } catch {
      // missing file counts as different
    }
    if (disk !== text) {
      console.error("0005_au_calendar_seed.sql differs from the generator output");
      process.exit(1);
    }
    console.log("0005_au_calendar_seed.sql is up to date");
    return;
  }
  writeFileSync(MIGRATION_PATH, text, "utf8");
  console.log(`wrote ${MIGRATION_PATH}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
