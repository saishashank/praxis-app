// Reference-data loaders for the manual CSV files (M14, D-218, D-238; docs/M14_design.md 2.3).
// WP0 SIGNATURE STUB: WP8 fills it in. Until then nothing is loaded, so no code has an index change
// and no code has an industry class (FAM-006 falls back to the ASX industry group, DAT-234 excludes
// nothing), which is v1 behaviour.
//
// WP8 contract: the loaders read `index_change` and `instrument_class` (migration 0018, append-only).
// `loadIndexChanges` returns each code's changes oldest first, for the decision date `d` (rows whose
// effective date is far in the future are still returned: the F3 rule tests the window around day 0).
// `loadIndustryMap` returns the newest `instrument_class` row with as_of <= d per code. Both are pure
// reads, so the live night and the snapshot builder (snapshotCore.mjs) see the same rows.
import type { Client } from "@libsql/client";
import type { IndexChangeFact } from "@/lib/agents/families/types";

/** One row of `index_change` (the CSV: code, index, add/delete, announced date, effective date, source). */
export type IndexChangeRow = IndexChangeFact & {
  readonly market: string;
  readonly code: string;
  readonly source: string;
};

/** One row of `instrument_class`. */
export type InstrumentClassRow = {
  readonly market: string;
  readonly code: string;
  readonly industry: string;
  readonly source: string;
  readonly asOf: string;
};

/** Placeholder industry values of the ASX file that count as unknown (D-217). */
export const UNKNOWN_INDUSTRY_VALUES: readonly string[] = ["Class Pend", "Not Applic"];

/** True when an industry is missing or a placeholder. */
export function industryUnknown(industry: string | null | undefined): boolean {
  return industry === null || industry === undefined || UNKNOWN_INDUSTRY_VALUES.includes(industry);
}

/** Index changes by code. STUB: none. */
export async function loadIndexChanges(
  db: Client,
  market: string,
  d: string,
): Promise<ReadonlyMap<string, readonly IndexChangeFact[]>> {
  void db;
  void market;
  void d;
  return new Map();
}

/** Finer industry class by code. STUB: none. */
export async function loadIndustryMap(
  db: Client,
  market: string,
  d: string,
): Promise<ReadonlyMap<string, string>> {
  void db;
  void market;
  void d;
  return new Map();
}
