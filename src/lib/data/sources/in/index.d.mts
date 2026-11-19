export const SOURCE: "in_nse_indices_manual";
export type IndexRow = {
  indexCode: string;
  d: string;
  o: bigint;
  h: bigint;
  l: bigint;
  c: bigint;
  publishedAt: string;
};
export function parseIndexCsv(
  text: string,
  o: { market: string; codes: readonly string[]; closeLocal: string; latencyMin: number },
): { rows: IndexRow[]; skipped: number };
export function indexBarRows(
  rows: IndexRow[],
  o: { market: string; ingestedAt: string },
): (string | bigint)[][];
