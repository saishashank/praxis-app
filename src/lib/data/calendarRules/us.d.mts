import type { CalendarRow } from "../calendarRules.mjs";
export const EARLY_CLOSE_TIME: string;
export const SOURCE: string;
export const ONE_OFF_CLOSURES: Readonly<Record<string, string>>;
export function holidays(year: number): string[];
export function earlyCloses(year: number): string[];
export function yearRows(year: number): CalendarRow[];
