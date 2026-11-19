export type MacroRow = { source: string; seriesId: string; d: string; valueMicro: bigint };
export function storableMacroRows(
  rows: readonly MacroRow[],
  sources: readonly string[],
): { rows: MacroRow[]; skipped: number };
export function writeMacroSeries(
  db: { execute: (...a: never[]) => unknown; batch: (...a: never[]) => unknown },
  market: string,
  rows: readonly MacroRow[],
  fetchedAt: string,
): Promise<number>;
