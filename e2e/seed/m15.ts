// M15 P4 e2e seed: a small synthetic Cortex world for the "rich" scenario (one night, one map, one angle
// passport, one allowed strategy, a placebo and NAV-at-risk result, two abstains). Synthetic names only.
// Idempotent: it checks for its own night row.
import { createClient } from "@libsql/client";
import { ensureRich } from "./rich";

const D = "2026-10-16";

export async function ensureM15(): Promise<void> {
  if (process.env.E2E_SCENARIO !== "rich") return;
  await ensureRich();
  const m = createClient({ url: process.env.TURSO_MAIN_URL! });
  try {
    const have = await m.execute({
      sql: "SELECT count(*) AS n FROM cortex_night WHERE d = ?",
      args: [D],
    });
    if (Number(have.rows[0].n) > 0) return;
    const at = "2026-10-01T00:00:00Z";
    const stmts: Array<{ sql: string; args: Array<string | number | null> }> = [
      {
        sql: `INSERT INTO input_manifest (manifest_id, market, d, sources_json, schema_sha, row_counts_json, created_at)
              VALUES ('m15e2e','AU',?,'{}','s','{}',?)`,
        args: [D, `${D}T09:00:00Z`],
      },
      {
        sql: `INSERT INTO cortex_night (market, d, status, reason, manifest_id, universe_n, bars_n, feature_rows,
                runtime_ms, active_set_hash, map_fitted_at) VALUES ('AU',?,'ran',NULL,'m15e2e',10,10,10,5,'h',?)`,
        args: [D, at],
      },
      {
        sql: `INSERT INTO cortex_map (market, family, rule_version, fitted_at, params_json, active_set_hash, n_eff, pool, fit_split)
              VALUES ('AU','F1','v1',?,'{}','h',1,'p','development')`,
        args: [at],
      },
      {
        sql: `INSERT INTO angle_passport (market, angle_id, version, domain, cluster, orientation, kind, inputs_json,
                history_fields_json, status, horizon_sessions, evidence_json, measured_json, frozen_at)
              VALUES ('AU','zz_secret_angle',1,1,'momentum',1,'score','[]','{}','active',10,'{}',NULL,?)`,
        args: [at],
      },
      {
        sql: `INSERT INTO family_status (market, family, since_d, status, evidence_json, statement_id, set_by)
              VALUES ('AU','F1','2026-10-01','allowed','{"n_eff":212,"mde":0.012}',NULL,'import')`,
        args: [],
      },
      {
        sql: `INSERT INTO cortex_ledger_cell (cell_id, market, family, angle_id, kind, spec_json, logged_at, result_at, result_json, split, lineage_id)
              VALUES ('e2e-placebo','AU','all',NULL,'placebo','{}',?,'2026-10-02T00:00:00Z','{"passed":true,"null_pass_rate":0.04}','development',NULL)`,
        args: [at],
      },
      {
        sql: `INSERT INTO cortex_ledger_cell (cell_id, market, family, angle_id, kind, spec_json, logged_at, result_at, result_json, split, lineage_id)
              VALUES ('e2e-nav','AU','all',NULL,'nav_at_risk','{}',?,'2026-10-02T00:00:00Z','{"loss_95_pct":4.2,"loss_worst_pct":9.1}','development',NULL)`,
        args: [at],
      },
      ...["B1", "B2"].map((b) => ({
        sql: `INSERT INTO cortex_abstain (market, d, book_id, gate_id, label, detail_json)
              VALUES ('AU',?,?,'G04_economic','setups like this have not come out ahead after costs','{}')`,
        args: [D, b],
      })),
    ];
    await m.batch(stmts, "write");
  } finally {
    m.close();
  }
}
