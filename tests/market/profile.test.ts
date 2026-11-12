// @vitest-environment node
// The market-profile loader (M19 A1; MKT-107, DAT-241, D-992, D-993). Loads AU, IN and US from a migrated
// database, overlays a `mkt.<CODE>.<field>` configuration row, caches per handle and invalidates, and refuses a
// market that is not enabled. Pure core checks (field list, codec, slots) sit beside it. AT-67, AT-75 (AU).
import { afterEach, describe, expect, it } from "vitest";
import {
  PROFILE_FIELDS,
  COUNTED_TRIAL_FIELDS,
  MKT_KEY_FIELDS,
  validateField,
} from "@/lib/market/fields.mjs";
import {
  decodeValue,
  encodeValue,
  marketsEnabledDefault,
  overlayKeyValue,
  valueFromKey,
  currencyFormatOf,
  OWNER_TZ,
  GLOBAL_INDICES,
} from "@/lib/market/profileCore.mjs";
import {
  enabledMarkets,
  invalidateProfiles,
  loadProfile,
  loadProfiles,
  MarketNotEnabled,
  mktKey,
  profileOf,
  PROFILE_CACHE_MS,
  requireEnabledMarket,
  UnknownMarket,
} from "@/lib/market/profile";
import { SEEDS, builtMarkets, seedOf } from "@/lib/market/seed/index.mjs";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(() => {
  cleanupTempDbs();
  invalidateProfiles();
});

describe("the field list and the seeds", () => {
  it("pins the 40 fields (a new field is a migration, a seed edit and this list together)", () => {
    expect(PROFILE_FIELDS).toHaveLength(40);
    expect(new Set(PROFILE_FIELDS).size).toBe(40);
    // the ch. 20 table rows plus the five CXA-002 additions
    for (const f of [
      "yahoo_suffix",
      "bar_latency_p95_min",
      "preopen_recheck_min",
      "category_map",
      "universe_max",
    ]) {
      expect(PROFILE_FIELDS).toContain(f);
    }
  });

  it("every seed has every field once, a valid value (null = set at M20), and the registry lists the three markets", () => {
    expect(builtMarkets()).toEqual(["AU", "IN", "US"]);
    for (const [code, seed] of Object.entries(SEEDS)) {
      expect(Object.keys(seed.fields).sort(), code).toEqual([...PROFILE_FIELDS].sort());
      for (const f of PROFILE_FIELDS) {
        expect(validateField(f, seed.fields[f].value), `${code}.${f}`).toBeNull();
      }
    }
  });

  it("the counted-trial fields and the mkt key fields are fields", () => {
    for (const f of COUNTED_TRIAL_FIELDS) expect(PROFILE_FIELDS).toContain(f);
    for (const f of Object.keys(MKT_KEY_FIELDS)) expect(PROFILE_FIELDS).toContain(f);
  });

  it("the value codec round-trips bigint and nested tables", () => {
    const v = { a: 500_000_000n, b: [{ c: -1n }], s: "5", n: 3, none: null };
    expect(decodeValue(encodeValue(v))).toEqual(v);
    expect(encodeValue(500n)).toBe('"500n"');
  });

  it("the overlay key value is the inverse of the field value for every overlay field", () => {
    for (const code of builtMarkets()) {
      for (const f of Object.keys(MKT_KEY_FIELDS)) {
        const cur = seedOf(code)!.fields[f as keyof typeof SEEDS.AU.fields].value;
        const key = overlayKeyValue(f, cur);
        expect(valueFromKey(f, key, cur), `${code}.${f}`).toEqual(cur);
      }
    }
  });

  it("markets_enabled defaults to AU alone and follows PRAXIS_MARKETS_ENABLED (unknown codes dropped)", () => {
    expect(marketsEnabledDefault({})).toEqual(["AU"]);
    expect(marketsEnabledDefault({ PRAXIS_MARKETS_ENABLED: "" })).toEqual(["AU"]);
    expect(marketsEnabledDefault({ PRAXIS_MARKETS_ENABLED: "US, IN ,AU" })).toEqual([
      "AU",
      "IN",
      "US",
    ]);
    expect(marketsEnabledDefault({ PRAXIS_MARKETS_ENABLED: "ZZ" })).toEqual(["AU"]);
  });

  it("the Owner zone, the global indices and the three currency formats (UXN-313)", () => {
    expect(OWNER_TZ).toBe("Australia/Melbourne");
    expect([...GLOBAL_INDICES]).toEqual(["GSPC", "VIX"]);
    expect(currencyFormatOf("AUD").symbol).toBe("A$");
    expect(currencyFormatOf("INR").locale).toBe("en-IN");
    expect(currencyFormatOf("USD").symbol).toBe("US$");
    expect(() => currencyFormatOf("EUR")).toThrow(/no display format/);
  });
});

