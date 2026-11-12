import type { RecordedDay } from "./redate.mjs";
export const RECORDED_ROOT: string;
export function recordedRootOf(market?: string): string;
export const MARKET_DAY_FILES: Readonly<Record<string, string>>;
export const MAX_FILE_BYTES: number;
export class RecordedDayError extends Error {
  constructor(code: string);
  code: string;
}
export function findRecordedDate(dir: string, date?: string, market?: string): string;
export function readRecordedDay(
  dir: string,
  opts?: { date?: string; market?: string },
): RecordedDay & { date: string; files?: Record<string, string> };
