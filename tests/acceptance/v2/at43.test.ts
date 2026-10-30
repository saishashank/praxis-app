// @vitest-environment node
// AT-43 Sizing and cost gates (M14; docs/M14_design.md section 5; FAM-004, FAM-005, FAM-006, FAM-008,
// FAM-009, ARN-106, ARN-108; decisions D-214 to D-224). One synthetic night (ZZ codes, SEC-110), three
// clauses:
//   1  the skip reasons are logged: the stop-distance cap, the cost gate (four ADV buckets, an injected
//      table) and the second-position limits, through the real selectEntries and runFamilies;
//   2  no order breaks the cap, the gate or the limits: batch 2b on a migrated test database and the
//      cohort replay of the same night place the same orders; FAM-008, FAM-009 and the noPosition rule;
//   3  the time-stop comparator and the +-1 stability table exist for every family F1...F6 and a planted
//      fragile version carries the label.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { costGateKey, passesCostGate, roundTripCost } from "@/lib/agents/costGate";
import {
  ABSTAIN_SHOCK_REASON,
  COST_GATE_REASON,
  SECOND_POSITION_REASON,
  returnCorrelation,
  selectEntries,
  type EntryGateContext,
} from "@/lib/agents/entryGates";
import { withReferenceData } from "@/lib/agents/candidates";
import { loadDayCandidates, syncForwardLedger } from "@/lib/agents/forwardLedger";
import { loadCalendar } from "@/lib/arena/closeBooks";
import { runFamilies } from "@/lib/agents/families";
import { exceedsStopCap, STOP_DISTANCE_REASON } from "@/lib/agents/families/stopCap";
import type { CodeFacts, FamilyInputs } from "@/lib/agents/families/types";
import { parsePlan } from "@/lib/agents/orderPlan";
import { ENTRY_SKIP_REASONS } from "@/lib/agents/schema";
import { COST_PROFILES } from "@/lib/arena/costs";
import { MIN_MARKETABLE_PARCEL_MICRO } from "@/lib/arena/sizing";
import { bucketBpsFor } from "@/lib/arena/slippage";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { entriesAllowed, type EntryDecision } from "@/lib/data/quality/gate";
import { divFloor } from "@/lib/money/rational";
import { replayCohorts } from "@/lib/replay/cohortReplay";
import { FAMILY_ORDER } from "@/lib/agents/families/constants";
import { robustnessStage } from "@/lib/learning/robustnessStage";
import { seedRuleVersions } from "@/lib/learning/ruleVersions";
import { replayLedger } from "@/lib/replay/ledger";
import type { ReplayStatInput } from "@/lib/replay/scorecards";
import type { DevelopmentNet } from "@/lib/replay/sensitivity";
import type { ExitAblationStat, StabilityStat } from "@/lib/stats/robustnessTypes";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import {
  DATES,
  NO_TERMINAL,
  addAction,
  buildNight,
  freshReplayDb,
  MARKET,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "../../agents/batch2bHarness";
import { MASTER_SEED } from "../../arena/replayHarness";
import { inputsOf } from "../../fixtures/agents/families/builders";
import { buildCohortWorld, seriesFromHarness } from "../../fixtures/replay/cohortWorld";
import {
  addDevelopmentLineage,
  applyNightScenario,
  AT43_NIGHT,
  asFamily,
  BUCKET_LABELS,
  BUCKET_VOLUMES,
  distanceOf,
  exactStopCases,
  f4Candidate,
  injectedCostTable,
  NIGHT_SPECS,
  nightCloses,
  nightCostTable,
  type NightScenario,
  oversoldFacts,
  P,
  patternFacts,
  ROBUSTNESS_FROM,
  ROBUSTNESS_SESSIONS,
  robustnessWorld,
  SEED_BELOW_TWO_PARCELS,
  SEED_TWO_LEGS,
  SPREAD_FOR_15_PCT,
  SPREAD_FOR_8_PCT,
} from "../../fixtures/m14/at43World";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

// Clause 2: the live night reads its FAM-005 table from the signal ledger of the database; the night has
// no ledger rows, so the loader returns the injected table (the replay gets the same one as an option).
vi.mock("@/lib/agents/costGate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/agents/costGate")>();
  return {
    ...real,
    loadCostGateTable: async () =>
      real.costGateTable(
        Array.from({ length: 40 }, () => ({
          family: "F4" as const,
          ruleVersion: "F4.v1",
          variant: "F4",
          grossNum: 5n,
          grossDen: 100n,
        })),
      ),
  };
});

