// @vitest-environment node
// D1 angles (M15 C1b; angles_D1.md; CTX-011, CTX-030, CTX-050; TST-109). Per angle: a hand-computed
// value on a synthetic ZZ path, the warm-up boundary (undefined one bar short, defined at
// `warmupSessions`), and the TST-109 truncation invariant over a world. Registry rules via
// `defineAngles(D1_ANGLES)`.
import { describe, expect, it } from "vitest";
import { atrSeries, logReturns, stdevFloat } from "@/lib/agents/indicators";
import { D1_ANGLES, seriesAt } from "@/lib/cortex/angles/d1";
import { defaultGrid, defineAngles, evaluateAngle } from "@/lib/cortex/angles/registry";
import type { AngleDef, AngleValue } from "@/lib/cortex/angles/types";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import { assertTruncationInvariant } from "@/lib/cortex/pit/truncation";
import type { AsOfWorld } from "@/lib/cortex/pit/types";
import { synthWorld, weekdaySessions, wobble, type PathSpec } from "./d1d2World";

const N = 330;
const LAST = N - 1;
const SESSIONS = weekdaySessions(N);

const up: PathSpec = { close: (i) => 1_000 + 2 * i }; // +2 c a session; H-L = 6 c, ATR(20) = 0.06
const down: PathSpec = { close: (i) => 2_000 - 2 * i };
const flat: PathSpec = { close: () => 1_000 };

const world = synthWorld({
  sessions: SESSIONS,
  codes: { ZZU: up, ZZD: down, ZZF: flat, ZZW: { close: wobble(7) } },
});
const view = buildAsOfView(world);

const byId = new Map(D1_ANGLES.map((a) => [a.id, a] as const));
const def = (id: string): AngleDef => byId.get(id)!;
const run = (
  id: string,
  v = view,
  code = "ZZU",
  t = LAST,
  grid = defaultGrid(def(id)),
): AngleValue => evaluateAngle(def(id), "active", v, code, t, grid);

/** ATR(20) of the last bar of `code` at t, by the v1 Wilder fold (the reference, not the angle). */
function atrLast(v = view, code = "ZZU", t = LAST, count = 330): number {
  const s = seriesAt(v, code, t, count)!;
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
  const sector = synthWorld({
    sessions: SESSIONS,
    codes: Object.fromEntries(
      ["ZZA", "ZZB", "ZZC", "ZZD", "ZZE"].map((c, k) => [
        c,
        { close: (i) => 800 + 40 * k + (k + 1) * i },
      ]),
    ),
    industry: { ZZA: "Mat", ZZB: "Mat", ZZC: "Mat", ZZD: "Mat", ZZE: "Mat" },
  });
  const sv = buildAsOfView(sector);
  for (const a of D1_ANGLES) {
    it(`${a.id}: undefined at ${a.warmupSessions - 1} bars, defined at ${a.warmupSessions}`, () => {
      const [v, code] = a.id === "A-D1-10" ? [sv, "ZZA"] : [view, "ZZU"];
      expect(run(a.id, v, code, a.warmupSessions - 2)).toBeUndefined();
      expect(run(a.id, v, code, a.warmupSessions - 1)).not.toBeUndefined();
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
    // Down 10 c a session for 200 sessions to 1,000 c, then up 4 c a session: at t = 329 the
    // close (1,516) is above the close 126 back (1,012) and above SMA200, but below the close
    // 252 back (2,230).
    const w = synthWorld({
      sessions: SESSIONS,
      codes: { ZZV: { close: (i) => (i < 200 ? 3_000 - 10 * i : 1_000 + 4 * (i - 200)) } },
    });
    const v = buildAsOfView(w);
    expect(run("A-D1-01", v, "ZZV")).toBeCloseTo(1 / 3, 12);
  });
});

