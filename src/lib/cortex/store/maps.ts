// cortex_map (CTX-012, D-281): one row per fit; the latest fitted_at per (family, rule_version)
// wins. The import (D-267) and the refit (CTX-060, CTX-072) append; nothing is overwritten.
import { jsonText, num, parseJson, str, type CortexFamily, type Exec } from "./common";

export type MapParams = {
  a: number;
  b: number;
  s_mean: number;
  s_sd: number;
  K: number;
  clusters: readonly string[];
};

export type MapRow = {
  market: string;
  family: CortexFamily;
  ruleVersion: string;
  fittedAt: string;
  params: MapParams;
  activeSetHash: string;
  nEff: number;
  pool: string;
  fitSplit: string;
};

const toRow = (r: Record<string, unknown>): MapRow => ({
  market: str(r.market),
  family: str(r.family) as CortexFamily,
  ruleVersion: str(r.rule_version),
  fittedAt: str(r.fitted_at),
  params: parseJson<MapParams>(r.params_json),
  activeSetHash: str(r.active_set_hash),
  nEff: num(r.n_eff),
  pool: str(r.pool),
  fitSplit: str(r.fit_split),
});

export async function insertMap(db: Exec, m: MapRow): Promise<void> {
  await db.execute({
    sql: `INSERT INTO cortex_map (market, family, rule_version, fitted_at, params_json, active_set_hash,
            n_eff, pool, fit_split) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      m.market,
      m.family,
      m.ruleVersion,
      m.fittedAt,
      jsonText(m.params),
      m.activeSetHash,
      m.nEff,
      m.pool,
      m.fitSplit,
    ],
  });
}

/** The newest fit of every (family, rule_version), ordered by family then rule version. */
export async function latestMaps(db: Exec, market: string): Promise<MapRow[]> {
  const r = await db.execute({
    sql: `SELECT m.* FROM cortex_map m
          WHERE m.market = ? AND m.fitted_at = (SELECT MAX(x.fitted_at) FROM cortex_map x
            WHERE x.market = m.market AND x.family = m.family AND x.rule_version = m.rule_version)
          ORDER BY m.family, m.rule_version`,
    args: [market],
  });
  return r.rows.map((x) => toRow(x as Record<string, unknown>));
}

/** The map a family trades on tonight: its newest fit over all rule versions; null when none. */
export async function currentMap(
  db: Exec,
  market: string,
  family: CortexFamily,
): Promise<MapRow | null> {
  const r = await db.execute({
    sql: `SELECT * FROM cortex_map WHERE market = ? AND family = ?
          ORDER BY fitted_at DESC, rule_version DESC LIMIT 1`,
    args: [market, family],
  });
  return r.rows[0] ? toRow(r.rows[0] as Record<string, unknown>) : null;
}

/** The fitted_at of the newest fit of any family (the refit marker compares with it); null when none. */
export async function newestFitAt(db: Exec, market: string): Promise<string | null> {
  const r = await db.execute({
    sql: "SELECT MAX(fitted_at) AS t FROM cortex_map WHERE market = ?",
    args: [market],
  });
  const t = r.rows[0]?.t;
  return t === null || t === undefined ? null : String(t);
}
