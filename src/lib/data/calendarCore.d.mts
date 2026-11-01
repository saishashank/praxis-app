export const CALENDAR_HORIZON_ALARM_DAYS: number;
export type DayStatus = "open" | "closed" | "missing";
export function isWeekendDate(date: string): boolean;
export function dayStatus(date: string, kind: string | null | undefined): DayStatus;
export function isTradingDayKind(date: string, kind: string | null | undefined): boolean;
export function dayStatusRows(
  date: string,
  rows: readonly { d: string; kind: string }[],
): DayStatus;
export function isTradingDayRows(
  date: string,
  rows: readonly { d: string; kind: string }[],
): boolean;
export function isWalkDay(date: string, rows: readonly { d: string; kind: string }[]): boolean;
export function horizonDaysLeft(maxD: string, today: string): number;
export function horizonAlarm(maxD: string | null, today: string, days?: number): boolean;
