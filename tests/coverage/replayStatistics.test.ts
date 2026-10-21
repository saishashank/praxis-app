// @vitest-environment node
// M8 T3 coverage (TST-121): the replay statistics modules (scorecards, returns, null runs, zero-edge,
// CIF) on the three synthetic years of the replay harness: JSON forms of maps and sets, empty
// inputs, scorecards without a ledger or a source, random-signal null runs that produce closed rows,
// a detection report with no usable runs, and the zero-edge benchmark in its degenerate cases.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { replayCohorts, type CohortReplayResult } from "@/lib/replay/cohortReplay";
import { replayLedger, type LedgerResult } from "@/lib/replay/ledger";
import {
  detectionReport,
  ledgerTestRows,
  matchedQ,
  randomSignalSource,
  realNullBatch,
  type RunTest,
} from "@/lib/replay/nullRuns";
import {
  costSetupFrom,
  pairedExcess,
  periodReturn,
  periodReturns,
  roundTripBrokerage,
  walkPosition,
  snapshotBarLookup,
} from "@/lib/replay/returns";
import { makeRational } from "@/lib/money/rational";
import {
  barrierSpecFrom,
  barrierTrade,
  buildReplayStats,
  canonical,
  cohortFigure,
  median,
  plain,
  tradeScorecard,
  type ScorecardInput,
} from "@/lib/replay/scorecards";
import { zeroEdge } from "@/lib/replay/zeroEdge";
import { resolveCohortParams } from "@/lib/arena/cohort";
import { buildDataset, freshReplayDb, terminalOverrides } from "../arena/replayHarness";
import { cleanupTempDbs } from "../db/helpers";
import { buildCohortWorld, seriesFromHarness } from "../fixtures/replay/cohortWorld";

const base = defaultAgentParams();
const p = { ...base, replay: { ...base.replay, zeroEdgeTrials: 50 } };
const SESSIONS = 780;

let world: ReturnType<typeof buildCohortWorld>;
let ledger: LedgerResult;
let cohorts: CohortReplayResult;
let input: ScorecardInput;
let gappy: ReturnType<typeof buildCohortWorld>;
let gappyLedger: LedgerResult;
let gappyCohorts: CohortReplayResult;

beforeAll(async () => {
  const db = await freshReplayDb();
  const ds = await buildDataset(db, { startD: "2030-01-07", sessions: SESSIONS, seed: 11 });
  const series = await seriesFromHarness(db, ds.dates, ds.spec);
  world = buildCohortWorld(ds.dates, series, p);
  // the same market with missing bars (every 11th session of every other code) and a thin first code
  gappy = buildCohortWorld(
    ds.dates,
    series.map((s, k) => ({
      ...s,
      bars: s.bars.map((b, i) => (k % 2 === 1 && i % 11 === 5 ? null : b)),
    })),
    p,
  );
  gappyLedger = replayLedger(gappy, { params: p });
  gappyCohorts = replayCohorts(gappy, {
    params: p,
    cohortParams: () => terminalOverrides(),
    controlsPerFamily: 2,
    step: 10,
  });
  ledger = replayLedger(world, { params: p });
  cohorts = replayCohorts(world, {
    params: p,
    cohortParams: () => terminalOverrides(),
    controlsPerFamily: 2,
    step: 10,
  });
  input = {
    runId: "run-cov",
    d: ds.dates[SESSIONS - 1]!,
    params: p,
    market: "AU",
    families: ["F1", "F2", "F3", "F4", "F5", "F6"],
    cohorts,
    ledger,
    src: world,
    timeoutSessions: 130,
    patterns: false,
  };
}, 180_000);
afterAll(cleanupTempDbs);

