// @vitest-environment node
// T11 fixed-notional returns: exact hand-computed cases (P5 brokerage, ADV-bucket slippage on the
// ASX tick grid, level/gap/close-signal exits, the stressed twin P3 + 50 %), the daily MTM series,
// period returns and the no-look-ahead property of the walk.
import { describe, expect, it } from "vitest";
import type { CsRule, ExitPlan } from "@/lib/agents/families";
import { defaultAgentParams } from "@/lib/agents/params";
import { makeRational } from "@/lib/money/rational";
import {
  aggregateDaily,
  costSetupFrom,
  economicsOf,
  fractionToRational,
  meanRational,
  pairedExcess,
  periodReturn,
  periodReturns,
  scaleBuckets,
  snapshotBarLookup,
  walkPosition,
  type WalkFilled,
} from "@/lib/replay/returns";
import { SLIPPAGE_BUCKETS } from "@/lib/arena/slippage";
import { handSource, sessionList, viewBar } from "../fixtures/replay/ledgerWorld";

const p = defaultAgentParams();
const cost = costSetupFrom(p);
const M = 1_000_000n; // A$1 in micro
const S = sessionList("2026-03-13", 12);
const ADV_10M = 10_000_000n * M; // top slippage bucket (10 bps)

const levelPlan = (level: bigint): ExitPlan => ({
  initialStops: [
    { id: "initial", via: null, spec: { atr_micro: null, k: null, cap: null, level_micro: level } },
  ],
  trails: [],
  cs: [],
});
const csPlan = (...cs: CsRule[]): ExitPlan => ({ initialStops: [], trails: [], cs });
const timeStop = (sessions: number): CsRule => ({
  id: "time_stop",
  via: null,
  kind: "time_stop",
  sessions,
  minReturn: null,
});

const spec = (plan: ExitPlan, over: Partial<Parameters<typeof walkPosition>[1]> = {}) => ({
  code: "ZZA",
  plan,
  entryIdx: 0,
  endIdx: 11,
  advMicro: ADV_10M,
  maxOpenMicro: null,
  forceExit: false,
  ...over,
});

function filled(w: ReturnType<typeof walkPosition>): WalkFilled {
  if (w.kind !== "filled") throw new Error(`expected a fill, got ${w.reason}`);
  return w;
}

const flat = (n: number) =>
  Array.from({ length: n }, (_, i) => viewBar(S[i]!, 50n * M, 50_500_000n, 49_500_000n, 50n * M));

