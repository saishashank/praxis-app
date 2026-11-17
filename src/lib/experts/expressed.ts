// Expressed clusters at screening time (M22 E4; KB-085, D-1437). Reads `cluster_expression` (0039); writes nothing.
// A cluster is an expressed candidate when a person confirmed it, a supporting claim is checked (as for a fitted
// cluster, LLM-069), it has NO family fit (a fitted cluster is screened as a fit) and its latest expression is
// `expressed`. Each statement names its row cap; no OFFSET.
import type { Client } from "@libsql/client";

export type Exec = Pick<Client, "execute">;

export type ExpressedCluster = {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly ruleJson: string;
  readonly exitJson: string;
  readonly preregSha: string;
};

/** Confirmed, checked, unfitted clusters whose newest expression is `expressed`, by id. */
export async function eligibleExpressed(db: Exec): Promise<ExpressedCluster[]> {
  // rows-ok: at most the parked clusters (about 60, one row each), ordered by id; no OFFSET
  const r = await db.execute(`
    SELECT k.id, k.name, e.version, e.rule_json, e.exit_json, e.prereg_sha
      FROM cluster k
      JOIN cluster_expression e ON e.cluster_id = k.id
       AND e.version = (SELECT MAX(x.version) FROM cluster_expression x WHERE x.cluster_id = k.id)
     WHERE e.outcome = 'expressed'
       AND k.testability = 'testable_eod'
       AND k.family_fit_json IS NULL
       AND (SELECT s.state FROM cluster_state s WHERE s.cluster_id = k.id ORDER BY s.seq DESC LIMIT 1)
           = 'confirmed'
       AND EXISTS (
         SELECT 1 FROM claim_cluster cc
           JOIN claim_status st ON st.claim_id = cc.claim_id
            AND st.seq = (SELECT MAX(seq) FROM claim_status WHERE claim_id = cc.claim_id)
          WHERE cc.cluster_id = k.id AND cc.role = 'supports'
            AND st.status IN ('owner_checked','formalised','screened','challenger','promoted'))
     ORDER BY k.id`);
  return r.rows.map((x) => ({
    id: String(x.id),
    name: String(x.name),
    version: Number(x.version),
    ruleJson: String(x.rule_json),
    exitJson: String(x.exit_json),
    preregSha: String(x.prereg_sha),
  }));
}

/** True when an earlier run already screened this exact expression (the hypothesis is charged once). */
export async function alreadyScreened(
  db: Exec,
  clusterId: string,
  paramsSha: string,
): Promise<boolean> {
  // rows-ok: at most 1 row (LIMIT 1); screening_result holds one row per cluster and run
  const r = await db.execute({
    sql: "SELECT 1 AS hit FROM screening_result WHERE cluster_id = ? AND params_sha = ? LIMIT 1",
    args: [clusterId, paramsSha],
  });
  return r.rows.length > 0;
}
