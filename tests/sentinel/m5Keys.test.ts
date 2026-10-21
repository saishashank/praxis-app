// @vitest-environment node
// M5 configuration keys (T2, docs/M5_design.md 4.11, D-096, D-097). The expected table is an
// independent transcription of ch.15 (l.119-122, 158, 163-165, 174-175, 189-198) and of the design:
// a change to a default or a bound in keys.ts must change it here too.
import { afterEach, describe, expect, it } from "vitest";
import { editText, parseConfigInput } from "@/lib/config/admin";
import {
  CONFIG_AREAS,
  CONFIG_KEYS,
  CONFIG_META,
  EMAIL_RETRY_POLICY,
  M5_KEY_NAMES,
  clockMinutes,
  type ConfigKey,
} from "@/lib/config/keys";
import { getConfig } from "@/lib/config/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const get = async () => undefined;
const check = (key: ConfigKey, v: unknown, g: (k: ConfigKey) => Promise<unknown> = get) =>
  CONFIG_KEYS[key].validate(v, g);

// [key, default, min, max, ref contains]. All Owner-editable (O).
const RANGED: readonly (readonly [ConfigKey, number, number, number, string])[] = [
  ["alert_p0_weight", 0.1, 0.01, 0.5, "D-097"],
  ["p0_email_daily_cap", 10, 1, 20, "D-097"],
  ["p0_batch_window_min", 5, 1, 15, "D-097"],
  ["watch_list_window", 20, 5, 60, "D-097"],
  ["owner_add_expiry_days", 90, 1, 90, "D-097"],
  ["sentinel_max_items_per_run", 40, 1, 40, "D-097"],
  ["email_daily_cap", 20, 5, 50, "l.189"],
  ["email_monthly_cap", 300, 50, 1000, "l.190"],
  ["unopened_review_banner_days", 3, 1, 14, "D-097"],
  ["unopened_review_incident_days", 7, 3, 14, "l.191"],
  ["attention_snooze_max_days", 7, 1, 14, "l.198"],
  ["tb_kw_confirm_sessions", 1, 1, 5, "D-096"],
];

const FIXED: readonly (readonly [ConfigKey, number])[] = [
  ["email_max_size_kb", 90],
  ["email_reserved_slots", 3],
  ["sentinel_body_max_kb", 256],
  ["test_email_min_interval_min", 10],
  ["test_email_daily_max", 3],
];

describe("M5 keys: ranged integers and numbers", () => {
  it("default, bounds, edit class and reference match the table", () => {
    for (const [key, def, min, max, ref] of RANGED) {
      const k = CONFIG_KEYS[key] as {
        default: unknown;
        range?: [number, number];
        editable: string;
        ref: string;
      };
      expect(k.default, key).toBe(def);
      expect(k.range, key).toEqual([min, max]);
      expect(k.editable, key).toBe("O");
      expect(k.ref, key).toContain(ref);
    }
  });

  it("every ranged key accepts both bounds and rejects values just outside them and wrong types", async () => {
    for (const [key, , min, max] of RANGED) {
      expect(await check(key, min), `${key} min`).toBeNull();
      expect(await check(key, max), `${key} max`).toBeNull();
      const intKey = CONFIG_META[key].input === "int";
      const eps = intKey ? 1 : 1e-6;
      expect(await check(key, min - eps), `${key} below`).not.toBeNull();
      expect(await check(key, max + eps), `${key} above`).not.toBeNull();
      for (const bad of ["1", null, Number.NaN, Number.POSITIVE_INFINITY, {}, [min]]) {
        expect(await check(key, bad), `${key} ${String(bad)}`).not.toBeNull();
      }
    }
    expect(await check("p0_email_daily_cap", 10.5)).toMatch(/whole number/);
    expect(await check("alert_p0_weight", 0.125)).toBeNull();
  });

  it("the spec ceilings are not exceeded: 40 items per call (PLT-075), 90-day expiry (AGT-014)", async () => {
    expect(await check("sentinel_max_items_per_run", 41)).not.toBeNull();
    expect(await check("owner_add_expiry_days", 91)).not.toBeNull();
  });
});