describe("exact fixed-notional returns (hand-computed)", () => {
  it("A: A$2.00 entry stopped at a level, cheap tick regime", () => {
    const src = handSource(S, {
      ZZA: [
        viewBar(S[0]!, 2n * M, 2_050_000n, 1_970_000n, 2_020_000n),
        viewBar(S[1]!, 1_950_000n, 1_960_000n, 1_880_000n, 1_900_000n),
      ],
    });
    const w = filled(walkPosition(src, spec(levelPlan(1_900_000n)), cost));
    // fill = 2.00 + max(10 bps = 2,000, 1 tick = 10,000) = 2.01; qty = floor(600 / 2.01) = 298
    expect(w.qty).toBe(298n);
    expect(w.fillInMicro).toBe(2_010_000n);
    expect(w.brokInMicro).toBe(5_000_000n); // P5: order value 598.98 <= 1,000 -> A$5.00
    // exit: open 1.95 > level 1.90 >= low 1.88: level - max(10 bps, 1 tick = 5,000) floor tick - 1 tick
    expect(w.exit).toMatchObject({ d: S[1], idx: 1, tag: "IS", fillOutMicro: 1_890_000n });
    const e = economicsOf(w)!;
    expect(e.costMicro).toBe(603_980_000n);
    expect(e.proceedsMicro).toBe(558_220_000n);
    expect(e.net).toEqual({ num: -45_760_000n, den: 603_980_000n });
    // gross: (298 x 1.90) / (298 x 2.00) - 1 before brokerage and slippage
    expect(e.gross).toEqual({ num: -29_800_000n, den: 596_000_000n });
    // stress: P3 A$6.50 each side; 15 bps stays inside the same ticks here
    expect(e.stressInMicro).toBe(605_480_000n);
    expect(e.stressOutMicro).toBe(556_720_000n);
    expect(e.stress).toEqual({ num: -48_760_000n, den: 605_480_000n });
    // daily MTM telescopes to net P/L
    expect(w.mtm).toEqual([
      { d: S[0], pnlMicro: -2_020_000n },
      { d: S[1], pnlMicro: -43_740_000n },
    ]);
  });

  it("B: A$50 entry: the stress column moves the fills (15 bps instead of 10)", () => {
    const src = handSource(S, {
      ZZA: [
        viewBar(S[0]!, 50n * M, 51n * M, 49_500_000n, 50_500_000n),
        viewBar(S[1]!, 49n * M, 49_200_000n, 47_500_000n, 47_800_000n),
      ],
    });
    const w = filled(walkPosition(src, spec(levelPlan(48n * M)), cost));
    expect(w.qty).toBe(11n); // floor(600 / 50.05)
    expect(w.fillInMicro).toBe(50_050_000n);
    expect(w.stressFillInMicro).toBe(50_080_000n); // 50.075 rounded up to the 1c tick
    expect(w.exit).toMatchObject({
      tag: "IS",
      fillOutMicro: 47_940_000n, // 47.952 floored to 47.95, minus one tick
      stressFillOutMicro: 47_910_000n, // 47.928 -> 47.92, minus one tick
      refOutMicro: 48n * M,
    });
    const e = economicsOf(w)!;
    expect(e.net).toEqual({ num: -33_210_000n, den: 555_550_000n });
    expect(e.stressInMicro).toBe(557_380_000n);
    expect(e.stressOutMicro).toBe(520_510_000n);
    expect(e.stress).toEqual({ num: -36_870_000n, den: 557_380_000n });
    expect(e.gross).toEqual({ num: 11n * -2n * M, den: 11n * 50n * M });
    expect(w.mtm).toEqual([
      { d: S[0], pnlMicro: -50_000n }, // 11 x (50.50 - 50.05) - 5.00
      { d: S[1], pnlMicro: -33_160_000n }, // proceeds 522.34 - 11 x 50.50
    ]);
    expect(w.mtm.reduce((a, x) => a + x.pnlMicro, 0n)).toBe(e.proceedsMicro - e.costMicro);
  });

  it("the stress buckets are the base buckets x 150 %", () => {
    const stress = scaleBuckets(SLIPPAGE_BUCKETS, 50n);
    expect(stress.map((b) => b.bps)).toEqual([
      makeRational(15n),
      makeRational(75n, 2n),
      makeRational(90n),
      makeRational(180n),
    ]);
    expect(cost.stressProfile.code).toBe("P3");
    expect(cost.profile.code).toBe("P5");
    expect(cost.notionalMicro).toBe(600n * M);
  });

  it("CS exit: a 3-session time stop decided at the close fills at the next open", () => {
    const src = handSource(
      S,
      { ZZA: flat(6) },
      { atrMicro: null, closeAboveExitSma: null, volumeRatios: [], events: [] },
    );
    const w = filled(walkPosition(src, spec(csPlan(timeStop(3))), cost));
    expect(w.exit).toMatchObject({ idx: 3, d: S[3], tag: "CS", rule: "time_stop" });
    expect(w.exit!.fillOutMicro).toBe(49_950_000n); // open 50.00 - 10 bps, onto the grid
    const e = economicsOf(w)!;
    expect(e.proceedsMicro).toBe(544_450_000n); // 11 x 49.95 - 5.00
    expect(e.net).toEqual({ num: -11_100_000n, den: 555_550_000n });
    expect(e.gross).toEqual({ num: 0n, den: 550n * M });
    expect(w.mtm.map((m) => m.pnlMicro)).toEqual([-5_550_000n, 0n, 0n, -5_550_000n]);
  });

  it("a session without a bar is carried: sessions held count the calendar", () => {
    const bars = flat(6) as (ReturnType<typeof viewBar> | null)[];
    bars[1] = null;
    const src = handSource(S, { ZZA: bars });
    const w = filled(walkPosition(src, spec(csPlan(timeStop(3))), cost));
    expect(w.exit).toMatchObject({ idx: 3, tag: "CS" });
    expect(w.mtm.map((m) => m.d)).toEqual([S[0], S[2], S[3]]);
    expect(w.mtm.reduce((a, x) => a + x.pnlMicro, 0n)).toBe(-11_100_000n);
  });

  it("an initial stop touched in the entry session exits that session (afterOpen rule)", () => {
    const src = handSource(S, { ZZA: flat(3) });
    const w = filled(walkPosition(src, spec(levelPlan(49_800_000n)), cost));
    expect(w.exit).toMatchObject({ idx: 0, tag: "IS", fillOutMicro: 49_740_000n });
    expect(w.mtm).toEqual([{ d: S[0], pnlMicro: -13_410_000n }]);
  });

  it("forceExit closes a control path at the last session's open; without it the row stays open", () => {
    const src = handSource(S, { ZZA: flat(6) });
    const open = filled(walkPosition(src, spec(csPlan(), { endIdx: 5 }), cost));
    expect(open.exit).toBeNull();
    expect(open.mtm).toHaveLength(6);
    expect(economicsOf(open)).toBeNull();
    const forced = filled(walkPosition(src, spec(csPlan(), { endIdx: 5, forceExit: true }), cost));
    expect(forced.forced).toBe(true);
    expect(forced.exit).toMatchObject({ idx: 5, tag: "CS", rule: "end_of_data" });
  });

  it("F3 gap cancel, unaffordable price and missing bars produce no fill", () => {
    const src = handSource(S, {
      ZZA: flat(3),
      ZZH: flat(3).map((b) => ({
        ...b,
        open: 700n * M,
        high: 701n * M,
        low: 699n * M,
        close: 700n * M,
      })),
    });
    expect(walkPosition(src, spec(csPlan(), { maxOpenMicro: 50n * M }), cost)).toEqual({
      kind: "skipped",
      reason: "gap",
    });
    expect(walkPosition(src, spec(csPlan(), { maxOpenMicro: 50n * M + 1n }), cost).kind).toBe(
      "filled",
    );
    expect(walkPosition(src, spec(csPlan(), { code: "ZZH" }), cost)).toEqual({
      kind: "skipped",
      reason: "unaffordable",
    });
    expect(walkPosition(src, spec(csPlan(), { code: "ZZN" }), cost)).toEqual({
      kind: "skipped",
      reason: "no_bar",
    });
  });

  it("never reads a session later than the one being processed (no look-ahead)", () => {
    const spy = { bar: [] as string[], facts: [] as string[] };
    const src = handSource(
      S,
      {
        ZZA: [
          viewBar(S[0]!, 50n * M, 51n * M, 49_500_000n, 50_500_000n),
          viewBar(S[1]!, 49n * M, 49_200_000n, 47_500_000n, 47_800_000n),
          viewBar(S[2]!, 1n, 1n, 1n, 1n), // poison after the exit
        ],
      },
      { atrMicro: null, closeAboveExitSma: null, volumeRatios: [], events: [] },
      spy,
    );
    const w = filled(walkPosition(src, spec(levelPlan(48n * M)), cost));
    expect(w.exit!.idx).toBe(1);
    expect([...spy.bar, ...spy.facts].every((d) => d <= S[1]!)).toBe(true);
    // identical result when the future bars are different
    const src2 = handSource(S, {
      ZZA: [
        viewBar(S[0]!, 50n * M, 51n * M, 49_500_000n, 50_500_000n),
        viewBar(S[1]!, 49n * M, 49_200_000n, 47_500_000n, 47_800_000n),
        viewBar(S[2]!, 999n * M, 999n * M, 999n * M, 999n * M),
      ],
    });
    expect(walkPosition(src2, spec(levelPlan(48n * M)), cost)).toEqual(w);
  });
});

