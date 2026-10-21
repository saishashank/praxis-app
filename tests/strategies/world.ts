// The synthetic world of the M7 T12 tests: the T7 loader seed (two strategies E01 and E02, controls,
// cards, a pick) plus rule versions, stored replay figures and a trade with a Decision Card. Synthetic
// ZZ codes only; nothing here is a real code or price.
import type { Client } from "@libsql/client";
import { CARD_UP, COHORT_E01, D, emptyDbs, seedPopulated, type Both } from "../loaders/seed";

export const RUN = `arena-3:AU:${D}`;
const SHA = "b".repeat(64);

async function run(db: Client, sql: string, args: Array<string | number | null> = []) {
  await db.execute({ sql, args });
}

const stat = (db: Client, scope: string, metric: string, value: unknown, run_id = RUN) =>
  run(db, "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES (?,?,?,?,?)", [
    run_id,
    scope,
    metric,
    D,
    JSON.stringify(value),
  ]);

const iv = (lower: number, upper: number) => ({ lower, upper });
const cif = (target: number) => ({
  proportions: [63, 126, 252].map((horizon, i) => ({
    horizon,
    n: 5,
    counts: { target: i, bust: 0, stalled: 0, timeout: 0 },
    cif: { target: target * (i + 1), bust: 0.1, stalled: 0.05, timeout: 0 },
    interval: {
      target: iv(0.02, 0.5),
      bust: iv(0, 0.3),
      stalled: iv(0, 0.2),
      timeout: iv(0, 0.1),
    },
  })),
  aalenJohansen: [],
  bootstrap: null,
});

/** The T7 seed, then the extras the Strategies pages read. */
export async function strategiesWorld(): Promise<Both> {
  const db = await emptyDbs();
  await seedPopulated(db);
  const m = db.main;

  // A second trade of E01 whose entry order carries the Decision Card (markers link to it).
  await run(
    m,
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, card_id)
     VALUES ('o4', ?, '2026-10-15', 'ZZUP', 'buy', 'entry', 3, ?)`,
    [COHORT_E01, CARD_UP],
  );
  await run(
    m,
    `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro, slip_micro,
       fill_price_micro, value_micro, brokerage_micro, cost_profile, bar_o_micro, bar_h_micro, bar_l_micro,
       bar_c_micro) VALUES ('f4','o4',?,'2026-10-16','ZZUP','buy',3,'open',12000000,0,12000000,36000000,0,'P5',
       12000000,12000000,12000000,12000000)`,
    [COHORT_E01],
  );
  await run(m, "UPDATE arena_order SET status = 'filled', fill_d = '2026-10-16' WHERE id = 'o4'");
  await run(
    m,
    "INSERT INTO trade (id, cohort_id, code, entry_fill_id, stop_micro) VALUES ('t4',?,'ZZUP','f4',11000000)",
    [COHORT_E01],
  );

  // The matched control moves along the same dates.
  for (const [d, v] of [
    ["2026-10-15", 600_000_000],
    ["2026-10-16", 605_000_000],
    [D, 615_000_000],
  ] as const) {
    await run(
      m,
      `INSERT INTO nav_daily (cohort_id, d, cash_settled_micro, recv_micro, pay_micro, positions_micro,
         div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro, fin_accrued_micro, nav_micro,
         liq_nav_micro, open_positions, invariants_ok) VALUES ('C2-F1@1',?,?,0,0,0,0,0,0,0,?,?,0,1)`,
      [d, v, v, v],
    );
  }

  // Rule versions of F1: v1 was live once and is retired; v2 is live. A challenger waits.
  for (const [n, parent, origin] of [
    [1, null, "seed"],
    [2, "F1.v1", "challenger"],
  ] as const) {
    await run(
      m,
      `INSERT INTO rule_version (id, market, family, n, parent, origin, params_json, params_sha, spec_json,
         schema_version, registered_d, created_by) VALUES (?, 'AU', 'F1', ?, ?, ?, '{}', ?, '{}', 1, ?, 'test')`,
      [`F1.v${n}`, n, parent, origin, SHA, n === 1 ? "2026-09-01" : "2026-10-05"],
    );
  }
  let seq = 0;
  for (const [id, status] of [
    ["F1.v1", "registered"],
    ["F1.v1", "live"],
    ["F1.v1", "retired"],
    ["F1.v2", "registered"],
    ["F1.v2", "live"],
  ] as const) {
    seq = id === "F1.v1" ? seq + 1 : status === "registered" ? 1 : 2;
    await run(
      m,
      "INSERT INTO rule_version_status (rule_version_id, seq, status, d, reason) VALUES (?,?,?,?, 'test')",
      [id, seq, status, "2026-10-05"],
    );
  }
  await run(
    m,
    `INSERT INTO validation_result (id, run_id, lineage_id, rule_version, variant, split_version, test, level,
       B, n, blocks, L_used, m_used, outcome) VALUES ('vr1','r','AU:F1','F1.v2','U',1,'holdout',0.05,100,50,5,1,1,'passed')`,
  );
  await run(
    m,
    `INSERT INTO challenger (id, lineage_id, rule_version_id, incumbent_version_id, origin, state_d, trial_id)
     VALUES ('C-1','AU:F1','F1.v3','F1.v2','generator','2026-10-18','trial-1')`,
  );

  // Stored batch 3 figures. E01 and E02 overlap, so they are one tied group.
  for (const [scope, target, n, mean] of [
    ["E01", 0.04, 5, 20_000_000],
    ["E02", 0.03, 4, 15_000_000],
  ] as const) {
    await stat(m, scope, "cif", cif(target));
    await stat(m, scope, "effective_n", { n, cohorts: n + 3, resolved: n + 1, censored: 2 });
    await stat(m, scope, "nav_minus_seed", {
      n,
      meanMicro: mean,
      interval: iv(-30_000_000, 60_000_000),
      replicates: 100,
    });
    await stat(m, scope, "headline", {
      scope,
      comparator: "C2-F1",
      cifTargetMinusC2: 0.05,
      navMinusC2Micro: 10_000_000,
      effectiveN: n,
      comparatorEffectiveN: 4,
    });
  }
  await stat(m, "all", "ranking", {
    metric: "navMinusSeedMicro",
    groups: [
      {
        rank: 1,
        tied: true,
        members: [
          { scope: "E01", mean: 20_000_000, interval: iv(-30_000_000, 60_000_000) },
          { scope: "E02", mean: 15_000_000, interval: iv(-30_000_000, 60_000_000) },
        ],
      },
    ],
    insufficient: [],
  });
  await stat(m, "AU:F1:v1", "zero_edge", {
    family: "F1",
    ruleVersion: "v1",
    scope: "zeroedge:F1:v1",
    trials: 2000,
    probability: { target: 0.03, bust: 0.4, stalled: 0.3, timeout: 0.27 },
    meanNavMinusSeedMicro: -15_000_000,
    meanSessions: 100,
  });
  const leg = (leverage: number, mean: number) => ({
    leverage,
    figure: { navMinusSeed: { n: 3, meanMicro: mean, interval: iv(-50_000_000, 90_000_000) } },
    sleeveTrades: 12,
    shadowTrades: 4,
    closeouts: 1,
    locks: 2,
    netPlMicro: "-25000000",
  });
  await stat(m, "sleeve:F2", "sleeve_leverage", {
    family: "F2",
    label: "hypothetical leverage",
    unlevered: null,
    levered: leg(10, 30_000_000),
    reality: leg(5, 12_000_000),
  });
  return db;
}
