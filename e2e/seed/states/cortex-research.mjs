// State `cortex-research` (M23 M4, D-1643, D-1765; AT-72, AT-74): the research half of the Cortex page renders from stored rows.
// Three registry looks (Pass, Null, Inconclusive) each with its pre-registration of the same fingerprint, one refused second look,
// four meter rows (collecting with a projected date, a mover rule that reached its sample with no look, a mover rule waiting for
// a forward record, a live n meter), the eight risk monitors for the last quarter (monitor 7 in alarm) with the one-off
// calibration row and the lens revisit row, one night of industry-group returns and two model-written proposals (one kept, one
// refused). Every lineage is a real registry key shown through its plain name; the groups are synthetic ZZ names. The state
// changes no configuration, so `all` includes it. Idempotent: every insert is keyed or INSERT OR IGNORE.
import { createHash } from "node:crypto";
import { tradingDays } from "../data.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");

/** The looks: lineage, verdict, setups, blocks. */
export const LOOKS = [
  {
    lineage: "cxa003_lowvol",
    verdict: "PASS",
    n: 240,
    blocks: 12,
    name: "Lowest-volatility stocks",
  },
  {
    lineage: "cxa003_hi52_vol",
    verdict: "NULL",
    n: 310,
    blocks: 14,
    name: "New 52-week high on heavy volume",
  },
  {
    lineage: "cxa003_short_cover",
    verdict: "INCONCLUSIVE",
    n: 12,
    blocks: 2,
    name: "Falling short positions",
  },
];
export const GROUPS = ["ZZ Industrials", "ZZ Materials", "ZZ Utilities"];
export const QUARTER = "2026-Q3";

const monitorValues = {
  1: {
    flags: { matured: 10, hits: 6, hit_rate: 0.6 },
    entries: {
      smaller_n: 30,
      smaller_mean_ppm: 2000,
      large_n: 40,
      large_mean_ppm: 5000,
      diff_ppm: -3000,
      lower90_ppm: -9000,
      floor_per_group: 20,
    },
  },
  2: {
    simulated: 200,
    families: [{ family: "F1", n_eff: 60, mde: 0.02, false_pass: 0.04, true_pass: 0.71 }],
  },
  3: {
    alarm_ub: 0.7,
    families: [{ family: "F1", slope_ub90: 0.85, hidden: false, alarm: false }],
  },
  4: { held_through_unconfirmed: 2, closed_on_stop: 0 },
  5: {
    min_setups: 30,
    label: "one regime only",
    families: [
      {
        family: "F1",
        setups: 40,
        top_regime: "calm",
        top_share: 0.95,
        regimes: [{ regime: "calm", setups: 38 }],
        one_regime_only: true,
      },
    ],
  },
  6: {
    option: "abstain when the evidence disagrees by more than the set share",
    reason: "a mixed picture is not a tested edge",
    disagreement_max: 0.4,
    g10_vetoed: 3,
    g10_abstain_nights: 1,
    revisit: false,
  },
  7: {
    alarm_pp: 5,
    min_cohorts: 20,
    families: [
      {
        family: "F1",
        cohorts: 40,
        stalled: 16,
        realised_rate: 0.4,
        expected_rate: 0.3,
        expected_cohorts: 40,
        expected_source: "calibration",
        alarm: true,
      },
    ],
  },
  8: {
    alarm_pp: 5,
    min_setups: 30,
    families: [
      {
        family: "F1",
        scored: 50,
        unfilled: 5,
        unfilled_share: 0.1,
        previous_scored: 50,
        previous_share: 0.08,
        alarm: false,
      },
    ],
  },
};

