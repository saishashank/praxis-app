// @vitest-environment node
// Data quality rules, pure (M2 T7): DAT-200, DAT-201, DAT-210, AT-07 goldens. Synthetic bars only.
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, type ConfigKeyDef } from "@/lib/config/keys";
import {
  boundedPct,
  DEFAULT_REFETCH_DIFF_PCT,
  DEFAULT_SUSPECT_MOVE_PCT,
  DEFAULT_U1_GATE_PCT,
  evaluateBar,
  evaluateMissing,
  evaluateRefetch,
  evaluateRejects,
  gateFails,
  gateFinding,
  PCT_BOUNDS,
  qualityConfigFrom,
  REEVALUATED_IDS,
  RULE_IDS,
  RULES,
  scoreDay,
  tierScore,
  type Bar,
} from "@/lib/data/quality/rules.mjs";

const good: Bar = { o: 10, h: 11, l: 9, c: 10.5, volume: 1000 };
const ids = (f: { rule: string }[]) => f.map((x) => x.rule);

describe("config parity (no magic numbers)", () => {
  it("defaults and bounds mirror the ch.15 keys", async () => {
    expect(DEFAULT_REFETCH_DIFF_PCT).toBe(CONFIG_KEYS.refetch_diff_flag.default);
    expect(DEFAULT_SUSPECT_MOVE_PCT).toBe(CONFIG_KEYS.suspect_move.default);
    expect(DEFAULT_U1_GATE_PCT).toBe(CONFIG_KEYS.u1_quality_gate.default);
    const get = async () => null;
    const check = (k: keyof typeof CONFIG_KEYS, v: number) =>
      (CONFIG_KEYS[k] as ConfigKeyDef).validate(v, get);
    for (const k of ["refetch_diff_flag", "suspect_move", "u1_quality_gate"] as const) {
      const [lo, hi] = PCT_BOUNDS[k];
      expect(await check(k, lo)).toBeNull();
      expect(await check(k, hi)).toBeNull();
      expect(await check(k, lo - 0.001)).not.toBeNull();
      expect(await check(k, hi + 0.001)).not.toBeNull();
      expect(CONFIG_KEYS[k].editable).toBe("O");
    }
  });
  it("falls back to defaults for absent or out-of-bounds values", () => {
    const defaults = { refetchDiffPct: 0.1, suspectMovePct: 40, u1GatePct: 95 };
    expect(qualityConfigFrom({})).toEqual(defaults);
    expect(
      qualityConfigFrom({ suspect_move: 5, u1_quality_gate: "x", refetch_diff_flag: 9 }),
    ).toEqual(defaults);
    expect(
      qualityConfigFrom({ suspect_move: 25, u1_quality_gate: 90, refetch_diff_flag: 0.5 }),
    ).toEqual({ refetchDiffPct: 0.5, suspectMovePct: 25, u1GatePct: 90 });
    expect(boundedPct(Number.NaN, 1, [0, 2])).toBe(1);
  });
  it("catalogue: unique ids, only the re-fetch flag is kept on re-runs", () => {
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
    expect(REEVALUATED_IDS).not.toContain(RULES.refetch_diff.id);
    expect(REEVALUATED_IDS).toHaveLength(RULE_IDS.length - 1);
  });
});