describe("daily series, period returns and excess", () => {
  const a = [
    { d: "2026-03-02", pnlMicro: 100n },
    { d: "2026-03-03", pnlMicro: 50n },
  ];
  const b = [
    { d: "2026-03-03", pnlMicro: -20n },
    { d: "2026-03-04", pnlMicro: 10n },
  ];

  it("aggregates P/L and open rows by date", () => {
    expect(aggregateDaily([a, b])).toEqual([
      { d: "2026-03-02", pnlMicro: 100n, open: 1 },
      { d: "2026-03-03", pnlMicro: 30n, open: 2 },
      { d: "2026-03-04", pnlMicro: 10n, open: 1 },
    ]);
  });

  it("period return = sum P/L / (A$600 x average open rows); empty periods are skipped", () => {
    const pts = aggregateDaily([a, b]);
    const n = 600n * M;
    // sum 140, 3 days, 4 row-days: 140 x 3 / (600M x 4)
    expect(periodReturn(pts, n, "2026-03-02", "2026-03-04")).toEqual({
      num: 7n,
      den: 40_000_000n,
    });
    expect(periodReturn(pts, n, "2026-03-03", "2026-03-03")).toEqual({
      num: 1n,
      den: 40_000_000n,
    });
    expect(periodReturn(pts, n, "2026-04-01", "2026-04-30")).toBeNull();
    const byMonth = periodReturns(pts, n, (d) => d.slice(0, 7));
    expect(byMonth).toHaveLength(1);
    expect(byMonth[0]!.ret).toEqual({ num: 7n, den: 40_000_000n });
  });

  it("paired excess = row return - mean of its controls (decision 25)", () => {
    const r = fractionToRational({ num: 1n, den: 10n });
    expect(meanRational([])).toBeNull();
    expect(pairedExcess(r, [makeRational(1n, 20n), makeRational(3n, 20n)])).toEqual(
      makeRational(0n),
    );
    expect(pairedExcess(r, [makeRational(0n), makeRational(1n, 10n)])).toEqual(
      makeRational(1n, 20n),
    );
    expect(pairedExcess(r, [])).toBeNull();
  });
});

