// @vitest-environment node
// Rolling-start cohort replay (M4 T14; design 4.7; ARN-080, ARN-053, ARN-102, TST-102, TST-109) on
// the three synthetic years of the M3 replay harness (ZZ codes): the terminal verdict equals the M3
// `evaluateTerminal`, effective N equals M3's on the same cohorts, two runs are byte-identical,
// nothing reads the future, and the full default-size replay (every start date, every control slot)
// fits the time budget. Parity with the database engine is in cohortParity.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import {
  effectiveNByExecution,
  resolveCohortParams,
  type EffectiveNCohort,
} from "@/lib/arena/cohort";
import { evaluateTerminal, type CloseDay } from "@/lib/arena/terminal";
import {
  judgeClose,
  replayCohorts,
  type CohortDayTrace,
  type CohortReplayResult,
  type ReplayProgress,
} from "@/lib/replay/cohortReplay";
import { cohortFigure, plain, replayDigest } from "@/lib/replay/scorecards";
import { cleanupTempDbs } from "../db/helpers";
import { buildDataset, freshReplayDb, terminalOverrides } from "../arena/replayHarness";
import {
  buildCohortWorld,
  seriesFromHarness,
  type CohortWorldOptions,
  type WorldSeries,
} from "../fixtures/replay/cohortWorld";

const p = defaultAgentParams();
const SESSIONS = 780;
let dates: string[] = [];
let series: WorldSeries[] = [];

beforeAll(async () => {
  const db = await freshReplayDb();
  const ds = await buildDataset(db, { startD: "2030-01-07", sessions: SESSIONS, seed: 11 });
  dates = ds.dates;
  series = await seriesFromHarness(db, ds.dates, ds.spec);
});
afterAll(cleanupTempDbs);

const small = { controlsPerFamily: 1, step: 25, cohortParams: () => terminalOverrides() };
const world = (o: CohortWorldOptions = {}) => buildCohortWorld(dates, series, p, o);

describe("judgeClose is the M3 terminal sequence", () => {
  // a small LCG: the same histories on every run
  let seed = 12345;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const params = resolveCohortParams({ terminal: { timeoutSessions: 30 } }).terminal;
  const WEEKDAYS: string[] = [];
  for (
    const d = new Date("2030-01-07T00:00:00Z");
    WEEKDAYS.length < 80;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) WEEKDAYS.push(d.toISOString().slice(0, 10));
  }

  it("agrees with evaluateTerminal on 600 random histories (every verdict occurs)", () => {
    const seen = new Set<string>();
    for (let k = 0; k < 600; k += 1) {
      const length = 1 + next(45);
      const history: CloseDay[] = [];
      const low = next(3) === 0;
      for (let j = 0; j < length; j += 1) {
        const liq = BigInt(low ? 300 + next(300) : 250 + next(1000)) * 1_000_000n;
        const flat = next(3) !== 0;
        const signals = j === length - 1 ? null : next(3);
        history.push({
          d: WEEKDAYS[j]!,
          navMicro: liq,
          liqNavMicro: liq,
          openPositions: flat ? 0n : 1n,
          signals,
          parcelOnlyRejections: signals === null ? 0 : next(signals + 1),
        });
      }
      const input = { params, startD: WEEKDAYS[0]!, calendar: [], history };
      const want = evaluateTerminal(input);
      const got = judgeClose(params, history, length);
      expect(got === null ? null : `${got.kind}:${got.rule}`).toBe(
        want === null ? null : `${want.kind}:${want.rule}`,
      );
      // the cheaper path used by the replay (no signal in the parcel window) never changes a verdict
      const known = history.slice(0, -1).slice(-params.stallParcelRejections);
      const quiet = known.every((h) => (h.signals ?? 0) === 0);
      const fast = judgeClose(params, history, length, { noRecentSignals: quiet });
      expect(fast).toEqual(got);
      seen.add(got === null ? "none" : got.rule);
    }
    // histories built for the parcel stall: flat, above the floor, parcel-only rejections in the window
    for (let k = 0; k < 60; k += 1) {
      const length = 22 + next(20);
      const history: CloseDay[] = [];
      for (let j = 0; j < length; j += 1) {
        const signals = j === length - 1 ? null : next(2);
        const spoil = k % 3 === 0 && j === length - 5 ? 1 : 0; // one non-parcel rejection or an open day
        history.push({
          d: WEEKDAYS[j]!,
          navMicro: 560_000_000n,
          liqNavMicro: 560_000_000n,
          openPositions: spoil === 1 && k % 2 === 0 ? 1n : 0n,
          signals,
          parcelOnlyRejections: signals === null ? 0 : spoil === 1 && k % 2 === 1 ? 0 : signals,
        });
      }
      const want = evaluateTerminal({ params, startD: WEEKDAYS[0]!, calendar: [], history });
      const got = judgeClose(params, history, length);
      expect(got === null ? null : `${got.kind}:${got.rule}`).toBe(
        want === null ? null : `${want.kind}:${want.rule}`,
      );
      seen.add(got === null ? "none" : got.rule);
    }
    for (const rule of ["target", "bust", "stall_floor", "stall_parcel", "timeout", "none"]) {
      expect(seen.has(rule), rule).toBe(true);
    }
  });
});

