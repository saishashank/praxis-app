// @vitest-environment node
// M7 configuration keys (T2, docs/M7_design.md 2.11, decision 29, D-128, D-129). The expected table is
// an independent transcription of ch.15 section 15.8 and l.171: a change to a default or a bound in
// keys.ts must change it here too.
import { describe, expect, it } from "vitest";
import { editText, parseConfigInput } from "@/lib/config/admin";
import {
  CONFIG_AREAS,
  CONFIG_KEYS,
  CONFIG_META,
  M7_KEY_NAMES,
  STRATEGY_NAME_FAMILIES,
  STRATEGY_NAME_FIELDS,
  STRATEGY_NAMES_DEFAULT,
  type ConfigKey,
  type ConfigKeyDef,
} from "@/lib/config/keys";
import { getConfig } from "@/lib/config/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { afterEach } from "vitest";

afterEach(cleanupTempDbs);

const get = async () => undefined;
const check = (key: ConfigKey, v: unknown) => CONFIG_KEYS[key].validate(v, get);

// [key, default, min, max]. All Owner-editable.
const RANGED: ReadonlyArray<readonly [ConfigKey, number, number, number]> = [
  ["unmask_expiry", 30, 1, 365],
  ["overview_max_per_night", 20, 0, 60],
  ["overview_refresh_days", 7, 1, 30],
  ["intraday_codes_max", 150, 0, 300],
  ["intraday_refresh_min", 5, 2, 15],
  ["watchlist_max", 50, 10, 200],
  ["attention_near_limit_pct", 15, 5, 30],
];

describe("M7 ranged keys", () => {
  it.each(RANGED)("%s: default %i, bounds %i to %i, Owner-editable", async (key, def, min, max) => {
    const k = CONFIG_KEYS[key];
    expect(k.default).toBe(def);
    expect(k.editable).toBe("O");
    expect((k as ConfigKeyDef).range).toEqual([min, max]);
    expect(await check(key, def)).toBeNull();
    expect(await check(key, min)).toBeNull();
    expect(await check(key, max)).toBeNull();
    expect(await check(key, min - 1)).not.toBeNull();
    expect(await check(key, max + 1)).not.toBeNull();
    expect(await check(key, def + 0.5)).not.toBeNull();
    expect(await check(key, "10")).not.toBeNull();
    expect(await check(key, null)).not.toBeNull();
  });

  it("market_list_page_size is 50 and fixed (named in ch.16, not editable)", async () => {
    const k = CONFIG_KEYS.market_list_page_size;
    expect(k.default).toBe(50);
    expect(k.editable).toBe("fixed");
    expect(await check("market_list_page_size", 50)).not.toBeNull();
  });

  it("the D-128 / D-129 keys say where they come from", () => {
    expect(CONFIG_KEYS.attention_near_limit_pct.ref).toContain("D-129");
    expect(CONFIG_KEYS.market_list_page_size.ref).toContain("D-129");
    expect(CONFIG_KEYS.strategy_names.ref).toContain("D-129");
    expect(CONFIG_KEYS.unmask_expiry.ref).toContain("ch.15 l.171");
  });
});

