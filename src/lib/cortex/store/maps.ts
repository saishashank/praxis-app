// cortex_map (CTX-012, D-281): one row per fit; the latest fitted_at per (family, rule_version)
// wins. The import (D-267) and the refit (CTX-060, CTX-072) append; nothing is overwritten.
import { decisionCutoffUtc } from "@/lib/agents/decisionView";
import { defaultAgentParams } from "@/lib/agents/params";
import { jsonText, num, parseJson, str, type CortexFamily, type Exec } from "./common";

export type MapParams = {
  a: number;
  b: number;
  s_mean: number;
  s_sd: number;
  K: number;
  clusters: readonly string[];
  /** D-923: a learner rule version's row (`<family>.learn`); absent on the fixed Cortex's rows. */
  learner?: boolean;
  /** D-924 scope: a base row the learning system wrote (bound by the as-of cut-off like a learner row). */
  system?: boolean;
  based_on?: string;
  generation?: number;
  weights?: {
    angle?: Readonly<Record<string, number>>;
    cluster?: Readonly<Record<string, number>>;
  };
  /** `weightsHash(weights)` (score/map.ts); the refit guard recomputes it (LRN-AT-6). */
  weights_hash?: string;
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

/**
 * D-923: a learner row, insert-or-ignore by its key (market, family, rule_version, fitted_at): the
 * learning stages write rows whose instant is a function of the night, so a re-run writes nothing.
 * True when the row was new.
 */
export async function insertMapIgnore(db: Exec, m: MapRow): Promise<boolean> {
  const r = await db.execute({
    sql: `INSERT INTO cortex_map (market, family, rule_version, fitted_at, params_json, active_set_hash,
            n_eff, pool, fit_split) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
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
  return r.rowsAffected > 0;
}

/**
 * D-924: the latest instant a map may have been fitted to be in force on night `d`: the night's
 * decision cut-off in UTC (`decisionCutoffUtc`, the same instant `loadStageRows` bounds every live
 * read with). A map fitted later is first used the next night (the weekly run's one-session embargo).
 */
export function mapCutoffOf(d: string, cutoffHhmm?: string): string {
  return decisionCutoffUtc(d, cutoffHhmm ?? defaultAgentParams().decisionCutoff);
}

/** D-923: a learner rule version's row (`params_json.learner === true`). */
export const isLearnerRow = (m: Pick<MapRow, "params">): boolean =>
  (m.params as unknown as Record<string, unknown>).learner === true;

/**
 * D-924 (scope): a row the learning system wrote (a learner generation, `learner: true`, or a future
 * system-written base row, `system: true`) as opposed to an Owner import. Only these rows are bound
 * by the as-of cut-off; the imported fixed maps keep their pre-D-924 behaviour exactly.
 */
export const isSystemRow = (m: Pick<MapRow, "params">): boolean => {
  const p = m.params as unknown as Record<string, unknown>;
  return p.learner === true || p.system === true;
};

/** SQL twin of `isSystemRow` over the alias `x` (json_extract of a JSON true is 1). */
const SYSTEM_ROW_SQL =
  "(COALESCE(json_extract(x.params_json, '$.learner'), 0) = 1 OR COALESCE(json_extract(x.params_json, '$.system'), 0) = 1)";

/**
 * The newest fit of every (family, rule_version), ordered by family then rule version. With `asOfD`
 * (D-924, scoped to system rows) a row the learning system wrote counts only when its `fitted_at` is at or
 * before night `asOfD`'s cut-off, so a replay of an old night sees exactly the learner generation that
 * was in force; Owner-imported rows are never filtered by date (an import fitted after night d is
 * still used on night d, as before D-924). Without `asOfD`, the newest fit of all (the pages).
 */
export async function latestMaps(
  db: Exec,
  market: string,
  asOfD?: string,
  cutoffHhmm?: string,
): Promise<MapRow[]> {
  const asOf = asOfD === undefined ? null : mapCutoffOf(asOfD, cutoffHhmm);
  const bound = asOf === null ? "" : ` AND (NOT ${SYSTEM_ROW_SQL} OR x.fitted_at <= ?)`;
  const r = await db.execute({
    sql: `SELECT m.* FROM cortex_map m
          WHERE m.market = ? AND m.fitted_at = (SELECT MAX(x.fitted_at) FROM cortex_map x
            WHERE x.market = m.market AND x.family = m.family AND x.rule_version = m.rule_version${bound})
          ORDER BY m.family, m.rule_version`,
    args: asOf === null ? [market] : [market, asOf],
  });
  return r.rows.map((x) => toRow(x as Record<string, unknown>));
}

/** D-923: the learner rule versions in force on night `asOfD` (newest generation of each). */
export async function learnerMaps(
  db: Exec,
  market: string,
  asOfD: string,
  cutoffHhmm?: string,
): Promise<MapRow[]> {
  return (await latestMaps(db, market, asOfD, cutoffHhmm)).filter(isLearnerRow);
}

/**
 * Every generation of every learner rule version (oldest first within a rule version); the batch 3
 * scorer picks from it the generation that was in force on each decision's night (`mapInForce`). One
 * read: about one row a week per learner rule version plus the checkpoint caps.
 */
export async function learnerHistory(db: Exec, market: string): Promise<MapRow[]> {
  const r = await db.execute({
    sql: `SELECT * FROM cortex_map WHERE market = ?
            AND COALESCE(json_extract(params_json, '$.learner'), 0) = 1
          ORDER BY family, rule_version, fitted_at`,
    args: [market],
  });
  return r.rows.map((x) => toRow(x as Record<string, unknown>));
}

/**
 * PURE (D-924): the newest of `rows` of (family, ruleVersion) fitted at or before night `d`'s cut-off;
 * undefined when none was in force yet.
 */
export function mapInForce(
  rows: readonly MapRow[],
  family: string,
  ruleVersion: string,
  d: string,
  cutoffHhmm?: string,
): MapRow | undefined {
  const asOf = mapCutoffOf(d, cutoffHhmm);
  let out: MapRow | undefined;
  for (const m of rows) {
    if (m.family !== family || m.ruleVersion !== ruleVersion || m.fittedAt > asOf) continue;
    if (out === undefined || m.fittedAt > out.fittedAt) out = m;
  }
  return out;
}

/**
 * The map a family trades on tonight: its newest fit over the FIXED rule versions (a learner row,
 * D-923, never is: who leads is `cortex_leader`'s, read by the stage); null when none.
 */
export async function currentMap(
  db: Exec,
  market: string,
  family: CortexFamily,
): Promise<MapRow | null> {
  const r = await db.execute({
    sql: `SELECT * FROM cortex_map WHERE market = ? AND family = ?
            AND COALESCE(json_extract(params_json, '$.learner'), 0) <> 1
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
