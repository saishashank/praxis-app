export const FINRA_SOURCE: string;
export function nextDay(d: string): string;
export function parseDailyShortVolume(text: string): {
  rows: { code: string; d: string; shortPpm: number; shortVolume: number; totalVolume: number }[];
  rejected: number;
};
export function parseShortInterest(text: string): {
  rows: {
    code: string;
    settlementDate: string;
    shortShares: number;
    avgDailyVolume: number | null;
    daysToCover: number | null;
  }[];
  rejected: number;
};
export function writeShortInterest(
  db: { batch: (...a: never[]) => unknown; execute: (...a: never[]) => unknown },
  market: string,
  rows: { code: string; d: string; shortPpm: number }[],
  covered: ReadonlySet<string>,
  now: string,
): Promise<{ inserted: number; notCovered: number }>;