describe("DAT-200 per-bar checks", () => {
  it("a clean bar passes", () => {
    expect(evaluateBar({ bar: good, prev: { ...good, c: 10.2 }, tier: "U1" })).toEqual([]);
  });
  it("high below max(open, close) flags; equal passes", () => {
    expect(ids(evaluateBar({ bar: { ...good, h: 10.4 } }))).toEqual([RULES.ohlc_inconsistent.id]);
    expect(evaluateBar({ bar: { ...good, h: 10.5 } })).toEqual([]);
  });
  it("low above min(open, close) flags; equal passes", () => {
    expect(ids(evaluateBar({ bar: { ...good, l: 10.1 } }))).toEqual([RULES.ohlc_inconsistent.id]);
    expect(evaluateBar({ bar: { ...good, l: 10 } })).toEqual([]);
  });
  it("a zero or negative price flags", () => {
    for (const k of ["o", "h", "l", "c"] as const) {
      expect(ids(evaluateBar({ bar: { ...good, [k]: 0 } }))).toContain(RULES.price_not_positive.id);
    }
    expect(ids(evaluateBar({ bar: { ...good, c: -1 } }))).toContain(RULES.price_not_positive.id);
  });
  it("volume: negative flags, zero passes outside U1", () => {
    expect(ids(evaluateBar({ bar: { ...good, volume: -1 } }))).toEqual([RULES.volume_negative.id]);
    expect(evaluateBar({ bar: { ...good, volume: 0 }, tier: "U2" })).toEqual([]);
  });
  it("a bar on a non-trading day flags", () => {
    expect(ids(evaluateBar({ bar: good, tradingDay: false }))).toEqual([RULES.not_trading_day.id]);
    expect(evaluateBar({ bar: good, tradingDay: true })).toEqual([]);
  });
  it("close-to-close move: exactly 40% passes, above flags, a covering event exempts it", () => {
    const prev: Bar = { o: 10, h: 10, l: 10, c: 10, volume: 5 };
    const at40 = { ...good, o: 14, h: 14, l: 14, c: 14 };
    expect(evaluateBar({ bar: at40, prev })).toEqual([]);
    const over = { ...good, o: 14.01, h: 14.01, l: 14.01, c: 14.01 };
    const f = evaluateBar({ bar: over, prev });
    expect(ids(f)).toEqual([RULES.suspect_move.id]);
    expect(f[0].blocks_entries).toBe(true);
    expect(evaluateBar({ bar: over, prev, explained: true })).toEqual([]);
    // down moves count too, and the limit is configurable
    expect(ids(evaluateBar({ bar: { ...good, o: 5.9, h: 5.9, l: 5.9, c: 5.9 }, prev }))).toEqual([
      RULES.suspect_move.id,
    ]);
    expect(evaluateBar({ bar: over, prev, suspectMovePct: 50 })).toEqual([]);
  });
  it("no previous bar: no move and no identical check", () => {
    expect(evaluateBar({ bar: good, prev: null })).toEqual([]);
    expect(evaluateBar({ bar: good, prev: { ...good, c: 0 } })).toEqual([]);
  });
  it("zero volume: flagged for a non-halted U1 code only", () => {
    const zero = { ...good, volume: 0 };
    expect(ids(evaluateBar({ bar: zero, tier: "U1", halted: false }))).toEqual([
      RULES.zero_volume_u1.id,
    ]);
    expect(evaluateBar({ bar: zero, tier: "U1", halted: true })).toEqual([]);
    expect(evaluateBar({ bar: zero, tier: "U3" })).toEqual([]);
  });
  it("identical OHLCV to the previous day flags; any one field different passes", () => {
    expect(ids(evaluateBar({ bar: good, prev: { ...good } }))).toEqual([RULES.identical_ohlcv.id]);
    expect(evaluateBar({ bar: good, prev: { ...good, volume: 1001 } })).toEqual([]);
  });
  it("re-fetch: above 0.1% flags without blocking; exactly 0.1% and below do not", () => {
    expect(evaluateRefetch(0.1)).toEqual([]);
    expect(evaluateRefetch(0)).toEqual([]);
    const f = evaluateRefetch(0.3); // the 0.3% acceptance case (spec/06 line 129)
    expect(ids(f)).toEqual([RULES.refetch_diff.id]);
    expect(f[0].blocks_entries).toBe(false);
    expect(evaluateRefetch(0.3, 0.5)).toEqual([]);
  });
  it("all bar findings but the re-fetch block entries (DAT-210)", () => {
    for (const [k, r] of Object.entries(RULES)) expect(r.blocks, k).toBe(k !== "refetch_diff");
  });
});

describe("DAT-210 missing bars and rejects", () => {
  it("a missing bar is a blocking finding that lists the reject reasons", () => {
    const [f] = evaluateMissing({
      rejectReasons: ["non_positive_price", "bad_volume", "bad_volume"],
    });
    expect(f).toMatchObject({ rule: RULES.missing_bar.id, blocks_entries: true });
    expect(f.detail).toEqual({ rejected: ["bad_volume", "non_positive_price"] });
    expect(evaluateMissing()[0].detail).toEqual({});
  });
  it("reject reasons map to DAT-200 rules; unmapped reasons add nothing", () => {
    expect(
      ids(
        evaluateRejects(["ohlc_inconsistent", "non_positive_price", "bad_volume", "duplicate_key"]),
      ),
    ).toEqual([
      RULES.ohlc_inconsistent.id,
      RULES.price_not_positive.id,
      RULES.volume_negative.id,
      RULES.duplicate_bar.id,
    ]);
    expect(evaluateRejects(["bad_number", "bad_code"])).toEqual([]);
    expect(evaluateRejects(["ohlc_inconsistent", "ohlc_inconsistent"])).toHaveLength(1);
  });
});

