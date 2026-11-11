import { MarketNotEnabled, isMarketNotEnabled } from "./errors.mjs";

export { MarketNotEnabled, isMarketNotEnabled };

/** The text the write-guard triggers raise. */
export const GUARD_TEXT: "MarketNotEnabled";
/** The table named in a guard refusal (also through `cause`), or null. */
export function refusedTable(err: unknown): string | null;
/** The market of a refused statement, best effort ("unknown" when no candidate). */
export function marketOfStatement(
  stmt: unknown,
  isEnabled?: (code: string) => boolean,
  isKnown?: (code: string) => boolean,
): string;
/** The typed error for a raw database error from the guard triggers, else null. */
export function marketNotEnabledFrom(err: unknown, market?: string): MarketNotEnabled | null;
/** Throws MarketNotEnabled unless the market is enabled (one primary-key read); returns the code. */
export function assertMarketEnabled(
  db: { execute: (stmt: never) => Promise<unknown> },
  code: string,
): Promise<string>;
/**
 * The libsql client with the guard's error mapping: execute, batch, executeMultiple, migrate and the
 * statements of a transaction rethrow a refused write as MarketNotEnabled after `onRefusal` ran.
 */
export function wrapClient<T>(
  client: T,
  onRefusal?: (err: MarketNotEnabled, info: { table: string | null }) => unknown,
): T;
