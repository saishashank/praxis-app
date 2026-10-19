// @vitest-environment node
// M4 configuration keys (T2, docs/M4_design.md section 6 decisions 10, 24, 28; ch.15 as extracted in
// docs/M4_requirements.md sections 2 and 3). The expected table below is an independent
// transcription of the extract: a change to a default or a bound in keys.ts must change it here too.
import { afterEach, describe, expect, it } from "vitest";
import { parseConfigInput } from "@/lib/config/admin";
import {
  CONFIG_AREAS,
  CONFIG_KEYS,
  CONFIG_META,
  M5_KEY_NAMES,
  M6_KEY_NAMES,
  type ConfigKey,
} from "@/lib/config/keys";
import { getConfig, setConfig } from "@/lib/config/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const get = async () => undefined;
const check = (key: ConfigKey, v: unknown) => CONFIG_KEYS[key].validate(v, get);

// [key, default, min, max, edit]; B = Lane-B (ch.15 section 15.3 and l.110, l.116, l.117).
type Ranged = readonly [ConfigKey, number, number, number, "O" | "B"];
const FAMILY_TABLE: readonly Ranged[] = [
  ["f1_volume_ratio_min", 1.5, 1.2, 3, "B"],
  ["f1_rs_top_fraction", 0.2, 0.1, 0.3, "B"],
  ["f1_initial_stop_atr", 2, 1.5, 3, "B"],
  ["f1_trail_atr", 3, 2, 4, "B"],
  ["f1_time_stop", 40, 20, 60, "B"],
  ["f1_min_gain_pct", 5, 0, 10, "B"],
  ["f1_max_hold", 120, 60, 120, "B"],
  ["f1_high_lookback", 250, 120, 250, "B"],
  ["f2_event_ar_min_pct", 3, 2, 6, "B"],
  ["f2_lookback_sessions", 5, 3, 10, "B"],
  ["f2_stop_atr", 2.5, 1.5, 3.5, "B"],
  ["f2_time_stop", 60, 30, 90, "B"],
  ["f3_event_ar_min_pct", 4, 3, 8, "B"],
  ["f3_volume_ratio_min", 2, 1.5, 4, "B"],
  ["f3_max_gap_pct", 8, 5, 12, "B"],
  ["f3_trail_after_pct", 10, 5, 20, "B"],
  ["f3_trail_atr", 2.5, 1.5, 4, "B"],
  ["f3_time_exit", 20, 10, 40, "B"],
  ["f4_rsi2_max", 10, 5, 20, "B"],
  ["f4_rsi14_max", 30, 20, 35, "B"],
  ["f4_time_exit", 10, 5, 20, "B"],
  ["f4_stop_atr", 2, 1.5, 3, "B"],
  ["f5_volume_ratio_min", 3, 2, 5, "B"],
  ["f5_ar_min_pct", 3, 2, 6, "B"],
  ["f5_range_pos_min", 0.75, 0.6, 0.9, "B"],
  ["f5_stop_atr", 2.5, 1.5, 3.5, "B"],
  ["f5_stop_cap_pct", 20, 10, 25, "B"],
  ["f5_trail_atr", 3, 2, 4, "B"],
  ["f5_time_stop", 30, 15, 45, "B"],
  ["f6_min_classes", 3, 3, 4, "B"],
  ["f6_insider_min", 0.5, 0.25, 0.75, "B"],
  ["f6_short_drop_pp", 2, 1, 4, "B"],
  ["f6_stop_atr", 2, 1.5, 3, "B"],
  ["f6_time_stop", 20, 10, 40, "B"],
  ["reentry_block", 10, 5, 20, "B"],
];
const OTHER_RANGED: readonly Ranged[] = [
  ["max_open_positions", 2, 1, 2, "O"],
  ["rolling_start_step", 5, 5, 21, "O"],
  ["c2_live_per_family", 20, 10, 50, "O"],
  ["zero_edge_trials", 20000, 5000, 100000, "O"],
  ["barrier_k_up", 2, 1, 3, "O"],
  ["barrier_k_down", 1.5, 1, 3, "O"],
  ["llm_budget_r2_daily", 50000, 25000, 75000, "O"],
  ["nightly_tokens_per_market", 30000, 0, 40000, "O"],
  ["llm_cache_ttl_hours", 24, 1, 168, "O"],
  ["event_polarity_threshold_pct", 2, 0.5, 10, "B"], // default ch.15 l.117; bounds D-079
  ["insider_window_sessions", 30, 10, 60, "B"], // default ch.15 l.116; bounds D-079
  ["trial_budget_per_lineage", 20, 1, 100, "O"], // default ch.15 l.44; bounds D-079
  ["survivorship_flag_share_pct", 5, 1, 50, "O"],
  ["useful_edge_min_pct", 0.5, 0, 5, "O"],
  ["delta_bust_tolerance", 0.05, 0, 0.25, "O"],
  ["killswitch_max_looks_per_year", 1, 1, 52, "O"],
  ["replay_light_minutes", 30, 5, 120, "O"],
  ["replay_full_minutes", 90, 15, 360, "O"],
  ["nightly_compute_minutes", 10, 2, 60, "O"],
  ["turso_recent_sessions", 500, 260, 1000, "O"],
  ["event_backfill_years", 6, 1, 15, "O"],
  ["llm_budget_r1_daily", 60000, 30000, 90000, "O"],
  ["llm_budget_r3_daily", 25000, 12500, 37500, "O"],
  ["llm_budget_r5_daily", 10000, 5000, 15000, "O"],
  ["r2_materiality_min", 2, 1, 3, "O"],
];
const RANGED = [...FAMILY_TABLE, ...OTHER_RANGED];

