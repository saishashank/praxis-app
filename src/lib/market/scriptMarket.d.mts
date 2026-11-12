export const MARKET_FLAG: "--market";
export const REFUSED_LINE: string;
export const REQUIRED_LINE: string;
export const UNSUPPORTED_LINE: string;
export const REFUSED_EXIT: 2;
export type ScriptDb = {
  execute: (q: never) => Promise<{ rows: unknown[] }>;
};
export function takeMarketFlag(argv: readonly string[]): {
  argv: string[];
  market: string | null;
  error: string | null;
};
export function enabledCodes(db: ScriptDb): Promise<string[]>;
export function assertMarketEnabled(db: ScriptDb, code: string): Promise<string>;
export function resolveScriptMarket(
  db: ScriptDb,
  flag: string | null,
  opts?: { supported?: readonly string[] },
): Promise<{ ok: true; market: string } | { ok: false; line: string; exit: number }>;
