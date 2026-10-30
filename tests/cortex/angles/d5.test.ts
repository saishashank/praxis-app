// @vitest-environment node
// D5 Sector, macro and regime (M15 C1c; angles_D5.md; CTX-011, CTX-017; D-271, D-290, D-291):
// regime / rates / calendar entries are gates; macro angles resolve to `measured` (no live reader);
// the US-index angle never sees the bar dated tonight; sector angles are candidates (D-271) with
// computes checked on the three-sector long world.
import { describe, expect, it } from "vitest";
import {
  AU_10Y_SERIES,
  breadthAbove,
  completedMonthEnds,
  D5_ANGLES,
  percentileOf,
  sectorRank,
  sectorReturns,
} from "@/lib/cortex/angles/d5";
import {
  ANGLES_PER_DOMAIN,
  canActivate,
  defaultGrid,
  defineAngles,
  evaluateAngle,
  LIVE_READERS,
  resolveStatus,
} from "@/lib/cortex/angles/registry";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import { assertTruncationInvariant } from "@/lib/cortex/pit/truncation";
import type { AsOfWorld, MacroRow } from "@/lib/cortex/pit/types";
import { regimeWorld } from "../pit/zzWorld";
import { axjoLevel, closeCents, LONG_CODES, longWorld, SECTOR_OF, vixLevel } from "./d3to8World";

const world = longWorld();
const view = buildAsOfView(world);
const T = world.sessions.length - 1;
const byId = (id: string) => D5_ANGLES.find((a) => a.id === id)!;
const run = (id: string, t: number, grid: Record<string, number> = {}, v = view, code = "ZZA") => {
  const def = byId(id);
  return def.compute!(v, code, t, { ...defaultGrid(def), ...grid });
};
const TS = [0, 1, 150, 299, 650, 1000, 1260, 1279, 1280, 1281, T - 1, T];
const ret = (code: string, i: number, h: number) =>
  closeCents(code, i) / closeCents(code, i - h) - 1;

function sectorMeans(i: number, h: number): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const c of LONG_CODES)
    by.set(SECTOR_OF[c]!, [...(by.get(SECTOR_OF[c]!) ?? []), ret(c, i, h)]);
  return new Map([...by].map(([s, rs]) => [s, rs.reduce((a, b) => a + b, 0) / rs.length]));
}

describe("D5 passports", () => {
  it("has ten validated entries with the status each reader set grants", () => {
    const defs = defineAngles(D5_ANGLES);
    expect(defs.length).toBe(ANGLES_PER_DOMAIN);
    expect(defs.map((a) => [a.kind, a.cluster])).toEqual([
      ["gate", "regime"],
      ["gate", "regime"],
      ["score", "momentum"],
      ["score", "momentum"],
      ["gate", "regime"],
      ["gate", "regime"],
      ["gate", "calendar"],
      ["gate", "regime"],
      ["gate", "regime"],
      ["score", "sentiment"],
    ]);
    expect(defs.map((a) => resolveStatus(a, "active"))).toEqual([
      "active", // 01 regime (index_au)
      "active", // 02 breadth
      "candidate", // 03 sector RS (D-271)
      "candidate", // 04 sector persistence (D-271)
      "measured", // 05 rates: macro has no live reader (D-291)
      "candidate", // 06 commodities: needs gold/oil/iron-ore series
      "candidate", // 07 release calendar
      "active", // 08 US risk: index_us is live (D-290; D-305 is the evaluator's)
      "measured", // 09 equity-bond correlation (macro)
      "candidate", // 10 sector sentiment (announcement archive + map)
    ]);
    for (const id of ["A-D5-05", "A-D5-06", "A-D5-09"]) expect(byId(id).inputs).toContain("macro");
    expect(canActivate(byId("A-D5-05"))).toEqual({
      ok: false,
      reason: "no_live_reader",
      missing: ["macro"],
    });
    expect(LIVE_READERS.has("macro")).toBe(false);
    expect(byId("A-D5-08").inputs).toEqual(["index_us"]);
    for (const id of ["A-D5-03", "A-D5-04"]) expect(byId(id).needsData).toMatch(/sector map/);
    for (const a of defs) expect(a.orientation).toBe(1);
  });
});

