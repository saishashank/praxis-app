// @vitest-environment node
// Movers gap additions: configuration keys (CR-MOV-A1…A8, D-740…D-759). Independent transcription: a
// change to a default or a bound in keys.ts must change it here too. None is a Cortex refit key (D-752).
import { describe, expect, it } from "vitest";
import {
  CONFIG_KEYS,
  CONFIG_META,
  CORTEX_REFIT_KEYS,
  MOVERS_KEY_NAMES,
  type ConfigKey,
  type ConfigKeyDef,
} from "@/lib/config/keys";

const get = async () => undefined;
const check = (key: ConfigKey, v: unknown) => CONFIG_KEYS[key].validate(v, get);

// [key, default, min, max, integer]
const RANGED: ReadonlyArray<readonly [ConfigKey, number, number, number, boolean]> = [
  ["halt_resume_arm_minute", 600, 570, 720, true],
  ["halt_resume_block_sessions", 1, 0, 5, true],
  ["halt_watch_expiry_sessions", 5, 2, 20, true],
  ["results_window_start_day", 1, 1, 15, true],
  ["results_window_end_day", 31, 16, 31, true],
  ["results_pre_window_sessions", 2, 0, 10, true],
  ["known_date_min_history_days", 365, 330, 730, true],
  ["volume_creep_vr_min", 3, 2, 6, false],
  ["volume_creep_ar_min_pct", 2, 1, 6, false],
  ["intraday_arm_codes_max", 20, 0, 60, true],
  ["short_risk_pct_min", 5, 3, 12, false],
  ["short_risk_change_pp_min", 2, 1, 6, false],
  ["short_risk_f4_veto", 0, 0, 1, true],
  ["sector_composite_min_members", 5, 3, 30, true],
];

describe("movers gap keys", () => {
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

  it("every key has a label and bounds text and the registry lists each once", () => {
    expect(new Set(MOVERS_KEY_NAMES).size).toBe(MOVERS_KEY_NAMES.length);
    expect([...MOVERS_KEY_NAMES].sort()).toEqual(RANGED.map((r) => r[0]).sort());
    for (const [key] of RANGED) {
      expect(CONFIG_META[key].label.length).toBeGreaterThan(5);
      expect(CONFIG_META[key].bounds.length).toBeGreaterThan(0);
    }
  });

  it("none is a Cortex refit key: an edit is not a charged trial (D-752)", () => {
    for (const k of MOVERS_KEY_NAMES) expect(CORTEX_REFIT_KEYS).not.toContain(k);
  });
});
