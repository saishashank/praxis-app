// @vitest-environment node
// D6 Sentiment, positioning and flows (M15 C1c; angles_D6.md; CTX-011, CTX-051): the ASIC short
// level reads `view.shorts` under the publication lag; the announcement-dependent entries are
// candidates with forward computes; the dividend-capture and contrarian gates are computed from
// the vendor actions, the calendar and the universe.
import { describe, expect, it } from "vitest";
import {
  benchmarkVolPct,
  D6_ANGLES,
  MIN_SHORT_POINTS,
  shortChange,
  shortsWithin,
} from "@/lib/cortex/angles/d6";
import { regimeSeries } from "@/lib/agents/regime";
import { breadthAbove } from "@/lib/cortex/angles/d5";
import {
  ANGLES_PER_DOMAIN,
  canActivate,
  defaultGrid,
  defineAngles,
  evaluateAngle,
  resolveStatus,
} from "@/lib/cortex/angles/registry";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import { assertTruncationInvariant } from "@/lib/cortex/pit/truncation";
import type { AsOfView } from "@/lib/cortex/pit/types";
import { asicPublishedAt } from "@/lib/data/backfill/rules.mjs";
import { axjoLevel, closeCents, LONG_CODES, longWorld, SHORT_PPM, shortWorld } from "./d3to8World";

const world = longWorld();
const view = buildAsOfView(world);
const T = world.sessions.length - 1;
const sw = shortWorld();
const sv = buildAsOfView(sw);
const ST = sw.sessions.length - 1;
const byId = (id: string) => D6_ANGLES.find((a) => a.id === id)!;
const run = (id: string, t: number, grid: Record<string, number> = {}, v = view, code = "ZZA") => {
  const def = byId(id);
  return def.compute!(v, code, t, { ...defaultGrid(def), ...grid });
};
const TS = [0, 1, 126, 127, 299, 650, 1000, 1280, 1281, T - 2, T - 1, T];

describe("D6 passports", () => {
  it("has ten validated entries with the expected statuses and clusters", () => {
    const defs = defineAngles(D6_ANGLES);
    expect(defs.length).toBe(ANGLES_PER_DOMAIN);
    expect(defs.map((a) => resolveStatus(a, "active"))).toEqual([
      "active", // 01 ASIC shorts
      "candidate", // 02 index flows (announcement archive)
      "active", // 03 dividend capture gate
      "candidate", // 04 options
      "candidate", // 05 ETF flows
      "candidate", // 06 tone
      "candidate", // 07 spike
      "candidate", // 08 crowdedness
      "candidate", // 09 attention
      "active", // 10 contrarian extremes gate
    ]);
    expect(byId("A-D6-01").inputs).toEqual(["asic_short"]);
    expect(byId("A-D6-01").cluster).toBe("sentiment");
    expect(byId("A-D6-03").kind).toBe("gate");
    expect(byId("A-D6-10").kind).toBe("gate");
    expect(byId("A-D6-08").cluster).toBe("momentum");
    for (const id of ["A-D6-02", "A-D6-06", "A-D6-07", "A-D6-08"]) {
      expect(byId(id).inputs).toContain("announcement");
      expect(byId(id).needsData).toMatch(/announcement archive/);
    }
    for (const id of ["A-D6-04", "A-D6-09"]) {
      expect(byId(id).needsData).toBeDefined();
      expect(byId(id).compute).toBeUndefined();
      expect(canActivate(byId(id)).ok).toBe(false);
    }
    for (const a of defs) {
      expect(a.domain).toBe(6);
      expect(a.orientation).toBe(1);
      if (a.needsData)
        expect(evaluateAngle(a, resolveStatus(a, "active"), view, "ZZA", T)).toBeUndefined();
    }
  });
});

