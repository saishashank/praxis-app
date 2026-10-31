// @vitest-environment node
// M11-lite configuration keys (WP1; docs/M11L_design.md, D-480 to D-498). Independent transcription:
// a change to a default or a bound in keys.ts must change it here too.
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, M11L_KEY_NAMES, type ConfigKey, type ConfigKeyDef } from "@/lib/config/keys";

const get = async () => undefined;
const check = (key: ConfigKey, v: unknown) => CONFIG_KEYS[key].validate(v, get);

// [key, default, min, max]
const RANGED: ReadonlyArray<readonly [ConfigKey, number, number, number]> = [
  ["llm_budget_r6_steelman_daily", 20000, 0, 40000],
  ["evidence_pack_max_items", 25, 10, 40],
  ["steelman_daily_cards", 8, 0, 20],
  ["steelman_suggestion_expiry_sessions", 10, 5, 30],
  // re-based by M11-lite (D-481)
  ["llm_daily_budget_total", 240000, 150000, 300000],
];

describe("M11-lite keys", () => {
  it.each(RANGED)("%s: default %f, bounds %f to %f, Owner-editable", async (key, def, min, max) => {
    const k = CONFIG_KEYS[key] as ConfigKeyDef;
    expect(k.default).toBe(def);
    expect(k.editable).toBe("O");
    for (const v of [def, min, max]) expect(await check(key, v)).toBeNull();
    expect(await check(key, min - 1)).not.toBeNull();
    expect(await check(key, max + 1)).not.toBeNull();
    expect(await check(key, min + 0.5)).not.toBeNull();
    expect(await check(key, "1")).not.toBeNull();
  });

  it("pick_reflection_enabled is an on/off switch, on by default", async () => {
    expect(CONFIG_KEYS.pick_reflection_enabled.default).toBe("on");
    expect(await check("pick_reflection_enabled", "off")).toBeNull();
    expect(await check("pick_reflection_enabled", "maybe")).not.toBeNull();
  });

  it("the total covers the role caps with room to spare (D-481)", () => {
    const roles = [
      "llm_budget_r1_daily",
      "llm_budget_r2_daily",
      "llm_budget_r3_daily",
      "llm_budget_r5_daily",
      "llm_budget_r6_steelman_daily",
    ] as const;
    const sum = roles.reduce((a, k) => a + (CONFIG_KEYS[k].default as number), 0);
    expect(sum).toBeLessThanOrEqual(CONFIG_KEYS.llm_daily_budget_total.default as number);
  });

  it("M11L_KEY_NAMES lists every new key once and all are registered", () => {
    expect(new Set(M11L_KEY_NAMES).size).toBe(M11L_KEY_NAMES.length);
    for (const k of M11L_KEY_NAMES) expect(CONFIG_KEYS[k]).toBeDefined();
    expect(M11L_KEY_NAMES).toHaveLength(5);
  });
});
