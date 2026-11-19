export const SOURCE: "in_nse_bhavcopy";
export const EQUITY_SERIES: readonly string[];
export type BhavRow = {
  code: string;
  series: string;
  isin: string;
  name: string;
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose: number | null;
  volume: number;
  tradedValue: number | null;
};
export function parseBhavcopy(
  text: string,
  o: { d: string },
): { rows: BhavRow[]; rejected: { code: string; reason: string }[]; total: number };
export function priceBarRows(
  rows: BhavRow[],
  o: { market: string; d: string; publishedAt: string; ingestedAt: string },
): (string | number)[][];
export function barPublishedAt(d: string, closeLocal: string, latencyMin: number): string;