describe("A-D6-01 short interest through the ASIC publication lag", () => {
  it("sees a report only after as_of + the ASIC lag, and reads points inside the trailing window", () => {
    const lastAsOf = sw.sessions[255]!;
    const known = asicPublishedAt(lastAsOf);
    const firstT = sw.sessions.findIndex((d) => sv.cutoffUtc(sw.sessions.indexOf(d)) >= known);
    expect(firstT).toBeGreaterThan(255);
    expect(shortsWithin(sv, "ZZA", firstT - 1, 250).length).toBe(SHORT_PPM.length - 1);
    expect(shortsWithin(sv, "ZZA", firstT, 250).length).toBe(SHORT_PPM.length);
    expect(shortsWithin(sv, "ZZA", ST, 250).map((p) => p.ppm)).toEqual([...SHORT_PPM].reverse());
    expect(shortsWithin(sv, "ZZA", ST, 50).map((p) => p.ppm)).toEqual([11_000, 12_000]);
    expect(shortsWithin(sv, "ZZB", ST, 250)).toEqual([]);
  });

  it("scores -(p - 0.5) x 2 with p the share of reports at or below the latest: 11 of 12 -> -0.8333", () => {
    // Twelve reports, latest 11,000: ten of the eleven PRIOR reports are lower (AGT-030 half-tie, D-326).
    expect(run("A-D6-01", ST, {}, sv)).toBeCloseTo(-(10 / 11 - 0.5) * 2, 12);
    expect(byId("A-D6-01").grid).toEqual({});
    // Before the last report is published (as_of + 5 weekdays, end of day) the latest is 12,000 (the maximum of 11): p = 1 -> -1.
    expect(run("A-D6-01", 260, {}, sv)).toBe(-1);
    // Fewer than MIN_SHORT_POINTS reports: undefined (unknown, not zero).
    expect(MIN_SHORT_POINTS).toBe(10);
    expect(run("A-D6-01", 240, {}, sv)).toBeUndefined();
    expect(run("A-D6-01", 0, {}, sv)).toBeUndefined();
    expect(run("A-D6-01", ST, {}, sv, "ZZB")).toBeUndefined();
  });

  it("shortChange: latest minus the newest report at or before t - lag", () => {
    expect(shortChange(sv, "ZZA", ST, 10)).toBe(0); // every report is older than t - 10
    // At the first session that sees the last report (as_of session 255): 11,000 - the report at or before t - 10.
    const t = sw.sessions.findIndex(
      (d, i) => sv.cutoffUtc(i) >= asicPublishedAt(sw.sessions[255]!),
    );
    const ref = sw.sessions[t - 10]!;
    const base = [...SHORT_PPM].reverse().find((_, j) => sw.sessions[255 - 5 * j]! <= ref)!;
    expect(shortChange(sv, "ZZA", t, 10)).toBe(11_000 - base);
    expect(shortChange(sv, "ZZA", 5, 10)).toBeUndefined();
    expect(shortChange(sv, "ZZB", ST, 10)).toBeUndefined();
  });
});

