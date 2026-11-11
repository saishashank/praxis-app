// The home market's constants for the plain-ESM and TypeScript modules that have no profile to hand (M19 C2,
// D-1051). Every value is READ from the home market's seed (seed/AU.mjs, the single definition), never written
// again: the pipeline rules, the Actions scripts and the data modules that used `MARKET = "AU"` / `TZ = ...` /
// `"18:10"` take them from here until M20 hands each of them a `MarketProfile`. The home market is the market
// whose pre-profile global keys stay its authority (profileCore.mjs `HOME_MARKET`, D-993).
import { HOME_MARKET, slotsProjection } from "./profileCore.mjs";
import { SEEDS } from "./seed/index.mjs";

const fields = SEEDS[HOME_MARKET].fields;

export { HOME_MARKET };

/**
 * The Worker slot anchors of a seeded market (`market.slots_json` of its seed), HH:MM of its own zone: the times a
 * recorded day runs its scripts at. Null for a market that is not seeded.
 * @param {string} code
 */
export function seedSlots(code) {
  const seed = Object.hasOwn(SEEDS, code) ? SEEDS[code] : undefined;
  if (seed === undefined) return null;
  const v = (n) => seed.fields[n].value;
  return slotsProjection({
    sessionOpen: v("session_open"),
    sessionClose: v("session_close"),
    decisionCutoff: v("decision_cutoff").time,
    batchSchedule: v("batch_schedule"),
    preopenRecheckMin: v("preopen_recheck_min"),
  });
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
export const HOME_TZ = fields.tz.value;
/** The home market's currency code. */
export const HOME_CURRENCY = fields.currency.value;
/** The home market's decision cut-off, HH:MM. */
export const HOME_CUTOFF = fields.decision_cutoff.value.time;
/** The home market's benchmark index code (the stored code, no caret). */
export const HOME_BENCHMARK = fields.benchmark_index.value.code;
/** The home market's Yahoo symbol of its benchmark index (with the caret). */
export const HOME_BENCHMARK_YAHOO = fields.benchmark_index.value.yahoo;
/** The home market's Yahoo ticker suffix (`<CODE><suffix>`). */
export const HOME_YAHOO_SUFFIX = fields.yahoo_suffix.value;
/** The home market's Worker slot anchors (HH:MM of its own zone): batch times, cut-off poll, pre-open re-check. */
export const HOME_SLOTS = seedSlots(HOME_MARKET);
