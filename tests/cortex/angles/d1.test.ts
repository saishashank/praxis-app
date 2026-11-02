// @vitest-environment node
// D1 angles (M15 C1b; angles_D1.md; CTX-011, CTX-030, CTX-050; TST-109; D-316/317/318). Per angle:
// a hand-computed value on a synthetic ZZ path, the warm-up boundary (undefined one bar short,
// defined at `warmupSessions`), a window-pinning case, and the TST-109 truncation invariant over a
// world. Every grid key is shown to change some value (D-318). Registry rules via
// `defineAngles(D1_ANGLES)`.
import { describe, expect, it } from "vitest";
import { atrSeries, logReturns, stdevFloat } from "@/lib/agents/indicators";
import { ATR_HISTORY, D1_ANGLES, seriesAt } from "@/lib/cortex/angles/d1";
import { defaultGrid, defineAngles, evaluateAngle } from "@/lib/cortex/angles/registry";
import type { AngleDef, AngleValue, AsOfView } from "@/lib/cortex/angles/types";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import { assertTruncationInvariant, valueKey } from "@/lib/cortex/pit/truncation";
import type { AsOfWorld } from "@/lib/cortex/pit/types";
import { synthWorld, weekdaySessions, wobble, type PathSpec } from "./d1d2World";

const N = 520; // room for the 312-bar A-D1-06 warm-up plus a long run of cut-offs
const LAST = N - 1;
const SESSIONS = weekdaySessions(N);

const up: PathSpec = { close: (i) => 1_000 + 2 * i }; // +2 c a session; H-L = 6 c, ATR(20) = 0.06
const down: PathSpec = { close: (i) => 2_000 - 2 * i };
const flat: PathSpec = { close: () => 1_000 }; // H-L = 4 c, ATR(20) = 0.04

/** Up to 1,598 c at i = 299, `downs` sessions down 2 c, then a close above the prior bar's high. */
const pullback = (downs: number): PathSpec => ({
  close: (i) =>
    i < 300
      ? 1_000 + 2 * i
      : i < 300 + downs
        ? 1_598 - 2 * (i - 299)
        : i === 300 + downs
          ? 1_598 - 2 * (downs - 2) + 2
          : 1_600,
});
/**
 * Range contraction: rise to R = LAST - 29, flat after; bracket 1 c for 20 sessions, then 0 c for
 * the last 10 (dead range) so the last ten ATR / close ratios sit far below the 250-session median
 * and the recent range (0) is below 0.8 x the prior ten sessions' range (2 c). Pivot(20) = C + 1 c.
 */
const R = LAST - 29;
const contraction: PathSpec = {
  close: (i) => (i < R ? 1_000 + 2 * i : 1_000 + 2 * R),
  hi: (i) => (i < R ? 2 : i < R + 20 ? 1 : 0),
  lo: (i) => (i < R ? 2 : i < R + 20 ? 1 : 0),
};
/**
 * Candle reversal: rise to 1,600 at i = 300, flat after; a one-bar dip at 310 (low 1,576, a
 * confirmed pivot low); at 321 a black bar (1,600 -> 1,590); at 322 a white bar opening 1,580 and
 * closing 1,604 (engulfs 1,590..1,600; low 1,578 is 2 c off the pivot; body / range = 24 / 28);
 * 323 closes 1,610, above the 322 high of 1,606: the flag fires at t = 323.
 */
const candle: PathSpec = {
  close: (i) =>
    i < 300
      ? 1_000 + 2 * i
      : i === 310
        ? 1_578
        : i === 321
          ? 1_590
          : i === 322
            ? 1_604
            : i >= 323
              ? 1_610
              : 1_600,
  open: (i, prev) => (i === 311 ? 1_600 : i === 322 ? 1_580 : i === 323 ? 1_606 : prev),
};
/**
 * Resistance: flat 1,600 after i = 300 with a spike to 1,640 at 310 (high 1,642; the 311 bar
 * opens back at 1,600 so the spike is a strict fractal), then 1,641 on the last session.
 */