describe("M5 keys: fixed constants", () => {
  it("each has its default and refuses every edit", async () => {
    for (const [key, def] of FIXED) {
      expect(CONFIG_KEYS[key].default, key).toBe(def);
      expect(CONFIG_KEYS[key].editable, key).toBe("fixed");
      expect(await check(key, def), key).toMatch(/fixed/);
      expect(await check(key, 12345), key).toMatch(/fixed/);
    }
  });

  it("email_retry_policy is fixed at three attempts, 2 s, 5 s, 60 s and 8 s", async () => {
    expect(CONFIG_KEYS.email_retry_policy.default).toEqual({
      max_attempts: 3,
      in_request_delay_s: 2,
      retry_after_max_s: 5,
      next_invocation_min_s: 60,
      timeout_s: 8,
    });
    expect(EMAIL_RETRY_POLICY.max_attempts).toBe(3);
    expect(CONFIG_KEYS.email_retry_policy.editable).toBe("fixed");
    expect(await check("email_retry_policy", EMAIL_RETRY_POLICY)).toMatch(/fixed/);
  });
});

describe("M5 keys: times, switches and the watchdog pair", () => {
  it("clockMinutes parses HH:MM only", () => {
    expect(clockMinutes("20:40")).toBe(1240);
    expect(clockMinutes("00:00")).toBe(0);
    for (const bad of ["24:00", "9:00", "20:5", "20:60", "20-40", "", 2040, null]) {
      expect(clockMinutes(bad), String(bad)).toBeNull();
    }
  });

  it("defaults are ch.15: review 20:00 / partial 20:30 / send_by 20:45, watchdog 20:40 and 21:50, reminder on at 08:00", () => {
    expect(CONFIG_KEYS.evening_review_time.default).toBe("20:00");
    expect(CONFIG_KEYS.partial_at.default).toBe("20:30");
    expect(CONFIG_KEYS.send_by.default).toBe("20:45");
    expect(CONFIG_KEYS.watchdog_times.default).toEqual({ first: "20:40", second: "21:50" });
    expect(CONFIG_KEYS.attention_reminder_enabled.default).toBe("on");
    expect(CONFIG_KEYS.attention_reminder_time.default).toBe("08:00");
    // Spec-silent keys (D-096): the Morning Brief and the pause are off.
    expect(CONFIG_KEYS.morning_brief_enabled.default).toBe("off");
    expect(CONFIG_KEYS.morning_brief_time.default).toBe("08:00");
    expect(CONFIG_KEYS.evening_review_paused.default).toBe("off");
    for (const k of ["evening_review_time", "partial_at", "send_by", "watchdog_times"] as const) {
      expect(CONFIG_KEYS[k].editable).toBe("O");
      expect(CONFIG_KEYS[k].ref).toContain("D-097");
    }
  });

  it("the Evening Review times keep send time < partial_at < send_by", async () => {
    const cur: Record<string, string> = {
      evening_review_time: "20:00",
      partial_at: "20:30",
      send_by: "20:45",
    };
    const g = async (k: ConfigKey) => cur[k];
    expect(await check("evening_review_time", "20:00", g)).toBeNull();
    expect(await check("evening_review_time", "20:29", g)).toBeNull();
    expect(await check("evening_review_time", "20:30", g)).toMatch(/order/);
    expect(await check("evening_review_time", "21:00", g)).toMatch(/order/);
    expect(await check("partial_at", "20:01", g)).toBeNull();
    expect(await check("partial_at", "20:00", g)).toMatch(/order/);
    expect(await check("partial_at", "20:45", g)).toMatch(/order/);
    expect(await check("send_by", "20:31", g)).toBeNull();
    expect(await check("send_by", "20:30", g)).toMatch(/order/);
    expect(await check("send_by", "22:00", g)).toBeNull();
  });

  it("each review time has its own window and refuses a bad shape", async () => {
    const wide = async (k: ConfigKey) =>
      ({ evening_review_time: "19:30", partial_at: "20:00", send_by: "20:15" })[k as string];
    expect(await check("evening_review_time", "19:29", wide)).toMatch(/19:30 to 21:00/);
    expect(await check("evening_review_time", "21:01", wide)).toMatch(/19:30 to 21:00/);
    expect(await check("partial_at", "19:59", wide)).toMatch(/20:00 to 21:30/);
    expect(await check("send_by", "22:01", wide)).toMatch(/20:15 to 22:00/);
    for (const key of ["evening_review_time", "partial_at", "send_by"] as const) {
      for (const bad of ["8pm", "20.00", 2000, null, "", "25:00"]) {
        expect(await check(key, bad), `${key} ${String(bad)}`).toMatch(/HH:MM/);
      }
    }
  });

  it("the defaults are valid together (the default of each passes with the defaults of the others)", async () => {
    const g = async (k: ConfigKey) => CONFIG_KEYS[k].default;
    for (const k of ["evening_review_time", "partial_at", "send_by"] as const) {
      expect(await check(k, CONFIG_KEYS[k].default, g), k).toBeNull();
    }
  });

  it("watchdog_times: two ordered times in their windows, exactly the keys first and second", async () => {
    const d = CONFIG_KEYS.watchdog_times.default;
    expect(await check("watchdog_times", d)).toBeNull();
    expect(await check("watchdog_times", { first: "20:30", second: "21:00" })).toBeNull();
    expect(await check("watchdog_times", { first: "21:30", second: "23:00" })).toBeNull();
    expect(await check("watchdog_times", { first: "20:29", second: "21:50" })).toMatch(/first/);
    expect(await check("watchdog_times", { first: "21:31", second: "22:00" })).toMatch(/first/);
    expect(await check("watchdog_times", { first: "20:40", second: "20:59" })).toMatch(/second/);
    expect(await check("watchdog_times", { first: "20:40", second: "23:01" })).toMatch(/second/);
    expect(await check("watchdog_times", { first: "21:30", second: "21:00" })).toMatch(/earlier/);
    expect(await check("watchdog_times", { first: "21:00", second: "21:00" })).toMatch(/earlier/);
    expect(await check("watchdog_times", { first: "20:40" })).toMatch(/needs first and second/);
    expect(
      await check("watchdog_times", { first: "20:40", second: "21:50", third: "22:00" }),
    ).toMatch(/needs/);
    expect(await check("watchdog_times", ["20:40", "21:50"])).toMatch(/needs/);
    expect(await check("watchdog_times", { first: "x", second: "21:50" })).toMatch(/HH:MM/);
  });

  it("attention reminder and Morning Brief times keep their windows (06:00-22:00 and 06:00-10:00)", async () => {
    expect(await check("attention_reminder_time", "06:00")).toBeNull();
    expect(await check("attention_reminder_time", "22:00")).toBeNull();
    expect(await check("attention_reminder_time", "05:59")).toMatch(/06:00 to 22:00/);
    expect(await check("attention_reminder_time", "22:01")).toMatch(/06:00 to 22:00/);
    expect(await check("morning_brief_time", "06:00")).toBeNull();
    expect(await check("morning_brief_time", "10:00")).toBeNull();
    expect(await check("morning_brief_time", "10:01")).toMatch(/06:00 to 10:00/);
    expect(await check("morning_brief_time", "05:59")).toMatch(/06:00 to 10:00/);
  });

  it("the three switches accept only on or off", async () => {
    for (const key of [
      "attention_reminder_enabled",
      "morning_brief_enabled",
      "evening_review_paused",
    ] as const) {
      expect(await check(key, "on"), key).toBeNull();
      expect(await check(key, "off"), key).toBeNull();
      for (const bad of ["ON", "yes", true, 1, null, ""]) {
        expect(await check(key, bad), `${key} ${String(bad)}`).toMatch(/on, off/);
      }
    }
  });
});

