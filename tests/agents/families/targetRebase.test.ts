// @vitest-environment node
// FAM-010 target under corporate actions (M21 E1 review fix, D-1224): the target is re-based with the fill, live
// (positionState) and in the replay walk (walkPosition). Every expected value is hand-computed in micro-AUD.
import { describe, expect, it } from "vitest";
import { evaluateOpen, positionState, type OpenTrade } from "@/lib/agents/candidates";
import { defaultAgentParams } from "@/lib/agents/params";
import type { OrderPlan } from "@/lib/agents/orderPlan";
import type { CsRule, ExitPlan } from "@/lib/agents/families/types";
import { makeRational } from "@/lib/money/rational";
import { costSetupFrom, walkPosition, type WalkFilled } from "@/lib/replay/returns";
import { handSource, sessionList, viewBar } from "../../fixtures/replay/ledgerWorld";

const p = defaultAgentParams();
const M = 1_000_000n;
const target2R: CsRule = {
  id: "target",
  via: null,
  kind: "target",
  targetR: makeRational(2n),
  targetPct: null,
};
const targetPct10: CsRule = {
  id: "target",
  via: null,
  kind: "target",
  targetR: null,
  targetPct: makeRational(1n, 10n),
};

// ---- live: positionState -------------------------------------------------------------------------------

describe("live positionState carries the initial stop on D's basis", () => {
  const calendar = ["2030-02-04", "2030-02-05", "2030-02-06", "2030-02-07"].map((d) => ({
    d,
    kind: "session",
    close_time: null,
  })) as never;
  const bar = (d: string, close: bigint) => ({
    d,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000n,
  });
  const orderPlan = (cs: CsRule[]): OrderPlan =>
    ({
      family: "F1",
      variant: "v",
      ruleVersion: "F1.v2",
      caThrough: "2030-02-04",
      caApplied: [],
      plan: {
        // ATR 0.50, k 2: the stop is fill - 1.00
        initialStops: [
          {
            id: "initial",
            via: null,
            spec: { atr_micro: 500_000n, k: makeRational(2n), cap: null, level_micro: null },
          },
        ],
        trails: [],
        cs,
      },
      rel: [],
    }) as OrderPlan;
  const day = (close: bigint) =>
    ({
      d: "2030-02-07",
      facts: new Map([
        [
          "ZZA",
          {
            code: "ZZA",
            bar: bar("2030-02-07", close),
            ind: { atrWarm: true, atrMicro: 250_000n, closeAboveSmaShort: false },
          },
        ],
      ]),
      adjusted: new Map([["ZZA", [bar("2030-02-05", 5_000_000n), bar("2030-02-07", close)]]]),
      eventsByCode: new Map(),
    }) as never;
  const split = (exDate: string) =>
    [{ id: "s1", code: "ZZA", type: "split", exDate, payload: { new: 2, old: 1 } }] as never;
  const evalAt = (trade: OpenTrade, actions: never, close: bigint) => {
    const s = positionState(trade, orderPlan([target2R]), day(close), actions, calendar, p)!;
    return { s, ev: evaluateOpen([s])[0]! };
  };

  it("no action: fill 10.00, stop 9.00, 2R target 12.00", () => {
    const trade: OpenTrade = {
      tradeId: "t",
      cohortId: "c",
      code: "ZZA",
      fillD: "2030-02-05",
      fillMicro: 10n * M,
      stopSpec: null,
    };
    expect(evalAt(trade, [] as never, 12n * M).ev.cs?.rule).toBe("target");
    expect(evalAt(trade, [] as never, 12n * M - 10_000n).ev.cs).toBeNull();
  });

  it("2:1 split while held: fill 5.00, stop 4.50, target 6.00 (the unsplit 12.00 halved), not 7.00", () => {
    const trade: OpenTrade = {
      tradeId: "t",
      cohortId: "c",
      code: "ZZA",
      fillD: "2030-02-05",
      fillMicro: 10n * M,
      stopSpec: null,
    };
    const { s, ev } = evalAt(trade, split("2030-02-06"), 6n * M);
    expect(s.fillMicro).toBe(5n * M);
    expect(s.initialStopMicro).toBe(4_500_000n);
    expect(ev.cs?.rule).toBe("target");
    expect(evalAt(trade, split("2030-02-06"), 6n * M - 10_000n).ev.cs).toBeNull();
    expect(evalAt(trade, split("2030-02-06"), 6_500_000n).ev.cs?.rule).toBe("target");
  });

  it("2:1 ex-date between the decision and the fill: the fill is already post-split (5.00), ATR halved to 0.25, stop 4.50, target 6.00", () => {
    // caThrough 2030-02-04 < ex 2030-02-05 = fill day: the plan's ATR is re-based by the crossing to the fill
    const trade: OpenTrade = {
      tradeId: "t",
      cohortId: "c",
      code: "ZZA",
      fillD: "2030-02-05",
      fillMicro: 5n * M,
      stopSpec: null,
    };
    const { s, ev } = evalAt(trade, split("2030-02-05"), 6n * M);
    expect(s.fillMicro).toBe(5n * M);
    expect(s.initialStopMicro).toBe(4_500_000n);
    expect(ev.cs?.rule).toBe("target");
    expect(evalAt(trade, split("2030-02-05"), 6n * M - 10_000n).ev.cs).toBeNull();
  });

  it("a cold ATR on the day does not crash the walk of a plan that carries a target", () => {
    const trade: OpenTrade = {
      tradeId: "t",
      cohortId: "c",
      code: "ZZA",
      fillD: "2030-02-05",
      fillMicro: 10n * M,
      stopSpec: null,
    };
    const cold = {
      ...(day(12n * M) as never as { facts: Map<string, { ind: object }> }),
    } as never;
    (cold as { facts: Map<string, { ind: object }> }).facts.get("ZZA")!.ind = {
      atrWarm: false,
      atrMicro: null,
      closeAboveSmaShort: null,
    };
    const s = positionState(trade, orderPlan([target2R]), cold, [] as never, calendar, p)!;
    expect(evaluateOpen([s])[0]!.cs?.rule).toBe("target");
  });
});

