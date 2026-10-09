// @vitest-environment node
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_KEYS, isConfigKey } from "@/lib/config/keys";
import { ConfigError, getConfig, setConfig } from "@/lib/config/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const T = "2026-10-10T07:00:00.000Z";
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const set = (key: string, value: unknown, scope?: string) =>
  setConfig(db, { key, value, scope, userId: 1, reason: "test", now: T });

describe("config store", () => {
  it("falls back to registry defaults", async () => {
    expect(await getConfig(db, "session_lifetime_days")).toBe(14);
    expect(await getConfig(db, "quota_thresholds")).toEqual({
      notice: 0.7,
      alert: 0.9,
      degrade: 0.95,
    });
  });

  it("registry matches the M1 defaults", () => {
    const d = (k: keyof typeof CONFIG_KEYS) => CONFIG_KEYS[k].default;
    expect(d("retention_logs_days")).toBe(30);
    expect(d("retention_runs_days")).toBe(180);
    expect(d("retention_news_days")).toBe(400);
    expect(d("backup_retention")).toEqual({ daily: 14, weekly: 8, monthly: 12 });
    expect(d("storage_warn_gb")).toBe(2.5);
    expect(d("storage_ceiling_gb")).toBe(3);
    expect(d("rate_limits")).toEqual({
      signin_per_min_ip: 10,
      writes_per_min_user: 60,
      exports_per_hour_user: 5,
    });
    expect(d("hmac_max_age_s")).toBe(300);
    expect(d("token_warning_days")).toEqual([14, 7, 2]);
    expect(d("what_if_daily_limit_per_user")).toBe(5);
    expect(d("sentinel_blind_alert_min")).toBe(15);
    expect(isConfigKey("nope")).toBe(false);
    expect(isConfigKey("toString")).toBe(false);
  });

  it("set creates a version with before/after and previous_json", async () => {
    const a = await set("session_lifetime_days", 10);
    expect(a).toMatchObject({ before: 14, after: 10 });
    const b = await set("session_lifetime_days", 7);
    expect(b.before).toBe(10);
    expect(b.versionId).toBeGreaterThan(a.versionId);
    expect(await getConfig(db, "session_lifetime_days")).toBe(7);
    const r = await db.execute(
      "SELECT previous_json, changed_by_user_id, reason FROM config_version ORDER BY id",
    );
    expect(r.rows.map((x) => x.previous_json)).toEqual([null, "10"]);
    expect(r.rows[0]).toMatchObject({ changed_by_user_id: 1, reason: "test" });
  });

  it("scope falls back to global; scoped value wins", async () => {
    await set("what_if_daily_limit_per_user", 8);
    expect(await getConfig(db, "what_if_daily_limit_per_user", "AU")).toBe(8);
    await set("what_if_daily_limit_per_user", 2, "AU");
    expect(await getConfig(db, "what_if_daily_limit_per_user", "AU")).toBe(2);
    expect(await getConfig(db, "what_if_daily_limit_per_user")).toBe(8);
    expect(await getConfig(db, "sentinel_blind_alert_min", "AU")).toBe(15);
  });

  it("rejects unknown, fixed, out-of-bounds and wrongly typed values", async () => {
    await expect(set("nope", 1)).rejects.toThrow(ConfigError);
    await expect(set("hmac_max_age_s", 600)).rejects.toThrow(/fixed/);
    await expect(set("session_lifetime_days", 15)).rejects.toThrow(ConfigError);
    await expect(set("session_lifetime_days", 0)).rejects.toThrow(ConfigError);
    await expect(set("session_lifetime_days", "7")).rejects.toThrow(ConfigError);
    await expect(set("what_if_daily_limit_per_user", 21)).rejects.toThrow(ConfigError);
    await expect(set("what_if_daily_limit_per_user", 0)).resolves.toBeDefined();
    await expect(set("session_lifetime_days", 7, "bad scope")).rejects.toThrow(/scope/);
    const c = await db.execute("SELECT count(*) AS c FROM config_version");
    expect(Number(c.rows[0].c)).toBe(1);
  });

  it("validates storage thresholds against each other", async () => {
    await expect(set("storage_warn_gb", 0)).rejects.toThrow(ConfigError);
    await expect(set("storage_warn_gb", 3.5)).rejects.toThrow(/ceiling/);
    await expect(set("storage_ceiling_gb", 2)).rejects.toThrow(/warning/);
    await expect(set("storage_ceiling_gb", -1)).rejects.toThrow(ConfigError);
    await set("storage_ceiling_gb", 4);
    await set("storage_warn_gb", 3.5);
  });

  it("validates object and list values", async () => {
    await set("quota_thresholds", { notice: 0.5, alert: 0.8, degrade: 1 });
    await expect(
      set("quota_thresholds", { notice: 0.9, alert: 0.8, degrade: 1 }),
    ).rejects.toThrow();
    await expect(set("quota_thresholds", { notice: 0.5 })).rejects.toThrow();
    await expect(set("quota_thresholds", [1])).rejects.toThrow();
    await set("rate_limits", {
      signin_per_min_ip: 5,
      writes_per_min_user: 30,
      exports_per_hour_user: 2,
    });
    await expect(
      set("rate_limits", {
        signin_per_min_ip: 0,
        writes_per_min_user: 30,
        exports_per_hour_user: 2,
      }),
    ).rejects.toThrow();
    await set("backup_retention", { daily: 7, weekly: 4, monthly: 6 });
    await expect(set("backup_retention", { daily: 7 })).rejects.toThrow();
    await set("token_warning_days", [20, 5, 1]);
    await expect(set("token_warning_days", [5, 7])).rejects.toThrow();
    await expect(set("token_warning_days", [])).rejects.toThrow();
    await expect(set("token_warning_days", "x")).rejects.toThrow();
    await set("retention_runs_days", 90);
    await expect(set("retention_runs_days", 0)).rejects.toThrow();
  });
});
