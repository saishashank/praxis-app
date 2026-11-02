// @vitest-environment node
// Matched-setup cells and the CTX-021 economic gate (M15 C2; CTX-012 outcome model, CTX-021, CTX-022b,
// D-276; AT-52 "the 40/60 setup fails the gate").
import { describe, expect, it } from "vitest";
import {
  buildCells,
  cellKey,
  type CellSetup,
  cellStatistic,
  DEFAULT_CELL_MIN_BLOCKS,
  DEFAULT_CELL_MIN_SETUPS,
  economicGate,
  isTop3Band,
  netReturnFromMicro,
  REGIME_MIN_SETUPS,
  scoreBands,
  TOP3_BAND_KEY,
} from "@/lib/stats/cells";
import { isUndefined } from "@/lib/stats/stationaryBootstrap";
import { normal, prngFor } from "./helpers";

const NOTIONAL = 1_000_000_000n; // A$1,000 in micro-dollars

/** A cell of `n` setups spread over 600 sessions; `netPct(i)` gives the net outcome in percent. */
function setupsOf(
  n: number,
  netPct: (i: number) => number,
  extra: Partial<CellSetup> = {},
): CellSetup[] {
  return Array.from({ length: n }, (_, i) => ({
    family: "F1",
    code: `ZZ${String(i % 20).padStart(2, "0")}`,
    session: Math.floor((i * 600) / n),
    band: 9,
    volBucket: "v2",
    liqTier: "U1",
    regime: i % 4 === 0 ? "RISK_OFF" : "RISK_ON",
    // percent → micro-dollars of a A$1,000 notional: 1 % = A$10 = 10,000,000 micro
    netMicro: BigInt(Math.round(netPct(i) * 10_000_000)),
    notionalMicro: NOTIONAL,
    filled: true,
    adverseGap: 0.01 + (i % 10) * 0.005,
    ...extra,
  }));
}

const BOOT = { expectedBlock: 20, replicates: 200 };

describe("score bands and keys", () => {
  it("deciles within the family, ties by average rank", () => {
    const s = Array.from({ length: 100 }, (_, i) => i);
    const bands = scoreBands(s);
    expect(bands[0]).toBe(1);
    expect(bands[9]).toBe(1);
    expect(bands[10]).toBe(2);
    expect(bands[99]).toBe(10);
    // An all-tie shares average rank 2 of 3 → ceil(2/3 × 10) = band 7 for every row.
    expect(scoreBands([5, 5, 5])).toEqual([7, 7, 7]);
    expect(scoreBands([])).toEqual([]);
    expect(isTop3Band(8) && isTop3Band(10) && !isTop3Band(7)).toBe(true);
  });

  it("cell key = family|band|volBucket|liqTier", () => {
    expect(cellKey("F1", 9, "v2", "U1")).toBe("F1|9|v2|U1");
    expect(cellKey("F4", TOP3_BAND_KEY, "v1", "U2")).toBe("F4|top3|v1|U2");
    expect(netReturnFromMicro(-21_000_000n, NOTIONAL)).toBeCloseTo(-0.021, 12);
  });
});

