// Pure UTC date helpers shared by the market calendar rule modules (M20 A3). No clock, no network, no database.
export const DAY_MS = 86_400_000;
const pad = (n) => String(n).padStart(2, "0");

/** @param {number} y @param {number} m 1-12 @param {number} d */
export const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
/** @param {Date} t */
export const iso = (t) =>
  `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
/** @param {Date} t @param {number} n */
export const addDays = (t, n) => new Date(t.getTime() + n * DAY_MS);
/** @param {Date} t */
export const isWeekend = (t) => t.getUTCDay() === 0 || t.getUTCDay() === 6;

/** Gregorian Easter Sunday (anonymous / Meeus algorithm). @param {number} year */
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

/** The n-th (1-based) weekday `dow` (0 Sunday) of a month. @param {number} y @param {number} m @param {number} dow @param {number} n */
export function nthWeekday(y, m, dow, n) {
  const first = utc(y, m, 1);
  return addDays(first, ((dow - first.getUTCDay() + 7) % 7) + (n - 1) * 7);
}

/** The last weekday `dow` of a month. @param {number} y @param {number} m @param {number} dow */
export function lastWeekday(y, m, dow) {
  const last = utc(y, m + 1, 0);
  return addDays(last, -((last.getUTCDay() - dow + 7) % 7));
}