// Fixed (edit "-") keys and their ch.15 / spec-text defaults.
const FIXED: readonly (readonly [ConfigKey, number | string])[] = [
  ["atr_period", 20],
  ["rsi_short_period", 2],
  ["rsi_long_period", 14],
  ["sma_exit_period", 5],
  ["sma_mid_period", 50],
  ["sma_trend_period", 200],
  ["return_window_sessions", 126],
  ["adv_window_sessions", 20],
  ["volume_ratio_window_sessions", 20],
  ["vol_window_sessions", 20],
  ["regime_vol_lookback_sessions", 1260],
  ["regime_fall_window_sessions", 5],
  ["short_interest_window_sessions", 10],
  ["f4_event_window_sessions", 3],
  ["day0_close_offset_min", 10],
  ["decision_cutoff", "18:10"],
  ["thesis_breakers_min", 3],
  ["thesis_breakers_max", 5],
  ["thesis_amber_fraction", 0.2],
  ["ledger_notional_aud", 600],
  ["alpha", 0.05],
  ["bootstrap_replications_min", 1000],
  ["bootstrap_replications_factor", 20],
  ["bootstrap_size_check_replications", 2000],
  ["bootstrap_block_min_sessions", 5],
  ["bootstrap_block_percentile", 75],
  ["min_blocks", 15],
  ["min_trades", 100],
  ["c2_controls_per_row", 20],
  ["active_lineages_floor", 6],
  ["split_holdout_min_sessions", 378],
  ["split_validation_min_sessions", 504],
  ["split_block_multiple", 15],
  ["split_development_min_sessions", 252],
  ["purge_extra_sessions", 20],
  ["survivorship_min_announcements", 3],
  ["survivorship_window_sessions", 60],
  ["forward_alpha_total", 0.1],
  ["forward_look_trades", 100],
  ["forward_min_months", 6],
  ["safety_check_min_neff", 8],
  ["pbo_max", 0.2],
  ["pbo_min_variants", 5],
  ["pbo_blocks", 10],
  ["dsr_min", 0.95],
  ["min_cohorts_ranked", 5],
  ["progress_min_neff", 3],
  ["scenario_min_n", 30],
  ["cost_feasibility_ratio", 2],
  ["stress_cost_profile", "P3"],
  ["stress_slippage_extra_pct", 50],
  ["barrier_horizon_sessions", 20],
  ["killswitch_trades_per_look", 20],
  ["killswitch_alpha_total", 0.05],
  ["killswitch_criteria", 3],
  ["killswitch_quiet_sessions", 60],
  ["event_coverage_min_pct", 90],
  ["zero_edge_seed", 20261018],
  ["sleeve_leverage", 10],
  ["reality_cap", 5],
];

