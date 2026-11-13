// A cost profile as it stood on a session date (M20 US1; D-1150, D-1181). The fee engine carries one schedule per
// profile version, and the US regulatory fees changed over the years, so a replay or a calibration that spans more
// than one regime selects the version by DATE through `cost_profile.effective_from`: the version with the greatest
// `effective_from` at or before the session. A market with no dated schedule (the home market) keeps its one profile,
// so every AU path is unchanged. A session before the first known version throws (never "the nearest one").
import { COST_VERSION_TABLES, costVersionsOf } from "@/lib/market/seed/costVersions.mjs";
import { costProfileRow, profileFromSeed, type CostProfile, type CostProfileInsert } from "./costs";

export type DatedCostProfile = {
  readonly version: number;
  readonly effectiveFrom: string;
  readonly profile: CostProfile;
};

const DATE_RE = new RegExp("^[0-9]{4}-[0-9]{2}-[0-9]{2}$");

/** Ascending by `effectiveFrom`; empty for a market with one schedule. */
export function datedCostProfiles(market: string, code: string): readonly DatedCostProfile[] {
  return costVersionsOf(market)
    .filter((v) => v.code === code)
    .map((v) => ({
      version: v.version,
      effectiveFrom: v.effective_from,
      profile: profileFromSeed(v.profile),
    }))
    .sort((a, b) =>
      a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0,
    );
}

/**
 * The version of `profile` that applied on `d` (a `YYYY-MM-DD` session date), or `profile` itself when its market has
 * no dated schedule for the code.
 */
export function costProfileAsOf(market: string, profile: CostProfile, d: string): CostProfile {
  if (!DATE_RE.test(d)) throw new RangeError("session date must be YYYY-MM-DD");
  const versions = datedCostProfiles(market, profile.code);
  if (versions.length === 0) return profile;
  let hit: DatedCostProfile | null = null;
  for (const v of versions) if (v.effectiveFrom <= d) hit = v;
  if (hit === null) {
    throw new RangeError(
      `no ${profile.code} version is dated on or before ${d} (first ${versions[0].effectiveFrom})`,
    );
  }
  return hit.profile;
}

/** The append-only `cost_profile` rows of a market's dated schedule, one per version (verified = 0). */
export function datedCostProfileRows(market: string, code: string): CostProfileInsert[] {
  return datedCostProfiles(market, code).map((v) =>
    costProfileRow(v.profile, `${v.effectiveFrom}T00:00:00.000Z`),
  );
}

/**
 * The version of `profile` on `d`, found by the profile code alone (a profile code names one market's table, so no
 * market is needed): the replay's fill environment calls this per session (D-1150). Identity for a profile with no
 * dated schedule, so AU cohorts keep the very same object.
 */
export function profileOnDate(profile: CostProfile, d: string): CostProfile {
  for (const market of Object.keys(COST_VERSION_TABLES)) {
    if (datedCostProfiles(market, profile.code).length > 0)
      return costProfileAsOf(market, profile, d);
  }
  return profile;
}

type RowWriter = {
  execute(stmt: { sql: string; args: (string | number)[] }): Promise<{ rowsAffected: number }>;
};

/**
 * Write the dated `cost_profile` rows of a market's schedule (D-1148, the D-1181 hand-off): the switch-on writer calls
 * this in the `off -> data_only` transaction beside `ensureMarketSources`, so the replay and the calibration find the
 * versions a session selects by `effective_from`. One `INSERT OR IGNORE` per version: `cost_profile` is append-only and
 * keyed by (code, version), so a row that exists, whatever it holds (an Owner approval is a NEW row at a higher
 * version, D-070 note 8), is never touched, and a second switch-on writes nothing. A market with no dated schedule
 * (AU, IN) writes nothing.
 */
export async function ensureDatedCostProfiles(
  db: RowWriter,
  market: string,
): Promise<{ codes: number; rows: number; inserted: number }> {
  const codes = [...new Set(costVersionsOf(market).map((v) => v.code))];
  let rows = 0;
  let inserted = 0;
  for (const code of codes) {
    for (const r of datedCostProfileRows(market, code)) {
      rows += 1;
      const res = await db.execute({
        // rows-ok: one primary-key insert per dated version of the market's schedule (four for US-P1), ignored when present
        sql: `INSERT OR IGNORE INTO cost_profile (code, version, tiers_json, slippage_json, source, verified, effective_from)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          r.code,
          r.version,
          r.tiers_json,
          r.slippage_json,
          r.source,
          r.verified,
          r.effective_from,
        ],
      });
      inserted += res.rowsAffected;
    }
  }
  return { codes: codes.length, rows, inserted };
}
