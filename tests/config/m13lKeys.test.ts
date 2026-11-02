// @vitest-environment node
// M13-lite configuration keys (WP1; docs/M13L_design.md, D-528). Independent transcription: a change to a
// default or a bound in keys.ts must change it here too. The four polling and extraction keys the design
// defers (D-510) must stay absent.
import { describe, expect, it } from "vitest";
import { buildAgentParams } from "@/lib/agents/params";
import {
  CONFIG_KEYS,
  CONFIG_META,
  M13L_KEY_NAMES,
  type ConfigKey,
  type ConfigKeyDef,
} from "@/lib/config/keys";

const get = async () => undefined;
const check = (key: ConfigKey, v: unknown) => CONFIG_KEYS[key].validate(v, get);

// [key, default, min, max, integer]
const RANGED: ReadonlyArray<readonly [ConfigKey, number, number, number, boolean]> = [
  ["expert_min_scored", 10, 5, 50, true],
  ["expert_screen_fdr", 0.1, 0.05, 0.2, false],
  ["expert_challengers_per_week", 2, 0, 4, true],
  ["f7_min_clusters", 3, 2, 10, true],
];

describe("M13-lite keys", () => {
  it.each(RANGED)(
    "%s: default %f, bounds %f to %f, Owner-editable",
    async (key, def, min, max, int) => {
      const k = CONFIG_KEYS[key] as ConfigKeyDef;
      expect(k.default).toBe(def);
      expect(k.editable).toBe("O");
      expect(k.range).toEqual([min, max]);
      for (const v of [def, min, max]) expect(await check(key, v)).toBeNull();
      expect(await check(key, min - (int ? 1 : 0.01))).not.toBeNull();
      expect(await check(key, max + (int ? 1 : 0.01))).not.toBeNull();
      if (int) expect(await check(key, min + 0.5)).not.toBeNull();
      expect(await check(key, String(def))).not.toBeNull();
    },
  );

  it("all four sit in the Learning and knowledge area with a label and bounds text", () => {
    for (const [key] of RANGED) {
      const m = CONFIG_META[key];
      expect(m.area).toBe("Learning and knowledge");
      expect(m.label.length).toBeGreaterThan(5);
      expect(m.bounds.length).toBeGreaterThan(0);
    }
  });

  it("M13L_KEY_NAMES lists every new key once and all are registered", () => {
    expect(new Set(M13L_KEY_NAMES).size).toBe(M13L_KEY_NAMES.length);
    expect([...M13L_KEY_NAMES].sort()).toEqual(RANGED.map((r) => r[0]).sort());
    for (const k of M13L_KEY_NAMES) expect(CONFIG_KEYS[k]).toBeDefined();
  });

  it("the deferred polling and extraction keys are not registered (D-510)", () => {
    const names = Object.keys(CONFIG_KEYS);
    expect(names.filter((k) => /^expert_(poll|extract|discover)/.test(k))).toEqual([]);
    expect(names.filter((k) => /^llm_budget_r7/.test(k))).toEqual([]);
  });

  it("buildAgentParams reads the four into LearningParams", () => {
    const p = buildAgentParams((k) => CONFIG_KEYS[k].default as never);
    expect(p.learning).toMatchObject({
      expertMinScored: 10,
      expertScreenFdr: 0.1,
      expertChallengersPerWeek: 2,
      f7MinClusters: 3,
    });
  });
});