const OBJECT_KEYS: readonly ConfigKey[] = [
  "regime_params",
  "insider_score_weights",
  "llm_market_share",
];

describe("M4 keys: defaults and bounds equal ch.15", () => {
  it("every ranged key has the ch.15 default, bounds and edit class", () => {
    for (const [key, def, min, max, edit] of RANGED) {
      const k = CONFIG_KEYS[key] as {
        default: unknown;
        editable: string;
        range?: [number, number];
      };
      expect(k.default, key).toBe(def);
      expect(k.range, key).toEqual([min, max]);
      expect(k.editable, key).toBe(edit);
    }
  });

  it("the Lane-B class is used for exactly the section 15.3 family keys, reentry, polarity and insider keys", () => {
    const b = (Object.keys(CONFIG_KEYS) as ConfigKey[])
      .filter((k) => CONFIG_KEYS[k].editable === "B")
      .sort();
    const expected = [
      ...FAMILY_TABLE.map((r) => r[0]),
      "event_polarity_threshold_pct",
      "insider_window_sessions",
      "insider_score_weights",
    ].sort();
    expect(b).toEqual(expected);
  });

  it("every ranged key accepts both bounds and rejects values just outside them", async () => {
    for (const [key, , min, max] of RANGED) {
      expect(await check(key, min), `${key} min`).toBeNull();
      expect(await check(key, max), `${key} max`).toBeNull();
      const eps = Number.isInteger(min) && Number.isInteger(max) ? 1 : 1e-6;
      const intKey = CONFIG_META[key].input === "int";
      expect(await check(key, min - (intKey ? 1 : eps)), `${key} below`).not.toBeNull();
      expect(await check(key, max + (intKey ? 1 : eps)), `${key} above`).not.toBeNull();
      for (const bad of ["1", null, Number.NaN, Number.POSITIVE_INFINITY, {}, [min]]) {
        expect(await check(key, bad), `${key} ${String(bad)}`).not.toBeNull();
      }
    }
  });

  it("whole-number keys refuse fractions; number keys accept them", async () => {
    expect(await check("f1_time_stop", 40.5)).toMatch(/whole number/);
    expect(await check("f6_min_classes", 3.5)).toMatch(/whole number/);
    expect(await check("f1_volume_ratio_min", 1.25)).toBeNull();
    expect(await check("f5_range_pos_min", 0.8)).toBeNull();
  });

  it("every fixed key has its default and refuses every edit", async () => {
    for (const [key, def] of FIXED) {
      expect(CONFIG_KEYS[key].default, key).toBe(def);
      expect(CONFIG_KEYS[key].editable, key).toBe("fixed");
      expect(await check(key, def), key).toMatch(/fixed/);
      expect(await check(key, 12345), key).toMatch(/fixed/);
    }
  });

  it("the set of M4 keys is exactly the three tables above plus the objects (nothing unlisted)", () => {
    const m3 = new Set([
      "retention_logs_days",
      "retention_runs_days",
      "retention_news_days",
      "backup_retention",
      "storage_warn_gb",
      "storage_ceiling_gb",
      "quota_thresholds",
      "session_lifetime_days",
      "rate_limits",
      "hmac_max_age_s",
      "token_warning_days",
      "what_if_daily_limit_per_user",
      "sentinel_blind_alert_min",
      "turso_writes_ceiling_month",
      "turso_reads_ceiling_month",
      "turso_staging_share",
      "actions_minutes_soft_ceiling",
      "llm_daily_budget_total",
      "yahoo_chunk_size",
      "yahoo_min_gap_s",
      "refetch_diff_flag",
      "suspect_move",
      "u1_quality_gate",
      "retention_flag_days",
      "corporate_action_auto_apply_sessions",
      "corporate_action_price_tolerance",
      "market_mode",
      "cost_profile_default",
      "stall_floor_bps",
      "untradeable_adv_pct",
      "stall_sessions",
      "stall_parcel_rejections",
      "timeout_sessions",
      "c1_etf_code",
      "pii_hash_after_revocation_days",
      ...M5_KEY_NAMES, // the M5 keys have their own table in tests/sentinel/m5Keys.test.ts
      ...M6_KEY_NAMES, // the M6 keys have their own table in tests/learning/m6Keys.test.ts
    ]);
    const listed = new Set<string>([
      ...RANGED.map((r) => r[0]),
      ...FIXED.map((r) => r[0]),
      ...OBJECT_KEYS,
    ]);
    const all = Object.keys(CONFIG_KEYS);
    expect(all.filter((k) => !m3.has(k) && !listed.has(k))).toEqual([]);
    expect(all.length).toBe(m3.size + listed.size);
  });

  it("[VERIFY] flags from the extract are kept in the key text", () => {
    expect(CONFIG_KEYS.reality_cap.ref).toContain("[VERIFY]");
    expect(CONFIG_KEYS.day0_close_offset_min.ref).toContain("[VERIFY]");
    expect(CONFIG_META.reality_cap.label).toContain("[VERIFY]");
    expect(CONFIG_META.day0_close_offset_min.label).toContain("[VERIFY]");
    expect(CONFIG_KEYS.llm_market_share.ref).toContain("[VERIFY");
    expect(CONFIG_KEYS.event_polarity_threshold_pct.ref).toContain("D-079");
  });

  it("each key has metadata in a listed area, and the default round-trips through its input type", () => {
    for (const k of Object.keys(CONFIG_KEYS) as ConfigKey[]) {
      const m = CONFIG_META[k];
      expect(CONFIG_AREAS, k).toContain(m.area);
      expect(m.label.length, k).toBeGreaterThan(3);
      expect(m.bounds.length, k).toBeGreaterThan(0);
    }
    for (const [key, def] of FIXED) {
      const m = CONFIG_META[key];
      expect(m.bounds).toBe("fixed");
      expect(parseConfigInput(m.input, String(def))).toEqual({ value: def });
    }
  });
});

