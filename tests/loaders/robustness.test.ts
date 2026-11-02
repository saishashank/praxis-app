// @vitest-environment node
// M14 WP8 (D-251, AT-02, O-54): the Robustness loader of one strategy. Seeded `replay_stat` rows in
// the shapes of src/lib/stats/robustnessTypes.ts. Empty state, populated state, role matrix and
// masking (no execution id, family, rule version, setting or ranking name for a masked viewer).
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { loadRobustness, ROBUSTNESS_LABEL } from "@/lib/ui/loaders/robustness";
import { emptyWorld, NOW, type Who, type World } from "./world";

afterAll(cleanupTempDbs);

const EX = "E01";
const summary = (n: number, mean: number | null) => ({
  n,
  mean_net: mean,
  median_net: mean,
  hit_rate: 0.55,
  mean_sessions_held: 4.5,
});

async function world(rows: Record<string, Array<[string, unknown]>> = {}): Promise<World> {
  const w = await emptyWorld();
  await w.main.execute(
    "INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile) VALUES ('E01','AU','E','F1','U','v1','P5')",
  );
  let run = 0;
  for (const [metric, list] of Object.entries(rows)) {
    for (const [scope, value] of list) {
      run += 1;
      await w.main.execute({
        sql: "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES (?, ?, ?, '2026-10-17', ?)",
        args: [`r${run}`, scope, metric, JSON.stringify(value)],
      });
    }
  }
  return w;
}
const deps = (w: World, who: Who) => ({
  mainDb: w.main,
  authDb: w.auth,
  user: { id: w.ids[who], role: who === "granted" ? "viewer" : who },
  now: NOW,
});

const FULL = {
  exit_ablation: [
    [
      "AU:F1:v1",
      {
        family: "F1",
        rule_version: "v1",
        rule: summary(80, 0.012),
        time_stop_only: summary(80, 0.004),
      },
    ],
  ],
  slip_one_tick: [
    [
      "AU:F1:v1",
      {
        family: "F1",
        rule_version: "v1",
        base: summary(80, 0.012),
        one_tick: summary(80, 0.009),
        stress_mean_net: 0.006,
      },
    ],
  ],
  stability: [
    [
      "AU:F1:v1",
      {
        family: "F1",
        rule_version: "v1",
        passes_absolute_gate: true,
        fragile: true,
        neighbours: [
          {
            key: "f1_stop_pct",
            direction: "down",
            value: 4,
            n: 70,
            mean_net: 0.01,
            net_lower90: 0.002,
            passes_absolute_gate: true,
          },
          {
            key: "f1_stop_pct",
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
  ],
  rank_ic: [
    [
      "AU:F1:default",
      {
        family: "F1",
        rank_variant: "default",
        n_days: 400,
        median_ic: 0.031,
        mean_ic: 0.03,
        lower90: 0.01,
        upper90: 0.05,
      },
    ],
    [
      "AU:F2:default",
      {
        family: "F2",
        rank_variant: "default",
        n_days: 10,
        median_ic: 0.5,
        mean_ic: 0.5,
        lower90: 0.1,
        upper90: 0.9,
      },
    ],
  ],
  min_btl: [
    [
      "AU:F1",
      {
        lineage: "AU:F1",
        trials: 45,
        target_sharpe: 1,
        min_years: 5,
        available_years: 3.2,
        label: "too short",
      },
    ],
  ],
  error_budget: [
    [
      "AU:F1",
      {
        lineage: "AU:F1",
        mode: "alpha_spending",
        tests_so_far: 3,
        next_level: 0.0059,
        lesson_pool: "open",
      },
    ],
  ],
} as Record<string, Array<[string, unknown]>>;

describe("loadRobustness", () => {
  it("is empty and measured=false before any row is stored", async () => {
    const w = await world();
    const v = await loadRobustness(deps(w, "owner"), EX);
    expect(v).toMatchObject({
      visible: true,
      measured: false,
      exitAblation: null,
      rankQuality: [],
    });
    expect(v.label).toBe(ROBUSTNESS_LABEL);
    expect(v.label).toBe("descriptive — not a finding");
  });

  it("an unknown execution gives an empty visible model", async () => {
    const w = await world(FULL);
    expect((await loadRobustness(deps(w, "owner"), "E99")).measured).toBe(false);
  });

  it("shows every stored metric to the Owner, with names", async () => {
    const w = await world(FULL);
    const v = await loadRobustness(deps(w, "owner"), EX);
    expect(v.measured).toBe(true);
    expect(v.ruleVersion).toBe("v1");
    expect(v.exitAblation?.rule.mean_net).toBe(0.012);
    expect(v.exitAblation?.timeStopOnly.mean_net).toBe(0.004);
    expect(v.slip).toMatchObject({ stressMeanNet: 0.006 });
    expect(v.slip?.oneTick.mean_net).toBe(0.009);
    expect(v.stability?.fragile).toBe(true);
    expect(v.stability?.neighbours.map((n) => n.setting)).toEqual(["f1_stop_pct", "f1_stop_pct"]);
    expect(v.rankQuality).toEqual([
      { ranking: "default", nDays: 400, medianIc: 0.031, lower90: 0.01, upper90: 0.05 },
    ]); // only this strategy's family
    expect(v.minBtl).toMatchObject({ label: "too short", minYears: 5, trials: 45 });
    expect(v.errorBudget).toMatchObject({ mode: "alpha_spending", nextLevel: 0.0059 });
  });

  it("masks for the Editor: same figures, no execution id, family, version or setting name", async () => {
    const w = await world(FULL);
    const v = await loadRobustness(deps(w, "editor"), EX);
    expect(v.measured).toBe(true);
    expect(v.exitAblation?.rule.n).toBe(80);
    expect(v.ruleVersion).toBeNull();
    expect(v.stability?.neighbours.map((n) => n.setting)).toEqual(["Setting 1", "Setting 2"]);
    expect(v.rankQuality[0]?.ranking).toBe("Ranking 1");
    const text = JSON.stringify(v);
    for (const leak of [EX, "F1", "v1", "f1_stop_pct", "default", "AU:"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("shows nothing and reads nothing for a Viewer, a granted Viewer or no user", async () => {
    const w = await world(FULL);
    for (const who of ["viewer", "granted"] as const) {
      const v = await loadRobustness(deps(w, who), EX);
      expect(v).toMatchObject({ visible: false, measured: false, exitAblation: null });
    }
    const anon = await loadRobustness({ ...deps(w, "owner"), user: null }, EX);
    expect(anon.visible).toBe(false);
  });

  it("takes the newest row of a scope and ignores malformed JSON shapes", async () => {
    const w = await world({
      exit_ablation: [["AU:F1:v1", { rule: summary(5, 0.01), time_stop_only: summary(5, 0.0) }]],
      slip_one_tick: [["AU:F1:v1", { base: "bad" }]],
      stability: [["AU:F1:v1", { neighbours: "bad" }]],
      min_btl: [["AU:F1", { trials: 3 }]],
    });
    await w.main.execute({
      sql: "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES ('rz', 'AU:F1:v1', 'exit_ablation', '2026-10-24', ?)",
      args: [JSON.stringify({ rule: summary(9, 0.02), time_stop_only: summary(9, 0.01) })],
    });
    const v = await loadRobustness(deps(w, "owner"), EX);
    expect(v.exitAblation?.rule.n).toBe(9); // the newer date wins
    expect(v.slip).toBeNull();
    expect(v.stability).toBeNull();
    expect(v.minBtl).toBeNull();
  });
});
