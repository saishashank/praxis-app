// M14 WP8 e2e seed: stored `replay_stat` rows in the shapes of src/lib/stats/robustnessTypes.ts for the
// "rich" scenario's E01 (family F1, rule version v1). E02 gets none, so its page shows the empty state.
// Synthetic numbers only. Applied once after the rich seed (idempotent: it checks for its own run id).
import { createClient } from "@libsql/client";
import { ensureRich } from "./rich";

const RUN = "m14-e2e";
const D = "2026-10-17";
const sum = (n: number, mean: number) => ({
  n,
  mean_net: mean,
  median_net: mean,
  hit_rate: 0.55,
  mean_sessions_held: 4.5,
});

export const M14_ROWS: ReadonlyArray<readonly [string, string, unknown]> = [
  [
    "AU:F1:v1",
    "exit_ablation",
    { family: "F1", rule_version: "v1", rule: sum(80, 0.012), time_stop_only: sum(80, 0.004) },
  ],
  [
    "AU:F1:v1",
    "slip_one_tick",
    {
      family: "F1",
      rule_version: "v1",
      base: sum(80, 0.012),
      one_tick: sum(80, 0.009),
      stress_mean_net: 0.006,
    },
  ],
  [
    "AU:F1:v1",
    "stability",
    {
      family: "F1",
      rule_version: "v1",
      passes_absolute_gate: true,
      fragile: true,
      neighbours: [
        {
          key: "f1_secret_key_down",
          direction: "down",
          value: 4,
          n: 70,
          mean_net: 0.01,
          net_lower90: 0.002,
          passes_absolute_gate: true,
        },
        {
          key: "f1_secret_key_up",
          direction: "up",
          value: 6,
          n: 60,
          mean_net: -0.001,
          net_lower90: -0.01,
          passes_absolute_gate: false,
        },
      ],
    },
  ],
  [
    "AU:F1:secretrank",
    "rank_ic",
    {
      family: "F1",
      rank_variant: "secretrank",
      n_days: 400,
      median_ic: 0.031,
      mean_ic: 0.03,
      lower90: 0.01,
      upper90: 0.05,
    },
  ],
  [
    "AU:F1",
    "min_btl",
    {
      lineage: "AU:F1",
      trials: 45,
      target_sharpe: 1,
      min_years: 5,
      available_years: 3.2,
      label: "too short",
    },
  ],
  [
    "AU:F1",
    "error_budget",
    {
      lineage: "AU:F1",
      mode: "alpha_spending",
      tests_so_far: 3,
      next_level: 0.0059,
      lesson_pool: "open",
    },
  ],
];

export async function ensureM14(): Promise<void> {
  if (process.env.E2E_SCENARIO !== "rich") return;
  await ensureRich();
  const m = createClient({ url: process.env.TURSO_MAIN_URL! });
  try {
    const have = await m.execute({
      sql: "SELECT count(*) AS n FROM replay_stat WHERE run_id = ?",
      args: [RUN],
    });
    if (Number(have.rows[0].n) > 0) return;
    await m.batch(
      M14_ROWS.map(([scope, metric, value]) => ({
        sql: "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES (?, ?, ?, ?, ?)",
        args: [RUN, scope, metric, D, JSON.stringify(value)],
      })),
      "write",
    );
  } finally {
    m.close();
  }
}
