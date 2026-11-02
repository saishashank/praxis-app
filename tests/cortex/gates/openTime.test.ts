// @vitest-environment node
// Open-time checks O01…O07 (M15 C3c; CTX-028): one pass and one fail per check, the list in order
// stopping at the first failure, and the AT-52 "+9 % open vs 8 % cap" fixture built with low > limit
// through `fillEntryLimit` (unfilled → O05).
import { describe, expect, it } from "vitest";
import type { StopSpec } from "@/lib/agents/families/types";
import { COST_PROFILES } from "@/lib/arena/costs";
import { fillEntryLimit, limitPriceMicro } from "@/lib/arena/fills";
import { GAP_CAP_LABEL } from "@/lib/cortex/economics/gapCap";
import {
  OPEN_LABELS,
  openGapCap,
  openKill,
  openRecheckMissing,
  openShockBlock,
  openSourceOff,
  openStaleUniverse,
  openStopGap95,
  openTimeChecks,
  type OpenChecksInput,
} from "@/lib/cortex/gates";
import { makeRational } from "@/lib/money/rational";

const M = 1_000_000n;
const gapCap = makeRational(8n, 100n);
const stopCap = makeRational(12n, 100n);
const maxLoss = makeRational(18n, 100n);
const close = 20n * M;
const stopSpec: StopSpec = { atr_micro: 1n * M, k: makeRational(2n), cap: null, level_micro: null }; // stop 18.00 at 20.00
const stop = 18n * M;
/** min(20 × 1.08 = 21.60, 18 ÷ 0.88 = 20.4545…) → 20.45 on the tick grid. */
const limit = limitPriceMicro(close, stop, gapCap, stopCap);
const env = (open: bigint, low: bigint, high: bigint, c: bigint) => ({
  bar: { openMicro: open, highMicro: high, lowMicro: low, closeMicro: c },
  advMicro: 2_000_000n * M,
  profile: COST_PROFILES.P1,
});
const kills = { arena: false, families: new Set<"F1">(), sourcesOff: new Set<"bar_au">() };

describe("the open-time checks one by one", () => {
  it("O01 kill: arena switch or family kill", () => {
    expect(openKill(kills, "F1")).toEqual({ pass: true });
    expect(openKill({ ...kills, arena: true }, "F1")).toEqual({
      pass: false,
      openId: "O01_kill",
      label: OPEN_LABELS.O01_kill,
      value: "arena",
    });
    expect(openKill({ ...kills, families: new Set(["F1"]) }, "F1")).toMatchObject({ value: "F1" });
  });
  it("O02 source off: only sources the order's evidence read", () => {
    expect(openSourceOff(new Set(["asic_short"]), ["bar_au"])).toEqual({ pass: true });
    expect(openSourceOff(new Set(["asic_short", "bar_au"]), ["bar_au", "asic_short"])).toEqual({
      pass: false,
      openId: "O02_source_off",
      label: OPEN_LABELS.O02_source_off,
      value: "asic_short,bar_au",
    });
  });
  it("O03 shock block: SHOCK cancels every family but F4", () => {
    expect(openShockBlock("NEUTRAL", "F1")).toEqual({ pass: true, value: "NEUTRAL" });
    expect(openShockBlock("SHOCK", "F1")).toEqual({
      pass: false,
      openId: "O03_shock_block",
      label: OPEN_LABELS.O03_shock_block,
      value: "SHOCK",
    });
    expect(openShockBlock("SHOCK", "F4").pass).toBe(true);
  });
  it("O04 stale universe: strictly above the share cancels", () => {
    expect(openStaleUniverse(0.1, 0.1)).toEqual({ pass: true, value: "0.1000" });
    expect(openStaleUniverse(0.11, 0.1)).toEqual({
      pass: false,
      openId: "O04_stale_universe",
      label: OPEN_LABELS.O04_stale_universe,
      value: "0.1100 > 0.1000",
    });
    expect(() => openStaleUniverse(1.5, 0.1)).toThrow(RangeError);
  });
  it("O05 gap cap (AT-52): a +9 % open whose low stays above the limit is unfilled in both arms", () => {
    expect(limit).toBe(20_450_000n);
    const nineUp = fillEntryLimit(
      env(2_180n * 10_000n, 2_100n * 10_000n, 2_200n * 10_000n, 2_150n * 10_000n),
      100n,
      limit,
    );
    expect(nineUp).toEqual({ status: "unfilled", reason: "limit_not_reached" });
    expect(openGapCap(nineUp)).toEqual({
      pass: false,
      openId: "O05_gap_cap",
      label: OPEN_LABELS.O05_gap_cap,
      value: "limit_not_reached",
    });
    // a +9 % open that trades back through the limit fills at the limit exactly (D-288)
    const through = fillEntryLimit(
      env(2_180n * 10_000n, 2_000n * 10_000n, 2_200n * 10_000n, 2_050n * 10_000n),
      100n,
      limit,
    );
    expect(through.status).toBe("filled");
    if (through.status === "filled") {
      expect(through.fill.rule).toBe("limit");
      expect(through.fill.fillPriceMicro).toBe(limit);
    }
    expect(openGapCap(through)).toEqual({ pass: true, value: `limit:${limit}` });
  });
  it("O06 stop + gap95 referenced to the fill; no gap95 fails closed", () => {
    // fill 20.45 → stop 18.45 (9.78 %) + 3 % passes; + 9 % fails
    expect(openStopGap95({ fillMicro: limit, stopSpec, gap95: 0.03, maxLoss })).toMatchObject({
      pass: true,
      stopMicro: 18_450_000n,
    });
    expect(openStopGap95({ fillMicro: limit, stopSpec, gap95: 0.09, maxLoss })).toMatchObject({
      pass: false,
      openId: "O06_stop_gap95",
      label: GAP_CAP_LABEL,
      stopMicro: 18_450_000n,
    });
    expect(openStopGap95({ fillMicro: limit, stopSpec, gap95: undefined, maxLoss })).toMatchObject({
      pass: false,
      value: "gap95_unknown",
      stopMicro: null,
    });
  });
  it("O07 re-check missing cancels", () => {
    expect(openRecheckMissing(true)).toEqual({ pass: true });
    expect(openRecheckMissing(false)).toEqual({
      pass: false,
      openId: "O07_recheck_missing",
      label: OPEN_LABELS.O07_recheck_missing,
    });
  });
});