// Clause 3 plants its verdicts here: the absolute-gate result of the development net is the only thing
// replaced (the rows, the ledger replays, the neighbour grid and the labelling stay the real code).
//   AU:F1:F1.v1       base passes; the stop-ATR step down fails (a fragile version)
//   AU:F4:F4.v1       base passes and every neighbour passes (a robust version)
// Every other scope runs the real bootstrap on its (few) rows and fails the gate.
vi.mock("@/lib/replay/sensitivity", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/replay/sensitivity")>();
  const planted = (scope: string): DevelopmentNet | null => {
    const pass = (ok: boolean): DevelopmentNet => ({
      n: 120,
      blocks: 30,
      meanNet: ok ? 0.02 : -0.01,
      netLower90: ok ? 0.01 : -0.02,
      passesAbsoluteGate: ok,
    });
    if (scope.startsWith("AU:F1:F1.v1:")) return pass(!scope.endsWith(":f1_initial_stop_atr:down"));
    if (scope.startsWith("AU:F4:F4.v1:")) return pass(true);
    return null;
  };
  return {
    ...real,
    developmentNet: (...a: Parameters<typeof real.developmentNet>) =>
      planted(a[4]) ?? real.developmentNet(...a),
  };
});

const LOGGED = new Set<string>(ENTRY_SKIP_REASONS);

function gateCtx(facts: CodeFacts[], over: Partial<EntryGateContext> = {}): EntryGateContext {
  const m = new Map(facts.map((f) => [f.code, f] as const));
  return {
    entry: P.entry,
    advWindow: P.windows.adv,
    costProfile: COST_PROFILES.P5,
    factsOf: (code) => m.get(code),
    heldCodes: [],
    cashMicro: 10_000n * 1_000_000n,
    ...over,
  };
}

/** The 20-session average traded value, as `sizingEnvFor` computes it. */
const advOf = (f: CodeFacts): bigint => {
  const bars = f.rawBars.slice(-P.windows.adv);
  return divFloor(
    bars.reduce((s, b) => s + b.close * b.volume, 0n),
    BigInt(bars.length),
  );
};

// ------------------------------------------------------------------------------------------------
// Clause 1
// ------------------------------------------------------------------------------------------------

