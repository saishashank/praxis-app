// @vitest-environment node
// M17 configuration keys (WP2; docs/M17_requirements.md "Configuration keys", D-381 to D-442). The
// expected table is an independent transcription: a change to a default or a bound in keys.ts must
// change it here too.
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, M17_KEY_NAMES, type ConfigKey, type ConfigKeyDef } from "@/lib/config/keys";

const store: Record<string, unknown> = {};
const get = async (k: ConfigKey) => store[k];
const check = (key: ConfigKey, v: unknown) => CONFIG_KEYS[key].validate(v, get);

// [key, default, min, max, kind]
const RANGED: ReadonlyArray<readonly [ConfigKey, number, number, number, "int" | "num"]> = [
  ["chase_cap_pct", 3, 1, 8, "num"],
  ["pick_alert_max_sessions", 3, 1, 10, "int"],
  ["pick_alert_emails_per_day", 12, 0, 20, "int"],
  ["intraday_scan_min", 30, 15, 60, "int"],
  ["intraday_scan_codes_max", 800, 0, 1500, "int"],
  ["intraday_scan_requests_max", 40, 10, 100, "int"],
  ["intraday_move_min_pct", 4, 2, 10, "num"],
  ["intraday_rel_volume_min", 2, 1.2, 4, "num"],
  ["intraday_candidate_emails_per_day", 3, 0, 8, "int"],
  ["quote_pause_cooldown_min", 30, 10, 120, "int"],
  ["intraday_quote_delay_min", 20, 0, 60, "int"],
  ["home_picks_shown", 3, 1, 5, "int"],
  ["intraday_candidates_shown_max", 5, 1, 20, "int"],
  ["pick_min_chance", 55, 50, 70, "num"],
  // changed by M17 (O-76)
  ["picks_per_profile", 10, 0, 10, "int"],
  ["picks_max_per_family", 10, 10, 10, "int"], // D-791: pinned, O-76 removed the cap
];

describe("M17 keys", () => {
  it.each(RANGED)(
    "%s: default %f, bounds %f to %f, Owner-editable",
    async (key, def, min, max, kind) => {
      const k = CONFIG_KEYS[key] as ConfigKeyDef;
      expect(k.default).toBe(def);
      expect(k.editable).toBe("O");
      expect(k.range).toEqual([min, max]);
      for (const v of [def, min, max]) expect(await check(key, v)).toBeNull();
      const eps = kind === "int" ? 1 : 0.001;
      expect(await check(key, min - eps)).not.toBeNull();
      expect(await check(key, max + eps)).not.toBeNull();
      expect(await check(key, "1")).not.toBeNull();
      if (kind === "int") expect(await check(key, min + 0.5)).not.toBeNull();
    },
  );

  it("the enum keys: defaults and allowed values", async () => {
    expect(CONFIG_KEYS.pick_alerts_default_owner.default).toBe("on");
    expect(await check("pick_alerts_default_owner", "off")).toBeNull();
    expect(await check("pick_alerts_default_owner", "maybe")).not.toBeNull();
    expect(CONFIG_KEYS.picks_default_sort.default).toBe("chance");
    expect(await check("picks_default_sort", "expected_gain")).toBeNull();
    expect(await check("picks_default_sort", "alpha")).not.toBeNull();
  });

  it("intraday_stream_state is fixed at shadow with no editable writer (VAL-118 only)", async () => {
    const k = CONFIG_KEYS.intraday_stream_state;
    expect(k.default).toBe("shadow");
    expect(k.editable).toBe("fixed");
    for (const v of ["shadow", "allowed", "live-tested"]) {
      expect(await check("intraday_stream_state", v)).not.toBeNull();
    }
  });

  it("the scan window is inside 10:00 to 16:00 and ordered", async () => {
    expect(CONFIG_KEYS.intraday_scan_start.default).toBe("10:30");
    expect(CONFIG_KEYS.intraday_scan_end.default).toBe("15:30");
    store.intraday_scan_start = "10:30";
    store.intraday_scan_end = "15:30";
    expect(await check("intraday_scan_start", "10:00")).toBeNull();
    expect(await check("intraday_scan_start", "09:59")).not.toBeNull();
    expect(await check("intraday_scan_start", "15:30")).not.toBeNull();
    expect(await check("intraday_scan_end", "16:00")).toBeNull();
    expect(await check("intraday_scan_end", "16:01")).not.toBeNull();
    expect(await check("intraday_scan_end", "10:30")).not.toBeNull();
    expect(await check("intraday_scan_end", "noon")).not.toBeNull();
  });

  it("M17_KEY_NAMES lists every new key once and all are registered", () => {
    expect(new Set(M17_KEY_NAMES).size).toBe(M17_KEY_NAMES.length);
    for (const k of M17_KEY_NAMES) expect(CONFIG_KEYS[k]).toBeDefined();
    expect(M17_KEY_NAMES).toHaveLength(19);
  });
});