describe("A-D1-02 52-week-high proximity", () => {
  it("close at its 250-session high -> 1; a falling series -> close / high of the window", () => {
    expect(run("A-D1-02")).toBe(1);
    // ZZD at t = 329: window 80..329, high = 2000 - 160 = 1840, close = 2000 - 658 = 1342.
    expect(run("A-D1-02", view, "ZZD")).toBeCloseTo(1_342 / 1_840, 12);
    expect(run("A-D1-02", view, "ZZD", LAST, { lookback: 200, at_high: 0.98 })).toBeCloseTo(
      1_342 / (2_000 - 2 * 130),
      12,
    );
  });
});

describe("A-D1-03 breakout quality", () => {
  it("a +2 c close above the prior high with ATR 0.06 -> ext 1/3 -> quality 2/3; below the high -> 1", () => {
    expect(run("A-D1-03")).toBeCloseTo(2 / 3, 9);
    expect(run("A-D1-03", view, "ZZD")).toBe(1);
  });

  it("vetoes an 8 % open gap and an extension past ext_veto", () => {
    const gap = synthWorld({
      sessions: SESSIONS,
      codes: {
        ZZG: { ...up, open: (i, prev) => (i === LAST ? Math.round(prev * 1.1) : prev) },
      },
    });
    expect(run("A-D1-03", buildAsOfView(gap), "ZZG")).toEqual({ flag: "veto" });
    // Jump of 20 c on the last session: ext = 0.20 / ATR; ATR_329 = (19 x 0.06 + TR) / 20 with
    // TR = H - L = 0.24 -> 0.069 -> ext ~ 2.9 > 1.
    const jump = synthWorld({
      sessions: SESSIONS,
      codes: { ZZJ: { close: (i) => 1_000 + 2 * i + (i === LAST ? 20 : 0) } },
    });
    expect(run("A-D1-03", buildAsOfView(jump), "ZZJ")).toEqual({ flag: "veto" });
    expect(
      run("A-D1-03", buildAsOfView(jump), "ZZJ", LAST, {
        lookback: 250,
        ext_veto: 5,
        gap_cap_pct: 8,
      }),
    ).toBe(0);
  });
});

describe("A-D1-04 pullback resumption", () => {
  // Up 2 c a session to 1,598 at i = 299, six sessions down 2 c (1,586 at 305), then 1,592 at 306
  // (above the 305 bar's high of 1,590): depth = (1,598 - 1,586) / ATR ~ 2 inside [1, 3].
  const path: PathSpec = {
    close: (i) =>
      i < 300 ? 1_000 + 2 * i : i <= 305 ? 1_598 - 2 * (i - 299) : i === 306 ? 1_592 : 1_600,
  };
  const w = synthWorld({ sessions: SESSIONS, codes: { ZZP: path } });
  const v = buildAsOfView(w);

  it("flags the resumption bar and nothing before it; a steady rise is not a pullback", () => {
    const atr = atrLast(v, "ZZP", 306, 306);
    const depth = 0.12 / atr;
    expect(depth).toBeGreaterThan(1);
    expect(depth).toBeLessThan(3);
    expect(run("A-D1-04", v, "ZZP", 306)).toBe(1);
    expect(run("A-D1-04", v, "ZZP", 305)).toBe(0); // no resumption yet
    expect(run("A-D1-04", v, "ZZP", 306, { depth_min: 2.5, depth_max: 3 })).toBe(0); // band miss
    expect(run("A-D1-04", view, "ZZU", LAST)).toBe(0); // depth 0.18 / 0.06 = 3: up to rounding, not inside
  });
});

