export const SOURCE: "in_nse_bands";
export function parseBands(text: string): {
  rows: { code: string; series: string; bandPct: number | null }[];
  rejected: number;
};
export function priceBandRows(
  rows: { code: string; bandPct: number | null }[],
  o: { market: string; d: string },
): (string | number | null)[][];
