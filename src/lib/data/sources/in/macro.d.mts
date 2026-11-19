export const SERIES: readonly string[];
export const SOURCES: readonly string[];
export function sourceOfSeries(seriesId: string): string | null;
export function parseMacroCsv(text: string): {
  rows: { seriesId: string; d: string; valueMicro: bigint }[];
  skipped: number;
};
export function macroSeriesRows(
  rows: { seriesId: string; d: string; valueMicro: bigint }[],
): { source: string; seriesId: string; d: string; valueMicro: bigint }[];
