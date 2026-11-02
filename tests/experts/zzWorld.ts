// Shared ZZ expert world for the WP7 tests: the synthetic seed imported through the real importer, plus a
// screening run with results, a proposal and a settled call written straight into the tables. ZZ names and
// example.test hosts only (D-521, SEC-110); nothing here comes from the private research.
import type { Client } from "@libsql/client";
import { run } from "../../scripts/experts/import.mjs";
import { writeSeed, zzSeedFiles } from "./zzSeed";

/** Imports the ZZ seed (6 experts, 12 items, 20 claims incl. 2 calls, 5 clusters, 1 red flag). */
export async function importZzSeed(db: Client): Promise<void> {
  const seed = writeSeed(zzSeedFiles());
  try {
    const code = await run(
      [seed.dir],
      { TURSO_MAIN_URL: "file:zz", TURSO_MAIN_TOKEN: "tok-ZZ" },
      {
        out: () => undefined,
        openDb: () => ({
          execute: (s: never) => db.execute(s),
          batch: (s: never, m: never) => db.batch(s, m),
          close: () => undefined,
        }),
      },
    );
    if (code !== 0) throw new Error(`ZZ seed import failed with code ${code}`);
  } finally {
    seed.cleanup();
  }
}

const SHA = "a".repeat(64);

/** One screening run on `d` with a result for each cluster id (the first survives). */
export async function addScreening(
  db: Client,
  x: { market: string; d: string; clusterIds: readonly string[] },
): Promise<void> {
  const runId = `expscreen:${x.market}:${x.d}`;
  const n = x.clusterIds.length;
  await db.execute({
    sql: `INSERT INTO screening_run (run_id, market, d, q, considered, eligible, screened, survivors, splits_json, created_at)
          VALUES (?, ?, ?, 0.1, ?, ?, ?, 1, '{}', ?)`,
    args: [runId, x.market, x.d, n, n, n, `${x.d}T00:00:00.000Z`],
  });
  for (const [i, id] of x.clusterIds.entries()) {
    const survived = i === 0 ? 1 : 0;
    await db.execute({
      sql: `INSERT INTO screening_result (run_id, cluster_id, family, params_sha, rows, blocks, mean_net_ppm,
              mean_excess_ppm, lower90_ppm, p, adjusted_p, bh_rejected, sign_agrees, survived, rank, grade)
            VALUES (?, ?, 'F1', ?, 40, 8, 12000, 15000, 3000, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        runId,
        id,
        SHA,
        survived ? 0.01 : 0.4,
        survived ? 0.02 : 0.5,
        survived,
        survived,
        survived,
        survived ? 1 : null,
        survived ? "L1" : "L0",
      ],
    });
  }
}

export async function addProposal(
  db: Client,
  x: { market: string; d: string; clusterId: string; status: "created" | "refused" },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO expert_proposal (id, market, d, cluster_id, kind, family, challenger_id, status, reason, created_at)
          VALUES (?, ?, ?, ?, 'challenger', 'F1', NULL, ?, 'ZZ reason', ?)`,
    args: [
      `expprop:${x.market}:${x.d}:${x.clusterId}`,
      x.market,
      x.d,
      x.clusterId,
      x.status,
      `${x.d}T00:00:00.000Z`,
    ],
  });
}

/** A settled outcome for a tracked seed call (C-ZZ-019). */
export async function addOutcome(db: Client, claimId = "C-ZZ-019"): Promise<void> {
  await db.execute({
    sql: `INSERT INTO expert_call_outcome (claim_id, state, entry_d, exit_d, net_ppm, index_code, basis,
            market_ret_ppm, vs_market_ppm, luck_pct, settled_d)
          VALUES (?, 'closed_target', '2030-01-11', '2030-01-18', 80000, 'AXJO', 'price_only', 20000, 60000, 40, '2030-01-25')`,
    args: [claimId],
  });
}