describe("replayCohorts on three synthetic years", () => {
  it("is byte-identical across two runs (digest) and runs cohorts to a terminal state or censors them", () => {
    const a = replayCohorts(world(), { params: p, ...small });
    const b = replayCohorts(world(), { params: p, ...small });
    expect(JSON.stringify(plain(a))).toBe(JSON.stringify(plain(b)));
    expect(replayDigest({ cohorts: a, stats: [] })).toBe(replayDigest({ cohorts: b, stats: [] }));
    expect(a.cohorts.length).toBeGreaterThan(0);
    // the last starts cannot finish: censored at the last session, with the sessions observed
    const lastIdx = SESSIONS - 1;
    for (const c of a.cohorts.filter((x) => x.censored)) {
      expect(c.endD).toBe(dates[lastIdx]);
      expect(c.sessions).toBe(lastIdx - c.startIdx + 1);
      expect(c.terminalKind).toBeNull();
    }
    for (const c of a.cohorts.filter((x) => !x.censored)) {
      expect(c.sessions).toBeLessThanOrEqual(130);
      expect(c.terminalRule).not.toBeNull();
    }
  });

  it("starts a full set on every step and names base and reality cohorts apart", () => {
    const r = replayCohorts(world(), { params: p, ...small });
    expect(r.step).toBe(25);
    expect(r.starts[1]).toBe(dates[26]);
    const perStart = r.cohorts.filter((c) => c.startD === r.starts[0]);
    // 12 E + 6 C2 + 6 C3 (one slot each) at the base leverage, 6 E-L + 6 C3 at the reality cap
    expect(perStart.filter((c) => c.group === "base").length).toBe(24);
    expect(perStart.filter((c) => c.group === "reality").length).toBe(12);
    expect(perStart.filter((c) => c.group === "reality").every((c) => c.id.endsWith("~L5"))).toBe(
      true,
    );
    const base = perStart.filter((c) => c.group === "base" && c.leverage !== null);
    expect(new Set(base.map((c) => c.leverage))).toEqual(new Set([10]));
    expect(new Set(perStart.filter((c) => c.group === "reality").map((c) => c.leverage))).toEqual(
      new Set([5]),
    );
    expect(perStart.filter((c) => c.variant === "U").every((c) => c.leverage === null)).toBe(true);
    expect(r.skippedC1).toBe(true);
    expect(r.cohorts.some((c) => c.kind === "C1")).toBe(false);
    expect(new Set(r.cohorts.map((c) => c.id)).size).toBe(r.cohorts.length);
  });

  it("effective N of every execution equals the M3 effectiveN on the same cohorts", () => {
    const r = replayCohorts(world(), { params: p, ...small });
    const asEffective = (c: CohortReplayResult["cohorts"][number]): EffectiveNCohort => ({
      id: c.id,
      executionId: c.executionId,
      startD: c.startD,
      terminalD: c.censored ? null : c.endD,
      terminalKind: c.terminalKind,
    });
    const base = r.cohorts.filter((c) => c.group === "base");
    const m3 = effectiveNByExecution(base.map(asEffective));
    let checked = 0;
    for (const [id, want] of m3) {
      const list = base.filter((c) => c.executionId === id);
      const fig = cohortFigure(id, list, {
        params: p,
        step: r.step,
        timeoutSessions: 130,
        intervals: false,
      });
      expect(fig.effectiveN, id).toBe(want.n);
      expect(fig.effectiveN).toBeLessThanOrEqual(fig.resolved);
      checked += 1;
    }
    expect(checked).toBe(24);
  });

  it("reports progress once per session, in order", () => {
    const seen: ReplayProgress[] = [];
    replayCohorts(world(), { params: p, ...small, progress: (x) => seen.push(x) });
    expect(seen.length).toBe(SESSIONS - 1);
    expect(seen.every((x, i) => x.session === i + 1 && x.total === SESSIONS - 1)).toBe(true);
    expect(seen[seen.length - 1]!.d).toBe(dates[SESSIONS - 1]);
    expect(seen[seen.length - 1]!.cohortsStarted).toBeGreaterThan(0);
  });

  it("looks at nothing after the session it decides: poisoned future bars change no earlier NAV", () => {
    const cut = 500;
    const trace = (w: ReturnType<typeof world>): CohortDayTrace[] => {
      const out: CohortDayTrace[] = [];
      replayCohorts(w, { params: p, ...small, trace: (e) => out.push(e) });
      return out.filter((e) => e.d <= dates[cut]!);
    };
    const clean = trace(world());
    const poisoned = trace(world({ poisonAfter: cut }));
    expect(poisoned.length).toBe(clean.length);
    expect(poisoned).toEqual(clean);
    expect(clean.length).toBeGreaterThan(1000);
    // and a replay that stops at the cut never asks for a later session's family inputs
    const guarded = world({ failInputsAfter: cut });
    expect(() => replayCohorts(guarded, { params: p, ...small, to: dates[cut] })).not.toThrow();
    expect(guarded.inputsCalls[guarded.inputsCalls.length - 1]).toBe(dates[cut]);
  });

  it("the control ETF C1 buys and holds when its code is set, and places no order otherwise", () => {
    const r = replayCohorts(world(), {
      params: p,
      ...small,
      c1EtfCode: "ZZA",
      executions: ["C1"],
      realityLeverage: null,
    });
    expect(r.skippedC1).toBe(false);
    const c1 = r.cohorts.filter((c) => c.kind === "C1");
    expect(c1.length).toBe(r.starts.length);
    expect(c1.every((c) => c.entries === 1 && c.exitsIs + c.exitsCs === 0)).toBe(true);
  });

  it("refuses a start outside the data, a zero step and a one-session source", () => {
    expect(() => replayCohorts(world(), { params: p, from: "2020-01-01" })).toThrow(RangeError);
    expect(() => replayCohorts(world(), { params: p, step: 0 })).toThrow(RangeError);
    const tiny = buildCohortWorld(
      dates.slice(0, 1),
      series.map((s) => ({ ...s, bars: s.bars.slice(0, 1) })),
      p,
    );
    expect(() => replayCohorts(tiny, { params: p })).toThrow(RangeError);
  });

  it("the full default-size replay (every step and control slot) fits the time budget", () => {
    const t0 = Date.now();
    const r = replayCohorts(world(), { params: p, cohortParams: () => terminalOverrides() });
    const seconds = (Date.now() - t0) / 1000;
    const starts = Math.ceil((SESSIONS - 2) / p.replay.rollingStartStep);
    const slots = p.replay.c2LivePerFamily;
    expect(r.starts.length).toBe(starts);
    // per start: 12 E + 6 x slots C2 + 6 x slots C3 (base) and 6 E-L + 6 x slots C3 (reality)
    expect(r.cohorts.length).toBe(starts * (12 + 6 * slots + 6 * slots + 6 + 6 * slots));
    // the replay itself (no database, no scorecards) stays inside the 60 s of the task
    expect(seconds).toBeLessThan(60);
  }, 180000);
});
