// @vitest-environment node
// M23 A1 (D-1612, D-1650; ch. 15 §15.11.4): the five fixed keys, as an independent transcription. A change to a default or
// a bound in keys.ts must change it here too. A fresh database reads every default; no key can be edited by the Owner.
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_KEYS,
  CONFIG_META,
  M23_KEY_NAMES,
  type ConfigKey,
  type ConfigKeyDef,
} from "@/lib/config/keys";
import { getConfig } from "@/lib/config/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const get = async () => undefined;
const check = (key: ConfigKey, v: unknown) => CONFIG_KEYS[key].validate(v, get);

const NAMES = [
  "sector_index_weighting",
  "survivorship_loss_assumed_pct",
  "label_golden_min",
  "residual_monitor_alarm_pp",
  "holdout_looks_max",
] as const;

// [key, default, min, max]
const NUMBERS: ReadonlyArray<readonly [ConfigKey, number, number, number]> = [
  ["survivorship_loss_assumed_pct", 50, 30, 80],
  ["label_golden_min", 500, 100, 2000],
  ["residual_monitor_alarm_pp", 5, 1, 20],
  ["holdout_looks_max", 1, 1, 1],
];

describe("M23 keys", () => {
  it("M23_KEY_NAMES lists the five keys once; all are registered with plain-words labels", () => {
    expect([...M23_KEY_NAMES].sort()).toEqual([...NAMES].sort());
    expect(M23_KEY_NAMES).toHaveLength(5);
    expect(new Set(M23_KEY_NAMES).size).toBe(5);
    for (const k of M23_KEY_NAMES) {
      expect(CONFIG_META[k].label.length, k).toBeGreaterThan(8);
      // D-922: no internal code and no key name in an Owner-read label or bounds text
      expect(CONFIG_META[k].label, k).not.toMatch(/\b(AGT|CXA|DAT|KB|VAL|ARN|D)-\d+|_/);
      expect(CONFIG_META[k].bounds, k).not.toMatch(/\b(AGT|CXA|DAT|KB|VAL|ARN|D)-\d+|_/);
    }
  });

  it.each(NUMBERS)("%s: default %f, range %f to %f, fixed", async (key, def, min, max) => {
    const k = CONFIG_KEYS[key] as ConfigKeyDef;
    expect(k.default).toBe(def);
    expect(k.range).toEqual([min, max]);
    expect(k.editable).toBe("fixed");
    for (const v of [def, min, max, min - 1, max + 1, "1", 1.5]) {
      expect(await check(key, v), `${key} ${String(v)}`).not.toBeNull(); // never edited
    }
  });

  it("sector_index_weighting is the text equal, fixed; the other word is refused too", async () => {
    const k = CONFIG_KEYS.sector_index_weighting as ConfigKeyDef;
    expect(k.default).toBe("equal");
    expect(k.editable).toBe("fixed");
    for (const v of ["equal", "value", "cap", 1, null]) {
      expect(await check("sector_index_weighting", v), String(v)).not.toBeNull();
    }
  });

  it("a fresh database reads every default", async () => {
    const db = await freshDb("main");
    for (const k of NAMES) {
      expect(await getConfig(db, k), k).toEqual(CONFIG_KEYS[k].default);
    }
    expect(await getConfig(db, "sector_index_weighting")).toBe("equal");
    expect(await getConfig(db, "survivorship_loss_assumed_pct")).toBe(50);
    expect(await getConfig(db, "label_golden_min")).toBe(500);
    expect(await getConfig(db, "residual_monitor_alarm_pp")).toBe(5);
    expect(await getConfig(db, "holdout_looks_max")).toBe(1);
  });
});
