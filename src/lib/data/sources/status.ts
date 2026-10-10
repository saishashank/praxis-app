// Source-off modes (DAT-127) as pure functions of `source_status` (M2 T5). No DB, no I/O.
// DAT-127 (spec 06 line 74):
//  - ASX off: no new announcement events; halts inferred only from zero-volume sessions (flagged);
//    F2/F3/F5/F6 make no new entries; F1/F4 continue with the halt proxy; exits continue.
//  - Yahoo off: no new bars -> DAT-210 blocks all new entries; open positions are marked at the
//    last price and flagged; exits resume when data returns.
//  - ASIC off: F6 runs as F6-no-short-interest; other families unaffected.
// DAT-123: a source that is off is not fetched ("off within one cycle").
// Mode "degraded" is not defined by DAT-127: the source is still fetched, outputs are flagged, and
// no off-consequence applies. "tripped" (kill switch fired, design s2) behaves exactly as "off".

export type SourceId = "asx" | "yahoo" | "asic";
export type SourceMode = "on" | "off" | "degraded" | "tripped";
export type SourceStatuses = Record<SourceId, SourceMode>;
export type Family = "F1" | "F2" | "F3" | "F4" | "F5" | "F6";

export const SOURCES: readonly SourceId[] = ["asx", "yahoo", "asic"];
export const FAMILIES: readonly Family[] = ["F1", "F2", "F3", "F4", "F5", "F6"];

export type EntryRule = "normal" | "no_new_entries" | "halt_proxy" | "no_short_interest";

export type ModePlan = {
  fetch: Record<SourceId, boolean>;
  /** New announcement events may be created (ASX not off). */
  newAnnouncementEvents: boolean;
  /** Halts are inferred from zero-volume sessions only, and flagged (ASX off). */
  haltProxyOnly: boolean;
  /** New price bars are expected (Yahoo not off). */
  newBarsExpected: boolean;
  /** Open positions are marked at the last price and flagged (Yahoo off). */
  markAtLastPriceFlagged: boolean;
  /** Exits are processed this session; false while Yahoo is off (they resume with the data). */
  exitsProcessed: boolean;
  entries: Record<Family, EntryRule>;
  /** Sources whose output is flagged as degraded. */
  degraded: SourceId[];
  /** Sources that are off, for the Evening Review and System Health (DAT-123). */
  offFeeds: SourceId[];
};

export const isOff = (m: SourceMode): boolean => m === "off" || m === "tripped";

/** DAT-123: whether a component may fetch from this source at all. */
export function mayFetch(mode: SourceMode): boolean {
  return !isOff(mode);
}

const ASX_BLOCKED: readonly Family[] = ["F2", "F3", "F5", "F6"];
const ASX_PROXY: readonly Family[] = ["F1", "F4"];

export function planForStatuses(s: SourceStatuses): ModePlan {
  const asxOff = isOff(s.asx);
  const yahooOff = isOff(s.yahoo);
  const asicOff = isOff(s.asic);

  const entries = Object.fromEntries(FAMILIES.map((f) => [f, "normal"])) as Record<
    Family,
    EntryRule
  >;
  // Least restrictive consequences first; "no_new_entries" always wins (DAT-210 for Yahoo off).
  if (asicOff) entries.F6 = "no_short_interest";
  if (asxOff) {
    for (const f of ASX_PROXY) entries[f] = "halt_proxy";
    for (const f of ASX_BLOCKED) entries[f] = "no_new_entries";
  }
  if (yahooOff) for (const f of FAMILIES) entries[f] = "no_new_entries";

  return {
    fetch: { asx: mayFetch(s.asx), yahoo: mayFetch(s.yahoo), asic: mayFetch(s.asic) },
    newAnnouncementEvents: !asxOff,
    haltProxyOnly: asxOff,
    newBarsExpected: !yahooOff,
    markAtLastPriceFlagged: yahooOff,
    exitsProcessed: !yahooOff,
    entries,
    degraded: SOURCES.filter((id) => s[id] === "degraded"),
    offFeeds: SOURCES.filter((id) => isOff(s[id])),
  };
}

/** Halt proxy when ASX is off (DAT-127 s13): zero volume or no price in the last session. */
export function haltProxy(
  lastSession: { volume: number | null; close: number | null } | null,
): boolean {
  if (lastSession === null) return true;
  return lastSession.close === null || lastSession.volume === null || lastSession.volume === 0;
}

/** Whether a stored status string is one of the modes this module understands. */
export function parseMode(v: unknown): SourceMode | null {
  return v === "on" || v === "off" || v === "degraded" || v === "tripped" ? v : null;
}