const resistance: PathSpec = {
  close: (i) => (i < 300 ? 1_000 + 2 * i : i === 310 ? 1_640 : i === LAST ? 1_641 : 1_600),
  open: (i, prev) => (i === 311 ? 1_600 : prev),
};

const world = synthWorld({
  sessions: SESSIONS,
  codes: {
    ZZU: up,
    ZZD: down,
    ZZF: flat,
    ZZW: { close: wobble(7) },
    ZZX: { close: wobble(13, 1_500) },
    ZZY: { close: wobble(29, 600) },
    // a 6 % open gap on the last session (between the 4 % and 8 % grid points)
    ZZG: { ...up, open: (i, prev) => (i === LAST ? Math.round(prev * 1.06) : prev) },
    // a +5 c close over the prior close on the last session: ext ~ 0.81 (between 0.75 and 1)
    ZZJ: { close: (i) => 1_000 + 2 * i + (i === LAST ? 3 : 0) },
    ZZP: pullback(4), // depth 0.08 / 0.062 ~ 1.3
    ZZQ: pullback(7), // depth 0.14 / 0.062 ~ 2.3
    ZZC: contraction,
    ZZE: candle,
    ZZS: resistance,
  },
});
const view = buildAsOfView(world);

const SECTOR_CODES = ["ZZA", "ZZB", "ZZC", "ZZD", "ZZE"];
const sectorWorld = synthWorld({
  sessions: SESSIONS,
  codes: Object.fromEntries(
    SECTOR_CODES.map((c, k) => [c, { close: wobble(11 + k, 900 + 50 * k) }]),
  ),
  industry: Object.fromEntries(SECTOR_CODES.map((c) => [c, "Mat"])),
});
const sectorView = buildAsOfView(sectorWorld);

const byId = new Map(D1_ANGLES.map((a) => [a.id, a] as const));
const def = (id: string): AngleDef => byId.get(id)!;
const run = (
  id: string,
  v = view,
  code = "ZZU",
  t = LAST,
  grid = defaultGrid(def(id)),
): AngleValue => evaluateAngle(def(id), "active", v, code, t, grid);
const one = (code: string, spec: PathSpec): AsOfView =>
  buildAsOfView(synthWorld({ sessions: SESSIONS, codes: { [code]: spec } }));

/** ATR(20) at session index t of `code`: the v1 Wilder fold over the ATR_HISTORY bars ending there (the reference, not the angle). */
function atrRef(v: AsOfView, code: string, t: number): number {
  const s = seriesAt(v, code, t, ATR_HISTORY)!;
  const f = (x: bigint): number => Number(x) / 1e6;
  const a = atrSeries(
    s.adj.map((b) => f(b.high)),
    s.adj.map((b) => f(b.low)),
    s.adjClose.map(f),
    20,
  );
  return a[a.length - 1]!;
}

