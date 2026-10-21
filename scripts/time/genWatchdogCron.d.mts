export const DEFAULT_TIMES: string[];
export function offsetMinutes(date: string): number;
export function cronLinesFor(time: string): string[];
export function cronLines(times?: string[]): string[];
export function slotForSchedule(cron: string, nowMs: number, times?: string[]): string | null;
export function renderSchedule(times?: string[]): string;