describe("A-D1-05 mean reversion", () => {
  it("not oversold (RSI 100 on a monotone rise) -> 0; a flat series has no stdev -> undefined", () => {
    expect(run("A-D1-05")).toBe(0);
    expect(run("A-D1-05", view, "ZZF")).toBeUndefined();
    expect(run("A-D1-05", view, "ZZD")).toBe(0); // below SMA200: the trend gate
  });

  it("three down sessions inside an uptrend: -(C / SMA20 - 1) / stdev20 of log returns", () => {
    const w = synthWorld({
      sessions: SESSIONS,
      codes: { ZZR: { close: (i) => (i < 327 ? 1_000 + 2 * i : 1_652 - 6 * (i - 326)) } },
    });
    const v = buildAsOfView(w);
    const closes = Array.from({ length: 20 }, (_, k) =>
      LAST - 19 + k < 327 ? 1_000 + 2 * (LAST - 19 + k) : 1_652 - 6 * (LAST - 19 + k - 326),
    );
    const sma20 = closes.reduce((a, b) => a + b, 0) / 20 / 100;
    const all = Array.from({ length: 200 }, (_, k) => {
      const i = LAST - 199 + k;
      return (i < 327 ? 1_000 + 2 * i : 1_652 - 6 * (i - 326)) / 100;
    });
    const sd = stdevFloat(logReturns(all), 20, 1)!;
    const expected = -(16.34 / sma20 - 1) / sd;
    expect(expected).toBeGreaterThan(0);
    expect(run("A-D1-05", v, "ZZR")).toBeCloseTo(expected, 9);
    expect(run("A-D1-05", v, "ZZR", LAST, { rsi2_max: 0, rsi14_max: 0 })).toBe(0); // thresholds bind
  });
});

describe("A-D1-06 volatility regime", () => {
  it("constant ATR on a rising price: today's ATR / close is the lowest -> 1; falling price -> -1", () => {
    expect(run("A-D1-06")).toBe(1);
    expect(run("A-D1-06", view, "ZZD")).toBe(-1);
  });

  it("the percentile counts prior sessions strictly below today's ratio", () => {
    // Flat ATR / close on a flat price -> nothing strictly below -> 1 - 0 = 1.
    expect(run("A-D1-06", view, "ZZF")).toBe(1);
  });
});

describe("A-D1-07 range contraction", () => {
  // Rise to 1,600 c at i = 300, then flat: bracket 1 c for 300..319, 0 c from 320 (dead range),
  // so the last 10 ATR / close ratios are far below the 250-session median and the recent range
  // (0) is below 0.8 x the prior ten sessions' range (2 c). Pivot = highest high of 20 = 1,601.
  const path: PathSpec = {
    close: (i) => (i < 300 ? 1_000 + 2 * i : 1_600),
    hi: (i) => (i < 300 ? 2 : i < 320 ? 1 : 0),
    lo: (i) => (i < 300 ? 2 : i < 320 ? 1 : 0),
  };
  const w = synthWorld({ sessions: SESSIONS, codes: { ZZC: path } });
  const v = buildAsOfView(w);

  it("contracted -> 1 - min(distance to pivot, 2) / 2; a trending series is not contracted -> 0", () => {
    const atr = atrLast(v, "ZZC");
    const expected = 1 - Math.min(0.01 / atr, 2) / 2;
    expect(run("A-D1-07", v, "ZZC")).toBeCloseTo(expected, 9);
    expect(run("A-D1-07")).toBe(0);
    // A tighter contraction threshold that the ratios do not meet -> 0.
    expect(
      run("A-D1-07", v, "ZZC", LAST, { contraction: 0.001, range_ratio: 0.8, pivot: 20 }),
    ).toBe(0);
  });
});

describe("A-D1-08 candlestick reversal", () => {
  // Rise to 1,600 at i = 300, flat 1,600 after; a one-bar dip at 310 (low 1,578, a confirmed
  // pivot low); at 321 a black bar (1,600 -> 1,590); at 322 a white bar opening 1,580 and closing
  // 1,604 (engulfs 1,590..1,600, low 1,578 = the pivot, body / range 24 / 28); 323 closes 1,610,
  // above the 322 high of 1,606: the flag fires at t = 323.
  const closeAt = (i: number): number =>
    i < 300
      ? 1_000 + 2 * i
      : i === 310
        ? 1_580
        : i === 321
          ? 1_590
          : i === 322
            ? 1_604
            : i >= 323
              ? 1_610
              : 1_600;
  const openAt = (i: number, prev: number): number =>
    i === 311 ? 1_600 : i === 322 ? 1_580 : i === 323 ? 1_606 : prev;
  const w = synthWorld({ sessions: SESSIONS, codes: { ZZE: { close: closeAt, open: openAt } } });
  const v = buildAsOfView(w);

  it("fires on the confirmation bar only, and needs the level and the body", () => {
    expect(run("A-D1-08", v, "ZZE", 323)).toBe(1);
    expect(run("A-D1-08", v, "ZZE", 322)).toBe(0); // the signal bar itself is not confirmed
    expect(run("A-D1-08", v, "ZZE", 324)).toBe(0);
    expect(run("A-D1-08", v, "ZZE", 323, { body_min: 0.9, level: 0.5 })).toBe(0);
    expect(run("A-D1-08", v, "ZZE", 323, { body_min: 0.6, level: 0.0001 })).toBe(1); // exactly at the level
    expect(run("A-D1-08")).toBe(0); // no pattern on a monotone rise
  });
});

