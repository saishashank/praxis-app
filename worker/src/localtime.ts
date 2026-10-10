// Australia/Sydney local time without Intl (PLT-070: 10 ms CPU per invocation). Port of the DST
// rule in src/lib/data/calendar.ts (D-059), reduced to the pure arithmetic the Worker needs; the
// Worker never imports from src/. worker/test/localtime.test.ts compares this with Intl for
// 2025..2030 around both transitions.
//
// Rule: AEST is UTC+10 and AEDT is UTC+11. Daylight time starts on the first Sunday in October
// at 02:00 AEST and ends on the first Sunday in April at 03:00 AEDT. Both instants are 16:00 UTC
// on the Saturday before that Sunday, so one comparison pair on the UTC year decides everything.

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

export type Local = {
  /** Sydney calendar date YYYY-MM-DD (the trading date, D-057 #1). */
  date: string;
  /** Minutes since local midnight, 0..1439. */
  minute: number;
  /** 0 = Sunday .. 6 = Saturday. */
  dow: number;
  /** True while AEDT (UTC+11) is in force. */
  dst: boolean;
};

// Day of month of the first Sunday of a month (month is 0-based).
function firstSunday(year: number, month: number): number {
  const dow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((7 - dow) % 7);
}

/** True when AEDT (UTC+11) is in force at the UTC instant. */
export function isSydneyDst(ms: number): boolean {
  const y = new Date(ms).getUTCFullYear();
  // Saturday 16:00 UTC before the first Sunday: 02:00 AEST (October) / 03:00 AEDT (April).
  const end = Date.UTC(y, 3, firstSunday(y, 3) - 1, 16);
  const start = Date.UTC(y, 9, firstSunday(y, 9) - 1, 16);
  return ms < end || ms >= start;
}

/** Sydney wall clock of a UTC instant. */
export function sydneyLocal(ms: number): Local {
  const dst = isSydneyDst(ms);
  const wall = new Date(ms + (dst ? 11 : 10) * HOUR_MS);
  return {
    date: wall.toISOString().slice(0, 10),
    minute: wall.getUTCHours() * 60 + wall.getUTCMinutes(),
    dow: wall.getUTCDay(),
    dst,
  };
}

export const isWeekend = (l: Local): boolean => l.dow === 0 || l.dow === 6;

/** "HH:MM" to minutes since midnight; throws on anything else (data errors fail loudly in tests). */
export function hhmm(time: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new RangeError(`bad time: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export const MINUTE_MS = MIN_MS;
