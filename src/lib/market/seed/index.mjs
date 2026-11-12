// The seed registry (M19 A1; D-993): the markets whose profile is built, in code order. `builtMarkets()` is the
// synchronous list validators use (validateMarketModes, validateMarketShare); at run time everything asks the
// `market` table through the loader (`enabledMarkets(db)`). A market is added here, as a seed module, a
// migration row and a fixture, together.
import AU from "./AU.mjs";
import IN from "./IN.mjs";
import US from "./US.mjs";
import { AU_COST_PROFILES } from "./au/costProfiles.mjs";
import { IN_COST_PROFILES } from "./in/costProfiles.mjs";
import { US_COST_PROFILES } from "./us/costProfiles.mjs";

/** code -> seed module. */
export const SEEDS = Object.freeze({ AU, IN, US });

/** The built market codes (the seed registry), e.g. for validators. */
export function builtMarkets() {
  return Object.keys(SEEDS).sort();
}

/** The seed of one market, or undefined. */
export function seedOf(code) {
  return Object.prototype.hasOwnProperty.call(SEEDS, code) ? SEEDS[code] : undefined;
}

/** code -> cost-profile table (the profiles a market's `cost_formula` resolves against; M20 A4). */
export const COST_PROFILE_TABLES = Object.freeze({
  AU: AU_COST_PROFILES,
  IN: IN_COST_PROFILES,
  US: US_COST_PROFILES,
});