describe("loadProfile from a migrated database", () => {
  it("loads AU: today's values, typed accessors, complete", async () => {
    const db = await freshDb("main");
    const p = await loadProfile(db, "AU");
    expect(p).toMatchObject({
      code: "AU",
      workStatus: "active",
      enabled: true,
      exchange: "ASX",
      tz: "Australia/Sydney",
      sessionOpen: "10:00",
      sessionClose: "16:00",
      currency: "AUD",
      decisionCutoff: "18:10",
      decisionCutoffZone: "Australia/Melbourne",
      settlementDays: 2,
      parcelFloorMicro: 500_000_000n,
      advFloorPerParcelMicro: 50_000_000_000n,
      preopenRecheckMin: 5,
      preopenAt: "09:55",
      costFormula: "P5",
      classificationScheme: "gics_group",
      haltModel: "cx16",
      benchmarkIndex: "AXJO",
      benchmarkYahooSymbol: "^AXJO",
      yahooSuffix: ".AX",
      dividendImputation: true,
      angleCount: 100,
      universeMax: null,
    });
    expect(p.indexCodes).toEqual(["AXJO", "GSPC", "VIX"]);
    expect(p.complete).toBe(true);
    expect(p.completeness).toMatchObject({ total: 40, valued: 40, verified: 40 });
    expect(Object.isFrozen(p)).toBe(true);
    expect(p.currencyFormat?.symbol).toBe("A$");
  });

  it("loads IN and US: built, off, incomplete by design (unverified [VERIFY] fields)", async () => {
    const db = await freshDb("main");
    const all = await loadProfiles(db);
    expect(all.map((x) => x.code)).toEqual(["AU", "IN", "US"]);
    const inn = all[1]!;
    const us = all[2]!;
    for (const p of [inn, us]) {
      expect(p.workStatus).toBe("built");
      expect(p.enabled).toBe(false);
      expect(p.mode).toBe("off");
      expect(p.complete).toBe(false);
      // M20 A4 filled tiers, slippage_buckets, sleeve_reality_cap and bar_latency_p95_min; every value is still [VERIFY]
      expect(p.completeness.missing).toEqual([]);
      expect(p.completeness.verified).toBe(0);
      expect(p.angleCount).toBe(99);
    }
    expect(inn).toMatchObject({
      currency: "INR",
      settlementDays: 1,
      parcelFloorMicro: 25_000_000_000n,
      benchmarkIndex: "NSEI",
      universeMax: 2000,
      yahooSuffix: ".NS",
    });
    expect(us).toMatchObject({
      currency: "USD",
      settlementDays: 1,
      parcelFloorMicro: 300_000_000n,
      benchmarkIndex: "GSPC",
      universeMax: 2500,
      yahooSuffix: "",
    });
    expect(inn.currencyFormat?.locale).toBe("en-IN");
  });

  it("an unknown market throws UnknownMarket", async () => {
    const db = await freshDb("main");
    await expect(loadProfile(db, "ZZ")).rejects.toBeInstanceOf(UnknownMarket);
  });

  it("overlays the newest mkt.<CODE>.<field> value, and the legacy decision_cutoff key for the home market", async () => {
    const db = await freshDb("main");
    const put = (key: string, value: unknown, at: string) =>
      db.execute({
        sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES (?, 'global', ?, ?)",
        args: [key, JSON.stringify(value), at],
      });
    await put(mktKey("AU", "parcel_floor"), 400, "2030-01-01T00:00:00.000Z");
    await put(mktKey("AU", "parcel_floor"), 600, "2030-01-02T00:00:00.000Z");
    await put(mktKey("AU", "cost_formula"), "P6", "2030-01-02T00:00:00.000Z");
    await put("decision_cutoff", "18:20", "2030-01-02T00:00:00.000Z");
    await put(mktKey("IN", "universe_max"), 1500, "2030-01-02T00:00:00.000Z");
    const au = await loadProfile(db, "AU");
    expect(au.parcelFloorMicro).toBe(600_000_000n);
    expect(au.advFloorPerParcelMicro).toBe(60_000_000_000n);
    expect(au.costFormula).toBe("P6");
    expect(au.decisionCutoff).toBe("18:20");
    expect(au.decisionCutoffZone).toBe("Australia/Melbourne");
    expect(au.fields.parcel_floor?.overlay).toBe(true);
    expect(au.fields.settlement_days?.overlay).toBe(false);
    // the legacy key applies to the home market only
    const inn = await loadProfile(db, "IN");
    expect(inn.decisionCutoff).toBe("17:30");
    expect(inn.universeMax).toBe(1500);
    // a value that fails the field's check is ignored, never half-applied
    await put(mktKey("AU", "preopen_recheck_min"), 99, "2030-01-03T00:00:00.000Z");
    invalidateProfiles();
    expect((await loadProfile(db, "AU")).preopenRecheckMin).toBe(5);
  });

  it("caches per handle for profile_cache_ms and invalidateProfiles() drops it", async () => {
    const db = await freshDb("main");
    const first = await loadProfile(db, "AU", { now: 1_000 });
    await db.execute(
      "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('mkt.AU.parcel_floor','global','700','t')",
    );
    expect(await loadProfile(db, "AU", { now: 1_000 + PROFILE_CACHE_MS - 1 })).toBe(first);
    expect((await loadProfile(db, "AU", { now: 1_000 + PROFILE_CACHE_MS })).parcelFloorMicro).toBe(
      700_000_000n,
    );
    await db.execute(
      "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('mkt.AU.parcel_floor','global','800','t2')",
    );
    invalidateProfiles();
    expect((await loadProfile(db, "AU", { now: 1_001 })).parcelFloorMicro).toBe(800_000_000n);
  });

  it("another database handle never sees this handle's cache", async () => {
    const a = await freshDb("main");
    const b = await freshDb("main");
    await a.execute(
      "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('mkt.AU.parcel_floor','global','900','t')",
    );
    expect((await loadProfile(a, "AU")).parcelFloorMicro).toBe(900_000_000n);
    expect((await loadProfile(b, "AU")).parcelFloorMicro).toBe(500_000_000n);
  });
});

