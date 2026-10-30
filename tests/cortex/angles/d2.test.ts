// @vitest-environment node
// D2 angles (M15 C1b; angles_D2.md; CTX-011, CTX-030, CTX-050, CTX-051; TST-109; D-316/318). Per
// computable angle: a hand-computed value on a synthetic ZZ path, the warm-up boundary, a window-
// pinning case and the TST-109 truncation invariant; the two candidates (A-D2-07, A-D2-08) and the
// cited cost gate (A-D2-09) evaluate to undefined. Every grid key changes some value (D-318).
import { describe, expect, it } from "vitest";
import { D2_ANGLES } from "@/lib/cortex/angles/d2";
import {
  canActivate,
  defaultGrid,
  defineAngles,
  evaluateAngle,
  resolveStatus,
} from "@/lib/cortex/angles/registry";
import type { AngleDef, AngleValue, AsOfView } from "@/lib/cortex/angles/types";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import { assertTruncationInvariant, valueKey } from "@/lib/cortex/pit/truncation";
import { synthWorld, weekdaySessions, wobble, type PathSpec } from "./d1d2World";

const N = 330;
const LAST = N - 1;
const SESSIONS = weekdaySessions(N);

const up: PathSpec = { close: (i) => 1_000 + 2 * i }; // H - L = 6 c, volume 100,000
const down: PathSpec = { close: (i) => 2_000 - 2 * i };
/** +5 c on odd sessions, -1 c on even ones; up days trade 150,000, down days 100,000. */
const zigzag: PathSpec = {
  close: (i) => 1_000 + 2 * i + (i % 2 === 1 ? 3 : 0),
  volume: (i) => (i % 2 === 1 ? 150_000 : 100_000),
};
/** Three up sessions (+2 c, 120,000) then one down (-1 c, 90,000): not alternating. */
const threeOne: PathSpec = {
  close: (i) => 1_000 + 2 * i - (i % 4 === 0 ? 3 : 0),
  volume: (i) => (i % 4 === 0 ? 90_000 : 120_000),
};
/** Volume 100k, then 200k for the 20 sessions before the last, 300k on the last (a breakout). */
const step: PathSpec = {
  ...up,
  volume: (i) => (i === LAST ? 300_000 : i >= LAST - 20 ? 200_000 : 100_000),
};
/** Volume collapses to a tenth from 15 sessions back. */
const fading: PathSpec = { ...up, volume: (i) => (i >= LAST - 14 ? 10_000 : 100_000) };

const world = synthWorld({
  sessions: SESSIONS,
  codes: {
    ZZU: up,
    ZZD: down,
    ZZZ: zigzag,
    ZZT: threeOne,
    ZZS: step,
    ZZ4: fading,
    ZZW: { close: wobble(5), volume: (i) => 50_000 + (i % 7) * 10_000 },
  },
});
const view = buildAsOfView(world);

const byId = new Map(D2_ANGLES.map((a) => [a.id, a] as const));
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

const COMPUTABLE = D2_ANGLES.filter((a) => a.compute !== undefined);

