export const DAY_MS: number;
export function utc(y: number, m: number, d: number): Date;
export function iso(t: Date): string;
export function addDays(t: Date, n: number): Date;
export function isWeekend(t: Date): boolean;
export function easterSunday(year: number): Date;
export function nthWeekday(y: number, m: number, dow: number, n: number): Date;
export function lastWeekday(y: number, m: number, dow: number): Date;