describe("strategy_names (UXN-039)", () => {
  const clone = () =>
    JSON.parse(JSON.stringify(STRATEGY_NAMES_DEFAULT)) as Record<string, Record<string, string>>;

  it("the default is the six UXN-039 rows with the six fields, no numbers in names", async () => {
    expect(Object.keys(STRATEGY_NAMES_DEFAULT)).toEqual([...STRATEGY_NAME_FAMILIES]);
    expect(STRATEGY_NAMES_DEFAULT.F1.name).toBe("Follow the trend");
    expect(STRATEGY_NAMES_DEFAULT.F4.name).toBe("Buy the dip");
    expect(STRATEGY_NAMES_DEFAULT.F6.name).toBe("Signals agree");
    for (const f of STRATEGY_NAME_FAMILIES) {
      expect(Object.keys(STRATEGY_NAMES_DEFAULT[f])).toEqual([...STRATEGY_NAME_FIELDS]);
    }
    expect(await check("strategy_names", STRATEGY_NAMES_DEFAULT)).toBeNull();
    expect(CONFIG_KEYS.strategy_names.editable).toBe("O");
  });

  it("refuses a missing family, an extra family, a missing or extra field and empty or long text", async () => {
    const noF6 = clone();
    delete noF6.F6;
    expect(await check("strategy_names", noF6)).toMatch(/exactly one entry/);
    expect(await check("strategy_names", { ...clone(), F7: clone().F1 })).toMatch(
      /exactly one entry/,
    );
    const noRisk = clone();
    delete noRisk.F2!.main_risk;
    expect(await check("strategy_names", noRisk)).toMatch(/F2 needs/);
    const extra = clone();
    extra.F2!.extra = "x";
    expect(await check("strategy_names", extra)).toMatch(/F2 needs/);
    const empty = clone();
    empty.F3!.one_liner = "   ";
    expect(await check("strategy_names", empty)).toMatch(/F3 one_liner/);
    const long = clone();
    long.F3!.name = "x".repeat(41);
    expect(await check("strategy_names", long)).toMatch(/F3 name/);
    expect(await check("strategy_names", [])).not.toBeNull();
    expect(await check("strategy_names", null)).not.toBeNull();
  });

  it("refuses a name that starts with a number (UXN-039: no 'Strategy 1')", async () => {
    for (const bad of ["Strategy 1", "1 Follow the trend", "#2 Dip", "strategy3"]) {
      const v = clone();
      v.F1!.name = bad;
      expect(await check("strategy_names", v), bad).toMatch(/must not start with a number/);
    }
    const ok = clone();
    ok.F1!.name = "The 52-week high";
    expect(await check("strategy_names", ok)).toBeNull();
  });

  it("the Owner's form text round-trips through the config editor (long object values are allowed)", () => {
    const text = editText(STRATEGY_NAMES_DEFAULT);
    expect(text.length).toBeGreaterThan(500);
    expect(parseConfigInput("object", text)).toEqual({ value: STRATEGY_NAMES_DEFAULT });
    expect(parseConfigInput("int", "7".repeat(501))).toEqual({ error: "is missing or too long" });
    expect(parseConfigInput("object", `{"a":"${"x".repeat(12_000)}"}`)).toEqual({
      error: "is missing or too long",
    });
  });
});

describe("registry plumbing", () => {
  it("M7_KEY_NAMES lists 7 ranged + 1 fixed + 1 explicit key, all registered, none repeated", () => {
    expect(M7_KEY_NAMES).toHaveLength(RANGED.length + 2);
    expect(new Set(M7_KEY_NAMES).size).toBe(M7_KEY_NAMES.length);
    for (const k of M7_KEY_NAMES) expect(CONFIG_KEYS[k], k).toBeDefined();
    for (const [k] of RANGED) expect(M7_KEY_NAMES).toContain(k);
    expect(M7_KEY_NAMES).toContain("market_list_page_size");
    expect(M7_KEY_NAMES).toContain("strategy_names");
  });

  it("every M7 key has metadata in a listed area with a label and bounds text", () => {
    for (const k of M7_KEY_NAMES) {
      const m = CONFIG_META[k];
      expect(CONFIG_AREAS, k).toContain(m.area);
      expect(m.label.length, k).toBeGreaterThan(3);
      expect(m.bounds.length, k).toBeGreaterThan(0);
    }
  });

  it("a fresh database reads each default through getConfig", async () => {
    const db = await freshDb("main");
    for (const [k, def] of RANGED) expect(await getConfig(db, k), k).toBe(def);
    expect(await getConfig(db, "strategy_names")).toEqual(STRATEGY_NAMES_DEFAULT);
  });
});
