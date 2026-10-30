import type { Client } from "@libsql/client";

export const INDEX_MARKET: "AU";
export const INDEX_CODE: "AXJO";
export const INDEX_YAHOO_SYMBOL: "^AXJO";
export const US_INDEX_YAHOO_SYMBOLS: { GSPC: "^GSPC"; VIX: "^VIX" };
export const INDEX_CODES: string[];
export const INDEX_SOURCE: "yahoo_eod";
export function toMicro(x: number): number;
export type IndexRow = {
  index_code: string;
  d: string;
  o_micro: number;
  h_micro: number;
  l_micro: number;
  c_micro: number;
  fetched_at: string;
};
export function validateIndexRow(
  raw: unknown,
  opts?: { from?: string; to?: string },
): { row: IndexRow } | { reason: string };
export function parseIndexText(
  text: string | null | undefined,
  opts?: { from?: string; to?: string },
): { status: "no_file" | "invalid" | "ok"; rows: IndexRow[]; rejected: Record<string, number> };
export function writeIndexBars(
  db: Client,
  o: { market?: string; rows: IndexRow[]; source?: string; ingestedAt: string },
): Promise<number>;
export type IndexBar = {
  d: string;
  o: number;
  h: number;
  l: number;
  c: number;
  publishedAt: string;
};
export function readIndexBars(
  db: Client,
  o: { asOf: string; limit?: number; market?: string; indexCode?: string },
): Promise<IndexBar[]>;