describe("M4 object keys", () => {
  it("regime_params: default is ch.15 l.115 and the ordering and ranges are enforced", async () => {
    const d = CONFIG_KEYS.regime_params.default;
    expect(d).toEqual({
      sma_sessions: 200,
      vol_pct_riskoff: 70,
      vol_pct_shock: 95,
      vol_pct_riskon: 50,
      fall5_pct: 7,
      exit_hysteresis: 3,
    });
    expect(CONFIG_KEYS.regime_params.editable).toBe("O");
    expect(await check("regime_params", d)).toBeNull();
    const bad = (patch: object) => check("regime_params", { ...d, ...patch });
    expect(await bad({ vol_pct_riskon: 70 })).toMatch(/vol_pct_riskon < vol_pct_riskoff/);
    expect(await bad({ vol_pct_riskoff: 96 })).toMatch(/vol_pct_riskon < vol_pct_riskoff/);
    expect(await bad({ vol_pct_shock: 101 })).toMatch(/<= 100/);
    expect(await bad({ vol_pct_riskon: 0 })).toMatch(/<= 100/);
    expect(await bad({ sma_sessions: 20 })).toMatch(/sma_sessions/);
    expect(await bad({ sma_sessions: 200.5 })).toMatch(/sma_sessions/);
    expect(await bad({ fall5_pct: 0 })).toMatch(/fall5_pct/);
    expect(await bad({ fall5_pct: 51 })).toMatch(/fall5_pct/);
    expect(await bad({ exit_hysteresis: 0 })).toMatch(/exit_hysteresis/);
    expect(await bad({ exit_hysteresis: 11 })).toMatch(/exit_hysteresis/);
    expect(await bad({ extra: 1 })).toMatch(/needs/);
    expect(await check("regime_params", { sma_sessions: 200 })).toMatch(/needs/);
    expect(await check("regime_params", [1])).toMatch(/needs/);
    expect(await bad({ vol_pct_shock: "95" })).not.toBeNull();
  });

  it("insider_score_weights: ch.15 l.116 default 0.5 / 0.25 / 0.25, Lane B, each 0 to 1", async () => {
    const d = CONFIG_KEYS.insider_score_weights.default;
    expect(d).toEqual({ director_net: 0.5, holder_new_or_increase: 0.25, holder_decrease: 0.25 });
    expect(CONFIG_KEYS.insider_score_weights.editable).toBe("B");
    expect(await check("insider_score_weights", d)).toBeNull();
    expect(await check("insider_score_weights", { ...d, director_net: 1 })).toBeNull();
    expect(await check("insider_score_weights", { ...d, director_net: 1.01 })).toMatch(/0 to 1/);
    expect(await check("insider_score_weights", { ...d, holder_decrease: -0.1 })).toMatch(/0 to 1/);
    expect(await check("insider_score_weights", { director_net: 0.5 })).toMatch(/needs/);
  });

  it("llm_market_share: AU only, each share 0 to 1", async () => {
    expect(CONFIG_KEYS.llm_market_share.default).toEqual({ AU: 1 });
    expect(await check("llm_market_share", { AU: 0.5 })).toBeNull();
    expect(await check("llm_market_share", { AU: 1.5 })).toMatch(/0 to 1/);
    expect(await check("llm_market_share", { US: 1 })).toBe("unknown market");
    expect(await check("llm_market_share", {})).toMatch(/list a share/);
  });

  it("object defaults round-trip through the edit form", () => {
    for (const k of OBJECT_KEYS) {
      const text = JSON.stringify(CONFIG_KEYS[k].default);
      expect(parseConfigInput(CONFIG_META[k].input, text), k).toEqual({
        value: CONFIG_KEYS[k].default,
      });
    }
  });

  it("the stage-wise role budgets fit inside the daily total at the defaults", () => {
    const sum =
      (CONFIG_KEYS.llm_budget_r1_daily.default as number) +
      (CONFIG_KEYS.llm_budget_r2_daily.default as number) +
      (CONFIG_KEYS.llm_budget_r3_daily.default as number) +
      (CONFIG_KEYS.llm_budget_r5_daily.default as number);
    expect(sum).toBeLessThanOrEqual(CONFIG_KEYS.llm_daily_budget_total.default);
  });
});

describe("M4 keys in the config store", () => {
  it("a B key and an O key can be set within bounds; out of bounds and fixed keys are refused", async () => {
    const db = await freshDb("main");
    const now = "2026-10-18T00:00:00.000Z";
    await setConfig(db, { key: "f1_trail_atr", value: 3.5, userId: 1, now });
    expect(await getConfig(db, "f1_trail_atr")).toBe(3.5);
    await setConfig(db, { key: "rolling_start_step", value: 10, userId: 1, now });
    expect(await getConfig(db, "rolling_start_step")).toBe(10);
    await expect(
      setConfig(db, { key: "f1_trail_atr", value: 4.5, userId: 1, now }),
    ).rejects.toThrow(/invalid value/);
    await expect(setConfig(db, { key: "atr_period", value: 21, userId: 1, now })).rejects.toThrow(
      /fixed/,
    );
    await expect(
      setConfig(db, { key: "regime_params", value: { sma_sessions: 1 }, userId: 1, now }),
    ).rejects.toThrow(/invalid value/);
    expect(await getConfig(db, "atr_period")).toBe(20);
  });
});
