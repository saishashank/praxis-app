// @vitest-environment node
// M3 acceptance AT-10..AT-13 (spec 14 section 14.1; M3 T11). Each describe states the criterion and
// asserts it cheaply, reusing the existing suites. Where the heavy proof lives elsewhere (the
// TST-101 loader, the 3-year golden replay) the title names the covering test file.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExecutionRegistry,
  carriesSleeve,
  effectiveN,
  planInitialStart,
  resolveCohortParams,
  type EffectiveNCohort,
} from "@/lib/arena/cohort";
import { COST_PROFILES, feeFor } from "@/lib/arena/costs";
import { replaySessions } from "@/lib/arena/replay";
import { evaluateTerminal, type CloseDay } from "@/lib/arena/terminal";
import { sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import { cleanupTempDbs } from "../db/helpers";
import {
  MARKET,
  NOW,
  dumpTables,
  makeStrategy,
  paramOverridesFor,
  setupReplay,
  type FullSetup,
} from "./replayHarness";

afterEach(cleanupTempDbs);

const here = import.meta.dirname;
const read = (rel: string) => readFileSync(path.resolve(here, rel), "utf8");

describe("AT-10: all TST-101 cases pass exactly (loader: tests/arena/tst101.test.ts)", () => {
  const cases = JSON.parse(read("../fixtures/arena/tst101_public.json")) as { id: string }[];
  const loader = read("tst101.test.ts");

  it("the table has 43 unique cases, each wired to a handler, none deferred", () => {
    expect(cases).toHaveLength(43);
    expect(new Set(cases.map((c) => c.id)).size).toBe(43);
    expect(loader).toContain("expect(CASES).toHaveLength(43)"); // the loader asserts every case is handled
    expect(loader).toContain("const LATER: Record<string, string> = {};");
  });

  it("P5 brokerage on both sides of the first tier boundary (A$1,000.00 / 1,000.01)", () => {
    const p5 = COST_PROFILES.P5;
    expect(feeFor(p5, 1_000_000_000n, "buy", { code: "ZZA" })).toBe(5_000_000n);
    expect(feeFor(p5, 1_000_010_000n, "buy", { code: "ZZA" })).toBe(10_000_000n);
  });
});

describe("AT-11: 12 executions and controls C1-C3 start with A$600; terminal states; effective N", () => {
  const registry = buildExecutionRegistry();
  const starts = planInitialStart({
    registry,
    startD: "2026-10-14",
    paramsFor: () => resolveCohortParams(),
    masterSeed: 20_261_011n,
  });

  it("25 executions (12 E in 6 twin pairs, C1, C2-F1..F6, C3-F1..F6), 253 cohorts, all A$600", () => {
    expect(registry).toHaveLength(25);
    const e = registry.filter((x) => /^E\d\d$/.test(x.id));
    expect(e).toHaveLength(12);
    expect(new Set(e.map((x) => x.id.slice(1) && x.family)).size).toBe(6);
    expect(starts).toHaveLength(253);
    expect(starts.every((s) => s.seedMicro === 600_000_000n)).toBe(true);
    const sleeves = starts.filter((s) => s.sleeveJson !== null).length;
    expect(sleeves).toBe(
      starts.filter((s) => carriesSleeve(registry.find((x) => x.id === s.executionId)!)).length,
    );
  });

  it("golden paths reach every terminal state (detailed cases: tests/arena/terminal.test.ts)", () => {
    const start = "2026-01-05";
    const none: CalendarRow[] = [];
    const dates = sessionsBetween(start, "2028-12-31", none);
    const params = resolveCohortParams().terminal;
    const run = (liq: (i: number) => bigint, n: number) => {
      const history: CloseDay[] = [];
      for (let i = 0; i < n; i++) {
        const v = liq(i);
        history.push({
          d: dates[i],
          navMicro: v,
          liqNavMicro: v,
          openPositions: 0n,
          signals: 0,
          parcelOnlyRejections: 0,
        });
      }
      return evaluateTerminal({ params, startD: start, calendar: none, history });
    };
    const kind = (r: ReturnType<typeof run>) => r?.kind ?? "alive";
    expect(kind(run((i) => (i < 9 ? 600_000_000n : 1_200_000_000n), 10))).toBe("target");
    expect(kind(run((i) => (i < 9 ? 600_000_000n : 300_000_000n), 10))).toBe("bust");
    expect(kind(run(() => 505_000_000n, 5))).toBe("stalled");
    expect(kind(run(() => 600_000_000n, 252))).toBe("timeout");
    expect(kind(run(() => 600_000_000n, 20))).toBe("alive");
  });

  it("effective N counts each non-overlapping cohort once and matches the fixture value (3)", () => {
    const c = (id: string, s: string, t: string | null, k: EffectiveNCohort["terminalKind"]) =>
      ({ id, executionId: "E01", startD: s, terminalD: t, terminalKind: k }) as EffectiveNCohort;
    const r = effectiveN([
      c("a", "2026-01-05", "2026-02-10", "target"),
      c("b", "2026-02-12", "2026-03-20", "bust"),
      c("c", "2026-03-01", "2026-04-01", "timeout"),
      c("d", "2026-03-23", null, null),
      c("e", "2026-03-23", "2026-05-01", "stalled"),
    ]);
    expect(r.n).toBe(3);
  });
});

// A 60-session replay stands in for the 3-year one here; the full 780-session golden replay with
// its recorded digest is tests/arena/replay.test.ts ("AT-12 / AT-13: three-year golden replay").
async function shortReplay(): Promise<FullSetup & { statuses: string[] }> {
  const setup = await setupReplay({
    startD: "2030-01-07",
    sessions: 60,
    seed: 11,
    dividendAt: 20,
    gateFailEvery: 17,
  });
  const results = await replaySessions(setup.db, {
    market: MARKET,
    from: setup.ds.dates[0],
    to: setup.ds.dates[setup.ds.dates.length - 1],
    now: NOW,
    afterClose: makeStrategy(setup.db, setup.ds),
    restartParams: paramOverridesFor,
  });
  return { ...setup, statuses: results.map((r) => r.status) };
}

describe("AT-12 / AT-13: invariants and byte-identical replays", () => {
  it("AT-12: no invariant violation on any stored day, no error log (full run: replay.test.ts; property tests: ledgerProperty.test.ts)", async () => {
    const a = await shortReplay();
    expect(new Set(a.statuses)).toEqual(new Set(["success"]));
    const n = async (sql: string) => Number((await a.db.execute(sql)).rows[0].n);
    expect(await n("SELECT COUNT(*) AS n FROM nav_daily")).toBeGreaterThan(50);
    expect(await n("SELECT COUNT(*) AS n FROM nav_daily WHERE invariants_ok = 0")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM app_log WHERE level = 'error'")).toBe(0);
  }, 60_000);

  it("AT-13: two replays with identical inputs give byte-identical trade and NAV rows", async () => {
    const a = await dumpTables((await shortReplay()).db);
    const b = await dumpTables((await shortReplay()).db);
    expect(Object.keys(b)).toEqual(Object.keys(a));
    for (const t of Object.keys(a)) expect(b[t] === a[t], t).toBe(true);
    expect(a.fill.length).toBeGreaterThan(0);
    expect(a.nav_daily.length).toBeGreaterThan(0);
  }, 60_000);
});
