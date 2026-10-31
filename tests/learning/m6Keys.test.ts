// @vitest-environment node
// M6 configuration keys (T2, docs/M6_design.md 4.12, D-110, D-111). The expected table is an
// independent transcription of ch.15 (l.40-75, 124, 170, 182, 207-215) and of the design: a change
// to a default or a bound in keys.ts must change it here too. Also proves that the reviewed constants
// that now have keys (D-085, D-090, D-091, D-095) keep their old values through AgentParams.
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { editText, parseConfigInput } from "@/lib/config/admin";
import {
  CONFIG_AREAS,
  CONFIG_KEYS,
  CONFIG_META,
  injectionPhrasesOf,
  M6_KEY_NAMES,
  type ConfigKey,
  type ConfigKeyDef,
} from "@/lib/config/keys";
import { getConfig } from "@/lib/config/store";
import { DEFAULT_INJECTION_PHRASES } from "@/lib/llm/injection";
import { cmpRat, makeRational } from "@/lib/money/rational";
import { CIF_HORIZONS, INTERVAL_CONFIDENCE } from "@/lib/replay/cif";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const get = async () => undefined;
const check = (key: ConfigKey, v: unknown) => CONFIG_KEYS[key].validate(v, get);

// [key, default, min, max, ref contains]. All Owner-editable (O).
const RANGED: readonly (readonly [ConfigKey, number, number, number, string])[] = [
  ["max_challengers", 8, 1, 8, "l.66"],
  ["max_promotions_per_week", 3, 0, 3, "l.67"],
  ["shakedown_sessions", 10, 5, 20, "l.68"],
  ["critic_llm_calls_per_night", 10, 0, 20, "D-111"],
  ["factor_min_bucket_n", 30, 20, 100, "AGT-112"],
  // M17 O-76 (c3a942e): 10 picks per profile and no family cap by default
  ["picks_per_profile", 10, 0, 10, "AGT-113"],
  ["picks_max_per_family", 10, 1, 10, "AGT-113"],
  ["pick_valid_sessions", 2, 1, 5, "AGT-113"],
  ["pick_success_min_n", 30, 10, 200, "D-111"],
];

// [key, default, area]. All fixed.
const FIXED: readonly (readonly [ConfigKey, number, string])[] = [
  ["lesson_L0_min_n", 10, "Learning and knowledge"],
  ["lesson_L1_min_n", 30, "Learning and knowledge"],
  ["lesson_bootstrap_level", 0.1, "Learning and knowledge"],
  ["l2_alpha_w0", 0.1, "Learning and knowledge"],
  ["l2_alpha_payout", 0.05, "Learning and knowledge"],
  ["comparisons_fdr_q", 0.1, "Learning and knowledge"],
  ["comparison_look_alpha", 0.05, "Learning and knowledge"],
  ["comparison_lockout_sessions", 60, "Learning and knowledge"],
  ["comparison_min_rows", 30, "Learning and knowledge"],
  ["playbook_max_tokens", 1500, "Learning and knowledge"],
  ["learning_loop_minutes", 5, "Learning and knowledge"],
  ["challenger_generator_per_week", 1, "Learning and knowledge"],
  ["code_reuse_gap_sessions", 120, "Validation statistics"],
  ["dsr_default_sr_variance", 0.0001, "Validation statistics"],
  ["cif_confidence", 0.9, "Validation statistics"],
  ["arn011_gain_sessions", 5, "Strategy families"],
  ["arn011_gain_max", 1, "Strategy families"],
  ["arn011_one_day_gain", 0.3, "Strategy families"],
  ["arn011_volume_ratio_max", 10, "Strategy families"],
  ["arn011_placement_window", 120, "Strategy families"],
  ["arn011_placements_max", 2, "Strategy families"],
  ["arn011_raise_window", 60, "Strategy families"],
  ["arn011_query_window", 2, "Strategy families"],
  ["arn011_consolidation_window", 90, "Strategy families"],
  ["arn011_range_fraction", 0.25, "Strategy families"],
  ["arn011_range_days_window", 5, "Strategy families"],
  ["arn011_range_days_min", 3, "Strategy families"],
  ["f5_dry_up_ratio", 0.5, "Strategy families"],
  ["f5_dry_up_sessions", 3, "Strategy families"],
];

const EXPLICIT: readonly ConfigKey[] = [
  "llm_classifier_model",
  "llm_injection_phrases",
  "factor_buckets",
  "kb_archive_time",
  "pick_profiles",
  "profile_portfolio_amount",
  "cif_horizons_sessions",
  "progress_nav_edges_ppm",
  "progress_sessions_edges",
];

