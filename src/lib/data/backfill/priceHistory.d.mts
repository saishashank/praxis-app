import type { Client } from "@libsql/client";
import type { HistoryStore } from "./dataRepo.mjs";

export const JOB_YAHOO: "yahoo_prices";
export const YAHOO_SOURCE: "yahoo_eod";
export const PRICE_SOURCE_TAG: "yahoo_eod";
export const DEFAULT_TOLERANCE_PCT: number;
export const VENDOR_MATCH_DAYS: number;

export type VendorBar = {
  code: string;
  d: string;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
};
export type Factor = { code: string; exDate: string; factor: number; actionId?: number };
export type VendorSplit = { code: string; exDate: string; ratio: number };
export type Finding = { code: string; kind: string; exDate?: string };
export type RawBarRow = VendorBar & { source: string; adj: "none" | "reversed"; flags?: string[] };

export function priceHistoryLocation(month: string): { tag: string; asset: string; path: string };
export function tickFor(price: number): number;
export function onTick(price: number): boolean;
export function cumulativeFactor(
  factors: { exDate: string; factor: number }[],
  date: string,
): number;
export function reverseBar<
  T extends { o: number; h: number; l: number; c: number; volume: number },
>(bar: T, f: number): T;
export function titleFactor(title: string): { kind: string; factor: number } | null;
export function reconstructRaw(
  bars: VendorBar[],
  o: {
    factors: Factor[];
    vendorSplits?: VendorSplit[];
    titles?: { code: string; publishedAt: string; title: string }[];
    vendor?: "adjusted" | "raw";
    tolerancePct?: number;
    prior?: { code: string; d: string; c: number }[];
  },
): {
  rows: RawBarRow[];
  findings: Finding[];
  usedFactors: { code: string; exDate: string; factor: number; from: string }[];
  reversed: number;
};
export function validateBars(bars: unknown, month: string): VendorBar[] | string;
export function initialPriceCursor(nowMs: number): string;
export function ensurePriceJob(db: Client, nowMs: number): Promise<void>;
export function readPriceState(db: Client): Promise<Record<string, unknown> & { status: string }>;
export function getPriceJob(db: Client): Promise<{
  nextDate: string | null;
  done: boolean;
  rowsWrittenMonth: number;
  state: Record<string, unknown> & { status: string };
} | null>;
export function priceGate(db: Client): Promise<string | null>;
export function loadConfirmedFactors(db: Client, codes: string[]): Promise<Factor[]>;
export function planPrices(
  db: Client,
  o: { nowMs: number; cap?: number },
): Promise<{ action: "none"; reason: string } | { action: "fetch"; month: string }>;
export function commitPriceMonth(
  db: Client,
  o: {
    month: string;
    bars: unknown[];
    vendorSplits?: VendorSplit[];
    vendor?: "adjusted" | "raw";
    store: HistoryStore;
    nowMs: number;
    cap?: number;
    tolerancePct?: number;
    commitSha?: string;
  },
): Promise<{
  status: string;
  reason?: string;
  expected?: string;
  rows?: number;
  reversed?: number;
  rejected?: Record<string, number>;
  file?: string;
  nextDate?: string | null;
  done?: boolean;
  used?: number;
  cap?: number;
  needed?: number;
}>;