describe("DAT-201 score and the U1 gate", () => {
  const codes = (n: number, tier: string) =>
    Array.from({ length: n }, (_, i) => ({ code: `${tier}${i}`, tier }));
  it("tier score is valid / expected; an empty tier scores 1", () => {
    expect(tierScore(4, 3)).toEqual({ expected: 4, valid: 3, score: 0.75, empty: false });
    expect(tierScore(0, 0)).toEqual({ expected: 0, valid: 0, score: 1, empty: true });
  });
  it("95% exactly passes, below fails (integer arithmetic)", () => {
    expect(gateFails({ expected: 100, valid: 95 })).toBe(false);
    expect(gateFails({ expected: 100, valid: 94 })).toBe(true);
    expect(gateFails({ expected: 20, valid: 19 })).toBe(false); // 95%
    expect(gateFails({ expected: 300, valid: 285 })).toBe(false);
    expect(gateFails({ expected: 300, valid: 284 })).toBe(true);
    expect(gateFails({ expected: 0, valid: 0 })).toBe(false);
    expect(gateFails({ expected: 100, valid: 80 }, 80)).toBe(false);
    expect(gateFails({ expected: 100, valid: 79 }, 80)).toBe(true);
  });
  it("AT-07 / spec 06:131 golden: U1 at 93% fails the gate, U2/U3 carry no gate", () => {
    const expected = [...codes(100, "U1"), ...codes(10, "U2"), ...codes(10, "U3")];
    const invalid = new Set([
      ...codes(7, "U1").map((c) => c.code),
      ...codes(10, "U2").map((c) => c.code),
    ]);
    const day = scoreDay({ expected, invalid });
    expect(day.gateFailed).toBe(true);
    expect(day.tiers.U1).toMatchObject({ valid: 93, expected: 100, score: 0.93, gate_pass: false });
    expect(day.tiers.U2).toMatchObject({ valid: 0, expected: 10, score: 0, gate_pass: true });
    expect(day.tiers.U3).toMatchObject({ valid: 10, score: 1, gate_pass: true });
    const f = gateFinding(day.tiers.U1);
    expect(f).toMatchObject({ rule: RULES.u1_gate.id, severity: "critical", blocks_entries: true });
    expect(f.detail).toMatchObject({ score_pct: 93, valid: 93, expected: 100, gate_pct: 95 });
  });
  it("95 of 100 U1 codes valid passes", () => {
    const day = scoreDay({
      expected: codes(100, "U1"),
      invalid: new Set(codes(5, "U1").map((c) => c.code)),
    });
    expect(day.gateFailed).toBe(false);
    expect(day.tiers.U1.gate_pass).toBe(true);
  });
  it("no U1 codes: passes, marked empty", () => {
    const day = scoreDay({ expected: codes(3, "U3"), invalid: new Set() });
    expect(day.gateFailed).toBe(false);
    expect(day.tiers.U1.empty).toBe(true);
  });
});

describe("AT-07 injected bad bars (spec/14 line 20)", () => {
  it("high<close, zero price and a 60% unexplained jump are each flagged and block", () => {
    const prev: Bar = { o: 10, h: 10.5, l: 9.5, c: 10, volume: 100 };
    const highBelowClose = evaluateBar({
      bar: { o: 10, h: 10, l: 9.5, c: 10.4, volume: 100 },
      prev,
    });
    const zeroPrice = evaluateBar({ bar: { o: 0, h: 0, l: 0, c: 0, volume: 100 }, prev });
    const jump = evaluateBar({ bar: { o: 16, h: 16.2, l: 15.9, c: 16, volume: 100 }, prev });
    expect(ids(highBelowClose)).toEqual([RULES.ohlc_inconsistent.id]);
    expect(ids(zeroPrice)).toContain(RULES.price_not_positive.id);
    expect(ids(jump)).toEqual([RULES.suspect_move.id]);
    expect(jump[0].detail).toMatchObject({ move_pct: 60, limit_pct: 40 });
    for (const f of [...highBelowClose, ...zeroPrice, ...jump]) expect(f.blocks_entries).toBe(true);
  });
});
