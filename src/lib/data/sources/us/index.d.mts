export const INDEX_MANUAL_SOURCE: string;
export function parseIndexCsv(
  text: string,
  indexCode: string,
): {
  rows: { indexCode: string; d: string; o: number; h: number; l: number; c: number }[];
  rejected: number;
};
export function writeIndexBars(
  db: { batch: (...a: never[]) => unknown; execute: (...a: never[]) => unknown },
  market: string,
  rows: { indexCode: string; d: string; o: number; h: number; l: number; c: number }[],
  now: string,
): Promise<number>;
