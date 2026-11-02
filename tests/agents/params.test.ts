// @vitest-environment node
// Typed agent parameters (M4 T2): exact conversion, defaults equal ch.15, fallback on bad values,
// reading the config store, the parameter hash.
import { DEFAULT_INJECTION_PHRASES } from "@/lib/llm/injection";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentParamKeys,
  agentParamsJson,
  agentParamsSha,
  buildAgentParams,
  defaultAgentParams,
  loadAgentParams,
  ratFromNumber,
  ratFromPercent,
  resolveAgentParams,
} from "@/lib/agents/params";
import { CONFIG_KEYS, type ConfigKey } from "@/lib/config/keys";
import { setConfig } from "@/lib/config/store";
import { makeRational } from "@/lib/money/rational";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const r = (n: bigint, d: bigint = 1n) => makeRational(n, d);

describe("exact conversion from a config number", () => {
  it("ratFromNumber goes through decimal text, not float arithmetic", () => {
    expect(ratFromNumber(1.5)).toEqual(r(3n, 2n));
    expect(ratFromNumber(0.1)).toEqual(r(1n, 10n));
    expect(ratFromNumber(0.2)).toEqual(r(1n, 5n));
    expect(ratFromNumber(0.75)).toEqual(r(3n, 4n));
    expect(ratFromNumber(2)).toEqual(r(2n));
    expect(ratFromNumber(0)).toEqual(r(0n));
    expect(ratFromNumber(1e-7)).toEqual(r(1n, 10_000_000n)); // exponent form is expanded
    expect(ratFromNumber(0.000417)).toEqual(r(417n, 1_000_000n));
  });

  it("ratFromPercent divides by 100 exactly", () => {
    expect(ratFromPercent(3)).toEqual(r(3n, 100n));
    expect(ratFromPercent(2.5)).toEqual(r(1n, 40n));
    expect(ratFromPercent(0.5)).toEqual(r(1n, 200n));
    expect(ratFromPercent(0)).toEqual(r(0n));
  });
});