describe("AT-43 clause 1: skip reasons are logged (FAM-004, FAM-005, FAM-006)", () => {
  it("the logged words are the card vocabulary", () => {
    for (const r of [
      STOP_DISTANCE_REASON,
      COST_GATE_REASON,
      SECOND_POSITION_REASON,
      ABSTAIN_SHOCK_REASON,
    ]) {
      expect(LOGGED.has(r)).toBe(true);
    }
  });

  describe("FAM-004 stop distance (12 % cap; F5 keeps its own 20 % cap beneath it)", () => {
    const f08 = oversoldFacts("ZZS08", SPREAD_FOR_8_PCT);
    const f15 = oversoldFacts("ZZS15", SPREAD_FOR_15_PCT);

    it("runFamilies: an 8 % stop is a candidate, a 15 % stop is blocked as skipped_stop_distance", () => {
      const open = f4Candidate(f08);
      const wide = f4Candidate(f15);
      const d08 = distanceOf({ cand: open, refMicro: f08.bar.close });
      const d15 = distanceOf({ cand: wide, refMicro: f15.bar.close });
      expect(d08).toBeGreaterThan(0.075);
      expect(d08).toBeLessThan(0.085);
      expect(d15).toBeGreaterThan(0.145);
      expect(d15).toBeLessThan(0.155);

      const out = runFamilies(inputsOf([f08, f15]), P);
      const taken = out.candidates.filter((c) => c.family === "F4").map((c) => c.code);
      const blocked = out.blocked.filter((c) => c.family === "F4");
      expect(taken).toEqual(["ZZS08"]);
      expect(blocked.map((c) => [c.code, c.reasons])).toEqual([["ZZS15", [STOP_DISTANCE_REASON]]]);
    });

    it("exact stops: 12 % passes, 12.0001 % and an F5 at 15 % under its 20 % cap are over the 12 % cap", () => {
      const cases = exactStopCases(f4Candidate(f08));
      const verdicts = cases.map((c) => [
        c.code,
        exceedsStopCap(c.cand, c.refMicro, P.entry.maxStopDistance),
      ]);
      expect(verdicts).toEqual([
        ["ZZS12", false],
        ["ZZS12X", true],
        ["ZZF5", true],
      ]);
      expect(distanceOf(cases[0]!)).toBe(0.12);
      expect(distanceOf(cases[2]!)).toBeCloseTo(0.15, 12);
      // F5's own 20 % cap alone would have let ZZF5 through
      expect(distanceOf(cases[2]!)).toBeLessThan(0.2);
    });
  });

  describe("FAM-005 cost gate with an injected table", () => {
    const template = f4Candidate(oversoldFacts("ZZS08", SPREAD_FOR_8_PCT));
    const table = injectedCostTable();
    const buckets = BUCKET_VOLUMES.map((v, i) =>
      patternFacts(`ZZB${i + 1}`, `Industry ${i + 1}`, 1, 0, v),
    );

    it("the four codes sit in the four ADV buckets and cost 1.87 %, 2.17 %, 2.87 % and 4.07 % round trip", () => {
      const bps = buckets.map((f) => Number(bucketBpsFor(advOf(f)).num));
      expect(bps).toEqual([10, 25, 60, 120]);
      const cost = buckets.map((f) => {
        const r = roundTripCost(COST_PROFILES.P5, advOf(f));
        return Math.round((Number(r.num) / Number(r.den)) * 10_000) / 100;
      });
      expect(cost).toEqual([1.87, 2.17, 2.87, 4.07]);
      expect(BUCKET_LABELS).toHaveLength(4);
    });

    it("gross 3 % against k = 2 times the cost is skipped_cost_gate in every bucket", () => {
      const f4 = table.get(costGateKey("F4", "F4.v1", "F4"))!;
      expect(f4.rows).toBe(40);
      for (const f of buckets) {
        const c = asFamily(template, f.code, "F4");
        const r = selectEntries([c], gateCtx([f], { costTable: table }));
        expect(r.eligible, f.code).toEqual([]);
        expect(r.skipped.get(c), f.code).toBe(COST_GATE_REASON);
      }
    });

    it("gross 5 % passes while it is at least twice the bucket cost (the two liquid buckets), not below it", () => {
      const out = buckets.map((f) => {
        const c = asFamily(template, f.code, "F1");
        const r = selectEntries([c], gateCtx([f], { costTable: table }));
        return r.skipped.get(c) ?? "taken";
      });
      // 5 % >= 2 x 1.87 % and 2 x 2.17 %; 5 % < 2 x 2.87 % and 2 x 4.07 %
      expect(out).toEqual(["taken", "taken", COST_GATE_REASON, COST_GATE_REASON]);
    });

    it("20 rows is cost_gate_unmeasured: the signal passes and the card flag says so", () => {
      expect(table.get(costGateKey("F2", "F2.v1", "F2"))).toEqual({ rows: 20, median: null });
      for (const f of buckets) {
        const c = asFamily(template, f.code, "F2");
        const r = selectEntries([c], gateCtx([f], { costTable: table }));
        expect(r.eligible, f.code).toEqual([c]);
        expect(r.flags.get(c), f.code).toContain("cost_gate_unmeasured");
      }
    });
  });

  describe("FAM-006 second position", () => {
    const template = f4Candidate(oversoldFacts("ZZS08", SPREAD_FOR_8_PCT));
    const a1 = patternFacts("ZZA1", "Banks", 1, 0, 700_000n);
    const a2 = patternFacts("ZZA2", "Banks", 0, 1, 700_000n);
    const m = patternFacts("ZZM", "Materials", 0.8, 0.6, 700_000n);
    const e = patternFacts("ZZE", "Energy", 0.4, Math.sqrt(1 - 0.16), 700_000n);
    const [ca1, ca2, cm, ce] = [a1, a2, m, e].map((f) => asFamily(template, f.code, "F4")) as [
      ReturnType<typeof asFamily>,
      ReturnType<typeof asFamily>,
      ReturnType<typeof asFamily>,
      ReturnType<typeof asFamily>,
    ];

    it("the fixture correlations are 0.8 and 0.4 against the first leg", () => {
      expect(returnCorrelation(m.closesAdj, a1.closesAdj, 60)!).toBeCloseTo(0.8, 2);
      expect(returnCorrelation(e.closesAdj, a1.closesAdj, 60)!).toBeCloseTo(0.4, 2);
      expect(Math.abs(returnCorrelation(a2.closesAdj, a1.closesAdj, 60)!)).toBeLessThan(0.05);
    });

    it("same industry -> second_position; correlation 0.8 -> second_position; correlation 0.4 -> taken", () => {
      const r = selectEntries([ca1, ca2, cm, ce], gateCtx([a1, a2, m, e]));
      expect(r.eligible.map((c) => c.code)).toEqual(["ZZA1", "ZZE"]);
      expect([...r.skipped].map(([c, why]) => [c.code, why])).toEqual([
        ["ZZA2", SECOND_POSITION_REASON],
        ["ZZM", SECOND_POSITION_REASON],
      ]);
    });

    it("the limit is on the held position too: a code held in Banks blocks a Banks candidate", () => {
      const r = selectEntries([ca2], gateCtx([a1, a2], { heldCodes: ["ZZA1"] }));
      expect(r.skipped.get(ca2)).toBe(SECOND_POSITION_REASON);
    });
  });

  describe("FAM-009 SHOCK half size", () => {
    const template = f4Candidate(oversoldFacts("ZZS08", SPREAD_FOR_8_PCT));
    const f = patternFacts("ZZH", "Banks", 1, 0, 700_000n);
    const half = asFamily(template, "ZZH", "F4", { halfSize: true });

    it("cash below two parcels abstains (abstain_shock), at two parcels the half-size entry goes on", () => {
      const poor = selectEntries(
        [half],
        gateCtx([f], { cashMicro: 2n * MIN_MARKETABLE_PARCEL_MICRO - 1n }),
      );
      expect(poor.eligible).toEqual([]);
      expect(poor.skipped.get(half)).toBe(ABSTAIN_SHOCK_REASON);
      const rich = selectEntries(
        [half],
        gateCtx([f], { cashMicro: 2n * MIN_MARKETABLE_PARCEL_MICRO }),
      );
      expect(rich.eligible).toEqual([half]);
    });
  });
});