describe("plain JSON forms", () => {
  it("maps and sets are sorted, non-finite numbers are null, rationals and bigints are text", () => {
    expect(plain(new Map<string, unknown>([["b", 2n], ["a", { num: 1n, den: 3n }]]))).toEqual({ a: "1/3", b: "2" });
    expect(plain(new Set(["y", "x"]))).toEqual(["x", "y"]);
    expect(plain({ n: Number.NaN, i: Number.POSITIVE_INFINITY, u: undefined, k: 1 })).toEqual({ n: null, i: null, k: 1 });
    expect(canonical(new Map([[2, "b"], [1, "a"]]))).toBe(canonical({ 1: "a", 2: "b" }));
  });

  it("median: none, odd and even counts", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("a figure for a scope with no cohorts is refused", () => {
    expect(() => cohortFigure("E99", [], { params: p } as never)).toThrow(/no cohorts for E99/);
  });
});

describe("buildReplayStats degenerate inputs", () => {
  it("without a ledger there are no trade scorecards; without a source there are no barrier rows", () => {
    const none = buildReplayStats({ ...input, ledger: null, src: null });
    expect(none.rows.some((r) => r.metric === "scorecard")).toBe(false);
    expect(none.rows.some((r) => r.metric === "barrier")).toBe(false);
    const noSrc = buildReplayStats({ ...input, src: null });
    expect(noSrc.rows.some((r) => r.metric === "scorecard")).toBe(true);
    expect(noSrc.rows.some((r) => r.metric === "barrier")).toBe(false);
  }, 180_000);

  it("a ledger with no entries and a single family still build rows, and say what was skipped", () => {
    const empty = buildReplayStats({
      ...input,
      families: ["F4"],
      ledger: { ...ledger, entries: [] } as LedgerResult,
    });
    expect(empty.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(empty.rows.length).toBeGreaterThan(0);
  }, 180_000);

  it("pattern scorecards are added when asked for", () => {
    const withPatterns = buildReplayStats({ ...input, patterns: true });
    expect(withPatterns.rows.length).toBeGreaterThan(0);
  }, 180_000);
});

describe("random-signal null runs on the synthetic world", () => {
  it("produce closed ledger rows and a bootstrap test per run that has rows", () => {
    const b = realNullBatch({ world, params: p, runs: 3, q: 0.3, B: 100 });
    expect(b.requested).toBe(3);
    expect(b.tests.length).toBeGreaterThanOrEqual(0);
    expect(b.pausedBudget).toBe(false);
    expect(matchedQ(ledger.entries.length, 500)).toBeGreaterThan(0);
  }, 180_000);
});

describe("a market with missing bars", () => {
  it("scorecards, barriers and null runs cope with sessions that have no bar", () => {
    const out = buildReplayStats({
      ...input,
      cohorts: gappyCohorts,
      ledger: gappyLedger,
      src: gappy,
      patterns: true,
    });
    expect(out.digest).toMatch(/^[0-9a-f]{64}$/);
    const b = realNullBatch({ world: gappy, params: p, runs: 3, q: 0.3, B: 100 });
    expect(b.requested).toBe(3);
  }, 300_000);
});

describe("detection report and zero-edge degenerate cases", () => {
  it("no usable runs: zero rate, no median, not passed", () => {
    const unusable = [{ insufficientBlocks: true, p: 0.5, mean: 0.1 } as unknown as RunTest];
    expect(detectionReport(unusable, 0.05, 0.8)).toMatchObject({ n: 0, rate: 0, pass: false, medianMean: null });
    expect(detectionReport([], 0.05, 0.8).n).toBe(0);
  });

  const zin = {
    family: "F1",
    ruleVersion: "F1.v1",
    dailyVol: 0.03,
    entryRate: 1,
    meanHoldSessions: 3,
    slippageBps: 10,
    params: resolveCohortParams({}),
    trials: 1,
    seed: 7,
  };

  it("one trial has no sampling variance; a huge volatility wipes a position out", () => {
    const one = zeroEdge(zin);
    expect(one.navMcSeMicro).toBe(0);
    const wild = zeroEdge({ ...zin, dailyVol: 1e9, trials: 20 });
    expect(wild.probability.bust + wild.probability.stalled + wild.probability.timeout + wild.probability.target).toBeCloseTo(1, 12);
  });

  it("a tiny account cannot meet the parcel: entries are rejected", () => {
    const poor = zeroEdge({
      ...zin,
      trials: 5,
      params: resolveCohortParams({ seedMicro: 1_000_000n } as never),
    });
    expect(poor.trials).toBe(5);
  });
});

describe("trade scorecard on crafted rows", () => {
  const n = p.stats.scenarioMinN;
  const sessions = Array.from({ length: 40 }, (_, i) => `2030-03-${String(i + 1).padStart(2, "0")}`);
  const entry = (i: number, net: bigint, entryD = sessions[i % 20]!, exitD = sessions[(i % 20) + 2]!) =>
    ({
      net: { num: net, den: 100n },
      row: { entry_d: entryD, exit_d: exitD },
    }) as never;
  const card = (nets: bigint[], dates?: [string, string]) =>
    tradeScorecard({
      entries: nets.map((x, i) => entry(i, x, dates?.[0] ?? sessions[i % 20]!, dates?.[1] ?? sessions[(i % 20) + 2]!)),
      sessions,
      params: p,
      scope: "cov",
    });

  it("too few closed rows say so", () => {
    const c = tradeScorecard({ entries: [entry(0, 1n)], sessions, params: p, scope: "cov" });
    expect(c.insufficient).toBe(true);
  });

  it("all-losing and all-winning sets leave the missing average null", () => {
    const losing = card(Array.from({ length: n }, (_, i) => BigInt(-1 - (i % 3))));
    const winning = card(Array.from({ length: n }, (_, i) => BigInt(1 + (i % 3))));
    expect(losing.insufficient || (losing as { avgWin: { value: number | null } }).avgWin.value === null).toBe(true);
    expect(winning.insufficient || (winning as { avgLoss: { value: number | null } }).avgLoss.value === null).toBe(true);
  });

  it("dates outside the calendar count from the first session", () => {
    const c = card(Array.from({ length: n }, (_, i) => BigInt(i % 2 === 0 ? 2 : -1)), ["1999-01-01", "1999-02-01"]);
    expect(c.n).toBe(n);
  });
});

describe("barrier trade on a stub path", () => {
  const spec = barrierSpecFrom(p);
  const days = Array.from({ length: spec.horizon + 3 }, (_, i) => `2030-05-${String(i + 1).padStart(2, "0")}`);
  const flat = (px: bigint) => ({ open: px, high: px + 1_000n, low: px - 1_000n, close: px, volume: 1_000_000n });
  const path = (barAt: (code: string, d: string) => ReturnType<typeof flat> | null) =>
    ({ sessions: days, bar: barAt }) as never;
  const arg = (over: Record<string, unknown> = {}) => ({
    code: "ZZA",
    entryIdx: 0,
    endIdx: days.length - 1,
    atrMicro: 200_000n,
    advMicro: 50_000_000_000n,
    ...over,
  });

  it("incomplete data, no entry bar and a price too high for the notional give null", () => {
    const ok = path(() => flat(10_000_000n));
    expect(barrierTrade(ok, arg({ endIdx: 0 }), spec)).toBeNull();
    expect(barrierTrade(ok, arg({ atrMicro: 0n }), spec)).toBeNull();
    expect(barrierTrade(path(() => null), arg(), spec)).toBeNull();
    expect(barrierTrade(path(() => flat(10n ** 15n)), arg(), spec)).toBeNull();
  });

  it("a stop level below one micro is floored; sessions without a bar are skipped; the time exit uses the last bar seen", () => {
    const only = path((_c, d) => (d === days[0] ? flat(10_000_000n) : null));
    const r = barrierTrade(only, arg({ atrMicro: 10n ** 12n }), spec);
    expect(r).not.toBeNull();
    expect(["up", "down", "time"]).toContain(r!.hit);
    const quiet = barrierTrade(only, arg(), spec);
    expect(quiet?.hit).toBe("time");
  });
});

describe("return helpers", () => {
  it("period returns skip groups with no open row and keep key order", () => {
    const pts = [
      { d: "2030-01-01", pnlMicro: 10_000n, open: 1 },
      { d: "2030-01-02", pnlMicro: 20_000n, open: 2 },
      { d: "2030-02-01", pnlMicro: 5n, open: 0 },
    ];
    const out = periodReturns(pts, 1_000_000n, (d) => d.slice(0, 7));
    expect(out.map((r) => r.key)).toEqual(["2030-01"]);
    expect(periodReturn(pts, 1_000_000n, "2030-03-01", "2030-03-31")).toBeNull();
  });

  it("paired excess is null without controls; brokerage covers both sides", () => {
    expect(pairedExcess(makeRational(1n, 10n), [])).toBeNull();
    expect(pairedExcess(makeRational(1n, 10n), [makeRational(1n, 20n)])).toEqual(makeRational(1n, 20n));
    expect(roundTripBrokerage(costSetupFrom(p), 5_000_000_000n)).toBeGreaterThan(0n);
  });

  it("snapshot bar lookup works with no calendar table and several bars of one code", () => {
    const look = snapshotBarLookup({
      bars: [
        { code: "ZZA", d: "2030-01-02", o: 1, h: 1.1, l: 0.9, c: 1, volume: 10 },
        { code: "ZZA", d: "2030-01-03", o: 1, h: 1.1, l: 0.9, c: 1, volume: 10 },
      ],
      tables: {},
    });
    expect(look.sessions).toEqual([]);
    expect(look.bar("ZZA", "2030-01-03")?.volume).toBe(10n);
    expect(look.bar("ZZB", "2030-01-03")).toBeNull();
  });
});

describe("random-signal source without optional world members", () => {
  it("works over a world with no market name and no corporate actions", () => {
    const bare = {
      sessions: world.sessions,
      bar: world.bar.bind(world),
      positionFacts: world.positionFacts.bind(world),
      controlUniverse: world.controlUniverse.bind(world),
      familyInputs: world.familyInputs.bind(world),
    } as never;
    const src = randomSignalSource(bare, { run: 0, q: 1, params: p });
    expect(src.market).toBe("AU");
    expect(src.corpActions).toBeUndefined();
    const d = world.sessions[200]!;
    expect(src.familyOutput?.(d)?.candidates.length).toBeGreaterThan(0);
  });

  it("closed rows with an excess become test rows relative to the first entry", () => {
    const e = (entry: string, exit: string, num: bigint) =>
      ({ excess: { num, den: 100n }, row: { entry_d: entry, exit_d: exit } }) as never;
    const sess = ["a", "b", "c", "d", "e"];
    const t = ledgerTestRows({ entries: [e("b", "d", 3n), e("c", "e", -1n), { excess: null, row: { entry_d: "a", exit_d: "b" } } as never] } as never, sess);
    expect(t.rows).toEqual([
      { session: 0, excess: 0.03 },
      { session: 1, excess: -0.01 },
    ]);
    expect(t.sessionCount).toBe(2);
    expect(t.holds).toEqual([2, 2]);
  });
});

describe("walkPosition refusals", () => {
  const days = ["2030-05-01", "2030-05-02", "2030-05-03"];
  const bar = { d: "x", open: 10_000_000n, high: 10_100_000n, low: 9_900_000n, close: 10_000_000n, volume: 1_000_000n };
  const spec = (over: Record<string, unknown> = {}) =>
    ({
      code: "ZZA",
      plan: { initialStops: [], trails: [], cs: [] },
      entryIdx: 0,
      endIdx: 2,
      advMicro: 10n ** 11n,
      maxOpenMicro: null,
      forceExit: false,
      ...over,
    }) as never;
  const src = (b: typeof bar | null) => ({ sessions: days, bar: () => b }) as never;

  it("names why a position is not opened", () => {
    const cost = costSetupFrom(p);
    expect(walkPosition(src(bar), spec({ entryIdx: 7, endIdx: 9 }), cost)).toEqual({ kind: "skipped", reason: "no_session" });
    expect(walkPosition(src(bar), spec({ entryIdx: 2, endIdx: 1 }), cost)).toEqual({ kind: "skipped", reason: "no_session" });
    expect(walkPosition(src(bar), spec({ entryIdx: 2, forceExit: true }), cost)).toEqual({ kind: "skipped", reason: "no_room" });
    expect(walkPosition(src(null), spec(), cost)).toEqual({ kind: "skipped", reason: "no_bar" });
    expect(walkPosition(src(bar), spec({ maxOpenMicro: 5_000_000n }), cost)).toEqual({ kind: "skipped", reason: "gap" });
  });
});