describe("D1 registry entries", () => {
  it("ten ids A-D1-01..10, valid under defineAngles, one gate (A-D1-09), the rest score angles", () => {
    const sorted = defineAngles(D1_ANGLES);
    expect(sorted.map((a) => a.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `A-D1-${String(i + 1).padStart(2, "0")}`),
    );
    for (const a of D1_ANGLES) {
      expect(a.domain).toBe(1);
      expect(a.orientation).toBe(1);
      expect(a.compute).toBeDefined();
      expect(a.needsData).toBeUndefined();
    }
    expect(D1_ANGLES.filter((a) => a.kind === "gate").map((a) => a.id)).toEqual(["A-D1-09"]);
    expect(def("A-D1-09").cluster).toBe("risk");
    expect(def("A-D1-05").cluster).toBe("sentiment");
    expect(def("A-D1-08").cluster).toBe("sentiment");
    expect(def("A-D1-06").cluster).toBe("low_volatility");
    expect(def("A-D1-07").cluster).toBe("low_volatility");
    expect(def("A-D1-10").inputs).toEqual(["bar_au", "sector_map"]);
    // D-318: card thresholds live in the passport text, not in the grid.
    expect(def("A-D1-02").grid).toEqual({ lookback: [250, 200, 225], young_floor: [0, 60] });
    expect(def("A-D1-02").historyFields?.some((h) => h.startsWith("card threshold"))).toBe(true);
    // D-316: a flag from a score angle is a veto, and the passport says so.
    expect(def("A-D1-03").definition).toContain("ineligible");
  });

  it("a candidate status, or a code with no bar tonight, evaluates to undefined", () => {
    expect(evaluateAngle(def("A-D1-02"), "candidate", view, "ZZU", LAST)).toBeUndefined();
    const gapped: AsOfWorld = {
      ...world,
      bars: new Map([["ZZU", world.bars.get("ZZU")!.filter((b) => b.d !== SESSIONS[LAST])]]),
    };
    const gv = buildAsOfView(gapped);
    for (const a of D1_ANGLES) expect(run(a.id, gv, "ZZU", LAST)).toBeUndefined();
    expect(run("A-D1-02", gv, "ZZU", LAST - 1)).toBe(1);
  });
});

describe("warm-up boundaries (warmupSessions is exact for the default grid)", () => {
  for (const a of D1_ANGLES) {
    it(`${a.id}: undefined at ${a.warmupSessions - 1} bars, defined at ${a.warmupSessions}`, () => {
      const [v, code] = a.id === "A-D1-10" ? [sectorView, "ZZA"] : [view, "ZZU"];
      expect(run(a.id, v, code, a.warmupSessions - 2)).toBeUndefined();
      expect(run(a.id, v, code, a.warmupSessions - 1)).not.toBeUndefined();
    });
  }
});

describe("D-318: every grid key changes some value on the test world", () => {
  // One alternative point per key, chosen so that at least one (code, t) of the world flips.
  const ALT: Record<string, Record<string, number>> = {
    "A-D1-01": { mid: 100, long: 200, skip: 21, young_floor: 60 },
    "A-D1-02": { lookback: 200, young_floor: 60 },
    "A-D1-03": { lookback: 125, ext_veto: 0.75, gap_cap_pct: 4 },
    "A-D1-04": { depth_min: 1.5, depth_max: 2 },
    "A-D1-05": { rsi2_max: 5, rsi14_max: 35 },
    "A-D1-06": { lookback: 504 },
    "A-D1-07": { contraction: 0.1, range_ratio: 0, pivot: 10 },
    "A-D1-08": { body_min: 0.9, level: 0.25 },
    "A-D1-09": { near: 0.1 },
    "A-D1-10": { lookback: 63, skip: 21 },
  };
  for (const a of D1_ANGLES) {
    it(`${a.id}: ${Object.keys(a.grid).join(", ")}`, () => {
      const v = a.id === "A-D1-10" ? sectorView : view;
      const base = defaultGrid(a);
      expect(Object.keys(ALT[a.id]!).sort()).toEqual(Object.keys(a.grid).sort());
      for (const [key, alt] of Object.entries(ALT[a.id]!)) {
        const grid = { ...base, [key]: alt };
        let flipped = false;
        // the young-listing point (A5) only differs while a code is younger than its lookback
        const from = key === "young_floor" ? 59 : a.warmupSessions - 1;
        for (let t = from; t <= LAST && !flipped; t += 1)
          for (const code of v.codes(t))
            if (valueKey(run(a.id, v, code, t)) !== valueKey(run(a.id, v, code, t, grid))) {
              flipped = true;
              break;
            }
        expect(flipped, `${a.id}.${key} = ${alt} changed nothing`).toBe(true);
      }
    });
  }
});

