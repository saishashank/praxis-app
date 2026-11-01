// @vitest-environment node
// M15 configuration keys (P1; docs/M15_requirements.md "Configuration keys", D-257 to D-306). The
// expected table is an independent transcription of the requirements table: a change to a default or
// a bound in keys.ts must change it here too. Also pins the fixed pair and the refit key set.
import { describe, expect, it } from "vitest";
import {
  CONFIG_KEYS,
  CORTEX_REFIT_KEYS,
  M15_KEY_NAMES,
  type ConfigKey,
  type ConfigKeyDef,
} from "@/lib/config/keys";

const get = async () => undefined;
const check = (key: ConfigKey, v: unknown) => CONFIG_KEYS[key].validate(v, get);

// [key, default, min, max, kind]
const RANGED: ReadonlyArray<readonly [ConfigKey, number, number, number, "int" | "num"]> = [
  ["cell_min_setups", 60, 30, 200, "int"],
  ["cell_min_blocks", 20, 6, 60, "int"],
  ["cortex_min_neff_trade", 200, 150, 400, "int"],
  ["rank_shrink_n0", 60, 20, 200, "int"],
  ["max_loss_pct", 18, 12, 25, "num"],
  ["entry_gap_cap_pct", 8, 4, 12, "num"],
  ["cortex_disagreement_max", 0.4, 0.25, 0.6, "num"],
  ["cluster_weight_max", 0.35, 0.2, 0.35, "num"],
  ["sector_tilt_margin_pp", 5, 0, 15, "num"],
  ["max_books_same_code", 2, 1, 3, "int"],
  ["max_books_same_industry", 3, 2, 6, "int"],
  ["max_code_nav_share", 0.2, 0.1, 0.35, "num"],
  ["max_industry_nav_share", 0.35, 0.2, 0.5, "num"],
  ["freeze_max_loss_pct", 25, 15, 40, "num"],
  ["unresolved_freeze_sessions", 5, 2, 10, "int"],
  ["persist_volume_mult", 2, 1, 5, "num"],
  ["pump_volume_mult", 4, 3, 6, "num"],
  ["pump_ar_pct", 8, 5, 12, "num"],
  ["promotion_flag_sessions", 20, 10, 40, "int"],
  ["abstain_alarm_sessions", 40, 20, 120, "int"],
  ["stale_universe_max_share", 0.1, 0.02, 0.25, "num"],
  ["opinion_min_n", 150, 100, 500, "int"],
  ["ledger_fdr_q", 0.1, 0.05, 0.2, "num"],
  ["bootstrap_block_sessions", 120, 60, 250, "int"],
  ["cortex_slope_hide_ub", 1, 0.5, 1, "num"],
  ["cortex_stage_minutes", 15, 5, 60, "int"],
];

describe("M15 keys", () => {
  it.each(RANGED)(
    "%s: default %f, bounds %f to %f, Owner-editable",
    async (key, def, min, max, kind) => {
      const k = CONFIG_KEYS[key] as ConfigKeyDef;
      expect(k.default).toBe(def);
      expect(k.editable).toBe("O");
      expect(k.range).toEqual([min, max]);
      expect(await check(key, def)).toBeNull();
      expect(await check(key, min)).toBeNull();
      expect(await check(key, max)).toBeNull();
      const eps = kind === "int" ? 1 : 0.001;
      expect(await check(key, min - eps)).not.toBeNull();
      expect(await check(key, max + eps)).not.toBeNull();
      expect(await check(key, "1")).not.toBeNull();
      if (kind === "int") expect(await check(key, min + 0.5)).not.toBeNull();
    },
  );

  it("survivorship_haircut_pp is fixed at 1.5 and refuses every edit", async () => {
    const k = CONFIG_KEYS.survivorship_haircut_pp;
    expect(k.default).toBe(1.5);
    expect(k.editable).toBe("fixed");
    expect(await check("survivorship_haircut_pp", 1.5)).not.toBeNull();
    expect(await check("survivorship_haircut_pp", 2)).not.toBeNull();
  });

  it("suspension_mark_policy is fixed and refuses every edit (D-272)", async () => {
    const k = CONFIG_KEYS.suspension_mark_policy;
    expect(k.editable).toBe("fixed");
    expect(k.default).toBe("100% x5, -10pts per 5, floor 50%");
    expect(await check("suspension_mark_policy", "anything")).not.toBeNull();
  });

  it("the key list is the requirements table plus the two design keys, with cost_gate_k reused", () => {
    expect([...M15_KEY_NAMES].sort()).toEqual(
      [...RANGED.map((r) => r[0]), "survivorship_haircut_pp", "suspension_mark_policy"].sort(),
    );
    expect(M15_KEY_NAMES).not.toContain("cost_gate_k");
    expect(CONFIG_KEYS.cost_gate_k.default).toBe(2);
  });

  it("every editable M15 key refits the map when edited; the fixed pair does not (CTX-072)", () => {
    expect([...CORTEX_REFIT_KEYS].sort()).toEqual(RANGED.map((r) => r[0]).sort());
    expect(CORTEX_REFIT_KEYS).not.toContain("survivorship_haircut_pp");
  });
});