/** @param {import("@libsql/client").Client} client @param {string} nowIso */
export async function apply(client, nowIso) {
  const [d] = tradingDays(nowIso, 1);
  /** @type {{ sql: string, args: (string | number | null)[] }[]} */
  const stmts = [];
  for (const l of LOOKS) {
    const frozen = JSON.stringify({ lineage: l.lineage, plan: "zz e2e fixture" });
    const s = sha(frozen);
    stmts.push({
      sql: `INSERT OR IGNORE INTO research_prereg (lineage, market, item, frozen_json, sha, created_at)
            VALUES (?, 'AU', 'CXA-003', ?, ?, ?)`,
      args: [l.lineage, frozen, s, nowIso],
    });
    stmts.push({
      sql: `INSERT OR IGNORE INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict)
            VALUES (?, 'AU', ?, ?, ?)`,
      args: [l.lineage, nowIso, s, l.verdict],
    });
    stmts.push({
      sql: `INSERT OR IGNORE INTO research_result (lineage, market, looked_at, prereg_sha, n_setups, n_blocks, stats_json)
            VALUES (?, 'AU', ?, ?, ?, ?, '{}')`,
      args: [l.lineage, nowIso, s, l.n, l.blocks],
    });
  }
  stmts.push({
    sql: `INSERT OR IGNORE INTO holdout_look_refusal (lineage, market, at, prereg_sha, caller)
          VALUES ('cxa003_lowvol', 'AU', ?, ?, 'zz-e2e')`,
    args: [nowIso, sha(JSON.stringify({ lineage: "cxa003_lowvol", plan: "zz e2e fixture" }))],
  });
  const meter = (lineage, n, target, projected, status) => ({
    sql: `INSERT OR IGNORE INTO research_meter (market, lineage, d, n, target, projected_d, status, created_at)
          VALUES ('AU', ?, ?, ?, ?, ?, ?, ?)`,
    args: [lineage, d, n, target, projected, status, nowIso],
  });
  stmts.push(
    meter("ann_angles", 14, 252, d, "collecting"),
    meter("movers_a1", 40, 40, null, "met"),
    meter("movers_a2", 0, 60, null, "blocked"),
    meter("neff_live_F1", 12, 150, null, "collecting"),
  );
  for (const [m, value] of Object.entries(monitorValues)) {
    const alarm = m === "7" ? 1 : 0;
    stmts.push({
      sql: `INSERT OR IGNORE INTO residual_monitor (market, monitor, period, value_json, alarm, created_at)
            VALUES ('AU', ?, ?, ?, ?, ?)`,
      args: [Number(m), m === "2" ? `cal-${d}` : QUARTER, JSON.stringify(value), alarm, nowIso],
    });
  }
  stmts.push({
    sql: `INSERT OR IGNORE INTO residual_monitor (market, monitor, period, value_json, alarm, created_at)
          VALUES ('AU', 6, 'cal-lens-revisit', ?, 1, ?)`,
    args: [JSON.stringify({ ...monitorValues[6], revisit: true }), nowIso],
  });
  GROUPS.forEach((g, i) => {
    stmts.push({
      sql: `INSERT OR IGNORE INTO sector_index (market, d, group_code, weighting, ret_ppm, level_ppm, n_members, map_as_of, created_at)
            VALUES ('AU', ?, ?, 'equal', ?, ?, ?, ?, ?)`,
      args: [d, g, (i - 1) * 4000, 1_000_000 + (i - 1) * 4000, 10 + i, d, nowIso],
    });
  });
  stmts.push({
    sql: `INSERT OR IGNORE INTO angle_proposal (proposal_id, market, month, kind, state, rule_json, orientation, cluster, evidence_json, model_id, created_at)
          VALUES (?, 'AU', ?, 'angle', 'stored', '{"name":"zz","rule":{}}', 'long', 'zz', '[]', 'zz-model', ?)`,
    args: ["a".repeat(64), d.slice(0, 7), nowIso],
  });
  stmts.push({
    sql: `INSERT OR IGNORE INTO angle_proposal (proposal_id, market, month, kind, state, created_at)
          VALUES (?, 'AU', ?, 'angle', 'refused_schema', ?)`,
    args: ["b".repeat(64), d.slice(0, 7), nowIso],
  });
  await client.batch(stmts, "write");
}