describe("A-D1-01 trend and momentum", () => {
  it("every horizon up and above SMA200 -> 1; every horizon down -> -1; mixed = mean of signs", () => {
    expect(run("A-D1-01")).toBe(1);
    expect(run("A-D1-01", view, "ZZD")).toBe(-1);
    // Flat series: no return is > 0 -> -1 on every horizon (strict comparison).
    expect(run("A-D1-01", view, "ZZF")).toBe(-1);
    // A 21-session skip reads the closes 21 sessions back; on a monotone path the signs agree.
    expect(run("A-D1-01", view, "ZZU", LAST, { mid: 126, long: 252, skip: 21 })).toBe(1);
  });

  it("a rise that started inside the mid window: mid and skip up, long down -> 1/3", () => {
    // Down 10 c a session to LAST - 130, then up 4 c a session: at LAST the close (1,520) is
    // above the close 126 back (1,016) and above SMA200 (~1,330), but below the close 252 back.
    const D = LAST - 130;
    const v = one("ZZV", { close: (i) => (i < D ? 5_000 - 10 * i : 1_000 + 4 * (i - D)) });
    expect(run("A-D1-01", v, "ZZV")).toBeCloseTo(1 / 3, 12);
    // Window pin: the long sign reads the close exactly `long` sessions back. The down leg
    // crosses 1,520 c at i = 348 = LAST - 171: long 170 reads 1,510 (up, strict), 171 reads
    // 1,520 (not above: down).
    expect(run("A-D1-01", v, "ZZV", LAST, { mid: 126, long: 170, skip: 0 })).toBe(1);
    expect(run("A-D1-01", v, "ZZV", LAST, { mid: 126, long: 171, skip: 0 })).toBeCloseTo(1 / 3, 12);
  });
});

describe("A-D1-02 52-week-high proximity", () => {
  it("close at its 250-session high -> 1; a falling series -> close / high of the window", () => {
    expect(run("A-D1-02")).toBe(1);
    const c = (i: number): number => 2_000 - 2 * i;
    expect(run("A-D1-02", view, "ZZD")).toBeCloseTo(c(LAST) / c(LAST - 249), 12);
    expect(run("A-D1-02", view, "ZZD", LAST, { lookback: 200 })).toBeCloseTo(
      c(LAST) / c(LAST - 199),
      12,
    );
    // Window pin: a spike exactly 250 sessions back is inside the window, 251 back is not.
    const spike = (at: number): PathSpec => ({
      close: (i) => 1_000 + 2 * i + (i === at ? 600 : 0),
    });
    const inWin = one("ZZI", spike(LAST - 249));
    const outWin = one("ZZO", spike(LAST - 250));
    expect(run("A-D1-02", inWin, "ZZI")).toBeCloseTo(
      (1_000 + 2 * LAST) / (1_600 + 2 * (LAST - 249)),
      12,
    );
    expect(run("A-D1-02", outWin, "ZZO")).toBe(1);
  });
});

