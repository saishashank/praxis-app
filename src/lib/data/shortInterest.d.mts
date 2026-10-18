import type { Client } from "@libsql/client";

export const SHORT_MARKET: "AU";
export const SHORT_SOURCE: "asic_short";
export const SHORT_WINDOW_DAYS: number;
export const SHORT_MAX_DATES: number;
export function shortPpm(short: number, total: number): number;
export function shortSourceMode(db: Client): Promise<string | null>;
export function shortModeAllowsFetch(m: string | null): boolean;
export function planShortDates(
  db: Client,
  o: { target: string; market?: string },
): Promise<string[]>;
export type ShortRow = { code: string; as_of: string; short_ppm: number };
export function parseShortText(text: string | null | undefined): {
  status: "no_file" | "invalid" | "ok";
  stopped: string | null;
  rows: ShortRow[];
  rejected: number;
  dates: number;
  absent: number;
};
export function writeShortInterest(
  db: Client,
  o: { market?: string; rows: ShortRow[]; ingestedAt: string },
): Promise<number>;
export type ShortInterestRow = {
  asOf: string;
  shortPpm: number;
  publishedAt: string;
  assumedTime: boolean;
};
export function readShortInterest(
  db: Client,
  o: { code: string; asOf: string; limit?: number; market?: string },
): Promise<ShortInterestRow[]>;
