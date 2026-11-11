// @vitest-environment node
// M19 configuration keys (docs/M19_design.md A1; MKT-107, DAT-241, D-993, D-994, D-1003): the nine
// `mkt.<CODE>.<field>` keys per built market, `markets_enabled`, `market_mode`'s default, MODE_MARKETS and the
// calendar markets as derived values. An independent transcription: a change to a default or a bound in keys.ts
// or a seed must change it here too.
import { describe, expect, it } from "vitest";
import {
  CONFIG_KEYS,
  CONFIG_META,
  MODE_MARKETS,
  isConfigKey,
  parseMktKey,
  validateMarketModes,
  type ConfigKey,
  type ConfigKeyDef,
} from "@/lib/config/keys";
import { CALENDAR_MARKETS, calendarMarkets } from "@/lib/data/calendar";
import { CALENDAR_RULE_MODULES } from "@/lib/data/calendarRules.mjs";
import { builtMarkets } from "@/lib/market/seed/index.mjs";

const get = async () => undefined;
const check = (key: string, v: unknown) =>
  (CONFIG_KEYS[key as ConfigKey] as ConfigKeyDef).validate(v, get);
const def = (key: string): ConfigKeyDef => CONFIG_KEYS[key as ConfigKey] as ConfigKeyDef;

const EXPECTED: ReadonlyArray<readonly [string, unknown, "O" | "fixed"]> = [
  ["mkt.AU.decision_cutoff", "18:10", "fixed"],
  ["mkt.IN.decision_cutoff", "17:30", "fixed"],
  ["mkt.US.decision_cutoff", "18:00", "fixed"],
  ["mkt.AU.settlement_days", 2, "fixed"],
  ["mkt.IN.settlement_days", 1, "fixed"],
  ["mkt.US.settlement_days", 1, "fixed"],
  ["mkt.AU.parcel_floor", 500, "O"],
  ["mkt.IN.parcel_floor", 25000, "O"],
  ["mkt.US.parcel_floor", 300, "O"],
  ["mkt.AU.opening_auction_window", { kind: "staggered", from: "10:00", to: "10:09" }, "fixed"],
  [
    "mkt.IN.opening_auction_window",
    { kind: "single", at: "09:15", call_auction: { from: "09:00", to: "09:08" } },
    "fixed",
  ],
  ["mkt.US.opening_auction_window", { kind: "single", at: "09:30" }, "fixed"],
  ["mkt.AU.preopen_recheck_min", 5, "fixed"],
  ["mkt.IN.preopen_recheck_min", 5, "fixed"],
  ["mkt.US.preopen_recheck_min", 5, "fixed"],
  ["mkt.AU.classification_scheme", "gics_group", "fixed"],
  ["mkt.IN.classification_scheme", "nse_level2", "fixed"],
  ["mkt.US.classification_scheme", "sic_2digit", "fixed"],
  ["mkt.AU.cost_formula", "P5", "O"],
  ["mkt.IN.cost_formula", "IN-P1", "O"],
  ["mkt.US.cost_formula", "US-P1", "O"],
  ["mkt.AU.universe_max", 0, "O"],
  ["mkt.IN.universe_max", 2000, "O"],
  ["mkt.US.universe_max", 2500, "O"],
  ["mkt.AU.dividend_imputation", true, "fixed"],
  ["mkt.IN.dividend_imputation", false, "fixed"],
  ["mkt.US.dividend_imputation", false, "fixed"],
];