describe("M6 keys: ranged (Owner-editable) keys", () => {
  for (const [key, def, min, max, ref] of RANGED) {
    it(`${key}: default ${def}, bounds ${min}..${max}, edit class O`, async () => {
      const k = CONFIG_KEYS[key];
      expect(k.default).toBe(def);
      expect(k.editable).toBe("O");
      expect((k as ConfigKeyDef).range).toEqual([min, max]);
      expect(k.ref).toContain(ref);
      expect(await check(key, min)).toBeNull();
      expect(await check(key, max)).toBeNull();
      expect(await check(key, min - 1)).not.toBeNull();
      expect(await check(key, max + 1)).not.toBeNull();
      expect(await check(key, min + 0.5)).not.toBeNull();
      expect(await check(key, "5")).not.toBeNull();
    });
  }
  it("the agent-chosen bounds are marked D-111 and the ch.15 ones are not", () => {
    for (const k of ["critic_llm_calls_per_night", "pick_success_min_n"] as const) {
      expect(CONFIG_KEYS[k].ref).toContain("D-111");
    }
    for (const k of ["max_challengers", "max_promotions_per_week", "shakedown_sessions"] as const) {
      expect(CONFIG_KEYS[k].ref).not.toContain("D-111");
    }
  });
});

describe("M6 keys: fixed keys", () => {
  for (const [key, def, area] of FIXED) {
    it(`${key}: fixed at ${def} in ${area}`, async () => {
      const k = CONFIG_KEYS[key];
      expect(k.default).toBe(def);
      expect(k.editable).toBe("fixed");
      expect(await check(key, def)).toMatch(/fixed/);
      expect(CONFIG_META[key].area).toBe(area);
      expect(CONFIG_META[key].bounds).toBe("fixed");
    });
  }
});

