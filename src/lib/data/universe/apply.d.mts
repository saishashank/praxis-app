import type { ListedCompany } from "./parse.mjs";

export const MISSING_TO_DELIST: number;
export const SHRINK_MIN_PERCENT: number;
export const DELIST_REASON: string;

export type ExistingInstrument = {
  code: string;
  name: string;
  industry: string | null;
  delistedOn: string | null;
  missingCount: number;
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