describe("D6 computes on the long world", () => {
  it("A-D6-02 index flow: ZZB's add is open (effective ahead), signed abnormal return since the announcement session", () => {
    const i = T - 4; // announced sessions[T-4]... the row is known one session later (D-302)
    const r = closeCents("ZZB", T) / closeCents("ZZB", i) - 1;
    const b = axjoLevel(T) / axjoLevel(i) - 1;
    expect(run("A-D6-02", T, {}, view, "ZZB")).toBeCloseTo(Math.min(1, Math.abs(r - b) / 0.1), 12);
    expect(run("A-D6-02", T, { ar_scale_pct: 0.001 }, view, "ZZB")).toBe(1);
    expect(run("A-D6-02", T - 3, { ar_scale_pct: 0.001 }, view, "ZZC")).toBe(-1);
    expect(run("A-D6-02", T - 4, {}, view, "ZZB")).toBeUndefined(); // not yet known (announced + 1 session)
    expect(run("A-D6-02", T, {}, view, "ZZC")).toBeUndefined(); // delete already effective: window closed
    expect(run("A-D6-02", T - 3, {}, view, "ZZC")).toBeLessThan(0); // delete: negative sign while open
    expect(run("A-D6-02", T, {}, view, "ZZA")).toBeUndefined();
    expect(
      run("A-D6-02", T, {}, buildAsOfView({ ...world, indexChanges: null }), "ZZB"),
    ).toBeUndefined();
  });

  it("A-D6-03 dividend capture: the 0.10 dividend ex tomorrow is 0.5 % of the close -> none at 4 %, candidate at 0.4 %", () => {
    expect(run("A-D6-03", T - 1)).toEqual({ flag: "none" });
    expect(run("A-D6-03", T - 1, { yield_pct: 0.4 })).toEqual({ flag: "capture_candidate" });
    // A vendor row is known from the start of the session before its ex-date: two sessions out it is unseen.
    expect(run("A-D6-03", T - 2, { yield_pct: 0.4, entry_k: 2 })).toEqual({ flag: "none" });
    expect(run("A-D6-03", T - 101, { yield_pct: 0.4, entry_k: 2 })).toEqual({ flag: "none" });
    expect(run("A-D6-03", T - 100, { yield_pct: 0.4, entry_k: 2 })).toEqual({
      flag: "capture_candidate",
    }); // 0.30 ex in one session
    expect(run("A-D6-03", T, { yield_pct: 0.4 })).toEqual({ flag: "none" }); // ex today, not ahead
    expect(run("A-D6-03", T - 1, {}, view, "ZZB")).toEqual({ flag: "none" });
  });

  it("A-D6-07 spike: three events in the last five sessions over a zero median -> the newest PS polarity (-1); 0 without a spike", () => {
    expect(run("A-D6-07", T)).toBe(-1);
    expect(run("A-D6-07", T, { spike_ratio: 4 })).toBe(0);
    expect(run("A-D6-07", T - 2)).toBe(0); // one recent event: ratio 1
    expect(run("A-D6-07", T, {}, view, "ZZB")).toBe(0);
    expect(run("A-D6-07", 60)).toBeUndefined(); // 65 sessions of history needed
    expect(run("A-D6-07", 64)).toBe(0);
  });

  it("A-D6-08 crowdedness: 3 - conditions met (ZZA: volume surge only on the long world; ZZB: top return too)", () => {
    const rets = new Map<string, number>(
      LONG_CODES.map((c) => [c, closeCents(c, T) / closeCents(c, T - 126) - 1]),
    );
    // AGT-030 half-tie share against the other four codes of the tier (D-326).
    const pct = (c: string) => {
      const mine = rets.get(c)!;
      const others = [...rets].filter(([k]) => k !== c).map(([, r]) => r);
      return (
        (others.filter((r) => r < mine).length + 0.5 * others.filter((r) => r === mine).length) / 4
      );
    };
    expect(pct("ZZB")).toBe(1);
    expect(pct("ZZA")).toBe(0.25); // only ZZC is lower
    expect(pct("ZZA")).toBeLessThan(0.8);
    expect(run("A-D6-08", T)).toBe(2); // volume surge on the last five sessions
    expect(run("A-D6-08", T - 5)).toBe(3); // no surge yet
    expect(run("A-D6-08", T, {}, view, "ZZB")).toBe(2); // top return, no surge
    expect(run("A-D6-08", T, { ret_pct: 1.01 }, view, "ZZB")).toBe(3);
    expect(run("A-D6-08", 125)).toBeUndefined();
    expect(run("A-D6-08", 126)).toBeDefined();
    // Covering: ZZA's last report 11,000 ppm against 12,000 ppm at t - 10 on the short world is -0.1 pp: not met.
    const t = sw.sessions.findIndex(
      (d, i) => sv.cutoffUtc(i) >= asicPublishedAt(sw.sessions[255]!),
    );
    expect(shortChange(sv, "ZZA", t, 10)).toBe(-1000);
    expect(run("A-D6-08", t, {}, sv)).toBe(3);
  });

  it("A-D6-10 contrarian extremes: both legs must hold (breadth level and the benchmark volatility percentile)", () => {
    const breadth = breadthAbove(view, T, 200, 1)!;
    expect(breadth).toBeGreaterThan(0.1);
    // The periodic benchmark's realised volatility shrinks as its level rises: tonight's is near the bottom.
    expect(run("A-D6-10", T, { min_universe: 1 })).toEqual({ flag: "none" });
    expect(run("A-D6-10", T, { min_universe: 1, breadth_low: 1 })).toEqual({ flag: "none" });
    expect(run("A-D6-10", T, { min_universe: 1, vol_pct: 0 })).toEqual({ flag: "none" });
    expect(run("A-D6-10", T, { min_universe: 1, breadth_low: 1, vol_pct: 0 })).toEqual({
      flag: "extreme_low",
    });
    expect(run("A-D6-10", T, { min_universe: 1, breadth_low: 1, vol_pct: 1 })).toEqual({
      flag: "none",
    });
    expect(run("A-D6-10", T)).toBeUndefined(); // 5 codes < 300
    expect(run("A-D6-10", 1280, { min_universe: 1 })).toBeUndefined(); // 1,281 closes: no prior 1,260 vols
    expect(run("A-D6-10", 1281, { min_universe: 1 })).toBeDefined();
  });

  it("benchmarkVolPct equals AGT-101 vol_pct on the same night (regimeSeries, default params) and is memoised", () => {
    const closes = view.index("AXJO", T, T + 1).map((b) => b.close);
    const regime = regimeSeries(closes, world.regimeParams);
    const want = regime[regime.length - 1]!.vol_pct;
    expect(want).not.toBeNull();
    expect(benchmarkVolPct(view, T)).toBe(want);
    expect(benchmarkVolPct(view, T - 7)).toBe(regime[T - 7]!.vol_pct);
    let indexCalls = 0;
    const counted = new Proxy(view, {
      get(target, prop, receiver) {
        if (prop === "index") indexCalls += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(benchmarkVolPct(counted, T)).toBe(want);
    expect(benchmarkVolPct(counted, T)).toBe(want);
    expect(indexCalls).toBe(1);
  });

  it("every compute passes TST-109 on the long and short worlds (one cut per t, every angle on both grids)", () => {
    const defs = D6_ANGLES.filter((a) => a.compute);
    expect(defs.length).toBe(6);
    const all = (v: AsOfView, c: string, t: number) =>
      defs.flatMap((def) => [
        evaluateAngle(def, "active", v, c, t),
        evaluateAngle(def, "active", v, c, t, { ...defaultGrid(def), min_universe: 1 }),
      ]);
    assertTruncationInvariant(world, all, { ts: TS });
    assertTruncationInvariant(sw, all, { ts: [0, 200, 240, 260, 261, 270, 299] });
  }, 120_000);
});