describe("helpers", () => {
  it("percentile, month-ends and sector ranks", () => {
    expect(percentileOf([1, 2, 3, 4], 3)).toBe(75);
    expect(percentileOf([5, 5, 5], 5)).toBe(100);
    const ends = completedMonthEnds(world.sessions, 30);
    expect(ends.map((i) => world.sessions[i])).toEqual(["2020-01-31"]);
    expect(completedMonthEnds(world.sessions, 18)).toEqual([]);
    const returns = new Map([
      ["b", 0.1],
      ["a", 0.1],
      ["c", -0.2],
    ]);
    expect(sectorRank(returns, "a")).toEqual({ rank: 1, n: 3 });
    expect(sectorRank(returns, "b")).toEqual({ rank: 2, n: 3 });
    expect(sectorRank(returns, "c")).toEqual({ rank: 3, n: 3 });
    expect(sectorRank(returns, "d")).toBeUndefined();
  });

  it("sectorReturns equal-weights the codes of each sector with enough bars and drops thin sectors", () => {
    const got = sectorReturns(view, T, 21, 1);
    const want = sectorMeans(T, 21);
    expect([...got.keys()]).toEqual(["Banks", "Energy", "Materials"]);
    for (const [s, v] of want) expect(got.get(s)).toBeCloseTo(v, 12);
    expect([...sectorReturns(view, T, 21, 2).keys()]).toEqual(["Banks", "Materials"]);
    expect(sectorReturns(view, 10, 21, 1).size).toBe(0); // warm-up
  });

  it("breadthAbove: share of codes above their SMA, undefined below the minimum universe", () => {
    let above = 0;
    for (const c of LONG_CODES) {
      let sum = 0;
      for (let i = T - 199; i <= T; i += 1) sum += closeCents(c, i);
      if (closeCents(c, T) * 200 > sum) above += 1;
    }
    expect(breadthAbove(view, T, 200, 1)).toBe(above / 5);
    expect(breadthAbove(view, T, 200, 6)).toBeUndefined();
    expect(breadthAbove(view, 100, 200, 1)).toBeUndefined();
  });
});

