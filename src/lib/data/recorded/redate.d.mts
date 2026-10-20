export type Row = Record<string, unknown>;
export type RecordedDay = {
  bars: Row[];
  index: Row[];
  short: (Row & { rows: Row[] }) | null;
  announcements: Row[];
  corporateActions: Row[];
};
export const DATE_FIELDS: Readonly<
  Record<
    "bars" | "index" | "short" | "announcements" | "corporateActions",
    { dates: string[]; stamps: string[] }
  >
>;
export function isIsoDate(s: unknown): boolean;
export function dayDiff(a: string, b: string): number;
export function shiftDate(s: string, n: number): string;
export function weekdaysBetween(start: string, end: string, maxDays?: number): string[];
export function alignDates(
  recorded: string[],
  targets: string[],
): { map: Map<string, string>; dropped: string[] };
export function redateDay(
  day: RecordedDay,
  target: { sessionDates: string[]; shortDates: string[] },
): RecordedDay & {
  report: {
    sessionsRecorded: number;
    sessionsKept: number;
    sessionsDropped: number;
    rowsDropped: number;
  };
};
