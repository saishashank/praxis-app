export const MARKET: string;
export const FIRST_YEAR: number;
export const LAST_YEAR: number;
export const SOURCE: string;
export const EARLY_CLOSE_TIME: string;
export const MIGRATION_PATH: string;
export function easterSunday(year: number): Date;
export function holidays(year: number): string[];
export function yearRows(
  year: number,
): Array<[string, "session" | "holiday" | "early_close", string | null]>;
export function allRows(): Array<[string, "session" | "holiday" | "early_close", string | null]>;
export function renderMigration(): string;
