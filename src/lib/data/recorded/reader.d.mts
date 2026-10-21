import type { RecordedDay } from "./redate.mjs";
export const RECORDED_ROOT: string;
export const MAX_FILE_BYTES: number;
export class RecordedDayError extends Error {
  constructor(code: string);
  code: string;
}
export function findRecordedDate(dir: string, date?: string): string;
export function readRecordedDay(
  dir: string,
  opts?: { date?: string },
): RecordedDay & { date: string };
