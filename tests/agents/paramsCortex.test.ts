// @vitest-environment node
// AgentParams.cortex (M15 P1): the typed block loads from the M15 keys, converts shares and loss
// caps exactly, falls back to the default on a bad stored value, and the parameter hash covers it.
import { afterEach, describe, expect, it } from "vitest";
import {
  agentParamKeys,
  agentParamsJson,
  agentParamsSha,
  buildAgentParams,
  defaultAgentParams,
  loadAgentParams,
  resolveAgentParams,
} from "@/lib/agents/params";
import { CONFIG_KEYS, M15_KEY_NAMES } from "@/lib/config/keys";
import { setConfig } from "@/lib/config/store";
import { makeRational } from "@/lib/money/rational";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const r = (n: bigint, d: bigint = 1n) => makeRational(n, d);

describe("AgentParams.cortex", () => {
  it("equals the requirements defaults at the registry defaults", () => {
    expect(defaultAgentParams().cortex).toEqual({
      cellMinSetups: 60,
      cellMinBlocks: 20,
      minNeffTrade: 200,
      rankShrinkN0: 60,
      maxLoss: r(9n, 50n), // 18 %
      entryGapCap: r(2n, 25n), // 8 %
      disagreementMax: 0.4,
      clusterWeightMax: 0.35,
      sectorTiltMarginPp: 5,
      maxBooksSameCode: 2,
      maxBooksSameIndustry: 3,
      maxCodeNavShare: r(1n, 5n),
      maxIndustryNavShare: r(7n, 20n),
      freezeMaxLoss: r(1n, 4n), // 25 %
      unresolvedFreezeSessions: 5,
      persistVolumeMult: 2,
      pumpVolumeMult: 4,
      pumpAr: r(2n, 25n), // 8 %
      promotionFlagSessions: 20,
      abstainAlarmSessions: 40,
      staleUniverseMaxShare: 0.1,
      opinionMinN: 150,
      ledgerFdrQ: 0.1,
      bootstrapBlockSessions: 120,
      slopeHideUb: 1,
      stageMinutes: 20,
      survivorshipHaircutPp: 1.5,
      suspensionMarkPolicy: "100% x5, -10pts per 5, floor 50%",
    });
  });

  it("reads exactly the M15 keys (each M15 key is read by buildAgentParams)", () => {
    const read = new Set(agentParamKeys());
    for (const k of M15_KEY_NAMES) expect(read.has(k), k).toBe(true);
  });

  it("follows a changed key", () => {
    const over: Record<string, unknown> = { max_loss_pct: 20, cortex_stage_minutes: 30 };
    const p = buildAgentParams((k) => (k in over ? over[k] : CONFIG_KEYS[k].default));
    expect(p.cortex.maxLoss).toEqual(r(1n, 5n));
    expect(p.cortex.stageMinutes).toBe(30);
  });

  it("an invalid stored value falls back to the default; a valid one is used", async () => {
    const p = await resolveAgentParams((k) =>
      k === "cell_min_setups" ? 5 : k === "max_books_same_code" ? 3 : undefined,
    );
    expect(p.cortex.cellMinSetups).toBe(60); // 5 is below the bound 30: the default
    expect(p.cortex.maxBooksSameCode).toBe(3);
  });

  it("loads from the config store", async () => {
    const db = await freshDb("main");
    await setConfig(db, {
      key: "cortex_disagreement_max",
      scope: "global",
      value: 0.5,
      userId: 1,
      reason: "test",
      now: "2030-01-01T00:00:00.000Z",
    });
    expect((await loadAgentParams(db)).cortex.disagreementMax).toBe(0.5);
  });

  it("is part of the parameter hash and its JSON", () => {
    const a = defaultAgentParams();
    const b = { ...a, cortex: { ...a.cortex, cellMinSetups: 61 } };
    expect(agentParamsSha(a)).not.toBe(agentParamsSha(b));
    expect(JSON.parse(agentParamsJson(a)).cortex.maxLoss).toBe("9/50");
  });
});
