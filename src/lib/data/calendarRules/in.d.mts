import type { CalendarRow } from "../calendarRules.mjs";
export const HOLIDAY_LISTS: Readonly<Record<number, readonly (readonly [string, string])[]>>;
export const SPECIAL_SESSIONS: Readonly<
  Record<string, Readonly<{ from: string; to: string; name: string }>>
>;
export const SOURCE: string;
export function sourceOf(year: number): string;
export function fixedDateHolidays(year: number): [string, string][];
export function holidays(year: number): string[];
export function yearRows(year: number): CalendarRow[];
