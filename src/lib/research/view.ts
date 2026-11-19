// The registry list for the Cortex page (M23 A2; AT-72 "every look listed with its hash"). Read only. A2 owns this file until
// task M4 imports it; every later task adds its own view function in its own module and M4 imports them here.
import type { Client } from "@libsql/client";
import { lineageName } from "./names";
import { displayVerdict, type Verdict } from "./verdict";

export type RegistryRow = {
  readonly lineage: string;
  /** The plain name; the key is never shown. */
  readonly name: string;
  readonly market: string;
  readonly lookedAt: string;
  /** The full 64-hex (or older shorter) hash of the frozen plan. */
  readonly sha: string;
  /** PASS, NULL or INCONCLUSIVE; null for a stored word that has no mapping. */
  readonly verdict: Verdict | null;
  readonly nSetups: number | null;
  readonly nBlocks: number | null;
  /** Second looks that were refused and audited. */
  readonly refusals: number;
};

const LIST_LIMIT = 200; // threshold-ok: the registry list is bounded; one row per lineage and market

/** Every look of one market, oldest first, with its hash, numbers when recorded and the count of refused second looks. */
export async function registryRows(db: Client, market: string): Promise<RegistryRow[]> {
  // rows-ok: holdout_look primary key prefix (lineage, market) for one market, LEFT JOIN on research_result's key, LIMIT 200
  const rs = await db.execute({
    sql: `SELECT h.lineage, h.looked_at, h.prereg_sha, h.verdict, r.n_setups, r.n_blocks,
                 (SELECT COUNT(*) FROM holdout_look_refusal f WHERE f.lineage = h.lineage AND f.market = h.market) AS refusals
            FROM holdout_look h
            LEFT JOIN research_result r ON r.lineage = h.lineage AND r.market = h.market
           WHERE h.market = ?
           ORDER BY h.looked_at, h.lineage
           LIMIT ?`,
    args: [market, LIST_LIMIT],
  });
  return rs.rows.map((r) => ({
    lineage: String(r.lineage),
    name: lineageName(String(r.lineage)),
    market,
    lookedAt: String(r.looked_at),
    sha: String(r.prereg_sha),
    verdict: displayVerdict(String(r.verdict)),
    nSetups: r.n_setups === null ? null : Number(r.n_setups),
    nBlocks: r.n_blocks === null ? null : Number(r.n_blocks),
    refusals: Number(r.refusals),
  }));
}
