export const QUANTITY_TYPES: string[];
export type SplitSummary = {
  window: number;
  actions: number;
  perYear: Record<string, number>;
  codesWithBars: number;
  codesWithSplit: number;
  codesWithSplitPct: number;
  windows: number;
  windowsTouched: number;
  windowsTouchedPct: number;
};
export function summarise(
  actions: Array<{ code: string; exDate: string; type: string }>,
  barDates: Map<string, string[]>,
  window?: number,
): SplitSummary;
export function measure(
  db: import("@libsql/client").Client,
  window?: number,
): Promise<SplitSummary>;