describe("D2 registry entries", () => {
  it("ten ids A-D2-01..10, valid under defineAngles; 07 and 08 candidates; 09 and 10 gates", () => {
    expect(defineAngles(D2_ANGLES).map((a) => a.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `A-D2-${String(i + 1).padStart(2, "0")}`),
    );
    for (const a of D2_ANGLES) {
      expect(a.domain).toBe(2);
      expect(a.orientation).toBe(1);
    }
    expect(COMPUTABLE.map((a) => a.id)).toEqual([
      "A-D2-01",
      "A-D2-02",
      "A-D2-03",
      "A-D2-04",
      "A-D2-05",
      "A-D2-06",
      "A-D2-10",
    ]);
    expect(D2_ANGLES.filter((a) => a.kind === "gate").map((a) => a.id)).toEqual([
      "A-D2-09",
      "A-D2-10",
    ]);
    expect(def("A-D2-09").cluster).toBe("risk");
    expect(def("A-D2-10").cluster).toBe("risk"); // chapter CTX-011: an exit veto never scores
    expect(def("A-D2-09").existing).toEqual(
      expect.arrayContaining(["ARN-032", "src/lib/agents/costGate.ts"]),
    );
    expect(def("A-D2-09").existing).not.toContain("src/lib/cortex/economics"); // planned, N8
    expect(def("A-D2-04").cluster).toBe("low_volatility");
    expect(def("A-D2-07").cluster).toBe("event");
    // D-318: grids hold compute-read dimensions only; card thresholds are passport text.
    expect(def("A-D2-01").grid).toEqual({ short: [5], long: [20] });
    expect(def("A-D2-02").grid).toEqual({ udv: [50, 20, 60] });
    expect(def("A-D2-06").grid).toEqual({ base: [20, 10, 30] });
    expect(def("A-D2-07").grid).toEqual({});
    expect(def("A-D2-09").grid).toEqual({});
    for (const id of ["A-D2-01", "A-D2-02", "A-D2-06", "A-D2-07", "A-D2-09"])
      expect(def(id).historyFields?.some((h) => h.startsWith("card "))).toBe(true);
    // D-316: the unstable flag is a veto, and the passport says so.
    expect(def("A-D2-03").definition).toContain("ineligible");
  });

  it("A-D2-07 and A-D2-08 need data: candidate whatever the passport declares, and undefined", () => {
    for (const id of ["A-D2-07", "A-D2-08"]) {
      expect(def(id).needsData).toBeTruthy();
      expect(def(id).compute).toBeUndefined();
      expect(canActivate(def(id))).toEqual({ ok: false, reason: "needs_data", missing: [] });
      expect(resolveStatus(def(id), "active")).toBe("candidate");
      expect(
        evaluateAngle(def(id), resolveStatus(def(id), "active"), view, "ZZU", LAST),
      ).toBeUndefined();
    }
    expect(def("A-D2-07").inputs).toContain("announcement");
    // The cited cost gate has no compute of its own (costGate.ts; C3a economics planned, D-278).
    expect(run("A-D2-09")).toBeUndefined();
    for (const a of COMPUTABLE) expect(resolveStatus(a, "active")).toBe("active");
  });

  it("a code with no bar tonight evaluates to undefined for every computable angle", () => {
    const gv = buildAsOfView({
      ...world,
      bars: new Map([["ZZU", world.bars.get("ZZU")!.filter((b) => b.d !== SESSIONS[LAST])]]),
    });
    for (const a of COMPUTABLE) expect(run(a.id, gv, "ZZU", LAST)).toBeUndefined();
  });
});

describe("warm-up boundaries (warmupSessions is exact for the default grid)", () => {
  for (const a of COMPUTABLE) {
    it(`${a.id}: undefined at ${a.warmupSessions - 1} bars, defined at ${a.warmupSessions}`, () => {
      expect(run(a.id, view, "ZZU", a.warmupSessions - 2)).toBeUndefined();
      expect(run(a.id, view, "ZZU", a.warmupSessions - 1)).not.toBeUndefined();
    });
  }
});

describe("D-318: every grid key changes some value on the test world", () => {
  const ALT: Record<string, Record<string, number>> = {
    "A-D2-01": { short: 10, long: 40 },
    "A-D2-02": { udv: 49 },
    "A-D2-03": { stability_lo: 2, stability_hi: 0.9 },
    "A-D2-04": { window: 10 },
    "A-D2-05": { window: 40 },
    "A-D2-06": { base: 21 },
    "A-D2-10": { ratio: 2, sessions: 3 },
  };
  for (const a of COMPUTABLE) {
    it(`${a.id}: ${Object.keys(a.grid).join(", ")}`, () => {
      const base = defaultGrid(a);
      expect(Object.keys(ALT[a.id]!).sort()).toEqual(Object.keys(a.grid).sort());
      for (const [key, alt] of Object.entries(ALT[a.id]!)) {
        const grid = { ...base, [key]: alt };
        let flipped = false;
        for (let t = a.warmupSessions - 1; t <= LAST && !flipped; t += 1)
          for (const code of view.codes(t))
            if (valueKey(run(a.id, view, code, t)) !== valueKey(run(a.id, view, code, t, grid))) {
              flipped = true;
              break;
            }
        expect(flipped, `${a.id}.${key} = ${alt} changed nothing`).toBe(true);
      }
    });
  }
});

