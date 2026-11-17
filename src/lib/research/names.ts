// Plain names for every registry lineage (M23 A2; D-1609). The Cortex page and the Owner lines show the name, never the key.
// `kind` says where a look is taken: "live" lineages are looked at by the app itself, "offline" ones on the build machine and
// reach the database only through the committed ledger (D-1606, D-1607). A name carries no market and no internal code; the
// page adds the market from the row. A later task adds its lineages here through its report (the successor task merges them).
export type LineageKind = "live" | "offline";

export type LineageName = { readonly name: string; readonly kind: LineageKind };

export const LINEAGE_NAMES: Readonly<Record<string, LineageName>> = {
  short_shadow: { name: "Short-selling shadow test", kind: "live" },
  regime_altinputs: { name: "Outside-signal market-state test", kind: "live" },
  committee_trial: { name: "Committee trial", kind: "live" },
  f1_v2_mom: { name: "Long-hold momentum rule", kind: "offline" },
};

const UNNAMED = "An unnamed test";

/** The plain name of a lineage; a lineage without an entry reads as an unnamed test (a test makes that a failure). */
export function lineageName(lineage: string): string {
  return LINEAGE_NAMES[lineage]?.name ?? UNNAMED;
}

/** The lineages that are looked at offline: a database look of one that is missing from the ledger is an Owner item. */
export function offlineLineages(): string[] {
  return Object.entries(LINEAGE_NAMES)
    .filter(([, v]) => v.kind === "offline")
    .map(([k]) => k);
}