describe("A-D1-03 breakout quality", () => {
  it("+2 c above the prior high with ATR 0.06 -> quality 2/3; a mid extension; not a breakout -> 0", () => {
    expect(run("A-D1-03")).toBeCloseTo(2 / 3, 9);
    expect(run("A-D1-03", view, "ZZD")).toBe(0); // below every prior close: not a breakout
    expect(run("A-D1-03", view, "ZZF")).toBe(0); // equal to the prior high: not above it
    // +5 c over the prior close: H - L = 9 c -> ATR = (19 x 0.06 + 0.09) / 20 = 0.0615; ext = 0.05 / ATR ~ 0.81.
    const atr = atrRef(view, "ZZJ", LAST);
    expect(atr).toBeCloseTo(0.0615, 9);
    expect(run("A-D1-03", view, "ZZJ")).toBeCloseTo(1 - 0.05 / atr, 9);
  });

  it("the prior-high window is exactly 250 sessions", () => {
    // A +600 c spike exactly 250 sessions back is the prior high -> not a breakout -> 0; one
    // session further back it has left the window -> the usual 2/3 (the spike's bar is also
    // outside the 250-bar ATR fold).
    const spike = (at: number): PathSpec => ({
      close: (i) => 1_000 + 2 * i + (i === at ? 600 : 0),
    });
    expect(run("A-D1-03", one("ZZI", spike(LAST - 250)), "ZZI")).toBe(0);
    expect(run("A-D1-03", one("ZZO", spike(LAST - 251)), "ZZO")).toBeCloseTo(2 / 3, 9);
  });

  it("vetoes an open gap at or above gap_cap_pct and an extension past ext_veto (D-316)", () => {
    // A 6 % gap is under the 8 % cap: quality from ext = 0.02 / ATR (the gap bar widens the ATR).
    expect(run("A-D1-03", view, "ZZG")).toBeCloseTo(1 - 0.02 / atrRef(view, "ZZG", LAST), 9);
    expect(
      run("A-D1-03", view, "ZZG", LAST, { lookback: 250, ext_veto: 1, gap_cap_pct: 5 }),
    ).toEqual({
      flag: "veto",
    });
    const gap = one("ZZH", {
      ...up,
      open: (i, prev) => (i === LAST ? Math.round(prev * 1.1) : prev),
    });
    expect(run("A-D1-03", gap, "ZZH")).toEqual({ flag: "veto" });
    // ZZJ: ext ~ 0.81 -> quality with ext_veto 1, veto with ext_veto 0.75.
    expect(
      run("A-D1-03", view, "ZZJ", LAST, { lookback: 250, ext_veto: 0.75, gap_cap_pct: 8 }),
    ).toEqual({
      flag: "veto",
    });
    // Jump of 20 c: ext = 0.20 / 0.069 ~ 2.9 > 1 -> veto; with ext_veto 5 the quality is 0.
    const jump = one("ZZK", { close: (i) => 1_000 + 2 * i + (i === LAST ? 20 : 0) });
    expect(run("A-D1-03", jump, "ZZK")).toEqual({ flag: "veto" });
    expect(run("A-D1-03", jump, "ZZK", LAST, { lookback: 250, ext_veto: 5, gap_cap_pct: 8 })).toBe(
      0,
    );
  });
});

describe("A-D1-04 pullback resumption", () => {
  it("flags the resumption bar and nothing before it; the depth band is read from the grid", () => {
    // ZZP: four sessions down to 1,590 at 303, 1,596 at 304 (above the 303 bar's high 1,594):
    // depth = (1,598 - 1,590) / ATR_304, ATR_304 = (19 x 0.06 + 0.10) / 20 = 0.062 -> 1.29.
    const atr = atrRef(view, "ZZP", 304);
    expect(atr).toBeCloseTo(0.062, 9);
    expect(0.08 / atr).toBeGreaterThan(1);
    expect(0.08 / atr).toBeLessThan(1.5);
    expect(run("A-D1-04", view, "ZZP", 304)).toBe(1);
    expect(run("A-D1-04", view, "ZZP", 303)).toBe(0); // no resumption yet
    expect(run("A-D1-04", view, "ZZP", 304, { depth_min: 1.5, depth_max: 3 })).toBe(0); // band miss
    // ZZQ: seven sessions down to 1,584 at 306, 1,590 at 307: depth 0.14 / 0.062 ~ 2.26.
    expect(run("A-D1-04", view, "ZZQ", 307)).toBe(1);
    expect(run("A-D1-04", view, "ZZQ", 307, { depth_min: 1, depth_max: 2 })).toBe(0);
    // A steady rise: the close equals the prior bar's high (+2 c), never above it -> no resumption.
    expect(run("A-D1-04", view, "ZZU", LAST)).toBe(0);
  });
});