describe("D5 computes", () => {
  it("A-D5-01 returns the AGT-101 state as a bucket, undefined while the classifier is unknown", () => {
    const rw = regimeWorld();
    const rv = buildAsOfView(rw);
    const last = rw.sessions.length - 1;
    expect(run("A-D5-01", last, {}, rv)).toEqual({ bucket: rv.regime(last) });
    expect(["RISK-ON", "RISK-OFF", "NEUTRAL", "SHOCK"]).toContain(rv.regime(last));
    expect(run("A-D5-01", 0, {}, rv)).toBeUndefined();
    assertTruncationInvariant(rw, (v, c, t) => evaluateAngle(byId("A-D5-01"), "active", v, c, t), {
      ts: [0, 100, 155, 299],
    });
  });

  it("A-D5-02 breadth200 on the five-code universe (min_universe lowered); undefined at the registered minimum", () => {
    expect(run("A-D5-02", T, { min_universe: 1 })).toBe(breadthAbove(view, T, 200, 1));
    expect(run("A-D5-02", T)).toBeUndefined(); // 5 codes < 300
    expect(run("A-D5-02", 0, { min_universe: 1 })).toBeUndefined();
  });

  it("A-D5-03 sector relative strength: Materials leads on every horizon, so ZZA scores 1", () => {
    for (const h of [21, 63, 126]) {
      const means = sectorMeans(T, h);
      expect(means.get("Materials")).toBeGreaterThan(means.get("Banks")!);
      expect(means.get("Materials")).toBeGreaterThan(means.get("Energy")!);
    }
    expect(run("A-D5-03", T, { min_codes: 1 })).toBe(1);
    expect(run("A-D5-03", T, { min_codes: 1 }, view, "ZZB")).toBe(1);
    const zzc = run("A-D5-03", T, { min_codes: 1 }, view, "ZZC") as number;
    expect(zzc).toBeGreaterThanOrEqual(0);
    expect(zzc).toBeLessThan(1);
    expect(run("A-D5-03", T, { min_codes: 3 })).toBeUndefined(); // no sector reaches 3 codes
    expect(run("A-D5-03", 100, { min_codes: 1 })).toBeUndefined(); // warm-up
    expect(
      run("A-D5-03", T, { min_codes: 1 }, buildAsOfView({ ...world, industry: new Map() })),
    ).toBeUndefined();
  });

  it("A-D5-04 persistence: Materials in the top third at the last three month-ends -> 3; warm-up undefined", () => {
    const ends = completedMonthEnds(world.sessions, T).slice(0, 3);
    for (const i of ends) {
      const means = sectorMeans(i, 126);
      expect(sectorRank(means, "Materials")).toEqual({ rank: 1, n: 3 });
    }
    expect(run("A-D5-04", T, { min_codes: 1 })).toBe(3);
    expect(run("A-D5-04", T, { min_codes: 1, lookback: 6 })).toBe(6);
    expect(run("A-D5-04", 100, { min_codes: 1 })).toBe(0); // month-ends exist, but no sector has 127 bars
    expect(run("A-D5-04", 30, { min_codes: 1 })).toBeUndefined(); // one completed month-end < lookback
  });

  it("A-D5-05 rates bucket from the 10-year yield level and 60-observation change", () => {
    const series = (value: (i: number) => number): AsOfWorld => {
      const rows: MacroRow[] = world.sessions.map((d, i) => ({ obsD: d, value: value(i) }));
      return longWorld({ sessions: 300, macro: new Map([[AU_10Y_SERIES, rows]]) });
    };
    const w = (value: (i: number) => number) => buildAsOfView(series(value));
    expect(
      run(
        "A-D5-05",
        299,
        {},
        w(() => 3),
      ),
    ).toEqual({ bucket: "supportive" });
    expect(
      run(
        "A-D5-05",
        299,
        {},
        w(() => 6),
      ),
    ).toEqual({ bucket: "restrictive" });
    expect(
      run(
        "A-D5-05",
        299,
        {},
        w(() => 4.5),
      ),
    ).toEqual({ bucket: "neutral" });
    // Level neutral, change +0.3 pp over the last 60 observations -> restrictive; falling -> supportive.
    expect(
      run(
        "A-D5-05",
        299,
        {},
        w((i) => 4.2 + (i >= 250 ? 0.3 : 0)),
      ),
    ).toEqual({
      bucket: "restrictive",
    });
    expect(
      run(
        "A-D5-05",
        299,
        {},
        w((i) => 4.8 - (i >= 250 ? 0.3 : 0)),
      ),
    ).toEqual({
      bucket: "supportive",
    });
    expect(
      run(
        "A-D5-05",
        299,
        { change_bp: 40 },
        w((i) => 4.2 + (i >= 250 ? 0.3 : 0)),
      ),
    ).toEqual({
      bucket: "neutral",
    });
    // The observation dated tonight is published one session later (MACRO_DEFAULT): 60 obs by t = 60.
    expect(
      run(
        "A-D5-05",
        60,
        {},
        w(() => 3),
      ),
    ).toBeUndefined();
    expect(
      run(
        "A-D5-05",
        61,
        {},
        w(() => 3),
      ),
    ).toEqual({ bucket: "supportive" });
  });

  it("A-D5-08 US risk state from the last known US session (D-1), the VIX percentile over 1,260 sessions", () => {
    // The bar dated sessions[T] is known at T+1 09:00 Melbourne: the view holds up to sessions[T-1].
    const last = T - 1;
    const values: number[] = [];
    for (let i = last - 1259; i <= last; i += 1) values.push(vixLevel(i));
    const pct = percentileOf(values, vixLevel(last));
    expect(pct).toBeLessThan(50);
    expect(run("A-D5-08", T)).toEqual({ bucket: "risk_on" }); // GSPC rises above its SMA200
    expect(run("A-D5-08", T, { vix_pct_on: Math.floor(pct) })).toEqual({ bucket: "neutral" });
    expect(run("A-D5-08", 1259)).toBeUndefined(); // 1,259 known VIX bars
    expect(run("A-D5-08", 1260)).toBeDefined();
    // A VIX spike dated tonight must be invisible (D-290): same state as without it.
    const spiked = buildAsOfView({
      ...world,
      index: {
        ...world.index,
        VIX: world.index!.VIX!.map((b, i) => (i === T ? { ...b, close: 90_000_000n } : b)),
      },
    });
    expect(run("A-D5-08", T, {}, spiked)).toEqual({ bucket: "risk_on" });
    // A falling S&P with a high VIX percentile is risk_off.
    const off = buildAsOfView({
      ...world,
      index: {
        ...world.index,
        GSPC: world.sessions.map((d, i) => ({ d, close: BigInt(5000 - i) * 1_000_000n })),
        VIX: world.sessions.map((d, i) => ({
          d,
          close: BigInt(10 + (i >= T - 5 ? 80 : i % 40)) * 1_000_000n,
        })),
      },
    });
    expect(run("A-D5-08", T, {}, off)).toEqual({ bucket: "risk_off" });
  });

  it("A-D5-09 equity-bond correlation: yields tied against ^AXJO co-move; undefined without 60 pairs", () => {
    expect(run("A-D5-09", T)).toEqual({ bucket: "co_moving" });
    expect(run("A-D5-09", T, { co_threshold: 1.1, off_threshold: -1.1 })).toEqual({
      bucket: "neutral",
    });
    expect(run("A-D5-09", T, { co_threshold: 1.1, off_threshold: 1.01 })).toEqual({
      bucket: "offsetting",
    });
    expect(run("A-D5-09", 60)).toBeUndefined(); // the yield of sessions[60] is published at 61
    expect(run("A-D5-09", 61)).toEqual({ bucket: "co_moving" });
    expect(axjoLevel(1) - axjoLevel(0)).not.toBe(0);
  });

  it("A-D5-10 sector sentiment: ZZA's price-sensitive events over the window, shrunk with k", () => {
    // Window 20 at T: E7 (-1), E1 (+1), E4 is outside; E6 not price-sensitive -> sum 0 / (2 + 3).
    expect(run("A-D5-10", T)).toBe(0);
    expect(run("A-D5-10", T, {}, view, "ZZB")).toBe(0); // same sector, same events
    expect(run("A-D5-10", T, {}, view, "ZZC")).toBe(0); // Banks: no events -> 0 / 3
    // At T-2 only E1 (+1) is inside: 1 / (1 + 3); with k = 1: 1 / 2.
    expect(run("A-D5-10", T - 2)).toBe(0.25);
    expect(run("A-D5-10", T - 2, { k: 1 })).toBe(0.5);
    expect(run("A-D5-10", T - 2, { window: 5 }, view, "ZZE")).toBe(0);
    expect(run("A-D5-10", T, {}, buildAsOfView({ ...world, industry: new Map() }))).toBeUndefined();
  });

  it("every compute passes TST-109 on the long world (one cut per t, every angle on both grids)", () => {
    const grid = { min_universe: 1, min_codes: 1 };
    const defs = D5_ANGLES.filter((a) => a.compute && a.id !== "A-D5-01");
    expect(defs.length).toBe(7);
    assertTruncationInvariant(
      world,
      (v, c, t) =>
        defs.flatMap((def) => [
          evaluateAngle(def, "active", v, c, t),
          evaluateAngle(def, "active", v, c, t, { ...defaultGrid(def), ...grid }),
        ]),
      { ts: TS },
    );
  }, 120_000);
});
