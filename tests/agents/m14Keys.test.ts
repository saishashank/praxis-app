// @vitest-environment node
// M14 configuration keys (WP0; docs/M14_design.md 2.7, D-213 to D-252). The expected table is an
// independent transcription of the design table: a change to a default or a bound in keys.ts must
// change it here too. Also pins that the new typed parameters resolve to the registry defaults and
// that the structural rule-schema switches reproduce v1.
import { describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import {
  checkStructuralParams,
  FAMILY_OPTIONAL_KEYS,
  FAMILY_PARAM_KEYS,
  FAMILY_SPECS,
  validateRuleSpec,
} from "@/lib/agents/families/ruleSchema";
import { CONFIG_KEYS, M14_KEY_NAMES, type ConfigKey, type ConfigKeyDef } from "@/lib/config/keys";

const get = async () => undefined;
const check = (key: ConfigKey, v: unknown) => CONFIG_KEYS[key].validate(v, get);

// [key, default, min, max, edit]
const RANGED: ReadonlyArray<readonly [ConfigKey, number, number, number, "O" | "B"]> = [
  ["max_stop_distance_pct", 12, 6, 20, "O"],
  ["cost_gate_k", 2, 1.5, 3, "O"],
  ["second_position_max_corr", 0.6, 0.3, 0.9, "O"],
  ["val_fwer_per_lineage", 0.05, 0.01, 0.1, "O"],
  ["l2_alpha_spend_fraction", 0.1, 0.05, 0.25, "O"],
  ["dedup_minhash_threshold", 0.85, 0.7, 0.95, "O"],
  ["f1_return_window_sessions", 126, 126, 252, "B"],
];

const FIXED: ReadonlyArray<readonly [ConfigKey, number | string]> = [
  ["cost_gate_min_rows", 30],
  ["second_position_corr_sessions", 60],
  ["l2_alpha_exhausted_level", 0.005],
  ["minbtl_target_sharpe", 1],
  ["rank_ic_min_codes", 10],
  ["rank_ic_bootstrap_replicates", 2000],
  ["rank_ic_bootstrap_blocks", "monthly"],
  ["dedup_window_sessions", 5],
  ["index_change_window_sessions", 1],
];

// [key, default, allowed, edit]
const ENUMS: ReadonlyArray<readonly [ConfigKey, string, readonly string[], "O" | "B"]> = [
  ["val_error_budget_mode", "alpha_spending", ["fixed", "alpha_spending"], "O"],
  ["settlement_stats_mode", "conservative", ["conservative", "matched"], "O"],
  ["f5_default_universe", "U2", ["U1", "U2", "U3"], "O"],
  ["f1_momentum_variant", "v1", ["v1", "skip_month_u2"], "B"],
  ["f1_rank_variant", "v1", ["v1", "composite3", "vol_scaled"], "B"],
  ["f4_rank_variant", "v1", ["v1", "composite3", "vol_scaled"], "B"],
  ["f4_entry_variant", "v1", ["v1", "reversal5_u2"], "B"],
  ["f3_surprise_mode", "category", ["category", "day0_ar"], "B"],
];

describe("M14 keys", () => {
  it.each(RANGED)(
    "%s: default %f, bounds %f to %f, edit class %s",
    async (key, def, min, max, ed) => {
      const k = CONFIG_KEYS[key] as ConfigKeyDef;
      expect(k.default).toBe(def);
      expect(k.editable).toBe(ed);
      expect(k.range).toEqual([min, max]);
      expect(await check(key, def)).toBeNull();
      expect(await check(key, min)).toBeNull();
      expect(await check(key, max)).toBeNull();
      expect(await check(key, min - 0.001)).not.toBeNull();
      expect(await check(key, max + 0.001)).not.toBeNull();
      expect(await check(key, "1")).not.toBeNull();
    },
  );

  it.each(FIXED)("%s is fixed at %s and refuses every edit", async (key, def) => {
    const k = CONFIG_KEYS[key];
    expect(k.default).toBe(def);
    expect(k.editable).toBe("fixed");
    expect(await check(key, def)).not.toBeNull();
  });

  it.each(ENUMS)("%s: default %s, only the listed words", async (key, def, allowed, ed) => {
    const k = CONFIG_KEYS[key];
    expect(k.default).toBe(def);
    expect(k.editable).toBe(ed);
    for (const w of allowed) expect(await check(key, w)).toBeNull();
    expect(await check(key, "other")).not.toBeNull();
    expect(await check(key, "Fixed")).not.toBeNull(); // exact, case-sensitive
    expect(await check(key, 1)).not.toBeNull();
  });

  it("bh_fdr is refused with its reason (D-227)", async () => {
    expect(await check("val_error_budget_mode", "bh_fdr")).toMatch(/not available in V2/);
  });

  it("f3_time_exit now reaches 60 (KB-081), the default stays 20", async () => {
    expect((CONFIG_KEYS.f3_time_exit as ConfigKeyDef).range).toEqual([10, 60]);
    expect(CONFIG_KEYS.f3_time_exit.default).toBe(20);
    expect(await check("f3_time_exit", 60)).toBeNull();
    expect(await check("f3_time_exit", 61)).not.toBeNull();
  });

  it("insider_score_weights takes an optional director_sale (AGT-136)", async () => {
    const base = { director_net: 0.5, holder_new_or_increase: 0.25, holder_decrease: 0.25 };
    expect(await check("insider_score_weights", base)).toBeNull();
    expect(await check("insider_score_weights", { ...base, director_sale: 0.25 })).toBeNull();
    expect(await check("insider_score_weights", { ...base, director_sale: 2 })).not.toBeNull();
    expect(await check("insider_score_weights", { ...base, other: 1 })).not.toBeNull();
  });

  it("M14_KEY_NAMES lists 7 ranged + 9 fixed + 8 enum keys, all registered, none repeated", () => {
    expect(M14_KEY_NAMES).toHaveLength(RANGED.length + FIXED.length + ENUMS.length);
    expect(new Set(M14_KEY_NAMES).size).toBe(M14_KEY_NAMES.length);
    for (const k of M14_KEY_NAMES) expect(CONFIG_KEYS[k], k).toBeDefined();
  });
});

describe("M14 typed parameters at their defaults", () => {
  it("resolve from the registry (v1 behaviour for the structural switches)", () => {
    const p = defaultAgentParams();
    expect(p.entry).toMatchObject({
      costGateMinRows: 30,
      secondPositionMaxCorr: 0.6,
      secondPositionCorrSessions: 60,
      dedupWindowSessions: 5,
      dedupMinhashThreshold: 0.85,
      indexChangeWindowSessions: 1,
    });
    expect(p.entry.maxStopDistance).toEqual({ num: 3n, den: 25n }); // 12 %
    expect(p.entry.costGateK).toEqual({ num: 2n, den: 1n });
    expect([p.f1.returnWindowSessions, p.f1.momentumVariant, p.f1.rankVariant]).toEqual([
      126,
      "v1",
      "v1",
    ]);
    expect(p.f3.surpriseMode).toBe("category");
    expect([p.f4.entryVariant, p.f4.rankVariant]).toEqual(["v1", "v1"]);
    expect(p.f5.defaultUniverse).toBe("U2");
    // an absent director_sale follows director_net, as in v1
    expect(p.insiderWeights.directorSale).toEqual(p.insiderWeights.directorNet);
    expect(p.stats).toMatchObject({
      valErrorBudgetMode: "alpha_spending",
      valFwerPerLineage: 0.05,
      settlementStatsMode: "conservative",
      minbtlTargetSharpe: 1,
      rankIcMinCodes: 10,
      rankIcBootstrapReplicates: 2000,
      rankIcBootstrapBlocks: "monthly",
    });
    expect(p.learning).toMatchObject({ l2AlphaSpendFraction: 0.1, l2AlphaExhaustedLevel: 0.005 });
  });
});

describe("rule schema: optional structural switches", () => {
  const defaults = (f: "F1" | "F3" | "F4"): Record<string, unknown> =>
    Object.fromEntries(
      FAMILY_PARAM_KEYS[f].map((k) => [
        k,
        (CONFIG_KEYS as Record<string, ConfigKeyDef>)[k].default,
      ]),
    );

  it("the required key set is unchanged (the stored v1 rows stay valid)", () => {
    for (const f of ["F1", "F3", "F4"] as const) {
      expect(FAMILY_PARAM_KEYS[f]).toEqual(FAMILY_SPECS[f].params);
      expect(
        FAMILY_PARAM_KEYS[f].some((k) => FAMILY_OPTIONAL_KEYS[f].some((s) => s.key === k)),
      ).toBe(false);
    }
  });

  it("an absent switch is the default; a present one is checked", () => {
    expect(validateRuleSpec(FAMILY_SPECS.F1, defaults("F1"))).toEqual([]);
    expect(
      validateRuleSpec(FAMILY_SPECS.F1, {
        ...defaults("F1"),
        f1_rank_variant: "composite3",
        f1_return_window_sessions: 252,
      }),
    ).toEqual([]);
    expect(
      validateRuleSpec(FAMILY_SPECS.F1, { ...defaults("F1"), f1_rank_variant: "best" }).join(),
    ).toContain("f1_rank_variant must be one of");
    expect(
      validateRuleSpec(FAMILY_SPECS.F1, {
        ...defaults("F1"),
        f1_return_window_sessions: 253,
      }).join(),
    ).toContain("f1_return_window_sessions must be a whole number");
    expect(checkStructuralParams("F4", { f4_entry_variant: "reversal5_u2" })).toEqual([]);
    expect(checkStructuralParams("F3", { f3_surprise_mode: "day0_ar" })).toEqual([]);
  });
});