describe("M6 keys: explicit keys", () => {
  it("llm_classifier_model: none by default; provider:model only", async () => {
    expect(CONFIG_KEYS.llm_classifier_model.default).toBe("none");
    expect(CONFIG_KEYS.llm_classifier_model.editable).toBe("O");
    expect(await check("llm_classifier_model", "none")).toBeNull();
    expect(await check("llm_classifier_model", "groq:llama-guard-3")).toBeNull();
    for (const bad of ["", "None", "groq", ":x", 1, null, "a b:c"]) {
      expect(await check("llm_classifier_model", bad), String(bad)).not.toBeNull();
    }
  });

  it("llm_injection_phrases: default is the built-in v1 list; shape and phrase checks", async () => {
    const d = CONFIG_KEYS.llm_injection_phrases.default as { version: string; phrases: string[] };
    expect(d.version).toBe("v1");
    expect(d.phrases).toEqual([...DEFAULT_INJECTION_PHRASES]);
    expect(CONFIG_KEYS.llm_injection_phrases.editable).toBe("O");
    expect(await check("llm_injection_phrases", d)).toBeNull();
    expect(
      await check("llm_injection_phrases", { version: "v2", phrases: ["do as I say"] }),
    ).toBeNull();
    for (const bad of [
      { phrases: ["abc"] },
      { version: "", phrases: ["abc"] },
      { version: "v1", phrases: [] },
      { version: "v1", phrases: ["ab"] },
      { version: "v1", phrases: ["x".repeat(121)] },
      { version: "v1", phrases: ["Same phrase", "same PHRASE"] },
      { version: "v1", phrases: [1] },
      { version: "v1", phrases: Array.from({ length: 201 }, (_, i) => `phrase ${i}`) },
      { version: "v1", phrases: ["abc"], extra: 1 },
      ["abc"],
      "abc",
    ]) {
      expect(
        await check("llm_injection_phrases", bad),
        JSON.stringify(bad).slice(0, 40),
      ).not.toBeNull();
    }
    expect(injectionPhrasesOf(d)).toEqual(DEFAULT_INJECTION_PHRASES);
    expect(injectionPhrasesOf({ version: "v2", phrases: ["a b c"] })).toEqual(["a b c"]);
    expect(injectionPhrasesOf("junk")).toEqual(DEFAULT_INJECTION_PHRASES);
    expect(injectionPhrasesOf(undefined)).toEqual(DEFAULT_INJECTION_PHRASES);
  });

  it("factor_buckets and kb_archive_time", async () => {
    expect(CONFIG_KEYS.factor_buckets.default).toBe("terciles");
    expect(await check("factor_buckets", "quintiles")).toBeNull();
    expect(await check("factor_buckets", "deciles")).not.toBeNull();
    expect(CONFIG_KEYS.kb_archive_time.default).toBe("22:15");
    expect(await check("kb_archive_time", "21:00")).toBeNull();
    expect(await check("kb_archive_time", "23:00")).toBeNull();
    for (const bad of ["20:59", "23:01", "22:5", "2215", 2215]) {
      expect(await check("kb_archive_time", bad), String(bad)).not.toBeNull();
    }
  });

  it("pick_profiles: the ch.15 caps by default; names, tiers and caps are checked", async () => {
    const d = CONFIG_KEYS.pick_profiles.default as Record<string, Record<string, unknown>>;
    expect(d.aggressive).toEqual({
      tiers: ["U1", "U2", "U3"],
      max_pct_per_pick: 20,
      risk_pct_per_pick: 2,
    });
    expect(d.balanced).toEqual({ tiers: ["U1", "U2"], max_pct_per_pick: 10, risk_pct_per_pick: 1 });
    expect(d.conservative).toEqual({ tiers: ["U1"], max_pct_per_pick: 5, risk_pct_per_pick: 0.5 });
    expect(await check("pick_profiles", d)).toBeNull();
    const one = { tiers: ["U1"], max_pct_per_pick: 5, risk_pct_per_pick: 1 };
    expect(await check("pick_profiles", { neutral: one })).toBeNull();
    for (const bad of [
      {},
      { "Bad Name": one },
      { x: { ...one, tiers: [] } },
      { x: { ...one, tiers: ["U4"] } },
      { x: { ...one, tiers: ["U1", "U1"] } },
      { x: { ...one, max_pct_per_pick: 101 } },
      { x: { ...one, risk_pct_per_pick: -1 } },
      { x: { tiers: ["U1"], max_pct_per_pick: 5 } },
      { x: { ...one, extra: 1 } },
      [],
    ]) {
      expect(await check("pick_profiles", bad), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it("profile_portfolio_amount: A$1,000 to A$1,000,000 per profile", async () => {
    expect(CONFIG_KEYS.profile_portfolio_amount.default).toEqual({
      aggressive: 10000,
      balanced: 10000,
      conservative: 10000,
    });
    expect(await check("profile_portfolio_amount", { balanced: 1000 })).toBeNull();
    expect(await check("profile_portfolio_amount", { balanced: 1_000_000 })).toBeNull();
    for (const bad of [
      { balanced: 999 },
      { balanced: 1_000_001 },
      { balanced: 1500.5 },
      {},
      { "X y": 5000 },
    ]) {
      expect(await check("profile_portfolio_amount", bad), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it("the three D-091 lists are fixed with the reviewed values", async () => {
    expect(CONFIG_KEYS.cif_horizons_sessions.default).toEqual([63, 126, 252]);
    expect(CONFIG_KEYS.progress_nav_edges_ppm.default).toEqual([
      600_000, 800_000, 1_000_000, 1_200_000, 1_500_000, 1_800_000,
    ]);
    expect(CONFIG_KEYS.progress_sessions_edges.default).toEqual([21, 63, 126, 189]);
    for (const k of [
      "cif_horizons_sessions",
      "progress_nav_edges_ppm",
      "progress_sessions_edges",
    ] as const) {
      expect(CONFIG_KEYS[k].editable).toBe("fixed");
      expect(CONFIG_META[k].input).toBe("list");
    }
  });
});

describe("M6 keys: registry hygiene", () => {
  it("M6_KEY_NAMES lists 9 ranged + 29 fixed + 9 explicit keys, all registered, none repeated", () => {
    expect(M6_KEY_NAMES).toHaveLength(RANGED.length + FIXED.length + EXPLICIT.length);
    expect(M6_KEY_NAMES).toHaveLength(47);
    expect(new Set(M6_KEY_NAMES).size).toBe(47);
    for (const k of M6_KEY_NAMES) expect(CONFIG_KEYS[k], k).toBeDefined();
    for (const k of [...RANGED.map((r) => r[0]), ...FIXED.map((r) => r[0]), ...EXPLICIT]) {
      expect(M6_KEY_NAMES, k).toContain(k);
    }
  });

  it("the Learning and knowledge area exists and every M6 key has a label and bounds text", () => {
    expect(CONFIG_AREAS).toContain("Learning and knowledge");
    for (const k of M6_KEY_NAMES) {
      expect(CONFIG_AREAS, k).toContain(CONFIG_META[k].area);
      expect(CONFIG_META[k].label.length, k).toBeGreaterThan(3);
      expect(CONFIG_META[k].bounds.length, k).toBeGreaterThan(0);
    }
  });

  it("the form text of every default parses back to the default", () => {
    for (const k of M6_KEY_NAMES) {
      const d = CONFIG_KEYS[k].default;
      expect(parseConfigInput(CONFIG_META[k].input, editText(d)), k).toEqual({ value: d });
    }
  });

  it("every M6 default is accepted by its own validator unless the key is fixed", async () => {
    for (const k of M6_KEY_NAMES) {
      if (CONFIG_KEYS[k].editable === "fixed") continue;
      expect(await check(k, CONFIG_KEYS[k].default), k).toBeNull();
    }
  });

  it("an unset key reads its default from the store", async () => {
    const db = await freshDb("main");
    expect(await getConfig(db, "max_challengers")).toBe(8);
    expect(await getConfig(db, "playbook_max_tokens")).toBe(1500);
    expect(await getConfig(db, "llm_classifier_model")).toBe("none");
  });
});

describe("reviewed constants that now have keys keep their values (D-085, D-090, D-091, D-095)", () => {
  const p = defaultAgentParams();

  it("ARN-011 thresholds equal the reviewed ARN011_V1 numbers", () => {
    const a = p.arn011;
    expect(a.gainSessions).toBe(5);
    expect(cmpRat(a.gainMax, makeRational(1n, 1n))).toBe(0);
    expect(cmpRat(a.oneDayGain, makeRational(3n, 10n))).toBe(0);
    expect(cmpRat(a.volumeRatioMax, makeRational(10n, 1n))).toBe(0);
    expect(a.placementWindow).toBe(120);
    expect(a.placementsMax).toBe(2);
    expect(a.raiseWindow).toBe(60);
    expect(a.queryWindow).toBe(2);
    expect(a.consolidationWindow).toBe(90);
    expect(cmpRat(a.rangeFraction, makeRational(1n, 4n))).toBe(0);
    expect(a.rangeDaysWindow).toBe(5);
    expect(a.rangeDaysMin).toBe(3);
  });

  it("the F5 volume exit is 0.5 for 3 sessions", () => {
    expect(cmpRat(p.specConstants.f5DryUpRatio, makeRational(1n, 2n))).toBe(0);
    expect(p.specConstants.f5DryUpSessions).toBe(3);
  });

  it("CIF horizons, confidence, progress buckets, code-reuse gap and the DSR fallback", () => {
    expect(p.cif.horizons).toEqual([63, 126, 252]);
    expect(p.cif.confidence).toBe(0.9);
    expect(CIF_HORIZONS).toEqual([63, 126, 252]);
    expect(INTERVAL_CONFIDENCE).toBe(0.9);
    expect(p.progress.sessionsEdges).toEqual([21, 63, 126, 189]);
    expect(p.progress.navEdgesPpm).toEqual([
      600_000, 800_000, 1_000_000, 1_200_000, 1_500_000, 1_800_000,
    ]);
    expect(p.stats.codeReuseGapSessions).toBe(120);
    expect(p.stats.dsrDefaultSrVariance).toBe(1e-4);
  });

  it("the lineage floor is the key itself (LINEAGES_FLOOR_MIN is gone)", () => {
    expect(p.stats.activeLineagesFloor).toBe(6);
  });

  it("learning and picks groups carry the design defaults", () => {
    expect(p.learning).toMatchObject({
      maxChallengers: 8,
      maxPromotionsPerWeek: 3,
      shakedownSessions: 10,
      criticLlmCallsPerNight: 10,
      lessonL0MinN: 10,
      lessonL1MinN: 30,
      l2AlphaW0: 0.1,
      l2AlphaPayout: 0.05,
      comparisonsFdrQ: 0.1,
      comparisonLookAlpha: 0.05,
      comparisonLockoutSessions: 60,
      comparisonMinRows: 30,
      playbookMaxTokens: 1500,
      learningLoopMinutes: 5,
      kbArchiveTime: "22:15",
      classifierModel: "none",
    });
    expect(p.picks).toMatchObject({
      factorMinBucketN: 30,
      factorBuckets: "terciles",
      picksPerProfile: 10, // M17 O-76
      picksMaxPerFamily: 10,
      pickValidSessions: 2,
      pickSuccessMinN: 30,
    });
    expect(Object.keys(p.picks.profiles)).toEqual(["aggressive", "balanced", "conservative"]);
    expect(p.picks.profiles.balanced).toEqual({
      tiers: ["U1", "U2"],
      maxPctPerPick: 10,
      riskPctPerPick: 1,
    });
    expect(p.llm.injectionPhrases).toEqual(DEFAULT_INJECTION_PHRASES);
    expect(p.llm.injectionPhrasesVersion).toBe("v1");
  });
});
