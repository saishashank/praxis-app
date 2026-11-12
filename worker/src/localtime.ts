// Local time without Intl (PLT-070: 10 ms CPU per invocation) for the zones the market table names (M19 C1,
// D-1004: the rule table is keyed by zone through src/lib/market/clockTables.mjs, and a zone it does not
// list throws `unsupported zone`). Three rules (M20 A2, D-1117): the Sydney/Melbourne one, Kolkata (UTC+5:30, no DST) and
// US Eastern (second Sunday of March to first Sunday of November, 02:00 local). Port of the DST rule in
// src/lib/data/calendar.ts (D-059), reduced to the pure arithmetic the Worker needs.
// worker/test/localtime.test.ts compares each with Intl for 2025..2030 around every transition.
//
// Rule: AEST is UTC+10 and AEDT is UTC+11. Daylight time starts on the first Sunday in October
// at 02:00 AEST and ends on the first Sunday in April at 03:00 AEDT. Both instants are 16:00 UTC
// on the Saturday before that Sunday, so one comparison pair on the UTC year decides everything.

import { ZONE_RULES } from "../../src/lib/market/clockTables.mjs";

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

export type Local = {
  /** Calendar date YYYY-MM-DD of the zone (the trading date of its market, D-057 #1). */
  date: string;
  /** Minutes since local midnight, 0..1439. */
  minute: number;
  /** 0 = Sunday .. 6 = Saturday. */
  dow: number;
  /** True while the zone's daylight time is in force (AEDT, EDT; never for Kolkata). */
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

// Day of month of the n-th Sunday (n = 1..) of a month (month is 0-based).
function nthSunday(year: number, month: number, n: number): number {
  return firstSunday(year, month) + 7 * (n - 1);
}

/**
 * True when US Eastern daylight time (UTC-4) is in force at the UTC instant. DST starts on the second Sunday of March
 * at 02:00 EST (07:00 UTC) and ends on the first Sunday of November at 02:00 EDT (06:00 UTC).
 */
export function isUsEasternDst(ms: number): boolean {
  const y = new Date(ms).getUTCFullYear();
  const start = Date.UTC(y, 2, nthSunday(y, 2, 2), 7);
  const end = Date.UTC(y, 10, firstSunday(y, 10), 6);
  return ms >= start && ms < end;
}

/** Wall clock of a UTC instant at a fixed offset (minutes east of UTC). */
function wallAt(ms: number, offsetMin: number, dst: boolean): Local {
  const wall = new Date(ms + offsetMin * MIN_MS);
  return {
    date: wall.toISOString().slice(0, 10),
    minute: wall.getUTCHours() * 60 + wall.getUTCMinutes(),
    dow: wall.getUTCDay(),
    dst,
  };
}

/** Kolkata wall clock of a UTC instant: UTC+5:30 all year. */
export function kolkataLocal(ms: number): Local {
  return wallAt(ms, 330, false);
}

/** US Eastern wall clock of a UTC instant (New York). */
export function usEasternLocal(ms: number): Local {
  const dst = isUsEasternDst(ms);
  return wallAt(ms, dst ? -240 : -300, dst);
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

const ruleOf = (tz: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(ZONE_RULES, tz) ? ZONE_RULES[tz] : undefined;

/** True when the Worker can compute local time in this zone. */
export const zoneSupported = (tz: string): boolean => ruleOf(tz) !== undefined;

/**
 * The wall clock of a UTC instant in a market zone (D-1004, D-1117). Only the zones in ZONE_RULES are supported; any
 * other throws `unsupported zone`.
 */
export function localFor(tz: string, ms: number): Local {
  const rule = ruleOf(tz);
  if (rule === "au-south-dst") return sydneyLocal(ms);
  if (rule === "asia-kolkata") return kolkataLocal(ms);
  if (rule === "us-eastern-dst") return usEasternLocal(ms);
  throw new RangeError("unsupported zone");
}

/** True when the zone follows the same rule as the home (Sydney) zone the ops slots are written in. */
export const isHomeRule = (tz: string): boolean => ruleOf(tz) === "au-south-dst";

export const isWeekend = (l: Local): boolean => l.dow === 0 || l.dow === 6;

/** "HH:MM" to minutes since midnight; throws on anything else (data errors fail loudly in tests). */
export function hhmm(time: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new RangeError(`bad time: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export const MINUTE_MS = MIN_MS;