describe("economicGate (CTX-021)", () => {
  it("defaults: 60 setups, 20 blocks, 30 per regime", () => {
    expect(DEFAULT_CELL_MIN_SETUPS).toBe(60);
    expect(DEFAULT_CELL_MIN_BLOCKS).toBe(20);
    expect(REGIME_MIN_SETUPS).toBe(30);
  });

  it("AT-52: the 40/60 cell (40 % win +10, 60 % lose −6, C 2.5) fails with bound_not_positive", () => {
    // Net = gross − 2.5: wins +7.5, losses −8.5 → mean −2.1 %.
    const setups = setupsOf(200, (i) => (i % 5 < 2 ? 7.5 : -8.5));
    const cell = cellStatistic("F1|top3|v2|U1", setups, prngFor("cell-4060"), BOOT);
    expect(cell.n).toBe(200);
    expect(cell.meanNet).toBeCloseTo(-0.021, 12);
    expect(cell.lower90).toBeLessThan(0);
    expect(cell.blocks).toBe(30);
    expect(cell.nEff).toBeDefined();
    expect(cell.lReal).toBeCloseTo(0.085, 12);
    const g = economicGate(cell, "RISK_ON");
    expect(g.pass).toBe(false);
    if (!g.pass) expect(g.reason).toBe("bound_not_positive");
  });

  it("a cell with a positive edge passes; regime fail-closed blocks a thin regime", () => {
    const prng = prngFor("cell-good");
    const setups = setupsOf(200, () => 3 + 4 * normal(prng));
    const cell = cellStatistic("F1|top3|v2|U1", setups, prngFor("cell-good-boot"), BOOT);
    expect(cell.lower90).toBeGreaterThan(0);
    expect(economicGate(cell, "RISK_ON")).toEqual({ pass: true, lower90: cell.lower90 });
    expect(cell.byRegime.RISK_ON!.n).toBe(150);
    expect(cell.byRegime.RISK_OFF!.n).toBe(50);
    // A regime the cell has never seen is blocked; one with < 30 setups too.
    const unseen = economicGate(cell, "SHOCK");
    expect(unseen.pass).toBe(false);
    if (!unseen.pass) expect(unseen.reason).toBe("regime_blocked");
    const thin = economicGate(cell, "RISK_OFF", { regimeMinSetups: 60 });
    expect(thin.pass).toBe(false);
    if (!thin.pass) expect(thin.reason).toBe("regime_blocked");
  });

  it("a regime with a negative point estimate is blocked even when the cell passes", () => {
    const prng = prngFor("cell-regime-neg");
    const setups = setupsOf(200, (i) => (i % 4 === 0 ? -2 : 5 + 2 * normal(prng)));
    const cell = cellStatistic("F1|top3|v2|U1", setups, prngFor("cell-regime-neg-boot"), BOOT);
    expect(cell.lower90).toBeGreaterThan(0);
    expect(economicGate(cell, "RISK_ON").pass).toBe(true);
    const off = economicGate(cell, "RISK_OFF");
    expect(off.pass).toBe(false);
    if (!off.pass) expect(off.reason).toBe("regime_blocked");
  });

  it("not enough history: fewer than 60 setups, fewer than 20 blocks, or n_eff undefined", () => {
    const prng = prngFor("cell-short");
    const few = cellStatistic(
      "k",
      setupsOf(40, () => 5 + normal(prng)),
      prngFor("few"),
      BOOT,
    );
    const g1 = economicGate(few, "RISK_ON");
    expect(!g1.pass && g1.reason).toBe("not_enough_history");
    // 100 setups all in the first 100 sessions with 20-session blocks → 5 blocks → n_eff undefined.
    const packed = setupsOf(100, () => 5 + normal(prng)).map((s, i) => ({ ...s, session: i }));
    const cell = cellStatistic("k", packed, prngFor("packed"), { ...BOOT, sessionCount: 600 });
    expect(cell.nEff).toBeUndefined();
    expect(cell.blocks).toBe(5);
    const g2 = economicGate(cell, "RISK_ON");
    expect(!g2.pass && g2.reason).toBe("not_enough_history");
    // 15 blocks defined but below cell_min_blocks 20.
    const spread = setupsOf(100, () => 5 + normal(prng)).map((s, i) => ({ ...s, session: i * 3 }));
    const c3 = cellStatistic("k", spread, prngFor("spread"), { ...BOOT, sessionCount: 600 });
    expect(c3.blocks).toBe(15);
    expect(c3.nEff).toBeDefined();
    const g3 = economicGate(c3, "RISK_ON");
    expect(!g3.pass && g3.reason).toBe("not_enough_history");
    expect(economicGate(c3, "RISK_ON", { cellMinBlocks: 10 }).pass).toBe(true);
  });

  it("excludes unfilled setups (CTX-022b) and reports their share, gap95 and L_real", () => {
    const setups = setupsOf(100, () => 5).map((s, i) => ({ ...s, filled: i % 10 !== 0 }));
    const cell = cellStatistic("k", setups, prngFor("unfilled"), BOOT);
    expect(cell.n).toBe(90);
    expect(cell.excludedUnfilledShare).toBeCloseTo(0.1, 12);
    expect(cell.gap95).toBeCloseTo(0.055, 12);
    expect(cell.lReal).toBe(0);
    const empty = cellStatistic("k", [], prngFor("empty"), BOOT);
    expect(empty.n).toBe(0);
    expect(isUndefined(empty.bound)).toBe(true);
    expect(economicGate(empty, "RISK_ON").pass).toBe(false);
  });
});

describe("buildCells", () => {
  it("builds one cell per band and a pooled top-3 cell per family × vol × tier, keys sorted", () => {
    const setups = [
      ...setupsOf(30, () => 1, { band: 8 }),
      ...setupsOf(30, () => 2, { band: 10 }),
      ...setupsOf(30, () => -1, { band: 3 }),
      ...setupsOf(30, () => 1, { band: 9, family: "F4" }),
    ];
    const cells = buildCells(setups, (key) => prngFor(`cells:${key}`), BOOT);
    expect([...cells.keys()]).toEqual([
      "F1|10|v2|U1",
      "F1|3|v2|U1",
      "F1|8|v2|U1",
      "F1|top3|v2|U1",
      "F4|9|v2|U1",
      "F4|top3|v2|U1",
    ]);
    expect(cells.get("F1|top3|v2|U1")!.n).toBe(60);
    expect(cells.get("F1|top3|v2|U1")!.meanNet).toBeCloseTo(0.015, 12);
    expect(cells.get("F4|top3|v2|U1")!.n).toBe(30);
    expect(buildCells([], () => prngFor("none")).size).toBe(0);
  });

  it("is deterministic per cell key regardless of input order", () => {
    const setups = [...setupsOf(60, () => 2, { band: 9 }), ...setupsOf(60, () => 1, { band: 8 })];
    const a = buildCells(setups, (k) => prngFor(`det:${k}`), BOOT);
    const b = buildCells([...setups].reverse(), (k) => prngFor(`det:${k}`), BOOT);
    // Same draws per key; row order inside a session only changes float summation order.
    expect(a.get("F1|top3|v2|U1")!.lower90).toBeCloseTo(b.get("F1|top3|v2|U1")!.lower90, 12);
    expect(a.get("F1|8|v2|U1")!.nEff).toBeCloseTo(b.get("F1|8|v2|U1")!.nEff!, 12);
    expect(a.get("F1|8|v2|U1")!.blocks).toBe(b.get("F1|8|v2|U1")!.blocks);
  });
});
