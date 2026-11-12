export const SOURCE: "in_sebi_pit_sast";
export const PARSER_VERSION: string;
export type InsiderRow = {
  market: string;
  annId: string;
  code: string;
  kind: string;
  valueMicro: bigint | null;
  publishedAt: string;
};
export function parseInsiderNotices(
  text: string,
  o: { market: string },
): { rows: InsiderRow[]; skipped: number };
export function insiderRows(rows: InsiderRow[]): (string | bigint | null)[][];
