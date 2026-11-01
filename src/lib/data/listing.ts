// Listing identity (V1-S7, migration 0025, D-690..D-694): the one SQL fragment that bounds a code-keyed
// lookback at the start of the code's CURRENT entity. `instrument_listing` holds a row only where the
// Owner decided that a reused code is a different company; with no row the fragment is '' and the bound
// is `d >= ''`, true for every date, so histories (and every replay world) are unchanged.
//
// Use it in a query over `price_bar` (or `universe_snapshot`) that is not aliased, or pass the table
// alias: `... AND ${listingFloor("price_bar")}`.
export const listingFloor = (table: string, dateCol = "d"): string =>
  `${table}.${dateCol} >= COALESCE((SELECT MAX(l.listed_on) FROM instrument_listing l ` +
  `WHERE l.market = ${table}.market AND l.code = ${table}.code), '')`;
