export const NASDAQ_HALTS_SOURCE: string;
export const SEC_SUSPENSIONS_SOURCE: string;
export type HaltRow = {
  code: string;
  kind: "luld" | "halt" | "suspension";
  haltedAt: string;
  resumedAt: string | null;
  reason: string | null;
  source: string;
};
export function zonedToUtc(date: string, time: string, tz: string): string;
export function parseNasdaqHalts(xml: string, tz: string): { rows: HaltRow[]; skipped: number };
export function parseSecSuspensions(xml: string): { rows: HaltRow[]; skipped: number };
export function writeHalts(
  db: { execute: (...a: never[]) => unknown; batch: (...a: never[]) => unknown },
  market: string,
  rows: HaltRow[],
): Promise<{ inserted: number; resumed: number }>;