describe("A-D1-05 mean reversion", () => {
  it("not oversold (RSI 100 on a monotone rise) -> 0; a flat series has no stdev -> undefined", () => {
    expect(run("A-D1-05")).toBe(0);
    expect(run("A-D1-05", view, "ZZF")).toBeUndefined();
    expect(run("A-D1-05", view, "ZZD")).toBe(0); // below SMA200: the trend gate
  });

  it("three down sessions inside an uptrend: -(C / SMA20 - 1) / stdev20 (ddof 1, log returns)", () => {
    const K = LAST - 3;
    const closeAt = (i: number): number => (i <= K ? 1_000 + 2 * i : 1_000 + 2 * K - 6 * (i - K));
    const v = one("ZZR", { close: closeAt });
    const last20 = Array.from({ length: 20 }, (_, k) => closeAt(LAST - 19 + k) / 100);
    const sma20 = last20.reduce((a, b) => a + b, 0) / 20;
    const last200 = Array.from({ length: 200 }, (_, k) => closeAt(LAST - 199 + k) / 100);
    const sd = stdevFloat(logReturns(last200), 20, 1)!;
    const expected = -(closeAt(LAST) / 100 / sma20 - 1) / sd;
    expect(expected).toBeGreaterThan(0);
    expect(run("A-D1-05", v, "ZZR")).toBeCloseTo(expected, 9);
    expect(run("A-D1-05", v, "ZZR", LAST, { rsi2_max: 0, rsi14_max: 0 })).toBe(0); // thresholds bind
  });
});

describe("A-D1-06 volatility regime", () => {
  it("constant ATR on a rising price: today's ratio is the lowest -> 1; falling price -> -1; flat (all ties) -> 0", () => {
    expect(run("A-D1-06")).toBe(1);
    expect(run("A-D1-06", view, "ZZD")).toBe(-1);
    // AGT-030 half-tie convention: 252 ties -> percentile 0.5 -> score 0.
    expect(run("A-D1-06", view, "ZZF")).toBe(0);
  });

  it("tonight = the 250-bar ATR; prior sessions read one fold seasoned 60 bars before the window (D-325); the lookback is exact", () => {
    const close = (i: number): number => Number(view.adj("ZZW", i, 1).adjClose[0]!) / 1e6;
    const expected = (l: number): number => {
      // One Wilder fold over bars LAST - l - 59 .. LAST - 1, read at the window's indices.
      const s = seriesAt(view, "ZZW", LAST - 1, l + 59)!;
      const f = (x: bigint): number => Number(x) / 1e6;
      const fold = atrSeries(
        s.adj.map((b) => f(b.high)),
        s.adj.map((b) => f(b.low)),
        s.adjClose.map(f),
        20,
      );
      const today = atrRef(view, "ZZW", LAST) / close(LAST);
      let lower = 0;
      let ties = 0;
      for (let i = LAST - l; i < LAST; i += 1) {
        const p = fold[i - (LAST - l - 59)]! / close(i);
        if (p < today) lower += 1;
        else if (p === today) ties += 1;
      }
      return 1 - (2 * lower + ties) / l;
    };
    expect(run("A-D1-06", view, "ZZW")).toBeCloseTo(expected(252), 12);
    expect(run("A-D1-06", view, "ZZW", LAST, { lookback: 251 })).toBeCloseTo(expected(251), 12);
    expect(expected(252)).not.toBe(expected(251));
  });
});

describe("A-D1-07 range contraction", () => {
  it("contracted -> 1 - min(distance to pivot, 2) / 2; a trending series is not contracted -> 0", () => {
    const atr = atrRef(view, "ZZC", LAST);
    expect(run("A-D1-07", view, "ZZC")).toBeCloseTo(1 - Math.min(0.01 / atr, 2) / 2, 9);
    expect(run("A-D1-07")).toBe(0);
    // Pivot over 10 sessions: all dead-range bars, so the pivot is the close -> distance 0 -> 1.
    expect(
      run("A-D1-07", view, "ZZC", LAST, { contraction: 0.7, range_ratio: 0.8, pivot: 10 }),
    ).toBe(1);
    // A tighter contraction threshold that the ratios do not meet -> 0.
    expect(
      run("A-D1-07", view, "ZZC", LAST, { contraction: 0.001, range_ratio: 0.8, pivot: 20 }),
    ).toBe(0);
    // Window pin: one session earlier the dead range is 9 sessions long and the last ten
    // sessions' range is 2 c, not below 0.8 x 2 c -> 0.
    expect(run("A-D1-07", view, "ZZC", LAST - 1)).toBe(0);
  });
});