describe("enabled markets and the profile of a request", () => {
  it("enabledMarkets is AU alone under the seed; requireEnabledMarket refuses IN and US", async () => {
    const db = await freshDb("main");
    expect(await enabledMarkets(db)).toEqual(["AU"]);
    expect(await requireEnabledMarket(db, "AU")).toBe("AU");
    await expect(requireEnabledMarket(db, "IN")).rejects.toBeInstanceOf(MarketNotEnabled);
    await expect(requireEnabledMarket(db, "US")).rejects.toMatchObject({
      name: "MarketNotEnabled",
      market: "US",
    });
  });

  it("profileOf: explicit market; else the single enabled market; with two enabled, the user's default", async () => {
    const db = await freshDb("main");
    expect((await profileOf(db)).code).toBe("AU");
    expect((await profileOf(db, { market: "IN" })).code).toBe("IN");
    expect((await profileOf(db, { defaultMarket: "IN" })).code).toBe("AU"); // IN is not enabled
    await db.execute("UPDATE market SET enabled = 1 WHERE code = 'IN'");
    expect(await enabledMarkets(db)).toEqual(["AU", "IN"]);
    expect((await profileOf(db, { defaultMarket: "IN" })).code).toBe("IN");
    expect((await profileOf(db, { defaultMarket: "US" })).code).toBe("AU"); // not enabled: first
    expect((await profileOf(db)).code).toBe("AU");
  });

  it("no enabled market at all is MarketNotEnabled", async () => {
    const db = await freshDb("main");
    await db.execute("UPDATE market SET enabled = 0, mode = 'off' WHERE code = 'AU'");
    await expect(profileOf(db)).rejects.toBeInstanceOf(MarketNotEnabled);
  });
});
