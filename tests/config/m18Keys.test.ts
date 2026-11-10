// @vitest-environment node
// M18 configuration keys (OPS-103/104/105, SEC-115, DAT-251 b; D-954, D-958, D-979). An independent
// transcription: a change to a default or a bound in keys.ts must change it here too.
import { describe, expect, it } from "vitest";
import { CALENDAR_MARKETS } from "@/lib/data/calendarAdmin";
import {
  CONFIG_KEYS,
  CONFIG_META,
  isConfigKey,
  type ConfigKey,
  type ConfigKeyDef,
} from "@/lib/config/keys";

const get = async () => undefined;
const check = (key: ConfigKey, v: unknown) => CONFIG_KEYS[key].validate(v, get);

describe("M18 Owner-editable keys", () => {
  it("news_assess_per_run: default 40, whole items 20 to 200", async () => {
    const k = CONFIG_KEYS.news_assess_per_run as ConfigKeyDef;
    expect(k.default).toBe(40);
    expect(k.editable).toBe("O");
    expect(k.range).toEqual([20, 200]);
    for (const v of [20, 40, 200]) expect(await check("news_assess_per_run", v)).toBeNull();
    for (const v of [19, 201, 40.5, "40"]) {
      expect(await check("news_assess_per_run", v)).not.toBeNull();
    }
  });

  it("the old key name is gone from the registry (renamed, D-954)", () => {
    expect(isConfigKey("sentinel_max_items_per_run")).toBe(false);
    expect(isConfigKey("news_assess_per_run")).toBe(true);
  });

  it("turso_notice_pct: default 15, whole percent 10 to 19 (below the 20 % line)", async () => {
    const k = CONFIG_KEYS.turso_notice_pct as ConfigKeyDef;
    expect(k.default).toBe(15);
    expect(k.editable).toBe("O");
    expect(k.range).toEqual([10, 19]);
    for (const v of [10, 15, 19]) expect(await check("turso_notice_pct", v)).toBeNull();
    for (const v of [9, 20, 15.5]) expect(await check("turso_notice_pct", v)).not.toBeNull();
  });

  it("the Turso row ceilings default to 20 % of the free plan (500 M read, 10 M written)", () => {
    expect(CONFIG_KEYS.turso_reads_ceiling_month.default).toBe(100_000_000);
    expect(CONFIG_KEYS.turso_writes_ceiling_month.default).toBe(2_000_000);
    expect(CONFIG_KEYS.turso_reads_ceiling_month.default).toBe(
      (500_000_000 * CONFIG_KEYS.turso_free_ceiling_pct.default) / 100,
    );
    expect(CONFIG_KEYS.turso_writes_ceiling_month.default).toBe(
      (10_000_000 * CONFIG_KEYS.turso_free_ceiling_pct.default) / 100,
    );
  });
});

describe("M18 fixed keys (D-979)", () => {
  const FIXED: ReadonlyArray<readonly [ConfigKey, unknown]> = [
    ["turso_free_ceiling_pct", 20],
    ["hmac_scheme_version", 2],
    ["calendar_draft_markets", CALENDAR_MARKETS.join(", ")],
    ["restore_drill_reminder", "quarterly, first day"],
  ];
  it.each(FIXED)("%s has its default and refuses every edit", async (key, def) => {
    const k = CONFIG_KEYS[key] as ConfigKeyDef;
    expect(k.default).toEqual(def);
    expect(k.editable).toBe("fixed");
    expect(await check(key, def)).not.toBeNull();
    expect(await check(key, 1)).not.toBeNull();
  });

  it("the calendar draft markets are the calendar markets, not a second list", () => {
    expect(CONFIG_KEYS.calendar_draft_markets.default).toBe(CALENDAR_MARKETS.join(", "));
  });

  it("every M18 key is shown on the Configuration page with a label and bounds text", () => {
    for (const key of [
      "news_assess_per_run",
      "turso_notice_pct",
      "turso_free_ceiling_pct",
      "hmac_scheme_version",
      "calendar_draft_markets",
      "restore_drill_reminder",
    ] as ConfigKey[]) {
      expect(CONFIG_META[key].label.length, key).toBeGreaterThan(5);
      expect(CONFIG_META[key].bounds.length, key).toBeGreaterThan(0);
    }
  });
});
