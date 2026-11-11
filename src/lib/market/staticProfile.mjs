// The seed profile without a database (M19 B1, D-1030): the MarketProfile a market's seed module stands for,
// built synchronously through profileFromRows, with no Owner overlay and no I/O. Pure modules and module-level
// constants that cannot await the loader (angles, the money engines, legacy exports such as PARCEL_FLOOR_MICRO)
// read their market fact here, so the market literal lives in the seed and nowhere else (AT-67). For a market
// with an Owner overlay (`mkt.<CODE>.<field>`) the async loader (`loadProfile`) is the authority; for AU the two
// agree on every field the refactor moved, because the seed is today's constant to the byte
// (tests/market/auConstants.test.ts).
import { HOME_MARKET, encodeValue, profileFromRows } from "./profileCore.mjs";
import { UnknownMarket } from "./errors.mjs";
import { seedOf } from "./seed/index.mjs";
import { AU_COST_PROFILES } from "./seed/au/costProfiles.mjs";

/** code -> cost-profile table (the P-profiles a market's `cost_formula` resolves against). */
const COST_PROFILE_TABLES = Object.freeze({ [HOME_MARKET]: AU_COST_PROFILES });

const cache = new Map();

/**
 * The seed profile of a market. Throws UnknownMarket for a code with no seed. Frozen and shared.
 * @param {string} code
 */
export function staticProfile(code) {
  const hit = cache.get(code);
  if (hit !== undefined) return hit;
  const seed = seedOf(code);
  if (seed === undefined) throw new UnknownMarket(code);
  const v = (n) => seed.fields[n].value;
  const fieldRows = Object.entries(seed.fields).map(([field, f]) => ({
    field,
    value_json: encodeValue(f.value),
    verify: f.verify,
    verified_at: f.verifiedAt,
    evidence_ref: f.evidenceRef,
  }));
  const profile = profileFromRows({
    market: {
      code,
      tz: v("tz"),
      open_time: v("session_open"),
      close_time: v("session_close"),
      cutoff_time: v("decision_cutoff").time,
      currency: v("currency"),
      mode: seed.mode,
      enabled: seed.enabled,
      slots_json: null,
    },
    profile: {
      code,
      work_status: seed.workStatus,
      status_changed_at: seed.statusChangedAt,
      built_at: seed.builtAt,
      evidence_recorded_at: seed.evidenceRecordedAt,
      profile_version: seed.profileVersion,
      updated_at: seed.updatedAt,
    },
    fieldRows,
    name: seed.name,
  });
  cache.set(code, profile);
  return profile;
}

/** The home market's seed profile: the market whose constants predate the profile (AU, D-993). */
export function homeProfile() {
  return staticProfile(HOME_MARKET);
}

/**
 * The cost-profile table of a market (code -> profile record), for `profile.costFormula` to resolve against.
 * Throws for a market whose table is not built (M20), never returns a guess.
 * @param {string} code
 */
export function costProfilesOf(code) {
  const t = COST_PROFILE_TABLES[code];
  if (t === undefined) throw new Error(`cost profiles for market ${code} not built (M20)`);
  return t;
}

/**
 * The benchmark index code of a market (CXA-002 h), e.g. for a pure module that holds the market code only.
 * @param {string} code
 */
export function benchmarkIndexOf(code) {
  const b = staticProfile(code).benchmarkIndex;
  if (b === null) throw new Error(`market ${code} has no benchmark index`);
  return b;
}
