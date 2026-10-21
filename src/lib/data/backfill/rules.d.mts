export const BACKFILL_WRITE_CAP_MONTH: number;
export const MARKET: "AU";
export function addDays(date: string, n: number): string;
export function isRealDate(s: unknown): s is string;
export function isValidCode(code: unknown): boolean;
export function sydneyDate(ms: number): string;

export const RUN_JOB: "backfill-history";
export const BATCH1_JOB: "ingest-batch1";
export const JOB_ASIC: "asic_short_interest";
export const JOB_ASX: "asx_announcements";
export const JOB_NAMES: readonly string[];
export const STATUS_SOURCE: Record<string, string>;
export const ANNOUNCEMENT_SOURCE: "asx_announcements";
export const HISTORY_SOURCES: readonly string[];
export const HISTORY_YEARS: number;
export const INDEX_FACTOR: number;
export const ADMIN_WRITES: number;
export const NEWS_RETENTION_DAYS: number;
export const MAX_MONTHS_PER_RUN: number;
export const MAX_ITEMS_PER_DAY: number;
export const EMPTY_MONTHS_DEPTH: number;
export const ASIC_PUBLISH_LAG_WEEKDAYS: number;
export const ASIC_MIN_GAP_MS: number;
export const ASIC_HOST: string;
export const ASIC_URL_TEMPLATE: string;

export function isMonth(m: unknown): m is string;
export function monthOf(date: string): string;
export function monthFirstDay(month: string): string;
export function monthLastDay(month: string): string;
export function addMonths(month: string, n: number): string;
export function lastCompleteMonth(today: string): string;
export const EXPORT_SETTLE_DAYS: number;
export function monthSettled(month: string, today: string): boolean;
export function previousWeekday(date: string): string;
export function addWeekdays(date: string, n: number): string;
export function weekdaysOfMonth(month: string, upTo?: string): string[];
export function floorDate(today: string): string;
export function historyLocation(
  source: string,
  month: string,
): { tag: string; asset: string; path: string };
export function toJsonl(rows: object[]): string;
export function gzipDeterministic(text: string): Uint8Array;
export function sha256Hex(bytes: Uint8Array): string;
export function announcementWrites(rows: number): number;
export function capDecision(p: { used: number; cap: number; needed: number }): {
  ok: boolean;
  remaining: number;
};
export type MonthPlan = { month: string; dates: string[]; complete: boolean };
export function monthsToDo(cursor: string | null, floor: string, max?: number): MonthPlan[];
export function asicUrl(date: string): string;
export function asicPublishedAt(asOf: string): string;
export type AsicRow = {
  as_of: string;
  published_at: string;
  assumed_time: true;
  code: string;
  product: string;
  short_positions: number;
  total_in_issue: number;
  pct_short: number;
  source: "asic_short";
};
export function parseAsicCsv(
  text: string,
  asOf: string,
): { rows: AsicRow[]; skipped: number } | { error: "no_header" };
export type AnnouncementRow = {
  code: string;
  annId: string;
  publishedAt: string;
  type: string;
  priceSensitive: 0 | 1;
  title: string;
  url: string | null;
};
export function validateAnnouncement(
  raw: unknown,
  date: string,
): { row: AnnouncementRow } | { reason: string };
export function announcementLine(r: Record<string, unknown>): Record<string, unknown>;
export function quotaMonth(ms: number): { start: string; end: string };
export function fromJsonlGz(bytes: Uint8Array): Record<string, unknown>[];
export function visibleAt<T extends { published_at: string }>(
  rows: readonly T[],
  cutoffIso: string,
): T[];
