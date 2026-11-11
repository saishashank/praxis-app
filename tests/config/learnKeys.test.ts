// @vitest-environment node
// The learning Cortex's configuration keys (O-81; design C.9, D-929, D-940). Independent transcription of
// the C.9 table: a change to a default or a bound must change it here too. None is a Cortex refit key
// (an edit never refits the fixed Cortex's map), and the stages read them through loadLearnConfig.
import { afterAll, describe, expect, it } from "vitest";
import {
  CONFIG_KEYS,
  CONFIG_META,
  CORTEX_REFIT_KEYS,
  LEARN_KEY_NAMES,
  type ConfigKey,
  type ConfigKeyDef,
} from "@/lib/config/keys";
import { setConfig } from "@/lib/config/store";
import { LEARN_CONFIG, LEARN_CONFIG_SPEC } from "@/lib/cortex/learn/config";
import { loadLearnConfig } from "@/lib/cortex/learn/configStore";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterAll(cleanupTempDbs);

const NOW = "2026-11-11T00:00:00.000Z";

const get = async () => undefined;
const check = (key: ConfigKey, v: unknown) => CONFIG_KEYS[key].validate(v, get);

// [key, default, min, max, integer] — design C.9, row by row
const C9: ReadonlyArray<readonly [ConfigKey, number, number, number, boolean]> = [
  ["learn_window_sessions", 60, 40, 120, true],
  ["learn_null_sessions", 120, 60, 250, true],
  ["learn_shrink_n0", 60, 20, 200, true],
  ["learn_dev_haircut", 0.5, 0.3, 1, false],
  ["learn_max_step", 0.25, 0.1, 0.5, false],
  ["learn_weight_floor", 0.25, 0, 0.5, false],
  ["learn_band_pp", 2, 0, 5, false],
  ["learn_fdr_q", 0.1, 0.05, 0.2, false],
  ["learn_probe_q", 0.05, 0.01, 0.1, false],
  ["learn_ph_delta", 0.005, 0.001, 0.02, false],
  ["learn_ph_fa_pct", 99, 95, 99.9, false],
  ["learn_cap_sessions", 10, 5, 20, true],
  ["learn_actions_week_max", 3, 1, 6, true],
  ["learn_switch_alpha", 0.05, 0.01, 0.1, false],
  ["learn_fallback_alpha", 0.1, 0.05, 0.25, false],
  ["learn_switch_min_nights", 40, 20, 100, true],
  ["learn_cooldown_sessions", 20, 10, 60, true],
  ["learn_psi_break", 0.25, 0.1, 0.5, false],
  ["learner_off", 0, 0, 1, true],
];

describe("learning Cortex keys (C.9)", () => {
  it.each(C9)(
    "%s: default %f, bounds %f to %f, Owner-editable",
    async (key, def, min, max, int) => {
      const k = CONFIG_KEYS[key] as ConfigKeyDef;
      expect(k.default).toBe(def);
      expect(k.editable).toBe("O");
      expect(k.range).toEqual([min, max]);
      for (const v of [def, min, max]) expect(await check(key, v)).toBeNull();
      expect(await check(key, min - (int ? 1 : 0.001))).not.toBeNull();
      expect(await check(key, max + (int ? 1 : 0.001))).not.toBeNull();
      if (int) expect(await check(key, min + 0.5)).not.toBeNull();
      expect(CONFIG_META[key].label.length).toBeGreaterThan(5);
      expect(CONFIG_META[key].area).toBe("Learning and knowledge");
    },
  );

  it("the registry lists exactly the C.9 rows of LEARN_CONFIG_SPEC, none a refit key", () => {
    expect([...LEARN_KEY_NAMES].sort()).toEqual(C9.map((r) => r[0]).sort());
    const c9 = Object.values(LEARN_CONFIG_SPEC).filter((s) => s.source === "C.9");
    expect(c9.map((s) => s.key).sort()).toEqual([...LEARN_KEY_NAMES].sort());
    for (const s of c9) {
      const k = CONFIG_KEYS[s.key as ConfigKey] as ConfigKeyDef;
      expect([k.default, ...(k.range ?? [])]).toEqual([s.default, s.min, s.max]);
    }
    for (const k of LEARN_KEY_NAMES) expect(CORTEX_REFIT_KEYS).not.toContain(k);
  });

  it("loadLearnConfig reads the stored values; a missing key keeps its default", async () => {
    const db = await freshDb("main");
    expect(await loadLearnConfig(db)).toEqual(LEARN_CONFIG);
    await setConfig(db, { key: "learn_max_step", value: 0.4, userId: null, now: NOW });
    await setConfig(db, { key: "learner_off", value: 1, userId: null, now: NOW });
    const c = await loadLearnConfig(db);
    expect(c.maxStep).toBe(0.4);
    expect(c.learnerOff).toBe(1);
    expect(c.windowSessions).toBe(LEARN_CONFIG.windowSessions);
  });

  it("a stored value out of bounds or not a number keeps the default", async () => {
    const db = await freshDb("main");
    for (const [key, v] of [
      ["learn_max_step", 0.9],
      ["learn_window_sessions", "sixty"],
    ] as const) {
      await db.execute({
        sql: `INSERT INTO config_version (key, scope, value_json, changed_at) VALUES (?, 'global', ?, ?)`,
        args: [key, JSON.stringify(v), NOW],
      });
    }
    const c = await loadLearnConfig(db);
    expect(c.maxStep).toBe(LEARN_CONFIG.maxStep);
    expect(c.windowSessions).toBe(LEARN_CONFIG.windowSessions);
  });
});
