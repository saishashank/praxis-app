// The AT-67 allow-list (D-1000): files outside `src/lib/market/**` that may hold a market literal because they
// ARE a per-market rule table keyed by market code. Each entry must exist in the tree (the scanner checks).
// scripts/ci/market-literals.mjs (stream E1) reads this list; nothing else exempts a file.
export const MARKET_LITERAL_ALLOW = Object.freeze([
  "src/lib/data/calendarRules.mjs", // the per-market calendar rule modules (CALENDAR_RULE_MODULES)
  "scripts/data/make-au-calendar.mjs", // the AU calendar generator (takes --market, AU rules only)
]);