// ------------------------------------------------------------------------------------------------
// Clause 3: time-stop comparator and the +-1 stability table for every family
// ------------------------------------------------------------------------------------------------

describe("AT-43 clause 3: exit ablation and +-1 stability for F1 to F6 (ARN-106, ARN-108)", () => {
  let db: Client;
  let stats: ReplayStatInput[];

  beforeAll(async () => {
    db = await freshDb("main");
    await seedRuleVersions(db, { market: "AU", d: "2026-10-01" });
    for (const family of FAMILY_ORDER)
      await addDevelopmentLineage(db, family, ROBUSTNESS_SESSIONS.at(-1)!);
    const world = robustnessWorld();
    const outputs = new Map();
    const ledger = replayLedger(world, {
      params: P,
      from: ROBUSTNESS_SESSIONS[ROBUSTNESS_FROM]!,
      controls: false,
      outputSink: outputs,
    });
    const out = await robustnessStage({
      db,
      market: "AU",
      d: "2026-10-17",
      params: P,
      runId: "at43",
      world,
      ledger,
      facts: new Map(),
      calendar: [],
      familyOutputs: outputs,
    } as never);
    stats = [...out.stats];
  }, 600_000);
  afterAll(cleanupTempDbs);

  const of = (metric: string): ReplayStatInput[] => stats.filter((s) => s.metric === metric);

  it("every family has a lineage split and none is skipped", () => {
    const skipped = of("robustness")[0]!.value as { skipped: unknown[] };
    expect(skipped.skipped).toEqual([]);
  });

  it("an exit_ablation row exists for F1...F6, scoped to the incumbent rule version", () => {
    const rows = of("exit_ablation");
    expect(rows.map((r) => r.scope)).toEqual(FAMILY_ORDER.map((f) => `AU:${f}:${f}.v1`));
    for (const r of rows) {
      const v = r.value as ExitAblationStat;
      expect(v.rule.n).toBe(v.time_stop_only.n); // the comparator is paired entry by entry
    }
  });

  it("F1 has development rows and the stop changes the outcome against the time-stop-only exit", () => {
    const f1 = of("exit_ablation").find((r) => r.scope === "AU:F1:F1.v1")!
      .value as ExitAblationStat;
    expect(f1.rule.n).toBeGreaterThan(0);
    expect(f1.rule.mean_net).not.toBeNull();
    expect(f1.time_stop_only.mean_net).not.toBeNull();
    expect(f1.rule.mean_net).not.toBe(f1.time_stop_only.mean_net);
    expect(f1.rule.mean_sessions_held).not.toBe(f1.time_stop_only.mean_sessions_held);
  });

  it("a stability row exists for F1...F6 with the generator's -1 and +1 steps of the numeric keys", () => {
    const rows = of("stability");
    expect(rows.map((r) => r.scope)).toEqual(FAMILY_ORDER.map((f) => `AU:${f}:${f}.v1`));
    for (const r of rows) {
      const v = r.value as StabilityStat;
      expect(v.neighbours.length, r.scope).toBeGreaterThanOrEqual(2);
      const directions = new Set(v.neighbours.map((n) => n.direction));
      expect([...directions].sort(), r.scope).toEqual(["down", "up"]);
    }
  });

  it("the planted version F1.v1 (base passes, the stop-ATR step down fails) carries the fragile label; the robust F4 and the failing rest do not", () => {
    const byScope = new Map(of("stability").map((r) => [r.scope, r.value as StabilityStat]));
    const f1 = byScope.get("AU:F1:F1.v1")!;
    expect(f1.passes_absolute_gate).toBe(true);
    expect(f1.fragile).toBe(true);
    expect(
      f1.neighbours.filter((n) => !n.passes_absolute_gate).map((n) => `${n.key}:${n.direction}`),
    ).toEqual(["f1_initial_stop_atr:down"]);
    const f4 = byScope.get("AU:F4:F4.v1")!;
    expect(f4.passes_absolute_gate).toBe(true);
    expect(f4.neighbours.every((n) => n.passes_absolute_gate)).toBe(true);
    expect(f4.fragile).toBe(false);
    for (const family of ["F2", "F3", "F5", "F6"]) {
      const v = byScope.get(`AU:${family}:${family}.v1`)!;
      expect(v.passes_absolute_gate, family).toBe(false);
      expect(v.fragile, family).toBe(false);
    }
  });
});

