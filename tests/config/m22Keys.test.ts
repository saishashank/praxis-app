// @vitest-environment node
// M22 A2 (D-1402, D-1410, D-1455; ch. 15 §15.11.3 and the ten V2 keys; AT-77/AT-80 defaults): the fourteen keys, as an
// independent transcription. A change to a default or a bound in keys.ts must change it here too. A fresh database reads
// every default, and every default is the safe one: off, empty, zero or rules-only.
import { afterEach, describe, expect, it } from "vitest";
import { editText, parseConfigInput } from "@/lib/config/admin";
import {
  CONFIG_KEYS,
  CONFIG_META,
  M22_KEY_NAMES,
  type ConfigKey,
  type ConfigKeyDef,
} from "@/lib/config/keys";
import { getConfig } from "@/lib/config/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const get = async () => undefined;
const check = (key: ConfigKey, v: unknown) => CONFIG_KEYS[key].validate(v, get);

const NAMES = [
  "llm_live_roles",
  "llm_budget_workers_ai_daily",
  "minilm_enabled",
  "regime_altinputs_enabled",
  "llm_budget_committee_daily",
  "committee_shortlist",
  "committee_horizon_sessions",
  "committee_trial_sessions",
  "committee_min_settled",
  "committee_permutations",
  "committee_call_record_retention_months",
  "llm_budget_experts_daily",
  "expert_extract_daily",
  "expert_tracked_max",
] as const;

// [key, default, min, max, edit]
const RANGED: ReadonlyArray<readonly [ConfigKey, number, number, number, "O" | "fixed"]> = [
  ["llm_budget_workers_ai_daily", 0, 0, 10_000, "O"],
  ["llm_budget_committee_daily", 40_000, 0, 60_000, "O"],
  ["committee_shortlist", 3, 0, 5, "O"],
  ["committee_horizon_sessions", 20, 5, 60, "O"],
  ["committee_trial_sessions", 126, 63, 252, "O"],
  ["committee_min_settled", 150, 100, 500, "O"],
  ["committee_permutations", 20_000, 5_000, 100_000, "fixed"],
  ["committee_call_record_retention_months", 18, 6, 36, "O"],
  ["llm_budget_experts_daily", 30_000, 0, 60_000, "O"],
  ["expert_extract_daily", 20, 0, 60, "O"],
  ["expert_tracked_max", 150, 20, 300, "O"],
];

describe("M22 keys", () => {
  it("M22_KEY_NAMES lists the fourteen keys once; all are registered with plain-words labels", () => {
    expect([...M22_KEY_NAMES].sort()).toEqual([...NAMES].sort());
    expect(M22_KEY_NAMES).toHaveLength(14);
    expect(new Set(M22_KEY_NAMES).size).toBe(14);
    for (const k of M22_KEY_NAMES) {
      expect(CONFIG_META[k].label.length, k).toBeGreaterThan(8);
      // D-922: no internal code, no role code, no key name in an Owner-read label
      expect(CONFIG_META[k].label, k).not.toMatch(/\b(AGT|LLM|DAT|KB|VAL|ARN|D)-\d+|\bR[1-7]\b|_/);
      // the bounds text of llm_live_roles lists the names the Owner types; no other bounds text has a role code
      if (k !== "llm_live_roles") expect(CONFIG_META[k].bounds, k).not.toMatch(/\bR[1-7]\b/);
    }
  });

  it.each(RANGED)("%s: default %f, bounds %f to %f, edit %s", async (key, def, min, max, edit) => {
    const k = CONFIG_KEYS[key] as ConfigKeyDef;
    expect(k.default).toBe(def);
    expect(k.range).toEqual([min, max]);
    expect(k.editable).toBe(edit);
    if (edit === "fixed") {
      expect(await check(key, def)).not.toBeNull(); // never edited
      return;
    }
    for (const v of [def, min, max]) expect(await check(key, v)).toBeNull();
    expect(await check(key, min - 1)).not.toBeNull();
    expect(await check(key, max + 1)).not.toBeNull();
    expect(await check(key, "1")).not.toBeNull();
    expect(await check(key, min + 0.5)).not.toBeNull();
  });

  it("the two switches are on/off text, default off, Owner-editable", async () => {
    for (const key of ["minilm_enabled", "regime_altinputs_enabled"] as const) {
      expect(CONFIG_KEYS[key].default, key).toBe("off");
      expect(CONFIG_KEYS[key].editable, key).toBe("O");
      expect(await check(key, "off"), key).toBeNull();
      expect(await check(key, "on"), key).toBeNull();
      expect(await check(key, "maybe"), key).not.toBeNull();
      expect(await check(key, true), key).not.toBeNull();
    }
  });

  it("llm_live_roles: empty by default; a list of distinct names from R1, R2, R3, R5, R6, R7, words", async () => {
    expect(CONFIG_KEYS.llm_live_roles.default).toEqual([]);
    expect(CONFIG_KEYS.llm_live_roles.editable).toBe("O");
    for (const ok of [[], ["R1"], ["R1", "R2", "R3", "R5", "R6", "R7", "words"], ["words", "R7"]]) {
      expect(await check("llm_live_roles", ok), JSON.stringify(ok)).toBeNull();
    }
    for (const bad of [
      ["R4"],
      ["R8"],
      ["r1"],
      ["R1", "R1"],
      ["Words"],
      [""],
      [1],
      "R1",
      null,
      { R1: true },
    ]) {
      expect(await check("llm_live_roles", bad), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it("llm_live_roles input: words separated by commas, spaces or a JSON list; empty means none", () => {
    expect(CONFIG_META.llm_live_roles.input).toBe("word_list");
    const p = (t: string) => parseConfigInput("word_list", t);
    expect(p("")).toEqual({ value: [] });
    expect(p("  ")).toEqual({ value: [] });
    expect(p("[]")).toEqual({ value: [] });
    expect(p("R1, R2 words")).toEqual({ value: ["R1", "R2", "words"] });
    expect(p('["R6","words"]')).toEqual({ value: ["R6", "words"] });
    expect(p("[1]")).toHaveProperty("error");
    expect(p('{"a":1}')).toHaveProperty("error");
    expect(parseConfigInput("word_list", 5)).toHaveProperty("error");
    expect(parseConfigInput("word_list", editText(["R1", "words"]))).toEqual({
      value: ["R1", "words"],
    });
    expect(parseConfigInput("word_list", editText([]))).toEqual({ value: [] });
  });

  it("a fresh database reads every default, and the safe ones are off, empty or zero (AT-77, AT-80)", async () => {
    const db = await freshDb("main");
    for (const k of NAMES) {
      expect(await getConfig(db, k), k).toEqual(CONFIG_KEYS[k].default);
    }
    expect(await getConfig(db, "llm_live_roles")).toEqual([]);
    expect(await getConfig(db, "llm_budget_workers_ai_daily")).toBe(0);
    expect(await getConfig(db, "minilm_enabled")).toBe("off");
    expect(await getConfig(db, "regime_altinputs_enabled")).toBe("off");
  });
});