describe("M5 keys: registry hygiene", () => {
  it("M5_KEY_NAMES lists 12 ranged + 5 fixed + 10 explicit keys, all registered, none repeated", () => {
    expect(M5_KEY_NAMES).toHaveLength(27);
    expect(new Set(M5_KEY_NAMES).size).toBe(27);
    for (const k of M5_KEY_NAMES) expect(CONFIG_KEYS[k], k).toBeDefined();
  });

  it("every M5 key sits in the Sentinel and email area with a label and bounds text", () => {
    for (const k of M5_KEY_NAMES) {
      expect(CONFIG_META[k].area, k).toBe("Sentinel and email");
      expect(CONFIG_META[k].label.length, k).toBeGreaterThan(3);
      expect(CONFIG_META[k].bounds.length, k).toBeGreaterThan(0);
    }
    expect(CONFIG_AREAS).toContain("Sentinel and email");
  });

  it("the form text of every default parses back to the default", () => {
    for (const k of M5_KEY_NAMES) {
      const d = CONFIG_KEYS[k].default;
      expect(parseConfigInput(CONFIG_META[k].input, editText(d)), k).toEqual({ value: d });
    }
  });

  it("the pre-existing keys the design reuses are unchanged: token_warning_days, sentinel_blind_alert_min", () => {
    expect(CONFIG_KEYS.token_warning_days.default).toEqual([14, 7, 2]);
    expect(CONFIG_KEYS.sentinel_blind_alert_min.default).toBe(15);
    expect(CONFIG_KEYS.r2_materiality_min.default).toBe(2);
  });

  it("an unset key reads its default from the store", async () => {
    const db = await freshDb("main");
    expect(await getConfig(db, "p0_email_daily_cap")).toBe(10);
    expect(await getConfig(db, "watchdog_times")).toEqual({ first: "20:40", second: "21:50" });
    expect(await getConfig(db, "morning_brief_enabled")).toBe("off");
    expect(await getConfig(db, "send_by")).toBe("20:45");
  });
});