// ------------------------------------------------------------------------------------------------
// Clause 2: no order breaks the cap, the gate or the limits (batch 2b live = cohort replay)
// ------------------------------------------------------------------------------------------------

const NIGHT_D = DATES[AT43_NIGHT]!;
const LAST = AT43_NIGHT + 3; // fills at +1, a CS exit at +2, one more session
const live = testParams();
const industryOf = new Map(NIGHT_SPECS.map((s) => [s.code, s.industry]));
const specOf = new Map(NIGHT_SPECS.map((s) => [s.code, s]));
const closesOf = new Map(NIGHT_SPECS.map((s) => [s.code, nightCloses(s)]));

type Row = Record<string, unknown>;
const rowsOf = async (db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

type LiveNight = { db: Client; cohortId: string; seed: bigint; scn: NightScenario };

async function liveNight(scn: NightScenario, seed: bigint = SEED_TWO_LEGS): Promise<LiveNight> {
  const db = await freshReplayDb();
  await buildNight(db, {
    codes: NIGHT_SPECS.map((s) => ({
      code: s.code,
      close: (i: number) => closesOf.get(s.code)![i]!,
      volume: () => s.volume,
    })),
  });
  await applyNightScenario(db, DATES, scn);
  await setMode(db, "full");
  const [cohortId] = await startCohortsAt(db, AT43_NIGHT - 5, ["E07"], { seedMicro: seed });
  if (scn.delisting !== undefined) {
    await addAction(db, scn.delisting.code, "delisting", scn.delisting.exIndex, {});
  }
  const run = await runNights(db, live, AT43_NIGHT - 5, LAST);
  for (const [, r] of run.signals) expect(r.status).toBe("success");
  return { db, cohortId: cohortId!, seed, scn };
}

type DayPositions = Map<string, string>;

/** Stored positions of the cohort per session, as `code:qty:close:value:haircut` joined by `;`. */
async function storedPositions(n: LiveNight): Promise<DayPositions> {
  const out: DayPositions = new Map();
  const nav = await rowsOf(n.db, "SELECT d FROM nav_daily WHERE cohort_id = ? ORDER BY d", [
    n.cohortId,
  ]);
  const pos = await rowsOf(
    n.db,
    "SELECT d, code, qty, close_micro, value_micro, haircut FROM nav_daily_pos WHERE cohort_id = ? ORDER BY d, code",
    [n.cohortId],
  );
  for (const r of nav) out.set(String(r.d), "");
  for (const p of pos) {
    const d = String(p.d);
    const cur = out.get(d) ?? "";
    out.set(
      d,
      `${cur}${cur === "" ? "" : ";"}${p.code}:${p.qty}:${p.close_micro}:${p.value_micro}:${p.haircut}`,
    );
  }
  return out;
}

/** The same night through the in-memory cohort replay; returns its positions per session. */
async function replayNight(n: LiveNight) {
  const gates = new Map<string, EntryDecision>();
  for (let i = AT43_NIGHT - 5; i <= LAST; i += 1) {
    for (const s of NIGHT_SPECS) {
      gates.set(`${s.code}|${DATES[i]}`, await entriesAllowed(n.db, s.code, DATES[i]!));
    }
  }
  const halted = new Set<string>();
  for (const r of await rowsOf(n.db, "SELECT code, d FROM universe_snapshot WHERE halted = 1")) {
    halted.add(`${r.code}|${r.d}`);
  }
  const series = await seriesFromHarness(
    n.db,
    DATES,
    Object.fromEntries(NIGHT_SPECS.map((s) => [s.code, { tier: "U1" as const }])),
  );
  const records: CorpActionRecord[] =
    n.scn.delisting === undefined
      ? []
      : [
          {
            id: "1",
            code: n.scn.delisting.code,
            type: "delisting",
            exDate: DATES[n.scn.delisting.exIndex]!,
            payload: {},
          },
        ];
  const world = buildCohortWorld(DATES, series, live, {
    actions: records,
    halted: (code, d) => (halted.has(`${code}|${d}`) ? true : null),
    qualityGate: (code, d) => gates.get(`${code}|${d}`)!,
  });
  // FAM-006 industry (the live night reads instrument.industry) and the regime the live night stored
  // (SHOCK on the shock night and, with its exit hysteresis, on the nights after)
  const regimeOf = new Map(
    (await rowsOf(n.db, "SELECT d, state FROM regime_daily")).map(
      (r) => [String(r.d), String(r.state)] as const,
    ),
  ) as Map<string, FamilyInputs["regime"]>;
  const source = {
    ...world,
    familyInputs: (d: string) => {
      const inputs = world.familyInputs(d);
      return {
        ...inputs,
        regime: regimeOf.get(d) ?? inputs.regime,
        codes: inputs.codes.map((f) => withReferenceData(f, industryOf.get(f.code), undefined)),
      };
    },
  };
  const positions: DayPositions = new Map();
  const result = replayCohorts(source, {
    params: live,
    from: DATES[AT43_NIGHT - 5],
    to: DATES[LAST],
    step: 1000,
    masterSeed: MASTER_SEED,
    controlsPerFamily: 1,
    executions: ["E07"],
    realityLeverage: null,
    cohortParams: () => ({ ...NO_TERMINAL, seedMicro: n.seed, costProfile: "P5" }),
    costGate: nightCostTable(),
    trace: (e) =>
      positions.set(
        e.d,
        e.positions
          .map((p) => `${p.code}:${p.qty}:${p.closeMicro}:${p.valueMicro}:${p.haircut}`)
          .join(";"),
      ),
  });
  return { result, positions };
}

/** Entry orders decided on a night. */
async function entryOrders(n: LiveNight, decidedD = NIGHT_D) {
  return rowsOf(
    n.db,
    `SELECT id, code, qty, status, reject_reason, stop_spec, signal_id FROM arena_order
     WHERE cohort_id = ? AND kind = 'entry' AND decided_d = ? ORDER BY code`,
    [n.cohortId, decidedD],
  );
}

const cardsOf = async (n: LiveNight, d = NIGHT_D): Promise<Map<string, string>> =>
  new Map(
    (
      await rowsOf(
        n.db,
        `SELECT s.code, c.taken, c.not_taken_reason FROM decision_card c JOIN signal s ON s.id = c.signal_id
         WHERE s.d = ? AND c.execution_id = 'E07'`,
        [d],
      )
    ).map((r) => [String(r.code), Number(r.taken) === 1 ? "taken" : String(r.not_taken_reason)]),
  );

/** ADV (micro) of a night code on session `i`: the same 20-session average the engine uses. */
function advAt(code: string, i: number): bigint {
  const closes = closesOf.get(code)!;
  const volume = specOf.get(code)!.volume;
  let sum = 0n;
  for (let j = i - 19; j <= i; j += 1) sum += closes[j]! * volume;
  return sum / 20n;
}

/** The scan: no entry order over the stop cap, under the cost gate, or in a forbidden pair. */
function scanOrders(orders: readonly Row[], decidedIndex: number): void {
  const median = nightCostTable().get(costGateKey("F4", "F4.v1", "F4"))!.median!;
  const codes = orders.map((o) => String(o.code));
  for (const o of orders) {
    const code = String(o.code);
    // FAM-004: the initial stop of the stored plan against the D close
    const plan = parsePlan(String(o.stop_spec));
    const ref = closesOf.get(code)![decidedIndex]!;
    expect(
      exceedsStopCap({ stopSpec: plan.plan.initialStops[0]!.spec }, ref, P.entry.maxStopDistance),
      `${code} stop distance`,
    ).toBe(false);
    // FAM-005: median gross >= k x round-trip cost of the code's ADV bucket
    const cost = roundTripCost(COST_PROFILES.P5, advAt(code, decidedIndex));
    expect(passesCostGate(median, cost, P.entry.costGateK), `${code} cost gate`).toBe(true);
  }
  // FAM-006: pairs of the same night differ in industry and stay at or under the correlation limit
  for (let i = 0; i < codes.length; i += 1) {
    for (let j = i + 1; j < codes.length; j += 1) {
      const a = codes[i]!;
      const b = codes[j]!;
      expect(industryOf.get(a), `${a}/${b} industry`).not.toBe(industryOf.get(b));
      const corr = returnCorrelation(
        closesOf.get(a)!.slice(0, decidedIndex + 1),
        closesOf.get(b)!.slice(0, decidedIndex + 1),
        P.entry.secondPositionCorrSessions,
      );
      expect(corr!, `${a}/${b} correlation`).toBeLessThanOrEqual(P.entry.secondPositionMaxCorr);
    }
  }
}

function expectParity(stored: DayPositions, replayed: DayPositions): void {
  expect(replayed.size).toBe(LAST - (AT43_NIGHT - 5) + 1);
  for (const [d, pos] of replayed) expect(stored.get(d), d).toBe(pos);
}

const heldOn = (p: DayPositions, i: number): string[] =>
  (p.get(DATES[i]!) ?? "")
    .split(";")
    .filter((x) => x !== "")
    .map((x) => x.split(":")[0]!);

describe("AT-43 clause 2: batch 2b live and the cohort replay place the same orders, none breaks a gate", () => {
  it("the base night: Q1 and Q4 are bought; the skip reasons are on the cards; live = replay", async () => {
    const n = await liveNight({});
    expect(await cardsOf(n)).toEqual(
      new Map([
        ["ZZQ1", "taken"],
        ["ZZQ2", SECOND_POSITION_REASON],
        ["ZZQ3", SECOND_POSITION_REASON],
        ["ZZQ4", "taken"],
        ["ZZQ5", COST_GATE_REASON],
      ]),
    );
    const orders = await entryOrders(n);
    expect(orders.map((o) => `${o.code}:${o.status}`)).toEqual(["ZZQ1:filled", "ZZQ4:filled"]);
    scanOrders(orders, AT43_NIGHT);
    // ZZQ6 (a 13 % stop) is blocked inside runFamilies: no signal, no card, no order, no position
    expect(await rowsOf(n.db, "SELECT 1 FROM signal WHERE code = 'ZZQ6'")).toEqual([]);
    expect(await rowsOf(n.db, "SELECT 1 FROM arena_order WHERE code = 'ZZQ6'")).toEqual([]);
    // ...but the block is logged: batch 3's ledger sync stores the night's candidates and blocked
    // candidates (D-253: no card for a blocked candidate), read back with the production reader
    await syncForwardLedger(n.db, {
      market: MARKET,
      d: NIGHT_D,
      calendar: await loadCalendar(n.db, MARKET),
      hours: { tz: "Australia/Melbourne", open_time: "10:00", close_time: "16:00" },
      params: live,
      replay: true,
      masterSeed: MASTER_SEED,
      maxCatchUp: 0, // tonight only
    });
    const day = (await loadDayCandidates(n.db, MARKET, [NIGHT_D])).get(NIGHT_D)!;
    expect(day.blocked.filter((b) => b.code === "ZZQ6").map((b) => [b.family, b.reasons])).toEqual([
      ["F4", [STOP_DISTANCE_REASON]],
    ]);
    expect(day.candidates.map((c) => c.code)).not.toContain("ZZQ6");

    const stored = await storedPositions(n);
    const { result, positions } = await replayNight(n);
    expectParity(stored, positions);
    expect(heldOn(positions, AT43_NIGHT + 1)).toEqual(["ZZQ1", "ZZQ4"]);
    expect(result.cohorts[0]!.entries).toBe(2);
    // the replayed quantities are the live orders' quantities
    const qty = new Map(
      (positions.get(DATES[AT43_NIGHT + 1]!) ?? "")
        .split(";")
        .map((p) => [p.split(":")[0]!, p.split(":")[1]!] as const),
    );
    for (const o of orders) expect(qty.get(String(o.code))).toBe(String(o.qty));
  });

  it("FAM-008: an entry order lives for one open; ZZQ4 is halted at the fill, its order is cancelled and never resubmitted", async () => {
    const n = await liveNight({ halt: { code: "ZZQ4", from: AT43_NIGHT + 1 } });
    const orders = await entryOrders(n);
    expect(orders.map((o) => [o.code, o.status, o.reject_reason])).toEqual([
      ["ZZQ1", "filled", null],
      ["ZZQ4", "cancelled", "no_bar"],
    ]);
    const all = await rowsOf(
      n.db,
      "SELECT id, status, decided_d FROM arena_order WHERE cohort_id = ? AND kind = 'entry' AND code = 'ZZQ4'",
      [n.cohortId],
    );
    expect(all).toHaveLength(1); // one order, one open, no second order on any later night
    expect(
      await rowsOf(n.db, "SELECT 1 FROM fill WHERE order_id = ?", [String(orders[1]!.id)]),
    ).toEqual([]);
    const stored = await storedPositions(n);
    const { positions } = await replayNight(n);
    expectParity(stored, positions);
    expect(heldOn(positions, AT43_NIGHT + 1)).toEqual(["ZZQ1"]);
    expect(heldOn(positions, LAST)).not.toContain("ZZQ4");
  });

  it("FAM-009: in SHOCK a half-size entry with cash below two parcels is abstain_shock, in live and in replay", async () => {
    const n = await liveNight({ shock: true }, SEED_BELOW_TWO_PARCELS);
    const regime = await rowsOf(n.db, "SELECT state FROM regime_daily WHERE d = ?", [NIGHT_D]);
    expect(regime).toEqual([{ state: "SHOCK" }]);
    const cards = await cardsOf(n);
    // the abstaining codes are not first legs either, so no second_position is logged
    expect(Object.fromEntries(cards)).toEqual({
      ZZQ1: ABSTAIN_SHOCK_REASON,
      ZZQ2: ABSTAIN_SHOCK_REASON,
      ZZQ3: ABSTAIN_SHOCK_REASON,
      ZZQ4: ABSTAIN_SHOCK_REASON,
      ZZQ5: COST_GATE_REASON, // the cost gate comes first
    });
    expect(await entryOrders(n)).toEqual([]);
    const stored = await storedPositions(n);
    const { result, positions } = await replayNight(n);
    expectParity(stored, positions);
    expect(result.cohorts[0]!.entries).toBe(0);
    expect(heldOn(positions, LAST)).toEqual([]);
  });

  it("FAM-009: the same SHOCK night with two parcels of cash buys at half size, identically in live and replay", async () => {
    const n = await liveNight({ shock: true }, SEED_TWO_LEGS);
    const orders = await entryOrders(n);
    expect(orders.length).toBeGreaterThan(0);
    scanOrders(orders, AT43_NIGHT);
    const stored = await storedPositions(n);
    const { positions } = await replayNight(n);
    expectParity(stored, positions);
    expect(heldOn(positions, AT43_NIGHT + 1)).toEqual(orders.map((o) => String(o.code)));
  });

  it("noPosition: a disposal across the next session on the first-ranked code is not the first leg (live and replay)", async () => {
    const n = await liveNight({ delisting: { code: "ZZQ1", exIndex: AT43_NIGHT + 1 } });
    const cards = await cardsOf(n);
    // ZZQ1 cannot open across a delisting, so it is not the first leg: its Banks twin ZZQ2 is taken
    // (in the base night ZZQ2 is second_position), and the later codes are measured against ZZQ2
    expect(Object.fromEntries(cards)).toEqual({
      ZZQ1: "corporate_action",
      ZZQ2: "taken",
      ZZQ3: SECOND_POSITION_REASON,
      ZZQ4: SECOND_POSITION_REASON,
      ZZQ5: COST_GATE_REASON,
    });
    const orders = await entryOrders(n);
    expect(orders.map((o) => o.code)).toContain("ZZQ2");
    expect(orders.map((o) => o.code)).not.toContain("ZZQ1");
    scanOrders(orders, AT43_NIGHT);
    const stored = await storedPositions(n);
    const { positions } = await replayNight(n);
    expectParity(stored, positions);
    expect(heldOn(positions, AT43_NIGHT + 1)).toEqual(orders.map((o) => String(o.code)));
  });
});
