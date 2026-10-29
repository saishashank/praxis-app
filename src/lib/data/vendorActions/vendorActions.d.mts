import type { Client } from "@libsql/client";

export const VENDOR_ACTION_MARKET: string;
export const VENDOR_ACTION_SOURCE: "yahoo";
export const VENDOR_ACTION_CURRENCY: string;

export type VendorActionRow = {
  code: string;
  ex_date: string;
  kind: "split" | "dividend";
  ratio: number | null;
  amount_micro: number | null;
  currency: string;
  source: "yahoo";
  fetched_at: string;
};
export type ParsedVendorActions = {
  status: "no_file" | "invalid" | "ok";
  rows: VendorActionRow[];
  rejected: Record<string, number>;
};
export type VendorAction = {
  code: string;
  exDate: string;
  kind: "split" | "dividend";
  ratio: number | null;
  amountMicro: bigint | null;
  currency: string;
  source: string;
  fetchedAt: string;
};

export function validateVendorAction(
  raw: unknown,
  opts?: { from?: string; to?: string },
): { row: VendorActionRow } | { reason: string };
export function parseVendorActionsText(
  text: string | null | undefined,
  opts?: { from?: string; to?: string },
): ParsedVendorActions;
export function writeVendorActions(
  db: Client,
  o: { market?: string; rows: VendorActionRow[] },
): Promise<number>;
export function readVendorActions(
  db: Client,
  code: string,
  from: string,
  to: string,
  market?: string,
): Promise<VendorAction[]>;