describe("A-D1-08 candlestick reversal", () => {
  it("fires on the confirmation bar only, and needs the level and the body", () => {
    expect(run("A-D1-08", view, "ZZE", 323)).toBe(1);
    expect(run("A-D1-08", view, "ZZE", 322)).toBe(0); // the signal bar itself is not confirmed
    expect(run("A-D1-08", view, "ZZE", 324)).toBe(0);
    expect(run("A-D1-08", view, "ZZE", 323, { body_min: 0.9, level: 0.5 })).toBe(0);
    // The signal low is 2 c off the pivot low: inside 0.5 x ATR (~0.07), outside 0.25 x ATR.
    const atr = atrRef(view, "ZZE", 322);
    expect(0.25 * atr).toBeLessThan(0.02);
    expect(0.5 * atr).toBeGreaterThan(0.02);
    expect(run("A-D1-08", view, "ZZE", 323, { body_min: 0.6, level: 0.25 })).toBe(0);
    expect(run("A-D1-08")).toBe(0); // no pattern on a monotone rise
  });
});

describe("A-D1-09 resistance proximity (gate)", () => {
  it("no swing high above the close -> clear; a close just under a confirmed swing high -> near_res", () => {
    expect(run("A-D1-09")).toEqual({ flag: "clear" });
    expect(run("A-D1-09", view, "ZZS")).toEqual({ flag: "near_res" }); // 1 c under 1,642
    expect(run("A-D1-09", view, "ZZS", LAST - 1)).toEqual({ flag: "clear" }); // 1,600: 42 c away
    expect(run("A-D1-09", view, "ZZS", LAST, { near: 0.0001 })).toEqual({ flag: "clear" });
    // Window pin: the swing high must be inside the last 250 sessions (t - 249 .. t) with its
    // two left neighbours, so a spike at 70 is found up to t = 70 - 2 + 249 = 317 and not at 318.
    const late: PathSpec = {
      close: (i) => (i === 70 ? 1_640 : i >= 300 ? 1_641 : 1_600),
      open: (i, prev) => (i === 71 ? 1_600 : prev),
    };
    const v = one("ZZL", late);
    expect(run("A-D1-09", v, "ZZL", 317)).toEqual({ flag: "near_res" });
    expect(run("A-D1-09", v, "ZZL", 318)).toEqual({ flag: "clear" });
  });
});

describe("A-D1-10 relative strength vs sector", () => {
  const slopes = [1, 2, 3, 4, 5, 6];
  const codes = Object.fromEntries(
    slopes.map((k, j) => [`ZZ${"ABCDEF"[j]}`, { close: (i: number) => 1_000 + k * i }]),
  );
  codes.ZZX = { close: (i: number) => 1_000 + 7 * i };
  const w = synthWorld({
    sessions: SESSIONS,
    codes,
    industry: {
      ZZA: "Mat",
      ZZB: "Mat",
      ZZC: "Mat",
      ZZD: "Mat",
      ZZE: "Mat",
      ZZF: "Mat",
      ZZX: "Fin",
    },
  });
  const v = buildAsOfView(w);
  const ret = (k: number, l: number, skip: number): number =>
    (1_000 + k * (LAST - skip)) / (1_000 + k * (LAST - skip - l)) - 1;

  it("own 126-session return minus the sector mean (6 members); a one-member sector is undefined", () => {
    const mean = slopes.reduce((a, k) => a + ret(k, 126, 0), 0) / 6;
    expect(run("A-D1-10", v, "ZZA")).toBeCloseTo(ret(1, 126, 0) - mean, 12);
    expect(run("A-D1-10", v, "ZZF")).toBeCloseTo(ret(6, 126, 0) - mean, 12);
    expect(run("A-D1-10", v, "ZZX")).toBeUndefined();
    expect(run("A-D1-10", view, "ZZU")).toBeUndefined(); // no industry map
  });

  it("the lookback and the skip are exact: 21 back, 126 long, and one session either way differs", () => {
    const at = (l: number, skip: number): number =>
      ret(3, l, skip) - slopes.reduce((a, k) => a + ret(k, l, skip), 0) / 6;
    expect(run("A-D1-10", v, "ZZC", LAST, { lookback: 126, skip: 21 })).toBeCloseTo(
      at(126, 21),
      12,
    );
    expect(run("A-D1-10", v, "ZZC", LAST, { lookback: 127, skip: 21 })).toBeCloseTo(
      at(127, 21),
      12,
    );
    expect(at(126, 21)).not.toBe(at(127, 21));
  });
});

