// The two tables the Worker clock (worker/src) reads that are market facts but not profile fields (M19 C1,
// D-996, D-1004). Plain ESM, no imports, so the Worker can bundle it like profileCore.mjs. This file is in
// the src/lib/market/** allow-list: it is the one place a zone name or an exchange-feed time is written down
// for the Worker.

/**
 * The local-time rule each zone the Worker can compute follows (PLT-070: no Intl, 10 ms CPU). The rule id
 * names an implementation in worker/src/localtime.ts. A zone that is not listed is unsupported: the Worker
 * throws `unsupported zone` for a market row that names it (D-1004). Sydney and Melbourne share offset and
 * DST dates, so one rule serves both; Kolkata (no DST) and New York (US rules) are added with their DST
 * tests at M20.
 */
export const ZONE_RULES = Object.freeze({
  "Australia/Sydney": "au-south-dst",
  "Australia/Melbourne": "au-south-dst",
});

/**
 * The home market's exchange-feed slots (the announcement poll, the listed-companies import, the late sweep
 * and the marker check, D-194, DAT-122), local HH:MM of the market zone. Only the home market has such a feed
 * in M19; another market's feed slots are added with its data work at M20. Not profile fields: they belong to
 * the feed, not to the exchange session.
 */
export const FEED_SLOT_TIMES = Object.freeze({
  poll: Object.freeze({ from: "07:00", until: "19:30", everyMin: 4 }),
  universe: Object.freeze({ at: "07:30" }),
  fetch: Object.freeze({ from: "08:00", until: "19:00", everyMin: 30 }),
  late_sweep: Object.freeze({ at: "19:35" }),
  marker_check: Object.freeze({ at: "19:50" }),
});
