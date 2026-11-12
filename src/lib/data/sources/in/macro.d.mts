export const SERIES: readonly string[];
export function parseMacroCsv(text: string): {
  rows: { seriesId: string; d: string; valueMicro: bigint }[];
  skipped: number;
};