describe("TST-109: every D1 angle gives the same value on the truncated world", () => {
  for (const a of D1_ANGLES) {
    it(`${a.id} over every cut-off`, () => {
      const w = a.id === "A-D1-10" ? sectorWorld : world;
      assertTruncationInvariant(w, (v, c, t) => evaluateAngle(a, "active", v, c, t));
    });
  }
});

describe("A5 young-listing variant (version 2, young_floor grid point)", () => {
  // Rises to 1,160 c at session 80, then falls 3 c a session: a code with 100 sessions of history.
  const shape: PathSpec = { close: (i) => (i <= 80 ? 1_000 + 2 * i : 1_160 - 3 * (i - 80)) };
  const young = (n: number): [AsOfView, number] => {
    const sessions = weekdaySessions(n);
    return [buildAsOfView(synthWorld({ sessions, codes: { ZZY: shape } })), n - 1];
  };
  const floor60 = (id: string): Record<string, number> => ({
    ...defaultGrid(def(id)),
    young_floor: 60,
  });

  it("both angles are version 2 and the young point is off by default (young_floor 0 = the version 1 value)", () => {
    expect(def("A-D1-01").version).toBe(2);
    expect(def("A-D1-02").version).toBe(2);
    expect(defaultGrid(def("A-D1-02")).young_floor).toBe(0);
    expect(defaultGrid(def("A-D1-01")).young_floor).toBe(0);
  });

  it("A-D1-02 uses the sessions a code has once it has 60: close / the high of all 100 sessions", () => {
    const [v, t] = young(100);
    expect(run("A-D1-02", v, "ZZY", t)).toBeUndefined(); // default: 250 sessions needed
    const last = 1_160 - 3 * (t - 80);
    expect(run("A-D1-02", v, "ZZY", t, floor60("A-D1-02"))).toBeCloseTo(last / 1_160, 12);
  });

  it("below the floor it stays undefined; with a full lookback the young point equals the default", () => {
    const [v59, t59] = young(59);
    expect(run("A-D1-02", v59, "ZZY", t59, floor60("A-D1-02"))).toBeUndefined();
    expect(run("A-D1-01", v59, "ZZY", t59, floor60("A-D1-01"))).toBeUndefined();
    const t = LAST;
    expect(run("A-D1-02", view, "ZZU", t, floor60("A-D1-02"))).toBe(run("A-D1-02", view, "ZZU", t));
    expect(run("A-D1-01", view, "ZZU", t, floor60("A-D1-01"))).toBe(run("A-D1-01", view, "ZZU", t));
  });

  it("A-D1-01 caps the horizons and the SMA at the history: a 100-session riser votes +1 on all three", () => {
    const sessions = weekdaySessions(100);
    const rise = buildAsOfView(synthWorld({ sessions, codes: { ZZR: up } }));
    expect(run("A-D1-01", rise, "ZZR", 99)).toBeUndefined();
    expect(run("A-D1-01", rise, "ZZR", 99, floor60("A-D1-01"))).toBe(1);
    const fall = buildAsOfView(synthWorld({ sessions, codes: { ZZF: down } }));
    expect(run("A-D1-01", fall, "ZZF", 99, floor60("A-D1-01"))).toBe(-1);
  });
});
