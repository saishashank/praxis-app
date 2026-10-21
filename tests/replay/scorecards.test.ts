// @vitest-environment node
// Scorecards (M4 T14; ARN-070, ARN-072, ARN-074, ARN-076, ARN-078): hand-computed trade metrics, tied
// ranking groups, the triple-barrier trade on known paths, lift over controls and the candle-pattern
// scorecard on synthetic worlds, the leave-one-class-out arithmetic, and the row shapes.
import { describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import type { LedgerEntry, LedgerResult } from "@/lib/replay/ledger";
import {
  barrierScorecards,
  barrierSpecFrom,
  barrierTrade,
  leaveOneClassOut,
  notEnoughHistory,
  patternScorecards,
  rankExecutions,
  replayRunRow,
  statRows,
  tradeScorecard,
  tradeScorecards,
  type CohortFigure,
} from "@/lib/replay/scorecards";
import type { PoolCode } from "@/lib/replay/controlLibrary";
import { buildCohortWorld, type WorldSeries } from "../fixtures/replay/cohortWorld";
import { sessionList } from "../fixtures/agents/families/builders";
import { handSource, viewBar } from "../fixtures/replay/ledgerWorld";

const p = defaultAgentParams();
const Z = 1.6448536269514722; // two-sided 90 %
const near = (a: number, b: number, tol = 1e-9): void => {
  expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(tol);
};
const SESSIONS = sessionList("2027-09-30", 320);

/** A closed ledger row with only the fields a scorecard reads. */
function entry(i: number, num: bigint, den: bigint, hold = 3, variant = "F4"): LedgerEntry {
  return {
    row: { id: `lr:${i}`, entry_d: SESSIONS[i * 5]!, exit_d: SESSIONS[i * 5 + hold - 1]! },
    lineage: "AU:F4",
    family: "F4",
    ruleVersion: "F4.v1",
    variant,
    code: "ZZA",
    decisionD: SESSIONS[i * 5 - 1] ?? SESSIONS[0]!,
    net: { num, den },
    excess: null,
    controls: null,
  } as unknown as LedgerEntry;
}

describe("ARN-070 trade scorecard", () => {
  // 40 closed rows, 25 wins of +2 % and 15 losses of -1 %, every row held 3 sessions, one every 5
  const entries = Array.from({ length: 40 }, (_, i) =>
    i % 8 < 5 ? entry(i, 2n, 100n) : entry(i, -1n, 100n),
  );
  const card = tradeScorecard({ entries, sessions: SESSIONS, params: p, scope: "AU:F4|F4.v1|F4" });

  it("net win rate with a Wilson 90 % interval, average win and loss, payoff, expectancy, profit factor", () => {
    if (card.insufficient) throw new Error("expected a full card");
    expect(card.n).toBe(40);
    near(card.winRate.value, 25 / 40);
    const n = 40;
    const phat = 25 / 40;
    const denom = 1 + (Z * Z) / n;
    const centre = (phat + (Z * Z) / (2 * n)) / denom;
    const half = (Z * Math.sqrt((phat * (1 - phat)) / n + (Z * Z) / (4 * n * n))) / denom;
    near(card.winRate.interval.lower, centre - half, 1e-8);
    near(card.winRate.interval.upper, centre + half, 1e-8);
    near(card.avgWin.value!, 0.02);
    near(card.avgLoss.value!, -0.01);
    near(card.payoff.value!, 2);
    near(card.expectancy.value!, (25 * 0.02 - 15 * 0.01) / 40);
    near(card.profitFactor.value!, (25 * 0.02) / (15 * 0.01));
  });

  it("holding period and exposure follow the dates; intervals bracket the estimates", () => {
    if (card.insufficient) throw new Error("expected a full card");
    expect(card.holdingSessions).toEqual({ mean: 3, median: 3 });
    near(card.exposure, (40 * 3) / SESSIONS.length);
    for (const e of [card.expectancy, card.avgWin, card.avgLoss, card.payoff, card.profitFactor]) {
      expect(e.interval!.lower).toBeLessThanOrEqual(e.value! + 1e-12);
      expect(e.interval!.upper).toBeGreaterThanOrEqual(e.value! - 1e-12);
    }
    expect(card.replicates).toBe(p.stats.bootstrapReplicationsMin);
    expect(card.block).toBeGreaterThanOrEqual(p.stats.bootstrapBlockMinSessions);
  });

  it("is a seeded stream: the same input gives the same card", () => {
    expect(
      tradeScorecard({ entries, sessions: SESSIONS, params: p, scope: "AU:F4|F4.v1|F4" }),
    ).toEqual(card);
  });

  it('below scenario_min_n rows it says "Not enough history yet (n = x)" and nothing else', () => {
    const few = tradeScorecard({
      entries: entries.slice(0, 29),
      sessions: SESSIONS,
      params: p,
      scope: "s",
    });
    expect(few).toEqual({
      scope: "s",
      n: 29,
      insufficient: true,
      message: "Not enough history yet (n = 29)",
    });
    expect(notEnoughHistory(7)).toBe("Not enough history yet (n = 7)");
  });

  it("open rows are not trades; groups are (lineage, rule version, variant)", () => {
    const open = {
      ...entries[0]!,
      net: null,
      row: { ...entries[0]!.row, exit_d: null },
    } as unknown as LedgerEntry;
    const result = {
      market: "AU",
      from: SESSIONS[0],
      to: SESSIONS[319],
      sessions: SESSIONS.length,
      entries: [
        ...entries,
        open,
        ...entries.slice(0, 30).map((e, i) => entry(i, 1n, 100n, 3, "F4-U1")),
      ],
      skipped: [],
      controlPaths: 0,
    } as unknown as LedgerResult;
    const cards = tradeScorecards(result, SESSIONS, p);
    expect(cards.map((c) => c.scope)).toEqual(["AU:F4|F4.v1|F4", "AU:F4|F4.v1|F4-U1"]);
    expect(cards[0]!.n).toBe(40);
    expect(cards[1]!.n).toBe(30);
  });
});

describe("ARN-078 rankings", () => {
  const fig = (scope: string, n: number, mean: number, lo: number, hi: number): CohortFigure =>
    ({
      scope,
      executionId: scope,
      effectiveN: n,
      navMinusSeed: { n, meanMicro: mean, interval: { lower: lo, upper: hi }, replicates: 1 },
    }) as unknown as CohortFigure;

  it("groups executions whose 90 % intervals overlap as tied, never orders inside a group", () => {
    const r = rankExecutions(
      [
        fig("E01", 5, 50, 40, 60),
        fig("E02", 5, 45, 35, 55), // overlaps E01
        fig("E03", 4, 10, 5, 15),
        fig("E04", 2, 99, 90, 110), // effective N below progress_min_neff
        fig("E05", 6, -30, -45, -20),
      ],
      p,
    );
    expect(r.groups.map((g) => g.members.map((m) => m.scope))).toEqual([
      ["E01", "E02"],
      ["E03"],
      ["E05"],
    ]);
    expect(r.groups.map((g) => [g.rank, g.tied])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
    expect(r.insufficient).toEqual([{ scope: "E04", effectiveN: 2 }]);
  });

  it("chains overlaps: A-B and B-C overlap, so all three are one tied group", () => {
    const r = rankExecutions(
      [fig("E01", 5, 10, 0, 20), fig("E02", 5, 25, 15, 35), fig("E03", 5, 40, 30, 50)],
      p,
    );
    expect(r.groups.length).toBe(1);
    expect(r.groups[0]!.members.map((m) => m.scope)).toEqual(["E03", "E02", "E01"]);
  });
});

describe("ARN-072 triple barrier on known paths", () => {
  const sessions = sessionList("2026-10-16", 40);
  const D = (x: number): bigint => BigInt(Math.round(x * 1e6));
  const ADV = 10_000_000_000_000n; // A$10M: the 10 bps bucket
  const spec = barrierSpecFrom(p);
  const flat = () =>
    Array.from({ length: 40 }, (_, i) => viewBar(sessions[i]!, D(10), D(10.05), D(9.95), D(10)));
  const run = (bars: ReturnType<typeof flat>, entryIdx = 0, endIdx = 39) =>
    barrierTrade(
      handSource(sessions, { ZZA: bars }),
      { code: "ZZA", entryIdx, endIdx, atrMicro: D(0.5), advMicro: ADV },
      spec,
    );
  // entry: open 10.00 + 1 tick of slippage = 10.01, 59 shares (floor(600 / 10.01)), A$5 brokerage
  const cost = 59 * 10.01 + 5;
  // 59 x fill - A$5 against the cost
  const net = (fill: number): number => (59 * fill - 5 - cost) / cost;

  it("upper barrier fill + 2 x ATR = 11.01 is hit: the sell fills at 11.01 less a tick of slippage", () => {
    const bars = flat();
    bars[3] = viewBar(sessions[3]!, D(10.5), D(11.2), D(10.4), D(11));
    const t = run(bars)!;
    expect(t.hit).toBe("up");
    near(t.net, net(10.99));
  });

  it("lower barrier fill - 1.5 x ATR = 9.26 is hit: the stop fills at the level less slippage and a tick", () => {
    const bars = flat();
    bars[2] = viewBar(sessions[2]!, D(10), D(10.1), D(9.2), D(9.3));
    const t = run(bars)!;
    expect(t.hit).toBe("down");
    near(t.net, net(9.24));
  });

  it("a gap below the lower barrier fills at the open less slippage", () => {
    const bars = flat();
    bars[2] = viewBar(sessions[2]!, D(9), D(9.1), D(8.9), D(9));
    const t = run(bars)!;
    expect(t.hit).toBe("down");
    near(t.net, net(8.99));
  });

  it("a session that touches both barriers counts the lower one first", () => {
    const bars = flat();
    bars[2] = viewBar(sessions[2]!, D(10), D(11.5), D(9.2), D(10));
    expect(run(bars)!.hit).toBe("down");
  });

  it("no touch in 20 sessions: sold at the close of the 20th session", () => {
    const t = run(flat())!;
    expect(t.hit).toBe("time");
    near(t.net, net(9.99));
  });

  it("an incomplete path (the data ends inside the 20 sessions) is not scored", () => {
    expect(run(flat(), 30, 39)).toBeNull();
    expect(
      barrierTrade(
        handSource(sessions, { ZZA: flat() }),
        { code: "ZZA", entryIdx: 0, endIdx: 39, atrMicro: 0n, advMicro: ADV },
        spec,
      ),
    ).toBeNull();
  });
});

/** A world with a riser (ZZA) and a flat code (ZZB): every ZZA barrier trade hits the upper barrier. */
function twoCodeSeries(n = 200) {
  const sessions = sessionList("2027-09-30", n);
  const D = (x: number): bigint => BigInt(Math.round(x * 1e6));
  const riser = sessions.map((d, i) => {
    const close = D(10 * 1.012 ** i);
    const open = D(10 * 1.012 ** Math.max(0, i - 1));
    return viewBar(
      d,
      open,
      close > open ? close + 10_000n : open + 10_000n,
      open < close ? open - 10_000n : close - 10_000n,
      close,
      3_000_000n,
    );
  });
  const flat = sessions.map((d) => viewBar(d, D(10), D(10.02), D(9.98), D(10), 3_000_000n));
  return { sessions, riser, flat, D };
}

describe("ARN-072 lift over matched controls", () => {
  const { sessions, riser, flat } = twoCodeSeries(200);
  const facts = { atrMicro: 500_000n, closeAboveExitSma: null, volumeRatios: [], events: [] };
  const base = handSource(sessions, { ZZA: riser, ZZB: flat }, facts);
  const pool = (): PoolCode[] => [
    {
      code: "ZZA",
      tier: "U1",
      vol20: 0.01,
      atrMicro: 500_000n,
      advMicro: 10_000_000_000_000n,
      eligible: true,
    },
    {
      code: "ZZB",
      tier: "U1",
      vol20: 0.01,
      atrMicro: 500_000n,
      advMicro: 10_000_000_000_000n,
      eligible: true,
    },
  ];
  const src = { ...base, controlUniverse: pool };
  const mk = (n: number, with_controls = true): LedgerResult => {
    const entries = Array.from({ length: n }, (_, i) => {
      const entryIdx = 6 + i * 3;
      return {
        row: { id: `lr:${i}`, entry_d: sessions[entryIdx], exit_d: sessions[entryIdx + 4] },
        lineage: "AU:F4",
        family: "F4",
        ruleVersion: "F4.v1",
        variant: "F4",
        code: "ZZA",
        decisionD: sessions[entryIdx - 1],
        net: { num: 1n, den: 100n },
        controls: { controls: with_controls ? [{ code: "ZZB" }] : [] },
      };
    });
    return {
      market: "AU",
      sessions: sessions.length,
      entries,
      skipped: [],
      controlPaths: 0,
    } as unknown as LedgerResult;
  };

  it("the riser hits the upper barrier, the flat control times out: lift is the gap between them", () => {
    const [card] = barrierScorecards(mk(40), src, p);
    if (card === undefined || card.insufficient) throw new Error("expected a full card");
    expect(card.n).toBe(40);
    expect(card.share).toEqual({ up: 1, down: 0, time: 0 });
    near(card.lift, card.meanNet - card.meanControl, 1e-12);
    expect(card.meanNet).toBeGreaterThan(0.02);
    expect(card.meanControl).toBeLessThan(0);
    expect(card.liftInterval.lower).toBeLessThanOrEqual(card.lift + 1e-12);
    expect(card.liftInterval.upper).toBeGreaterThanOrEqual(card.lift - 1e-12);
    expect(barrierScorecards(mk(40), src, p)).toEqual([card]);
  });

  it("fewer than scenario_min_n scored rows, or rows without controls, give the n = x message", () => {
    const [few] = barrierScorecards(mk(12), src, p);
    expect(few).toMatchObject({
      insufficient: true,
      n: 12,
      message: "Not enough history yet (n = 12)",
    });
    const [none] = barrierScorecards(mk(40, false), src, p);
    expect(none).toMatchObject({ insufficient: true, n: 0 });
  });
});

describe("ARN-074 candle-pattern scorecard", () => {
  const n = 320;
  const sessions = sessionList("2027-09-30", n);
  const { riser, flat } = twoCodeSeries(n);
  const series: WorldSeries[] = [
    { code: "ZZA", tier: "U1", bars: riser },
    { code: "ZZB", tier: "U1", bars: flat },
    { code: "ZZC", tier: "U1", bars: flat.map((b) => ({ ...b, volume: 4_000_000n })) },
  ];
  const world = buildCohortWorld(sessions, series, p);
  // ZZA shows a hammer on every 6th session
  const flagged = {
    ...world,
    familyInputs(d: string) {
      const inputs = world.familyInputs(d);
      const day = sessions.indexOf(d);
      return {
        ...inputs,
        codes: inputs.codes.map((c) =>
          c.code === "ZZA" && day % 6 === 0 ? { ...c, patterns: { hammer: true } } : c,
        ),
      };
    },
  };

  it("scores each pattern against same-date controls and charges the test to F4's lineage", () => {
    const cards = patternScorecards(flagged, p, "AU");
    expect(cards.map((c) => c.pattern)).toEqual([
      "bullishEngulfing",
      "hammer",
      "morningStar",
      "piercingLine",
    ]);
    expect(cards.every((c) => c.chargedTo === "AU:F4")).toBe(true);
    const hammer = cards.find((c) => c.pattern === "hammer")!.card;
    if (hammer.insufficient) throw new Error("expected enough hammer events");
    expect(hammer.n).toBeGreaterThanOrEqual(p.stats.scenarioMinN);
    expect(hammer.lift).toBeGreaterThan(0.01);
    near(hammer.lift, hammer.meanNet - hammer.meanControl, 1e-12);
    const none = cards.find((c) => c.pattern === "morningStar")!.card;
    expect(none).toMatchObject({ insufficient: true, n: 0 });
    expect(patternScorecards(flagged, p, "AU")).toEqual(cards);
  });

  it("can be limited to a date range (the development window)", () => {
    const cards = patternScorecards(flagged, p, "AU", { from: sessions[0]!, to: sessions[60]! });
    const hammer = cards.find((c) => c.pattern === "hammer")!.card;
    expect(hammer.insufficient).toBe(true);
  });
});

describe("ARN-076 leave-one-class-out arithmetic", () => {
  const dates = SESSIONS;
  const result = (values: number[]): LedgerResult =>
    ({
      entries: values.map((x, i) => ({
        family: "F6",
        net: { num: BigInt(Math.round(x * 1e6)), den: 1_000_000n },
        excess: { num: BigInt(Math.round(x * 1e6)), den: 1_000_000n },
        row: { entry_d: dates[i * 2] },
      })),
    }) as unknown as LedgerResult;
  const full = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.01 : 0.03));
  const shifted = full.map((x) => x - 0.01);

  it("contribution = mean excess with all classes minus without one, with a paired interval", () => {
    const out = leaveOneClassOut(
      (off) =>
        off === null
          ? result(full)
          : off === "a"
            ? result(shifted)
            : off === "b"
              ? result(full)
              : result([]),
      dates,
      p,
      "AU:F6",
    );
    near(out.all.meanExcess!, 0.02);
    expect(out.all.rows).toBe(40);
    const byClass = Object.fromEntries(out.classes.map((c) => [c.class, c]));
    near(byClass.a!.contribution!, 0.01);
    near(byClass.a!.interval!.lower, 0.01, 1e-9);
    near(byClass.a!.interval!.upper, 0.01, 1e-9);
    near(byClass.b!.contribution!, 0);
    // a class whose disabling leaves no F6 row at all has no estimate
    expect(byClass.c!.without.rows).toBe(0);
    expect(byClass.c!.contribution).toBeNull();
    expect(byClass.c!.interval).toBeNull();
    expect(out.classes.map((c) => c.class)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("rows in the migration 0008 shapes", () => {
  it("statRows are sorted, canonical JSON, one per (scope, metric)", () => {
    const rows = statRows("run-1", "2031-01-02", [
      { scope: "E02", metric: "cif", value: { b: 2n, a: { num: 1n, den: 3n } } },
      { scope: "E01", metric: "cif", value: [1, Number.NaN] },
    ]);
    expect(rows.map((r) => [r.scope, r.metric])).toEqual([
      ["E01", "cif"],
      ["E02", "cif"],
    ]);
    expect(rows[0]!.value_json).toBe("[1,null]");
    expect(rows[1]!.value_json).toBe('{"a":"1/3","b":"2"}');
    expect(rows.every((r) => r.run_id === "run-1" && r.d === "2031-01-02")).toBe(true);
    expect(() =>
      statRows("r", "d", [
        { scope: "s", metric: "m", value: 1 },
        { scope: "s", metric: "m", value: 2 },
      ]),
    ).toThrow(/duplicate/);
  });

  it("the run row carries the digest in files_json and the node version", () => {
    const row = replayRunRow({
      id: "run-1",
      kind: "light",
      market: "AU",
      snapshotSha: "a".repeat(64),
      commitSha: "b".repeat(40),
      paramsSha: "c".repeat(64),
      seed: 20261011n,
      nodeVersion: process.version,
      minutes: 1.5,
      files: ["replay-2031-01/ledger.json", "replay-2031-01/cohorts.json"],
      digest: "d".repeat(64),
    });
    expect(row.seed).toBe(20261011);
    expect(JSON.parse(row.files_json)).toEqual({
      digest: "d".repeat(64),
      files: ["replay-2031-01/cohorts.json", "replay-2031-01/ledger.json"],
    });
    expect(row.node_version).toBe(process.version);
  });
});
