export type UsBar = {
  code: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
};
export function validateUsBar(
  raw: unknown,
  opts?: { from?: string; to?: string },
): { row: UsBar } | { reason: string };
export class UsBarsFormatError extends Error {}
export function parseUsBarsText(
  text: string,
  opts?: { from?: string; to?: string },
): {
  rows: UsBar[];
  rejected: { index: number; code: string | null; date: string | null; reason: string }[];
  total: number;
};
export function yahooRequestFor(
  profile: { yahooSuffix?: string | null; currency: string | null },
  codes: string[],
  start: string,
  end: string,
): { codes: string[]; start: string; end: string; suffix: string; currency: string | null };
export function barsFromChart(json: unknown, code: string, tz: string): UsBar[];
export function barsFromStooqCsv(text: string, code: string): UsBar[];
