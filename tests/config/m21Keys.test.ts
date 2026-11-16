// @vitest-environment node
// M21 A1 (D-1212, D-1213, D-1231; ch. 15 §15.11.2; AT-77 defaults): the nine keys, as an independent transcription. A
// change to a default or a bound in keys.ts must change it here too. A fresh database reads every default as listed.
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_KEYS,
  CONFIG_META,
  M21_KEY_NAMES,
  type ConfigKey,
  type ConfigKeyDef,
} from "@/lib/config/keys";
import { parseConfigInput } from "@/lib/config/admin";
import { getConfig } from "@/lib/config/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const store: Record<string, unknown> = {};
const get = async (k: ConfigKey) => store[k];
const check = (key: ConfigKey, v: unknown) => CONFIG_KEYS[key].validate(v, get);

const NAMES = [
  "committee_enabled",
  "intraday_sweep_enabled",
  "intraday_sweep_requests_per_slot",
  "stop_hit_email_default",
  "owner_real_money_tools",
  "app_public_domain",
  "pwa_push_enabled",
  "expert_poll_items_daily",
  "llm_proposals_per_month",
] as const;

// [key, default, min, max]
const RANGED: ReadonlyArray<readonly [ConfigKey, number, number, number]> = [
  ["intraday_sweep_requests_per_slot", 5, 0, 20],
  ["expert_poll_items_daily", 150, 0, 500],
  ["llm_proposals_per_month", 3, 0, 10],
];
const SWITCHES = [
  "committee_enabled",
  "intraday_sweep_enabled",
  "stop_hit_email_default",
  "owner_real_money_tools",
  "pwa_push_enabled",
] as const satisfies readonly ConfigKey[];

describe("M21 keys (§15.11.2)", () => {
  it("M21_KEY_NAMES lists the nine keys once and all are registered, Owner-editable, with plain-words labels", () => {
    expect([...M21_KEY_NAMES].sort()).toEqual([...NAMES].sort());
    expect(M21_KEY_NAMES).toHaveLength(9);
    expect(new Set(M21_KEY_NAMES).size).toBe(9);
    for (const k of M21_KEY_NAMES) {
      expect(CONFIG_KEYS[k].editable, k).toBe("O");
      expect(CONFIG_META[k].label.length, k).toBeGreaterThan(8);
      expect(CONFIG_META[k].label, k).not.toMatch(/\b(AGT|CXA|EML|UXN|PLT|KB|D)-\d+/); // D-922: no internal code
    }
  });

  it.each(RANGED)("%s: default %f, bounds %f to %f", async (key, def, min, max) => {
    const k = CONFIG_KEYS[key] as ConfigKeyDef;
    expect(k.default).toBe(def);
    expect(k.range).toEqual([min, max]);
    for (const v of [def, min, max]) expect(await check(key, v)).toBeNull();
    expect(await check(key, min - 1)).not.toBeNull();
    expect(await check(key, max + 1)).not.toBeNull();
    expect(await check(key, "1")).not.toBeNull();
    expect(await check(key, min + 0.5)).not.toBeNull();
  });

  it("the switches are on/off text, default off", async () => {
    for (const key of SWITCHES) {
      expect(CONFIG_KEYS[key].default, key).toBe("off");
      expect(await check(key, "off"), key).toBeNull();
      expect(await check(key, "maybe"), key).not.toBeNull();
      expect(await check(key, true), key).not.toBeNull();
    }
    for (const key of SWITCHES.filter((k) => k !== "pwa_push_enabled")) {
      expect(await check(key, "on"), key).toBeNull();
    }
  });

  it("pwa_push_enabled refuses 'on': web push is not built (D-1231)", async () => {
    expect(await check("pwa_push_enabled", "on")).toBe(
      "Web push is not built: e-mail stays the alert channel",
    );
  });

  it("app_public_domain: empty by default; a lowercase host name with a dot, nothing else", async () => {
    expect(CONFIG_KEYS.app_public_domain.default).toBe("");
    for (const ok of ["", "praxis.example.com", "my-site.co", "a.b", "x".repeat(60) + ".com"]) {
      expect(await check("app_public_domain", ok), ok).toBeNull();
    }
    for (const bad of [
      "localhost",
      "https://praxis.example.com",
      "praxis.example.com:8443",
      "praxis.example.com/app",
      "*.example.com",
      "Praxis.Example.com",
      "-bad.example.com",
      "bad-.example.com",
      "a..b",
      ".example.com",
      "example.com.",
      "user@example.com",
      "exa mple.com",
      "a.".repeat(130) + "com",
      "x".repeat(64) + ".com",
      42,
      null,
    ]) {
      expect(await check("app_public_domain", bad), String(bad)).not.toBeNull();
    }
  });

  it("app_public_domain is the one text key that may be cleared; every plain text key still refuses an empty value (D-1240)", async () => {
    expect(CONFIG_META.app_public_domain.input).toBe("text_optional");
    expect(parseConfigInput("text_optional", "  ")).toEqual({ value: "" });
    expect(parseConfigInput("text_optional", " a.example.com ")).toEqual({
      value: "a.example.com",
    });
    expect(parseConfigInput("text", "")).toHaveProperty("error");
    expect(parseConfigInput("int", "")).toHaveProperty("error");
    const optional = (Object.keys(CONFIG_KEYS) as ConfigKey[]).filter(
      (k) => CONFIG_META[k].input === "text_optional",
    );
    expect(optional).toEqual(["app_public_domain"]);
  });

  it("a fresh database reads every default as listed", async () => {
    const db = await freshDb("main");
    const want: Record<string, unknown> = {
      committee_enabled: "off",
      intraday_sweep_enabled: "off",
      intraday_sweep_requests_per_slot: 5,
      stop_hit_email_default: "off",
      owner_real_money_tools: "off",
      app_public_domain: "",
      pwa_push_enabled: "off",
      expert_poll_items_daily: 150,
      llm_proposals_per_month: 3,
    };
    for (const k of NAMES) expect(await getConfig(db, k), k).toEqual(want[k]);
  });

  it("the per-user and rule parameters are not config keys (D-1212)", () => {
    for (const k of ["broker_links", "target_r", "target_pct"]) {
      expect(Object.prototype.hasOwnProperty.call(CONFIG_KEYS, k), k).toBe(false);
    }
  });
});
