// The home market's constants for the plain-ESM and TypeScript modules that have no profile to hand (M19 C2,
// D-1051). Every value is READ from the home market's seed profile (homeProfile(), M20 A2, D-1088: one derivation, the seed
// AU.mjs being the single definition), never written
// again: the pipeline rules, the Actions scripts and the data modules that used `MARKET = "AU"` / `TZ = ...` /
// `"18:10"` take them from here until M20 hands each of them a `MarketProfile`. The home market is the market
// whose pre-profile global keys stay its authority (profileCore.mjs `HOME_MARKET`, D-993).
import { HOME_MARKET } from "./profileCore.mjs";
import { SEEDS } from "./seed/index.mjs";
import { homeProfile, staticProfile } from "./staticProfile.mjs";

const home = homeProfile();

export { HOME_MARKET };

/**
 * The Worker slot anchors of a seeded market (`market.slots_json` of its seed), HH:MM of its own zone: the times a
 * recorded day runs its scripts at. Null for a market that is not seeded.
 * @param {string} code
 */
export function seedSlots(code) {
  return Object.hasOwn(SEEDS, code) ? staticProfile(code).slots : null;
}

/**
 * The markets a freshly migrated database has enabled (the seed rows: the production shape, MKT-110): what a script that
 * builds its own scratch database may run for.
 */
export function seedEnabledMarkets() {
  return Object.keys(SEEDS)
    .filter((c) => SEEDS[c].enabled === 1)
    .sort();
}
/** The home market's exchange zone (the zone its trading dates and calendar are written in). */
export const HOME_TZ = home.tz;
/** The home market's currency code. */
export const HOME_CURRENCY = home.currency;
/** The home market's decision cut-off, HH:MM. */
export const HOME_CUTOFF = home.decisionCutoff;
/** The home market's benchmark index code (the stored code, no caret). */
export const HOME_BENCHMARK = home.benchmarkIndex;
/** The home market's Yahoo symbol of its benchmark index (with the caret). */
export const HOME_BENCHMARK_YAHOO = home.benchmarkYahooSymbol;
/** The home market's Yahoo ticker suffix (`<CODE><suffix>`). */
export const HOME_YAHOO_SUFFIX = home.yahooSuffix;
/** The home market's Worker slot anchors (HH:MM of its own zone): batch times, cut-off poll, pre-open re-check. */
export const HOME_SLOTS = seedSlots(HOME_MARKET);