describe("A-D1-09 resistance proximity (gate)", () => {
  it("no swing high above the close -> clear; a close just under a confirmed swing high -> near_res", () => {
    expect(run("A-D1-09")).toEqual({ flag: "clear" });
    // Flat 1,600 after i = 300 with a spike to 1,640 at 310 (high 1,642), then 1,641 on the last
    // session: the nearest swing high above is 1 c away, under 0.5 x ATR.
    const w = synthWorld({
      sessions: SESSIONS,
      codes: {
        ZZS: {
          close: (i) => (i < 300 ? 1_000 + 2 * i : i === 310 ? 1_640 : i === LAST ? 1_641 : 1_600),
          // the 311 bar opens back at 1,600 so the spike's high is a strict fractal
          open: (i, prev) => (i === 311 ? 1_600 : prev),
        },
      },
    });
    const v = buildAsOfView(w);
    expect(run("A-D1-09", v, "ZZS")).toEqual({ flag: "near_res" });
    expect(run("A-D1-09", v, "ZZS", LAST - 1)).toEqual({ flag: "clear" }); // 1,600: 0.42 away
    expect(run("A-D1-09", v, "ZZS", LAST, { near: 0.0001 })).toEqual({ flag: "clear" });
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
  const r126 = (k: number): number => (1_000 + k * LAST) / (1_000 + k * (LAST - 126)) - 1;

  it("own 126-session return minus the sector mean (6 members); a one-member sector is undefined", () => {
    const mean = slopes.reduce((a, k) => a + r126(k), 0) / 6;
    expect(run("A-D1-10", v, "ZZA")).toBeCloseTo(r126(1) - mean, 12);
    expect(run("A-D1-10", v, "ZZF")).toBeCloseTo(r126(6) - mean, 12);
    expect(run("A-D1-10", v, "ZZX")).toBeUndefined();
    expect(run("A-D1-10", view, "ZZU")).toBeUndefined(); // no industry map
  });

  it("with a 21-session skip the return window ends 21 sessions back", () => {
    const r = (k: number): number => (1_000 + k * (LAST - 21)) / (1_000 + k * (LAST - 147)) - 1;
    const mean = slopes.reduce((a, k) => a + r(k), 0) / 6;
    expect(run("A-D1-10", v, "ZZC", LAST, { lookback: 126, skip: 21 })).toBeCloseTo(
      r(3) - mean,
      12,
    );
  });
});

describe("TST-109: every D1 angle gives the same value on the truncated world", () => {
  const sector = synthWorld({
    sessions: SESSIONS,
    codes: Object.fromEntries(
      ["ZZA", "ZZB", "ZZC", "ZZD", "ZZE"].map((c, k) => [
        c,
        { close: wobble(11 + k, 900 + 50 * k) },
      ]),
    ),
    industry: { ZZA: "Mat", ZZB: "Mat", ZZC: "Mat", ZZD: "Mat", ZZE: "Mat" },
  });
  for (const a of D1_ANGLES) {
    it(`${a.id} over every cut-off`, () => {
      const w = a.id === "A-D1-10" ? sector : world;
      assertTruncationInvariant(w, (v, c, t) => evaluateAngle(a, "active", v, c, t));
    });
  }
});
