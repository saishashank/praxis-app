export const MARKET: "AU";
export const TZ: "Australia/Sydney";
export const SOURCE: "yahoo_eod";
export const MAX_DATES_PER_RUN: number;
export const LOOKBACK_DAYS: number;
export const BACKFILL_WRITE_CAP_MONTH: number;
export const REFETCH_DIFF_PCT: number;
export const DEFAULT_CHUNK_SIZE: number;
export const DEFAULT_MIN_GAP_S: number;

export type CalendarLike = { d: string; kind: string };
export type PlannedDate = { d: string; trading: boolean };
export type BarRowIn = {
  code: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adj_close: number;
  source: "yahoo";
  published_at: null;
  fetched_at: string;
};
export type RejectedBarIn = {
  index: number;
  code: string | null;
  date: string | null;
  reason: string;
};
export type ParseOpts = { from?: string; to?: string };

export function isRealDate(s: unknown): s is string;
export function isValidCode(code: unknown): boolean;
export function sydneyDate(ms: number): string;
export function addDays(date: string, n: number): string;
export function isWeekend(date: string): boolean;
export function isTradingDay(date: string, rows: readonly CalendarLike[]): boolean;
export function previousTradingDay(date: string, rows: readonly CalendarLike[]): string;
export function tradingDaysBetween(
  from: string,
  to: string,
  rows: readonly CalendarLike[],
): string[];
export function planDates(p: {
  target: string;
  markers: ReadonlySet<string>;
  firstMarker: string | null;
  rows: readonly CalendarLike[];
  maxDates?: number;
  lookbackDays?: number;
}): { dates: PlannedDate[]; remaining: number };
export function validateBar(raw: unknown, opts?: ParseOpts): { row: BarRowIn } | { reason: string };
export class BarsFormatError extends Error {}
export function parseBars(
  json: unknown,
  opts?: ParseOpts,
): { rows: BarRowIn[]; rejected: RejectedBarIn[]; total: number };
export function parseBarsText(
  text: string,
  opts?: ParseOpts,
): { rows: BarRowIn[]; rejected: RejectedBarIn[]; total: number };
export function rejectSummary(rejected: { reason: string }[]): Record<string, number>;
export function compareBar(
  stored: { o: number; h: number; l: number; c: number; volume: number },
  fetched: { open: number; high: number; low: number; close: number; volume: number },
  threshold?: number,
): { differs: boolean; maxDiffPct: number };
export function refetchHash(
  rows: { code: string; open: number; high: number; low: number; close: number; volume: number }[],
): string;
export function throttleFrom(
  chunkRaw: unknown,
  gapRaw: unknown,
): { chunkSize: number; minGapS: number };
export function monthBoundsUtc(ms: number): { start: string; end: string };