describe("openTimeChecks: the list in order", () => {
  const base: OpenChecksInput = {
    family: "F1",
    kills,
    sourcesNeeded: ["bar_au"],
    regime: "NEUTRAL",
    staleShare: 0.02,
    staleUniverseMaxShare: 0.1,
    fill: null,
    stopSpec,
    gap95: 0.03,
    maxLoss,
    rechecked: true,
  };
  it("the 09:55 run (no fill) passes all seven with O05/O06 marked preopen", () => {
    const r = openTimeChecks(base);
    expect(r.firstFail).toBeNull();
    expect(r.trace.map((x) => x.openId)).toEqual([
      "O01_kill",
      "O02_source_off",
      "O03_shock_block",
      "O04_stale_universe",
      "O05_gap_cap",
      "O06_stop_gap95",
      "O07_recheck_missing",
    ]);
    expect(r.trace[4]).toEqual({ pass: true, value: "preopen", openId: "O05_gap_cap" });
    expect(r.stopMicro).toBeNull();
  });
  it("at the fill: a trade-through fill passes O05 and re-references the stop in O06", () => {
    const fill = fillEntryLimit(
      env(2_180n * 10_000n, 2_000n * 10_000n, 2_200n * 10_000n, 2_050n * 10_000n),
      100n,
      limit,
    );
    const r = openTimeChecks({ ...base, fill });
    expect(r.firstFail).toBeNull();
    expect(r.stopMicro).toBe(18_450_000n);
  });
  it("stops at the first failure and records it", () => {
    const r = openTimeChecks({ ...base, regime: "SHOCK", rechecked: false });
    expect(r.firstFail).toBe("O03_shock_block");
    expect(r.trace).toHaveLength(3);
    const unfilled = fillEntryLimit(
      env(2_180n * 10_000n, 2_100n * 10_000n, 2_200n * 10_000n, 2_150n * 10_000n),
      100n,
      limit,
    );
    expect(openTimeChecks({ ...base, fill: unfilled }).firstFail).toBe("O05_gap_cap");
    expect(openTimeChecks({ ...base, rechecked: false }).firstFail).toBe("O07_recheck_missing");
  });
});