describe("A-D2-01 volume ratio and trend", () => {
  it("constant volume -> 0; the last 5 sessions at double volume -> log2(200 / 125)", () => {
    expect(run("A-D2-01")).toBe(0);
    const v = one("ZZV", { ...up, volume: (i) => (i >= LAST - 4 ? 200_000 : 100_000) });
    expect(run("A-D2-01", v, "ZZV")).toBeCloseTo(Math.log2(200 / 125), 12);
    // Window pin: a sixth doubled session is inside `long` but outside `short`.
    const six = one("ZZ6", { ...up, volume: (i) => (i >= LAST - 5 ? 200_000 : 100_000) });
    expect(run("A-D2-01", six, "ZZ6")).toBeCloseTo(Math.log2(200 / 130), 12);
    // Clipped at +-1: 20x volume on the last 5 sessions.
    const big = one("ZZB", { ...up, volume: (i) => (i >= LAST - 4 ? 2_000_000 : 100_000) });
    expect(run("A-D2-01", big, "ZZB")).toBe(1);
    const dry = one("ZZN", { ...up, volume: (i) => (i >= LAST - 4 ? 0 : 100_000) });
    expect(run("A-D2-01", dry, "ZZN")).toBe(-1);
    const none = one("ZZ0", { ...up, volume: () => 0 });
    expect(run("A-D2-01", none, "ZZ0")).toBeUndefined();
  });
});

describe("A-D2-02 up-volume vs down-volume", () => {
  it("25 up sessions at 150k against 25 down at 100k -> tanh(ln 1.5); one-sided -> +-1; no moves -> undefined", () => {
    expect(run("A-D2-02", view, "ZZZ")).toBeCloseTo(Math.tanh(Math.log(1.5)), 12);
    expect(run("A-D2-02")).toBe(1); // a monotone rise: no down-volume, the tanh limit
    expect(run("A-D2-02", view, "ZZD")).toBe(-1); // a monotone fall
    const flat = one("ZZF", { close: () => 1_000 });
    expect(run("A-D2-02", flat, "ZZF")).toBeUndefined(); // neither side traded a move
    // The udv window is the grid: 20 sessions -> 10 up / 10 down, same ratio.
    expect(run("A-D2-02", view, "ZZZ", LAST, { udv: 20 })).toBeCloseTo(
      Math.tanh(Math.log(1.5)),
      12,
    );
  });

  it("window pin on a non-alternating path: 50 sessions hold 12 down days, 49 hold 12 too but one fewer up", () => {
    const udv = (l: number): number => {
      let upV = 0;
      let downV = 0;
      for (let i = LAST - l + 1; i <= LAST; i += 1) {
        if (i % 4 === 0) downV += 90_000;
        else upV += 120_000;
      }
      return Math.tanh(Math.log(upV / downV));
    };
    expect(run("A-D2-02", view, "ZZT")).toBeCloseTo(udv(50), 12);
    expect(run("A-D2-02", view, "ZZT", LAST, { udv: 49 })).toBeCloseTo(udv(49), 12);
    expect(udv(50)).not.toBe(udv(49));
  });
});

