// @vitest-environment node
// Terminal states, liquidation planning, legacy ledger (M3 T9; spec 05 section 5.1, ARN-026,
// ARN-052, ARN-053; AT-11 golden paths; D-076). HIGH-RISK: every test uses LIQUIDATION NAV.
import { describe, expect, it } from "vitest";
import { COST_PROFILES } from "@/lib/arena/costs";
import { suspensionMark } from "@/lib/arena/corpActions";
import { resolveCohortParams } from "@/lib/arena/cohort";
import { sizeEntry } from "@/lib/arena/sizing";
import {
  evaluateTerminal,
  isParcelOnlyReasonText,
  liquidationOrderId,
  parcelStallWindow,
  planLegacy,
  planLiquidation,
  restartSession,
  stallFloorStreak,
  terminalThresholds,
  type CloseDay,
  type TerminalParams,
} from "@/lib/arena/terminal";
import { sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import { daysBetween } from "@/lib/arena/sleeve";
import { makeRational } from "@/lib/money/rational";
import { rng } from "./ledgerHarness";

const PARAMS: TerminalParams = resolveCohortParams().terminal;
const START = "2026-01-05"; // a Monday
const NO_HOLIDAYS: CalendarRow[] = [];
const DATES = sessionsBetween(START, "2028-12-31", NO_HOLIDAYS);

const day = (
  i: number,
  liq: bigint,
  extra: Partial<CloseDay> = {},
  calendar: readonly string[] = DATES,
): CloseDay => ({
  d: calendar[i],
  navMicro: liq,
  liqNavMicro: liq,
  openPositions: 0n,
  signals: 0,
  parcelOnlyRejections: 0,
  ...extra,
});

const series = (liqs: readonly bigint[], extra: Partial<CloseDay> = {}): CloseDay[] =>
  liqs.map((v, i) => day(i, v, extra));

const evaluate = (history: readonly CloseDay[], params: TerminalParams = PARAMS) =>
  evaluateTerminal({ params, startD: START, calendar: NO_HOLIDAYS, history });

describe("thresholds (section 5.1)", () => {
  it("target A$1,200, bust A$300, stall floor 510,606,061 for the A$600 seed", () => {
    expect(terminalThresholds(PARAMS)).toEqual({
      targetMicro: 1_200_000_000n,
      bustMicro: 300_000_000n,
    });
    expect(PARAMS.stallFloorMicro).toBe(510_606_061n);
    expect(PARAMS.stallSessions).toBe(5);
    expect(PARAMS.stallParcelRejections).toBe(20);
    expect(PARAMS.timeoutSessions).toBe(252);
  });
  it("refuses nonsense parameters", () => {
    const bad = (p: Partial<TerminalParams>) => () =>
      evaluate(series([600_000_000n]), { ...PARAMS, ...p });
    expect(bad({ seedMicro: 0n })).toThrow(/seed/);
    expect(bad({ targetMultiple: makeRational(1n) })).toThrow(/target/);
    expect(bad({ bustFraction: makeRational(1n) })).toThrow(/bust/);
    expect(bad({ stallFloorMicro: 0n })).toThrow(/floor/);
    expect(bad({ stallSessions: 0 })).toThrow(/stall_sessions/);
    expect(bad({ timeoutSessions: 1.5 })).toThrow(/timeout_sessions/);
  });
});

describe("AT-11 golden paths: each terminal state", () => {
  it("target: first close with liquidation NAV >= A$1,200; TTD in sessions and days", () => {
    const liqs = [600n, 700n, 900n, 1_199n, 1_200n].map((v) => v * 1_000_000n);
    expect(evaluate(series(liqs.slice(0, 4)))).toBeNull();
    const v = evaluate(series(liqs));
    expect(v).toMatchObject({
      kind: "target",
      rule: "target",
      d: DATES[4],
      ttdSessions: 5n,
      ttdDays: 4n,
      outcomeMicro: 1_200_000_000n,
    });
  });

  it("target is judged on LIQUIDATION NAV: NAV at the target but liquidation NAV below it is not a target", () => {
    const h = [{ ...day(0, 1_188_800_000n), navMicro: 1_200_000_000n }]; // TST101-039 numbers
    expect(evaluate(h)).toBeNull();
    expect(evaluate([{ ...h[0], liqNavMicro: 1_200_000_000n }])?.kind).toBe("target");
  });

  it("bust: liquidation NAV <= A$300 (inclusive), A$300.000001 is alive", () => {
    expect(evaluate(series([301_000_000n, 300_000_001n]))).toBeNull();
    const v = evaluate(series([450_000_000n, 300_000_000n]));
    expect(v).toMatchObject({
      kind: "bust",
      rule: "bust",
      ttdSessions: 2n,
      outcomeMicro: 300_000_000n,
    });
  });

  it("stalled (a), U: A$505.00 with no position for 5 consecutive sessions; not before (TST101-040)", () => {
    const u = (n: number) => series(Array.from({ length: n }, () => 505_000_000n));
    expect(evaluate(u(4))).toBeNull();
    expect(evaluate(u(5))).toMatchObject({ kind: "stalled", rule: "stall_floor", ttdSessions: 5n });
  });

  it("stalled (a), L: the floor is the same for U and L, A$520.00 is above it", () => {
    const l = series(Array.from({ length: 30 }, () => 520_000_000n));
    for (let n = 1; n <= l.length; n++) expect(evaluate(l.slice(0, n))).toBeNull();
    // and an L cohort that does fall below stalls exactly like a U cohort
    const below = series(Array.from({ length: 5 }, () => 510_606_060n));
    expect(evaluate(below)?.kind).toBe("stalled");
    expect(evaluate(series(Array.from({ length: 5 }, () => 510_606_061n)))).toBeNull(); // not < floor
  });

  it("stalled (a): the run must be consecutive and free of open positions", () => {
    const m = (v: bigint) => v * 1_000_000n;
    const seq = (levels: readonly bigint[], open: readonly bigint[] = []): CloseDay[] =>
      levels.map((v, i) => day(i, m(v), { openPositions: open[i] ?? 0n }));
    // a recovery to 520 in the middle restarts the count
    expect(
      stallFloorStreak(seq([505n, 505n, 520n, 505n, 505n, 505n]), PARAMS.stallFloorMicro),
    ).toBe(3);
    // an open position on one day breaks the run, even with a low NAV
    const withPos = seq([505n, 505n, 505n, 505n, 505n], [0n, 0n, 1n, 0n, 0n]);
    expect(stallFloorStreak(withPos, PARAMS.stallFloorMicro)).toBe(2);
    expect(evaluate(withPos)).toBeNull();
  });

  it("stalled (b): 20 sessions of family signals all rejected only for parcel (TST101-041)", () => {
    const rejected = Array.from({ length: 20 }, (_, i) =>
      day(i, 400_000_000n, { signals: 1, parcelOnlyRejections: 1 }),
    );
    // the liquidation NAV A$400 is above bust and below target; the NAV floor streak also applies
    // here, so isolate (b) with NAV between the floor and the target
    const isolated = rejected.map((r) => ({
      ...r,
      liqNavMicro: 520_000_000n,
      navMicro: 520_000_000n,
    }));
    expect(evaluate(isolated.slice(0, 19))).toBeNull();
    expect(evaluate(isolated)).toMatchObject({
      kind: "stalled",
      rule: "stall_parcel",
      ttdSessions: 20n,
    });
  });

  it("stalled (b): a rejection for any other reason, an accepted signal or no signal at all prevents it", () => {
    const mk = (over: Partial<CloseDay>[]): CloseDay[] =>
      over.map((o, i) => day(i, 520_000_000n, { signals: 1, parcelOnlyRejections: 1, ...o }));
    const base = Array.from({ length: 20 }, () => ({}));
    expect(evaluate(mk(base))?.rule).toBe("stall_parcel");
    const cash = mk(base.map((_, i) => (i === 7 ? { parcelOnlyRejections: 0 } : {})));
    expect(evaluate(cash)).toBeNull(); // one signal rejected for cash / accepted
    const none = mk(base.map(() => ({ signals: 0, parcelOnlyRejections: 0 })));
    expect(evaluate(none)).toBeNull(); // "at least one signal" is part of the rule
    const withPosition = mk(base.map((_, i) => (i === 3 ? { openPositions: 1n } : {})));
    expect(evaluate(withPosition)).toBeNull();
  });

  it("stalled (b): windows count only days whose signals are known (books close before signals, ARN-060)", () => {
    const known = Array.from({ length: 20 }, (_, i) =>
      day(i, 520_000_000n, { signals: 1, parcelOnlyRejections: 1 }),
    );
    const today = day(20, 520_000_000n, { signals: null });
    expect(parcelStallWindow([...known, today], 20)).toMatchObject({ days: 20, stalled: true });
    expect(evaluate([...known, today])?.rule).toBe("stall_parcel");
    expect(evaluate([...known.slice(1), today])).toBeNull(); // only 19 known days
  });

  it("stalled values are injected: stall_sessions 3 and stall_parcel_rejections 10 (bounds)", () => {
    const p3: TerminalParams = { ...PARAMS, stallSessions: 3 };
    expect(evaluate(series([505_000_000n, 505_000_000n, 505_000_000n]), p3)?.kind).toBe("stalled");
    const p10: TerminalParams = { ...PARAMS, stallParcelRejections: 10 };
    const ten = Array.from({ length: 10 }, (_, i) =>
      day(i, 520_000_000n, { signals: 2, parcelOnlyRejections: 2 }),
    );
    expect(evaluate(ten, p10)?.rule).toBe("stall_parcel");
  });

  it("timeout: the 252nd session (the start session is session 1), not before", () => {
    const flat = (n: number) =>
      Array.from({ length: n }, (_, i) => day(i, 700_000_000n, { openPositions: 1n }));
    expect(evaluate(flat(251))).toBeNull();
    const v = evaluate(flat(252));
    expect(v).toMatchObject({ kind: "timeout", rule: "timeout", ttdSessions: 252n });
    expect(v?.ttdDays).toBe(daysBetween(START, DATES[251])); // calendar days, not sessions
    expect(v?.d).toBe(DATES[251]);
  });

  it("timeout counts sessions through the calendar, skipping holidays", () => {
    const holidays: CalendarRow[] = [
      { d: "2026-01-06", kind: "holiday", close_time: null },
      { d: "2026-01-07", kind: "holiday", close_time: null },
    ];
    const cal = sessionsBetween(START, "2028-12-31", holidays);
    const p: TerminalParams = { ...PARAMS, timeoutSessions: 4 };
    const hist = cal
      .slice(0, 4)
      .map((d) => ({ ...day(0, 700_000_000n, { openPositions: 1n }), d }));
    const v = evaluateTerminal({ params: p, startD: START, calendar: holidays, history: hist });
    expect(v).toMatchObject({ kind: "timeout", ttdSessions: 4n });
    expect(v?.d).toBe(cal[3]); // 4th session, with two holidays inside the span
    expect(v?.ttdDays).toBe(7n); // 2026-01-05 to 2026-01-12
  });

  it("precedence on one close: target, bust, stalled, timeout", () => {
    const p: TerminalParams = { ...PARAMS, timeoutSessions: 3 };
    // target on the timeout session: target wins
    expect(evaluate(series([700n, 800n, 1_300n].map((v) => v * 1_000_000n)), p)?.kind).toBe(
      "target",
    );
    // bust on the timeout session
    expect(evaluate(series([700n, 500n, 250n].map((v) => v * 1_000_000n)), p)?.kind).toBe("bust");
    // stalled before timeout when both hold (stall_sessions 3 = timeout 3)
    const both: TerminalParams = { ...PARAMS, timeoutSessions: 3, stallSessions: 3 };
    expect(evaluate(series([505n, 505n, 505n].map((v) => v * 1_000_000n)), both)?.kind).toBe(
      "stalled",
    );
  });

  it("a history before the start, out of order or empty is handled loudly or as unresolved", () => {
    expect(evaluate([])).toBeNull();
    expect(() =>
      evaluateTerminal({ params: PARAMS, startD: DATES[5], calendar: [], history: series([1n]) }),
    ).toThrow(/before the cohort start/);
    expect(() => evaluate([day(1, 600_000_000n), day(0, 600_000_000n)])).toThrow(/ascend/);
  });
});

describe("property: terminal checks use liquidation NAV and nothing else (ARN-052)", () => {
  it("the verdict never depends on plain NAV, and target / bust are exactly the liquidation thresholds", () => {
    const r = rng(2026);
    const { targetMicro, bustMicro } = terminalThresholds(PARAMS);
    for (let trial = 0; trial < 400; trial++) {
      const n = r.int(1, 12);
      const hist: CloseDay[] = Array.from({ length: n }, (_, i) =>
        day(i, BigInt(r.int(250, 1_300)) * 1_000_000n, {
          openPositions: BigInt(r.int(0, 1)),
          signals: r.int(0, 2),
          parcelOnlyRejections: 0,
        }),
      );
      const scrambled = hist.map((h) => ({ ...h, navMicro: BigInt(r.int(0, 2_000)) * 1_000_000n }));
      const a = evaluate(hist);
      const b = evaluate(scrambled);
      expect(b?.kind).toBe(a?.kind);
      expect(b?.rule).toBe(a?.rule);
      expect(b?.outcomeMicro).toBe(a?.outcomeMicro);
      const last = hist[hist.length - 1].liqNavMicro;
      expect(a?.kind === "target").toBe(last >= targetMicro);
      expect(a?.kind === "bust").toBe(last < targetMicro && last <= bustMicro);
      if (a !== null) expect(a.outcomeMicro).toBe(last); // outcome = liquidation NAV, never NAV
    }
  });
});

describe("parcel-only reason text", () => {
  it("accepts parcel / whole_share (alone or together), refuses anything else", () => {
    expect(isParcelOnlyReasonText("parcel")).toBe(true);
    expect(isParcelOnlyReasonText("whole_share")).toBe(true);
    expect(isParcelOnlyReasonText("parcel,whole_share")).toBe(true);
    for (const t of ["cash", "participation", "parcel,participation", "gate", "halted", "", null]) {
      expect(isParcelOnlyReasonText(t)).toBe(false);
    }
  });

  it("matches the sizing module: A$400 cash at A$9.80 is rejected for parcel only", () => {
    const sized = sizeEntry({
      settledCashMicro: 400_000_000n,
      navMicro: 400_000_000n,
      refPriceMicro: 9_800_000n,
      advValueMicro: 5_000_000_000_000n,
      adv20Shares: 1_000_000_000n,
      tier: "U1",
      profile: COST_PROFILES.P5,
    });
    expect(isParcelOnlyReasonText(sized.reasons.join(","))).toBe(true);
  });
});

describe("liquidation at the next open (ARN-053)", () => {
  const holiday: CalendarRow[] = [{ d: "2026-03-09", kind: "holiday", close_time: null }];
  const positions = new Map<string, bigint>([
    ["ZZB", 20n],
    ["ZZA", 60n],
  ]);
  const trades = [
    { tradeId: "T2", code: "ZZB" },
    { tradeId: "T1", code: "ZZA" },
  ];

  it("one exit_cs order per held code (ascending), filled on the next session, sleeve closed by cs", () => {
    const plan = planLiquidation({
      cohortId: "K1",
      d: "2026-03-06", // Friday
      calendar: holiday,
      positions,
      openTrades: trades,
      openSleeveTradeId: "S1",
    });
    expect(plan.fillD).toBe("2026-03-10"); // Monday 9th is a holiday
    expect(plan.sleeveTradeId).toBe("S1");
    expect(plan.sleeveExit).toBe("cs");
    expect(plan.orders.map((o) => [o.code, o.qty, o.tradeId, o.exitType])).toEqual([
      ["ZZA", 60n, "T1", "terminal"],
      ["ZZB", 20n, "T2", "terminal"],
    ]);
    expect(plan.orders[0].orderId).toBe(liquidationOrderId("K1", "2026-03-06", "ZZA"));
    expect(plan.orders.every((o) => o.decidedD === "2026-03-06" && o.fillD === "2026-03-10")).toBe(
      true,
    );
  });

  it("a flat cohort has no orders; inconsistent positions and trades raise", () => {
    const flat = planLiquidation({
      cohortId: "K1",
      d: "2026-03-06",
      calendar: [],
      positions: new Map(),
      openTrades: [],
    });
    expect(flat.orders).toEqual([]);
    expect(flat.sleeveTradeId).toBeNull();
    expect(() =>
      planLiquidation({
        cohortId: "K1",
        d: "2026-03-06",
        calendar: [],
        positions,
        openTrades: [trades[0]],
      }),
    ).toThrow(/exactly one open trade/);
    expect(() =>
      planLiquidation({
        cohortId: "K1",
        d: "2026-03-06",
        calendar: [],
        positions: new Map(),
        openTrades: [trades[0]],
      }),
    ).toThrow(/no position/);
    expect(() =>
      planLiquidation({
        cohortId: "K1",
        d: "2026-03-06",
        calendar: [],
        positions: new Map([["ZZA", 0n]]),
        openTrades: [trades[1]],
      }),
    ).toThrow(/positive/);
  });

  it("the next cohort starts at the open after the liquidation open: terminal close + 2 sessions", () => {
    expect(restartSession("2026-03-04", [])).toBe("2026-03-06");
    expect(restartSession("2026-03-05", [])).toBe("2026-03-09");
    expect(restartSession("2026-03-05", holiday)).toBe("2026-03-10");
    expect(restartSession("2026-03-06", holiday)).toBe("2026-03-11");
  });
});

describe("legacy ledger (ARN-026)", () => {
  const positions = new Map<string, bigint>([
    ["ZZA", 60n],
    ["ZZB", 100n],
    ["ZZC", 10n],
  ]);
  const trades = [
    { tradeId: "T1", code: "ZZA" },
    { tradeId: "T2", code: "ZZB" },
    { tradeId: "T3", code: "ZZC" },
  ];

  it("only halted codes move; the value is frozen close, or the 50 % haircut after the configured sessions", () => {
    const items = planLegacy({
      positions,
      openTrades: trades,
      halted: new Set(["ZZB", "ZZC"]),
      markFor: (code) =>
        suspensionMark({
          lastCloseMicro: code === "ZZB" ? 2_000_000n : 5_000_000n,
          advMicro: 1_000_000_000n,
          haltStartD: code === "ZZB" ? "2026-02-02" : "2026-03-30", // ZZB halted 20+ sessions, ZZC just now
          d: "2026-04-01",
          calendar: NO_HOLIDAYS,
        }),
    });
    expect(items.map((i) => i.code)).toEqual(["ZZB", "ZZC"]);
    expect(items[0]).toMatchObject({
      tradeId: "T2",
      qty: 100n,
      closeMicro: 2_000_000n,
      haircut: true,
      valueMicro: 100_000_000n,
    });
    expect(items[1]).toMatchObject({
      tradeId: "T3",
      qty: 10n,
      closeMicro: 5_000_000n,
      haircut: false,
      valueMicro: 50_000_000n,
    });
  });

  it("nothing halted, nothing moves; a halted code without exactly one open trade raises", () => {
    const none = planLegacy({
      positions,
      openTrades: trades,
      halted: new Set(),
      markFor: () => ({ closeMicro: 1n, advMicro: 1n }),
    });
    expect(none).toEqual([]);
    expect(() =>
      planLegacy({
        positions,
        openTrades: [],
        halted: new Set(["ZZA"]),
        markFor: () => ({ closeMicro: 1n, advMicro: 1n }),
      }),
    ).toThrow(/one open trade/);
  });
});