describe("the mkt.<CODE>.<field> keys (spec ch. 15 15.11.1)", () => {
  it("27 keys: nine fields for each of the three built markets, with the spec defaults and edit flags", () => {
    const mkt = Object.keys(CONFIG_KEYS).filter((k) => k.startsWith("mkt."));
    expect(mkt).toHaveLength(27);
    for (const [key, value, edit] of EXPECTED) {
      expect(isConfigKey(key), key).toBe(true);
      expect(def(key).default, key).toEqual(value);
      expect(def(key).editable, key).toBe(edit);
      expect(CONFIG_META[key as ConfigKey].label.length, `${key} label`).toBeGreaterThan(0);
      expect(CONFIG_META[key as ConfigKey].bounds.length, `${key} bounds`).toBeGreaterThan(0);
    }
    expect(mkt.sort()).toEqual(EXPECTED.map((e) => e[0]).sort());
  });

  it("mkt.AU.decision_cutoff is the decision_cutoff key's default: one definition (D-993)", () => {
    expect(def("mkt.AU.decision_cutoff").default).toBe(def("decision_cutoff").default);
    expect(def("decision_cutoff").default).toBe("18:10");
  });

  it("fixed keys refuse every edit", async () => {
    for (const [key, value, edit] of EXPECTED) {
      if (edit === "fixed") expect(await check(key, value), key).not.toBeNull();
    }
  });

  it("parcel_floor: 0 or more, in the market's currency (an O key, a counted trial)", async () => {
    for (const v of [0, 500, 25000.5]) expect(await check("mkt.AU.parcel_floor", v)).toBeNull();
    for (const v of [-1, "500", Number.NaN])
      expect(await check("mkt.AU.parcel_floor", v)).not.toBeNull();
  });

  it("cost_formula: one of the market's own profiles", async () => {
    for (const v of ["P0", "P5", "P5b", "P6"])
      expect(await check("mkt.AU.cost_formula", v), v).toBeNull();
    expect(await check("mkt.AU.cost_formula", "IN-P1")).not.toBeNull();
    expect(await check("mkt.IN.cost_formula", "IN-P1")).toBeNull();
    expect(await check("mkt.IN.cost_formula", "P5")).not.toBeNull();
    expect(await check("mkt.US.cost_formula", "US-P1")).toBeNull();
  });

  it("universe_max: 0 (no cap) or 500 to 6,000 whole codes", async () => {
    for (const v of [0, 500, 2000, 6000])
      expect(await check("mkt.IN.universe_max", v), String(v)).toBeNull();
    for (const v of [1, 499, 6001, 2000.5, "2000"])
      expect(await check("mkt.IN.universe_max", v), String(v)).not.toBeNull();
  });

  it("parseMktKey reads the key text and nothing else", () => {
    expect(parseMktKey("mkt.IN.parcel_floor")).toEqual({ code: "IN", field: "parcel_floor" });
    expect(parseMktKey("mkt.AU.settlement_days")).toEqual({ code: "AU", field: "settlement_days" });
    for (const bad of [
      "parcel_floor",
      "mkt.IN.tiers",
      "mkt.in.parcel_floor",
      "mkt.IN",
      "mkt.IN.parcel_floor.x",
    ]) {
      expect(parseMktKey(bad), bad).toBeNull();
    }
  });
});

describe("markets_enabled and market_mode (D-994)", () => {
  it("markets_enabled is fixed, text-listed, and AU alone while PRAXIS_MARKETS_ENABLED is unset", async () => {
    expect(def("markets_enabled").editable).toBe("fixed");
    expect(await check("markets_enabled", "AU")).not.toBeNull();
    if (process.env.PRAXIS_MARKETS_ENABLED === undefined)
      expect(def("markets_enabled").default).toBe("AU");
  });

  it("market_mode defaults to AU data_only and IN and US off, and accepts entries for every built market", () => {
    expect(def("market_mode").default).toEqual({ AU: "data_only", IN: "off", US: "off" });
    expect(validateMarketModes({ AU: "data_only", IN: "off", US: "off" })).toBeNull();
    expect(validateMarketModes({ ZZ: "off" })).toBe("unknown market");
  });
});

describe("derived market lists (MKT-107: no literal list)", () => {
  it("MODE_MARKETS is the seed registry; the calendar markets are the rule modules' keys", () => {
    expect([...MODE_MARKETS]).toEqual(builtMarkets());
    expect([...MODE_MARKETS]).toEqual(["AU", "IN", "US"]);
    expect(calendarMarkets()).toEqual(Object.keys(CALENDAR_RULE_MODULES).sort());
    expect([...CALENDAR_MARKETS]).toEqual(["AU"]); // IN and US have no calendar rules until M20
    expect(def("calendar_draft_markets").default).toBe(calendarMarkets().join(", "));
  });

  it("the money keys lose their A$ labels and keep their numbers (D-1003)", () => {
    expect(def("ledger_notional_aud").unit).toBe("market currency");
    expect(def("ledger_notional_aud").default).toBe(600);
    expect(def("picks_portfolio_seed_aud").unit).toBe("market currency");
    expect(def("picks_portfolio_seed_aud").default).toBe(5000);
    expect(def("profile_portfolio_amount").unit).toBe("market currency");
    expect(def("profile_portfolio_amount").default).toEqual({
      aggressive: 10000,
      balanced: 10000,
      conservative: 10000,
    });
  });
});