// ---- replay: walkPosition ------------------------------------------------------------------------------

describe("replay walk re-bases the initial stop with the fill", () => {
  const S = sessionList("2026-03-13", 12);
  const cost = costSetupFrom(p);
  const facts = { atrMicro: null, closeAboveExitSma: null, volumeRatios: [], events: [] };
  const plan = (initial: ExitPlan["initialStops"], rule: CsRule): ExitPlan => ({
    initialStops: initial,
    trails: [],
    cs: [rule],
  });
  const fixed45: ExitPlan["initialStops"] = [
    {
      id: "initial",
      via: null,
      spec: { atr_micro: null, k: null, cap: null, level_micro: 45n * M },
    },
  ];
  const cold: ExitPlan["initialStops"] = [
    {
      id: "initial",
      via: null,
      spec: { atr_micro: null, k: makeRational(2n), cap: null, level_micro: null },
    },
  ];
  const at = (price: bigint, i: number) => viewBar(S[i]!, price, price, price, price);
  const spec = (pl: ExitPlan) => ({
    code: "ZZA",
    plan: pl,
    entryIdx: 0,
    endIdx: 11,
    advMicro: 10_000_000n * M, // 10 bps bucket
    maxOpenMicro: null,
    forceExit: false,
  });
  const walk = (pl: ExitPlan, closes: bigint[], actions: never[] = []): WalkFilled => {
    const bars = Array.from({ length: 12 }, (_, i) =>
      at(closes[i] ?? closes[closes.length - 1]!, i),
    );
    const w = walkPosition(handSource(S, { ZZA: bars }, facts, undefined, actions), spec(pl), cost);
    if (w.kind !== "filled") throw new Error(`not filled: ${w.reason}`);
    return w;
  };
  const split = [
    { id: "s1", code: "ZZA", type: "split", exDate: S[2]!, payload: { new: 2, old: 1 } },
  ] as never[];

  // entry open 50.00, 10 bps = 50_000, fill 50_050_000; level 45.00; risk 5_050_000; 2R target 60_150_000

  it("unsplit: the 2R target is 60_150_000 (close at it fires, one tick below does not)", () => {
    const up = walk(plan(fixed45, target2R), [50n * M, 50n * M, 50n * M, 60_150_000n]);
    expect(up.exit).toMatchObject({ tag: "CS", rule: "target", idx: 4 });
    const below = walk(plan(fixed45, target2R), [50n * M, 50n * M, 50n * M, 60_140_000n]);
    expect(below.exit).toBeNull();
  });

  it("2:1 split at session 2: fill 25_025_000, level 22_500_000, target 30_075_000 (the unsplit target halved)", () => {
    // 60_150_000 / 2 = 30_075_000; the old code kept the level at 45.00 (risk below zero: the target never fired)
    const w = walk(plan(fixed45, target2R), [50n * M, 50n * M, 25n * M, 30_075_000n], split);
    expect(w.exit).toMatchObject({ tag: "CS", rule: "target", idx: 4 });
    const below = walk(plan(fixed45, target2R), [50n * M, 50n * M, 25n * M, 30_070_000n], split);
    expect(below.exit).toBeNull();
  });

  it("a cold ATR (no stop) does not crash; an R target gives none, a percent target still fires", () => {
    const r = walk(plan(cold, target2R), [50n * M, 50n * M, 50n * M, 100n * M]);
    expect(r.exit).toBeNull();
    // 10 %: ceil(50_050_000 x 1.1) = 55_055_000
    const pct = walk(plan(cold, targetPct10), [50n * M, 50n * M, 50n * M, 55_055_000n]);
    expect(pct.exit).toMatchObject({ tag: "CS", rule: "target", idx: 4 });
  });
});