describe("A-D2-03 average daily value and tier", () => {
  it("log10 of the 60-session median traded value; unstable (a veto, D-316) when ADV20 / ADV60med leaves the band", () => {
    // Median of closes 270..329 x 100,000 shares = (1,598 + 1,600) / 2 c x 100,000 = A$1,599,000.
    expect(run("A-D2-03")).toBeCloseTo(Math.log10(1_599_000), 12);
    // Volume x3 on the previous 20 sessions (today excluded): ADV20 / ADV60med ~ 3.07 > 2.
    const v = one("ZZV", {
      ...up,
      volume: (i) => (i >= LAST - 20 && i < LAST ? 300_000 : 100_000),
    });
    expect(run("A-D2-03", v, "ZZV")).toEqual({ flag: "unstable" });
    expect(run("A-D2-03", v, "ZZV", LAST, { stability_lo: 0.5, stability_hi: 4 })).toBeCloseTo(
      Math.log10(1_599_000),
      12,
    );
    const none = one("ZZ0", { ...up, volume: () => 0 });
    expect(run("A-D2-03", none, "ZZ0")).toBeUndefined();
  });

  it("window pin: today is inside the 60-session median and outside the ADV20 window", () => {
    // 60x volume today: inside ADV20 it would read (19 + 60) / 20 ~ 3.95 (unstable); excluded,
    // the ratio stays ~1.02 and the median is unchanged (today was already the largest value).
    const spike = one("ZZS", { ...up, volume: (i) => (i === LAST ? 6_000_000 : 100_000) });
    expect(run("A-D2-03", spike, "ZZS")).toBeCloseTo(Math.log10(1_599_000), 12);
    // Zero volume today: ADV20 unchanged, but the median now averages closes 298 and 299.
    const zero = one("ZZ0", { ...up, volume: (i) => (i === LAST ? 0 : 100_000) });
    expect(run("A-D2-03", zero, "ZZ0")).toBeCloseTo(Math.log10(1_597_000), 12);
  });
});

describe("A-D2-04 spread proxy", () => {
  it("1 - median over `window` sessions of (H - L) / C", () => {
    // Closes 310..329 with H - L = 6 c: the median is the mean of 6 / 1,638 and 6 / 1,640.
    expect(run("A-D2-04")).toBeCloseTo(1 - (6 / 1_638 + 6 / 1_640) / 2, 12);
    // Window pin: 10 sessions -> closes 320..329, median of 6 / 1,648 and 6 / 1,650.
    expect(run("A-D2-04", view, "ZZU", LAST, { window: 10 })).toBeCloseTo(
      1 - (6 / 1_648 + 6 / 1_650) / 2,
      12,
    );
    const wide = one("ZZX", { ...up, hi: () => 2_000, lo: () => 500 }); // range above the close
    expect(run("A-D2-04", wide, "ZZX")).toBe(0);
  });
});

describe("A-D2-05 Amihud illiquidity", () => {
  const term = (i: number): number => {
    const c = 1_000 + 2 * i;
    return (Math.abs(c / (c - 2) - 1) / ((c / 100) * 100_000)) * 1e6;
  };
  const expected = (w: number): number => {
    let acc = 0;
    for (let i = LAST - w + 1; i <= LAST; i += 1) acc += term(i);
    return -Math.log(acc / w);
  };

  it("-ln of the mean |r| / traded value x 1e6; the window is exact; zero volume throughout -> undefined", () => {
    expect(run("A-D2-05")).toBeCloseTo(expected(20), 9);
    expect(run("A-D2-05", view, "ZZU", LAST, { window: 21 })).toBeCloseTo(expected(21), 9);
    expect(expected(20)).not.toBe(expected(21));
    const none = one("ZZ0", { ...up, volume: () => 0 });
    expect(run("A-D2-05", none, "ZZ0")).toBeUndefined();
    // A flat price has zero return every session -> ILLIQ 0 -> undefined (false low, not +inf).
    const flat = one("ZZF", { close: () => 1_000 });
    expect(run("A-D2-05", flat, "ZZF")).toBeUndefined();
  });

  it("half the sessions at zero volume: the mean is over the traded sessions only", () => {
    const half = one("ZZH", { ...up, volume: (i) => (i % 2 === 0 ? 0 : 100_000) });
    let acc = 0;
    let days = 0;
    for (let i = LAST - 19; i <= LAST; i += 1) {
      if (i % 2 === 0) continue;
      acc += term(i);
      days += 1;
    }
    expect(run("A-D2-05", half, "ZZH")).toBeCloseTo(-Math.log(acc / days), 9);
  });
});