describe("snapshot bar lookup", () => {
  it("reads sessions from the calendar and converts vendor prices to micro once", () => {
    const look = snapshotBarLookup({
      bars: [{ code: "ZZA", d: "2026-03-02", o: 2.5, h: 2.6, l: 2.4, c: 2.55, volume: 1000 }],
      tables: {
        calendar: [
          { d: "2026-03-03", kind: "holiday" },
          { d: "2026-03-02", kind: "session" },
          { d: "2026-03-04", kind: "early_close" },
        ],
      },
    });
    expect(look.sessions).toEqual(["2026-03-02", "2026-03-04"]);
    expect(look.bar("ZZA", "2026-03-02")).toEqual({
      d: "2026-03-02",
      open: 2_500_000n,
      high: 2_600_000n,
      low: 2_400_000n,
      close: 2_550_000n,
      volume: 1000n,
    });
    expect(look.bar("ZZA", "2026-03-04")).toBeNull();
  });
});

describe("corporate actions inside the hold (ARN-036, ARN-043, DAT-223)", () => {
  const facts = { atrMicro: null, closeAboveExitSma: null, volumeRatios: [], events: [] };
  const plan = csPlan(timeStop(4));
  const rec = (id: string, type: string, exIdx: number, payload: Record<string, unknown>) => ({
    id,
    code: "ZZA",
    type,
    exDate: S[exIdx]!,
    payload,
  });
  const at = (price: bigint, i: number) => viewBar(S[i]!, price, price, price, price);
  const series = (p0: bigint, p1: bigint, splitAt = 2) =>
    Array.from({ length: 7 }, (_, i) => at(i < splitAt ? p0 : p1, i));
  const walkWith = (bars: ReturnType<typeof series>, actions: ReturnType<typeof rec>[]) =>
    filled(walkPosition(handSource(S, { ZZA: bars }, facts, undefined, actions), spec(plan), cost));
  const twin = walkWith(series(50n * M, 50n * M), []);

  it("a 2:1 split mid-hold doubles the quantity and gives the unsplit twin's return", () => {
    const w = walkWith(series(50n * M, 25n * M), [rec("a1", "split", 2, { new: 2, old: 1 })]);
    expect(w.qty).toBe(twin.qty); // entry quantity and cost are unchanged
    expect(w.exit).toMatchObject({ qtyOut: 2n * twin.qty, idx: 4, tag: "CS" });
    const e = economicsOf(w)!;
    const et = economicsOf(twin)!;
    expect(e.costMicro).toBe(et.costMicro);
    expect(e.gross).toEqual(et.gross); // exactly the same gross return (zero), not -50 %
    // net differs only by tick rounding of the exit fill (24.97 x 22 vs 49.95 x 11): under 0.1 %
    expect(e.proceedsMicro).toBe(544_340_000n);
    const diff =
      e.proceedsMicro > et.proceedsMicro
        ? e.proceedsMicro - et.proceedsMicro
        : et.proceedsMicro - e.proceedsMicro;
    expect(diff * 1000n < et.proceedsMicro).toBe(true);
    expect(w.mtm.reduce((a, x) => a + x.pnlMicro, 0n)).toBe(e.proceedsMicro - e.costMicro);
  });

  it("a dividend adds exactly qty x dps at the ex-date to net, stress and the MTM", () => {
    const div = rec("d1", "cash_dividend", 2, { dps: "0.10", pay_date: S[5]! });
    const w = walkWith(series(50n * M, 50n * M), [div]);
    const e = economicsOf(w)!;
    const et = economicsOf(twin)!;
    expect(w.dividendMicro).toBe(11n * 100_000n);
    expect(e.proceedsMicro - et.proceedsMicro).toBe(1_100_000n);
    expect(e.stressOutMicro - et.stressOutMicro).toBe(1_100_000n);
    expect(e.net.num - et.net.num).toBe(1_100_000n);
    expect(w.mtm.find((m) => m.d === S[2])!.pnlMicro).toBe(1_100_000n);
    expect(w.mtm.reduce((a, x) => a + x.pnlMicro, 0n)).toBe(e.net.num);
  });

  it("a cash merger exits at the stated terms on the ex-date, without brokerage", () => {
    const merger = rec("m1", "merger_cash", 2, { cash_per_share: "49" });
    const w = walkWith(series(50n * M, 50n * M).slice(0, 2), [merger]);
    expect(w.exit).toMatchObject({
      idx: 2,
      tag: "CS",
      rule: "corp_action:merger_cash",
      proceedsMicro: 539n * M,
      brokOutMicro: 0n,
    });
    const e = economicsOf(w)!;
    expect(e.net).toEqual({ num: 539n * M - 555_550_000n, den: 555_550_000n });
    expect(w.mtm.reduce((a, x) => a + x.pnlMicro, 0n)).toBe(e.net.num);
  });

  it("an action that is not modelled (rights) leaves the return alone and flags the row", () => {
    const w = walkWith(series(50n * M, 50n * M), [rec("r1", "rights_renounceable", 2, {})]);
    expect(w.flags).toEqual(["corp_action_in_hold"]);
    expect(economicsOf(w)).toEqual(economicsOf(twin));
  });
});
