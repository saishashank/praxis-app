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
  // CXA-004 (M23 T2, D-1690): the 22 announcement angles and the labels, looked at by the app itself once the archive holds 252 sessions
  "ann_angle_A-D3-01": { name: "Announcement category and tone test", kind: "live" },
  "ann_angle_A-D3-02": { name: "Price-sensitive flag as weight test", kind: "live" },
  "ann_angle_A-D3-03": { name: "Day-of-announcement price surprise test", kind: "live" },
  "ann_angle_A-D3-04": { name: "Day-of-announcement volume shock test", kind: "live" },
  "ann_angle_A-D3-05": { name: "Drift after announcement by category test", kind: "live" },
  "ann_angle_A-D3-06": { name: "Announcement clustering test", kind: "live" },
  "ann_angle_A-D3-07": {
    name: "Announcement timing (after close or during the session) test",
    kind: "live",
  },
  "ann_angle_A-D3-08": { name: "Announcement tone score test", kind: "live" },
  "ann_angle_A-D3-09": { name: "Director and substantial-holder trades test", kind: "live" },
  "ann_angle_A-D3-10": { name: "Scheduled events as timing risk test", kind: "live" },
  "ann_angle_A-D4-04": { name: "Earnings-guidance revision test", kind: "live" },
  "ann_angle_A-D5-10": { name: "Sector sentiment from announcements test", kind: "live" },
  "ann_angle_A-D6-02": { name: "Index-inclusion flows test", kind: "live" },
  "ann_angle_A-D6-06": { name: "Announcement-tone aggregate test", kind: "live" },
  "ann_angle_A-D6-07": { name: "Announcement volume spike test", kind: "live" },
  "ann_angle_A-D6-08": { name: "Crowded-trade composite test", kind: "live" },
  "ann_angle_A-D8-04": { name: "Results-season timing test", kind: "live" },
  "ann_angle_A-D8-06": { name: "Days-to-scheduled-event test", kind: "live" },
  "ann_angle_A-D9-02": { name: "Corporate-action confidence test", kind: "live" },
  "ann_angle_A-D9-03": { name: "Cross-source agreement test", kind: "live" },
  "ann_angle_A-D10-05": { name: "Expert-cluster consensus test", kind: "live" },
  "ann_angle_A-D10-06": { name: "Red-team counter-test", kind: "live" },
  ann_labels: { name: "Announcement text-label test", kind: "live" },
  // M23 R2 (D-1688): the new-edge tests run on the build machine; a variant is the same test at a larger parcel
  cxa003_hi52_vol: { name: "New 52-week high on heavy volume", kind: "offline" },
  cxa003_lowvol: { name: "Lowest-volatility stocks", kind: "offline" },
  cxa003_short_cover: { name: "Falling short positions", kind: "offline" },
  cxa003_earnings_drift: { name: "Drift after better results", kind: "offline" },
  cxa003_index_incl: { name: "Run-up to index inclusion", kind: "offline" },
  cxa003_insider_cluster: { name: "Clusters of director buying", kind: "offline" },
  // M23 R3 (D-1713): the sector rank-correlation test on the backfilled industry-group series, one look on the build machine
  sector_ic: { name: "Industry-group momentum test", kind: "offline" },
  cxa003_hi52_vol_p5000: {
    name: "New 52-week high on heavy volume, larger account",
    kind: "offline",
  },
  cxa003_lowvol_p5000: { name: "Lowest-volatility stocks, larger account", kind: "offline" },
  cxa003_short_cover_p5000: { name: "Falling short positions, larger account", kind: "offline" },
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