describe("A-D2-06 volume at breakout vs base", () => {
  it("breakout at base volume -> 0; at 3x -> tanh(2); no breakout -> 0 on a falling series", () => {
    expect(run("A-D2-06")).toBe(0); // every session is a new high at constant volume: bvr = 1
    const v = one("ZZV", { ...up, volume: (i) => (i === LAST ? 300_000 : 100_000) });
    expect(run("A-D2-06", v, "ZZV")).toBeCloseTo(Math.tanh(2), 12);
    expect(run("A-D2-06", v, "ZZV", LAST, { base: 10 })).toBeCloseTo(Math.tanh(2), 12);
    expect(run("A-D2-06", view, "ZZD")).toBe(0);
    // Below the prior high -> 0 even with heavy volume.
    const dip = one("ZZP", {
      close: (i) => (i === LAST ? 1_000 : 1_000 + 2 * i),
      volume: (i) => (i === LAST ? 300_000 : 100_000),
    });
    expect(run("A-D2-06", dip, "ZZP")).toBe(0);
  });

  it("window pins: the base boundary and the 250-session prior high", () => {
    // ZZS: 200k on the 20 sessions before the last -> base 20 is all 200k (bvr 1.5); base 21
    // takes in one 100k session (mean 4,100k / 21).
    expect(run("A-D2-06", view, "ZZS")).toBeCloseTo(Math.tanh(1.5 - 1), 12);
    expect(run("A-D2-06", view, "ZZS", LAST, { base: 21 })).toBeCloseTo(
      Math.tanh(300_000 / (4_100_000 / 21) - 1),
      12,
    );
    // A +600 c spike exactly 250 sessions back is the prior high -> no breakout -> 0; one
    // session further back it is outside the window -> tanh(2) on 3x volume.
    const spike = (at: number): PathSpec => ({
      close: (i) => 1_000 + 2 * i + (i === at ? 600 : 0),
      volume: (i) => (i === LAST ? 300_000 : 100_000),
    });
    expect(run("A-D2-06", one("ZZI", spike(LAST - 250)), "ZZI")).toBe(0);
    expect(run("A-D2-06", one("ZZO", spike(LAST - 251)), "ZZO")).toBeCloseTo(Math.tanh(2), 12);
  });
});

describe("A-D2-10 liquidity deterioration (gate)", () => {
  it("intact on steady volume; liquidity_exit after 5 sessions below half the 60-session median", () => {
    expect(run("A-D2-10")).toEqual({ flag: "intact" });
    const v = one("ZZL", { ...up, volume: (i) => (i >= LAST - 24 ? 10_000 : 100_000) });
    expect(run("A-D2-10", v, "ZZL")).toEqual({ flag: "liquidity_exit" });
    // ZZ4: low volume from 15 sessions back: the ADV20 windows ending at idx 329..327 hold 14,
    // 13 and 12 low sessions (ratio ~ (20 - n + 0.1 n) / 20 < 0.5 needs n >= 12), the one
    // ending at 326 holds 11 -> intact over 5 sessions, liquidity_exit over 3 (a window pin).
    expect(run("A-D2-10", view, "ZZ4")).toEqual({ flag: "intact" });
    expect(run("A-D2-10", view, "ZZ4", LAST, { ratio: 0.5, sessions: 3 })).toEqual({
      flag: "liquidity_exit",
    });
    expect(run("A-D2-10", view, "ZZ4", LAST, { ratio: 0.5, sessions: 4 })).toEqual({
      flag: "intact",
    });
    const none = one("ZZ0", { ...up, volume: () => 0 });
    expect(run("A-D2-10", none, "ZZ0")).toBeUndefined();
  });
});

describe("TST-109: every computable D2 angle gives the same value on the truncated world", () => {
  for (const a of COMPUTABLE) {
    it(`${a.id} over every cut-off`, () => {
      assertTruncationInvariant(world, (v, c, t) => evaluateAngle(a, "active", v, c, t));
    });
  }
});