describe("defaultAgentParams equals ch.15", () => {
  const p = defaultAgentParams();

  it("family thresholds (section 15.3)", () => {
    expect(p.f1).toEqual({
      volumeRatioMin: r(3n, 2n),
      rsTopFraction: r(1n, 5n),
      initialStopAtr: r(2n),
      trailAtr: r(3n),
      timeStop: 40,
      minGain: r(1n, 20n),
      maxHold: 120,
      highLookback: 250,
      returnWindowSessions: 126, // M14 switches: v1 behaviour at the defaults
      momentumVariant: "v1",
      rankVariant: "v1",
    });
    expect(p.f2).toEqual({
      eventArMin: r(3n, 100n),
      lookbackSessions: 5,
      stopAtr: r(5n, 2n),
      timeStop: 60,
    });
    expect(p.f3).toEqual({
      eventArMin: r(1n, 25n),
      volumeRatioMin: r(2n),
      maxGap: r(2n, 25n),
      trailAfter: r(1n, 10n),
      trailAtr: r(5n, 2n),
      timeExit: 20,
      surpriseMode: "category",
    });
    expect(p.f4).toEqual({
      rsi2Max: 10,
      rsi14Max: 30,
      timeExit: 10,
      stopAtr: r(2n),
      entryVariant: "v1",
      rankVariant: "v1",
    });
    expect(p.f5).toEqual({
      volumeRatioMin: r(3n),
      arMin: r(3n, 100n),
      rangePosMin: r(3n, 4n),
      stopAtr: r(5n, 2n),
      stopCap: r(1n, 5n),
      trailAtr: r(3n),
      timeStop: 30,
      defaultUniverse: "U2", // O-49 (D-221)
    });
    expect(p.f6).toEqual({
      minClasses: 3,
      insiderMin: r(1n, 2n),
      shortDropPp: r(2n),
      stopAtr: r(2n),
      timeStop: 20,
    });
    expect(p.reentryBlock).toBe(10);
    expect(p.maxOpenPositions).toBe(2);
  });

  it("indicator, regime and event settings", () => {
    expect(p.windows).toEqual({
      atr: 20,
      rsiShort: 2,
      rsiLong: 14,
      smaExit: 5,
      smaMid: 50,
      smaTrend: 200,
      returnWindow: 126,
      adv: 20,
      volumeRatio: 20,
      vol: 20,
      regimeVolLookback: 1260,
      regimeFall: 5,
      shortInterest: 10,
      f4EventWindow: 3,
      day0CloseOffsetMin: 10,
    });
    expect(p.regime).toEqual({
      smaSessions: 200,
      volPctRiskOff: r(70n),
      volPctShock: r(95n),
      volPctRiskOn: r(50n),
      fall5: r(7n, 100n),
      exitHysteresis: 3,
    });
    expect(p.eventPolarityThreshold).toEqual(r(1n, 50n));
    expect(p.insiderWindowSessions).toBe(30);
    expect(p.insiderWeights).toEqual({
      directorNet: r(1n, 2n),
      holderNewOrIncrease: r(1n, 4n),
      holderDecrease: r(1n, 4n),
      directorSale: r(1n, 2n), // follows director_net until a challenger sets it (AGT-136)
    });
    expect(p.decisionCutoff).toBe("18:10");
    expect(p.thesisBreakersMin).toBe(3);
    expect(p.thesisBreakersMax).toBe(5);
    expect(p.thesisAmberFraction).toEqual(r(1n, 5n));
  });

  it("statistics, kill switch, replay and LLM settings", () => {
    expect(p.stats).toMatchObject({
      alpha: 0.05,
      bootstrapReplicationsMin: 1000,
      bootstrapReplicationsFactor: 20,
      bootstrapSizeCheckReplications: 2000,
      bootstrapBlockMinSessions: 5,
      bootstrapBlockPercentile: 75,
      minBlocks: 15,
      minTrades: 100,
      c2ControlsPerRow: 20,
      activeLineagesFloor: 6,
      trialBudgetPerLineage: 20,
      splitHoldoutMinSessions: 378,
      splitValidationMinSessions: 504,
      splitBlockMultiple: 15,
      splitDevelopmentMinSessions: 252,
      purgeExtraSessions: 20,
      survivorshipFlagShare: r(1n, 20n),
      usefulEdgeMin: r(1n, 200n),
      forwardAlphaTotal: 0.1,
      forwardLookTrades: 100,
      forwardMinMonths: 6,
      safetyCheckMinNeff: 8,
      deltaBustTolerance: r(1n, 20n),
      pboMax: 0.2,
      pboMinVariants: 5,
      pboBlocks: 10,
      dsrMin: 0.95,
      minCohortsRanked: 5,
      progressMinNeff: 3,
      scenarioMinN: 30,
      costFeasibilityRatio: r(2n),
      stressCostProfile: "P3",
      stressSlippageExtraPct: 50,
      barrierKUp: r(2n),
      barrierKDown: r(3n, 2n),
      barrierHorizonSessions: 20,
      eventCoverageMin: r(9n, 10n),
    });
    expect(p.killswitch).toEqual({
      tradesPerLook: 20,
      alphaTotal: 0.05,
      criteria: 3,
      maxLooksPerYear: 1,
      quietSessions: 60,
    });
    expect(p.replay).toMatchObject({
      rollingStartStep: 5,
      c2LivePerFamily: 20,
      zeroEdgeTrials: 20000,
      sleeveLeverage: 10,
      realityCap: 5,
      lightMinutes: 30,
      fullMinutes: 300, // D-186: ch.15 default 90 raised for the 2020-2026 history
      nightlyMinutes: 10,
      tursoRecentSessions: 500,
      eventBackfillYears: 6,
    });
    expect(p.replay.ledgerNotionalMicro).toBe(600_000_000n);
    expect(p.llm).toEqual({
      roleDailyTokens: { R1: 60000, R2: 50000, R3: 25000, R5: 10000, R6: 20000 },
      dailyTotal: 240000,
      nightlyTokensPerMarket: 30000,
      marketShare: { AU: r(1n) },
      cacheTtlHours: 24,
      r2MaterialityMin: 2,
      injectionPhrases: DEFAULT_INJECTION_PHRASES,
      injectionPhrasesVersion: "v1",
    });
  });

  it("the parameter set reads only registry keys, and reads more than fifty of them", () => {
    const keys = agentParamKeys();
    expect(keys.length).toBeGreaterThan(50);
    for (const k of keys)
      expect(Object.prototype.hasOwnProperty.call(CONFIG_KEYS, k), k).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("resolveAgentParams", () => {
  it("uses a valid stored value and falls back to the default for an invalid or missing one", async () => {
    const stored: Partial<Record<ConfigKey, unknown>> = {
      f1_trail_atr: 3.5, // valid
      f1_time_stop: 999, // out of bounds
      f2_time_stop: "60", // wrong type
      regime_params: { sma_sessions: 1 }, // invalid object
      reentry_block: 7,
    };
    const p = await resolveAgentParams((k) => stored[k]);
    expect(p.f1.trailAtr).toEqual(r(7n, 2n));
    expect(p.f1.timeStop).toBe(40);
    expect(p.f2.timeStop).toBe(60);
    expect(p.regime.smaSessions).toBe(200);
    expect(p.reentryBlock).toBe(7);
  });

  it("a source that throws gives the defaults, never an error", async () => {
    const p = await resolveAgentParams(() => {
      throw new Error("db down");
    });
    expect(agentParamsJson(p)).toBe(agentParamsJson(defaultAgentParams()));
  });

  it("a fixed key's stored value is ignored (fixed keys refuse every value)", async () => {
    const p = await resolveAgentParams((k) => (k === "atr_period" ? 21 : undefined));
    expect(p.windows.atr).toBe(20);
  });
});

describe("loadAgentParams", () => {
  it("reads the latest global value, and a market-scope value wins over it", async () => {
    const db = await freshDb("main");
    const now = "2026-10-18T00:00:00.000Z";
    await setConfig(db, { key: "f3_max_gap_pct", value: 9, userId: 1, now });
    await setConfig(db, { key: "f3_max_gap_pct", value: 10, userId: 1, now });
    await setConfig(db, { key: "f4_time_exit", value: 8, userId: 1, now });
    await setConfig(db, { key: "f4_time_exit", value: 12, scope: "AU", userId: 1, now });
    const global = await loadAgentParams(db);
    expect(global.f3.maxGap).toEqual(r(1n, 10n));
    expect(global.f4.timeExit).toBe(8);
    const au = await loadAgentParams(db, "AU");
    expect(au.f3.maxGap).toEqual(r(1n, 10n));
    expect(au.f4.timeExit).toBe(12);
    expect(au.f1).toEqual(defaultAgentParams().f1);
  });
});

describe("parameter hash (ARN-102)", () => {
  it("is stable, key-sorted and changes with any parameter", () => {
    const a = defaultAgentParams();
    const b = defaultAgentParams();
    expect(agentParamsSha(a)).toBe(agentParamsSha(b));
    expect(agentParamsSha(a)).toMatch(/^[0-9a-f]{64}$/);
    const json = agentParamsJson(a);
    expect(json).toContain('"volumeRatioMin":"3/2"');
    expect(json).toContain('"ledgerNotionalMicro":"600000000"');
    const changed = buildAgentParams((k) => (k === "f6_stop_atr" ? 2.5 : CONFIG_KEYS[k].default));
    expect(agentParamsSha(changed)).not.toBe(agentParamsSha(a));
    // Same values in a different key order give the same bytes.
    const reordered = buildAgentParams((k) => CONFIG_KEYS[k].default);
    expect(agentParamsJson(reordered)).toBe(json);
  });
});
