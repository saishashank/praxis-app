export const EARLY_CLOSE_TIME: string;
export const ONE_OFF_CLOSURES: Readonly<Record<string, string>>;
export function easterSunday(year: number): Date;
export function holidays(year: number): string[];
export type CalendarRow = [string, "session" | "holiday" | "early_close", string | null];
export function yearRows(year: number): CalendarRow[];
/** The rule module of each market that has computed rules. */
export const CALENDAR_RULE_MODULES: Readonly<
  Record<
    string,
    Readonly<{
      yearRows: (year: number) => CalendarRow[];
      source: string;
      sourceOf?: (year: number) => string;
      onEnable?: boolean;
    }>
  >
>;
export const DRAFT_SOURCE_PREFIX: string;
