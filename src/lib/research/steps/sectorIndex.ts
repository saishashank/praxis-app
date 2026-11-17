// M23 night step "sectorIndex" (docs/M23_design.md, D-1613; task S1, D-1632, D-1633, D-1670...D-1674): one `equal` row per
// industry group per session, forward only, from the U1 codes of the session and the group `instrument_class` gives as of
// that session. `value` rows are never written. It reads the bars, the universe and the classification, writes only
// sector_index, runs per enabled market, and never throws past `runResearchNight`, which logs a failure and goes on.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { chainLevel, groupReturns, SECTOR_BASE_LEVEL_PPM, type Member } from "../sectorSeries";
import type { ResearchNightOptions, ResearchStep } from "../night";

const MAX_CODES = 2000; // threshold-ok: a bound on rows read (D-1641), not a rule
const MAX_GROUPS = 200; // threshold-ok: a bound on rows written
const MAX_GROUP_NAME = 32; // threshold-ok: the column's length check

const str = (v: unknown): string => String(v);

/** One night for one market. Exported for the tests; the step below calls it. */
export async function writeSectorIndex(
  db: Client,
  o: ResearchNightOptions,
): Promise<{ written: number }> {
  // The key is fixed to "equal" (D-1632): anything else writes nothing.
  if ((await getConfig(db, "sector_index_weighting")) !== "equal") return { written: 0 };

  // Forward only and idempotent: nothing is written when the market already has a row on this date or later.
  // rows-ok: primary-key range probe (market, d) with LIMIT 1; at most 1 row
  const later = await db.execute({
    sql: "SELECT d FROM sector_index WHERE market = ? AND weighting = 'equal' AND d >= ? LIMIT 1",
    args: [o.market, o.d],
  });
  if (later.rows.length > 0) return { written: 0 };

  // rows-ok: one MAX over the (market, d) index, 1 row
  const prevRes = await db.execute({
    sql: "SELECT MAX(d) AS d FROM price_bar WHERE market = ? AND d < ?",
    args: [o.market, o.d],
  });
  const prevD = prevRes.rows[0]?.d;
  if (prevD === null || prevD === undefined) return { written: 0 };

  // rows-ok: primary-key range (market, d), U1 only, LIMIT 2000 (D-1641)
  const u1 = await db.execute({
    sql:
      "SELECT code FROM universe_snapshot WHERE market = ? AND tier = 'U1' " +
      "AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d <= ?) LIMIT ?",
    args: [o.market, o.market, o.d, MAX_CODES],
  });
  if (u1.rows.length === 0) return { written: 0 };
  const codes = JSON.stringify(u1.rows.map((r) => str(r.code)));

  const closes = async (d: string): Promise<Map<string, number>> => {
    // rows-ok: primary-key probes (market, code, d) for the U1 list, one row per code, LIMIT 2000
    const r = await db.execute({
      sql:
        "SELECT b.code AS code, b.c AS c FROM json_each(?) j JOIN price_bar b " +
        "ON b.market = ? AND b.code = j.value AND b.d = ? LIMIT ?",
      args: [codes, o.market, d, MAX_CODES],
    });
    return new Map(r.rows.map((x) => [str(x.code), Number(x.c)]));
  };
  const close = await closes(o.d);
  if (close.size === 0) return { written: 0 };
  const prev = await closes(str(prevD));

  // The newest class at or before the session per code (the rows come in code, as_of order; the last one wins).
  // rows-ok: primary-key probes (market, code) over the U1 list, a few classes per code, LIMIT 20000
  const cls = await db.execute({
    sql:
      "SELECT c.code AS code, c.industry AS industry, c.as_of AS as_of FROM json_each(?) j JOIN instrument_class c " +
      "ON c.market = ? AND c.code = j.value AND c.as_of <= ? ORDER BY c.code, c.as_of LIMIT 20000",
    args: [codes, o.market, o.d],
  });
  const members = new Map<string, Member>();
  for (const x of cls.rows) {
    const code = str(x.code);
    const group = str(x.industry);
    if (group.length > MAX_GROUP_NAME) members.delete(code);
    else members.set(code, { group, asOf: str(x.as_of) });
  }

  let written = 0;
  let groups = 0;
  for (const [group, g] of groupReturns(close, members, prev)) {
    if (++groups > MAX_GROUPS) break;
    // rows-ok: primary-key range (market, group, d) descending probe with LIMIT 1; the group's latest earlier level
    const lv = await db.execute({
      sql:
        "SELECT level_ppm FROM sector_index WHERE market = ? AND group_code = ? AND weighting = 'equal' " +
        "AND d < ? ORDER BY d DESC LIMIT 1",
      args: [o.market, group, o.d],
    });
    const base = lv.rows[0] ? Number(lv.rows[0].level_ppm) : SECTOR_BASE_LEVEL_PPM;
    // rows-ok: one insert per group, at most 200 a night; a repeat is ignored
    const r = await db.execute({
      sql:
        "INSERT INTO sector_index (market, d, group_code, weighting, ret_ppm, level_ppm, n_members, map_as_of, created_at) " +
        "VALUES (?, ?, ?, 'equal', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      args: [o.market, o.d, group, g.retPpm, chainLevel(base, g.retPpm), g.n, g.mapAsOf, o.now],
    });
    written += r.rowsAffected;
  }
  return { written };
}

export const sectorIndexStep: ResearchStep = {
  name: "sectorIndex",
  plain: "building the industry-group index series",
  async run(db, o) {
    await writeSectorIndex(db, o);
  },
};
