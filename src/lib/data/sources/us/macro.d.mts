export const FRED_SOURCE: string;
export const FRED_KEY_ENV: string;
export const FRED_HOST: string;
export const MACRO_SOURCE: string;
export const FRED_SERIES: readonly string[];
export const FRED_BACK_DAYS: number;
export class FredKeyMissing extends Error {}
export function fredKey(env: Record<string, string | undefined>): string;
export function parseFredObservations(json: unknown): { d: string; valueMicro: bigint }[];
export function feedMacroEntry(
  seriesId: string,
  observations: { d: string; valueMicro: bigint }[],
): { seriesId: string; observations: { d: string; valueMicro: string }[] };
export function feedMacroRows(list: unknown): {
  rows: { source: string; seriesId: string; d: string; valueMicro: bigint }[];
  skipped: number;
};
export function createFredClient(o: {
  db: { execute: (...a: never[]) => unknown };
  market: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  gate?: (row: never) => unknown;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  siteOf?: (host: string) => never;
  sourceOf?: (id: string) => never;
}): {
  observations(seriesId: string, start?: string): Promise<{ d: string; valueMicro: bigint }[]>;
};
