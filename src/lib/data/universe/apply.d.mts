import type { ListedCompany } from "./parse.mjs";

export const MISSING_TO_DELIST: number;
export const SHRINK_MIN_PERCENT: number;
export const DELIST_REASON: string;
export const REUSE_GAP_DAYS: number;
export const RENAME_GAP_DAYS: number;
export const REUSE_SUSPECTED: string;
export const RELIST_CONFIRMED: string;
export const REUSE_CONFIRMED: string;
export function normaliseName(name: string): string;
export function reuseSuspicion(
  e: ExistingInstrument,
  row: { name: string },
  today: string,
): "name_changed" | "long_gap" | null;

export type ExistingInstrument = {
  code: string;
  name: string;
  industry: string | null;
  delistedOn: string | null;
  missingCount: number;
  delistReason?: string | null;
};

export type QuarantinedCode = {
  code: string;
  name: string;
  oldName: string;
  delistedOn: string | null;
  priorReason: string | null;
  why: "name_changed" | "long_gap";
};

export type UniverseCounts = {
  file: number;
  prevActive: number;
  inserted: number;
  updated: number;
  unchanged: number;
  reactivated: number;
  missingOnce: number;
  delisted: number;
};

export type UniversePlan =
  | { ok: false; error: "suspicious_shrink"; prevActive: number; fileCount: number }
  | {
      ok: true;
      today: string;
      inserts: ListedCompany[];
      updates: ListedCompany[];
      reactivations: ListedCompany[];
      /** V1-S7: delisted codes back in the file that look like a different company; kept delisted. */
      quarantined: QuarantinedCode[];
      /** Reactivations the Owner decided are a different company: each gets an instrument_listing row. */
      newListings: {
        code: string;
        name: string;
        priorName: string;
        priorDelistedOn: string | null;
        decidedBy: string;
      }[];
      /** Active codes present again whose missing counter goes back to 0. */
      seenAgain: string[];
      /** Active codes absent for the first time: counter set to the given value. */
      missing: { code: string; missingCount: number }[];
      delists: string[];
      counts: UniverseCounts;
    };

export function planUniverse(a: {
  existing: readonly ExistingInstrument[];
  file: readonly ListedCompany[];
  today: string;
}): UniversePlan;
