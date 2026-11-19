// Dated cost-profile versions per market (M20 US1, D-1150, D-1181). A market without an entry has one schedule per
// profile version (the home market). The registry is read only through `costVersionsOf(market)`.
import { US_COST_VERSIONS } from "./us/costVersions.mjs";

/** market code -> ascending list of { code, version, effective_from, profile }. */
export const COST_VERSION_TABLES = Object.freeze({ US: US_COST_VERSIONS });

/** @param {string} market */
export function costVersionsOf(market) {
  return Object.prototype.hasOwnProperty.call(COST_VERSION_TABLES, market)
    ? COST_VERSION_TABLES[market]
    : [];
}
