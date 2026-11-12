export const SOURCE: "in_nse_fo_oi";
export type FoRow = {
  market: string;
  code: string;
  asOf: string;
  shortPpm: number;
  publishedAt: string;
};
export function parseFoOi(text: string, o: { market: string }): { rows: FoRow[]; skipped: number };
export function shortInterestRows(rows: FoRow[], ingestedAt: string): (string | number)[][];
