// @vitest-environment node
// The learning loop feeds the Cortex (integration, design C.1, C.5, B.4, C.13 steps 4-8; D-923, D-924,
// D-927, D-928): the weekly stage writes generation 0 and later generations (embargoed, charged, logged,
// a re-run writes nothing); the nightly stage matures the d-21 duel, runs the checkpoint, writes a
// capped learner row in force from the next session, honours the Owner kill; reads stay within C.10
// (LRN-AT-10: <= 15,000 rows on a checkpoint night). Synthetic ZZ data only.
import type { Client, InStatement } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { angleById } from "@/lib/cortex/angles/registry";
import { isCheckpointNight } from "@/lib/cortex/learn/checkpoint";
import { learnConfig } from "@/lib/cortex/learn/config";
import {
  embargoFittedAt,
  generationZero,
  learnerRuleVersion,
  nightlyRow,
} from "@/lib/cortex/learn/learner";
import { cleanWords } from "@/lib/cortex/learn/learnWords";
import { cortexLearnNight } from "@/lib/cortex/learn/stage";
import {
  compareRowsSince,
  eventsSince,
  insertAngleDays,
  insertLeader,
  leaderMap,
} from "@/lib/cortex/learn/store";
import type { AngleDayRow } from "@/lib/cortex/learn/types";
import {
  BASE_FIT_OFFSET_MS,
  cortexLearnWeekly,
  cortexLearnWeeklyRun,
  cortexWeeklyStage,
} from "@/lib/cortex/learn/weekly";
import { weightsHash } from "@/lib/cortex/score/map";
import {
  insertDecision,
  insertMap,
  insertPassport,
  latestMaps,
  type MapParams,
  type MapRow,
} from "@/lib/cortex/store";
import type { MoverExplanation } from "@/lib/learning/daily";
import type { World } from "@/lib/learning/dailyLoad";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { BACK21, bars, codes, D, AFTER, featureNight, PREV, weekdays } from "./zzLearn";

afterEach(cleanupTempDbs);

const M = "AU";
const NOW = "2026-11-10T09:30:00.000Z";
const ANGLES = ["A-D1-02", "A-D2-01"];
const CLUSTERS = [...new Set(ANGLES.map((a) => String(angleById(a)!.cluster)))].sort();
const CONFIG = learnConfig({ replicates: 200 }, { relaxed: true });

const FIXED: MapRow = {
  market: M,
  family: "F1",
  ruleVersion: "F1.zz.1",
  fittedAt: "2026-01-01T00:00:00.000Z",
  params: {
    a: 1,
    b: 0,
    s_mean: 0,
    s_sd: 1,
    K: CLUSTERS.length,
    clusters: CLUSTERS,
    angles: ANGLES,
    tiers: ["U1"],
    family_mean_net: 0.01,
    top3_min_s: -1,
  } as unknown as MapParams,
  activeSetHash: "zzhash",
  nEff: 250,
  pool: "zz",
  fitSplit: "development",
};

async function seedRule(db: Client, split = true): Promise<void> {
  await insertMap(db, FIXED);
  for (const id of ANGLES) {
    await insertPassport(db, {
      market: M,
      angleId: id,
      version: 1,
      domain: Number(id.slice(3, 4)),
      cluster: angleById(id)!.cluster as never,
      orientation: 1,
      kind: "score",
      inputs: ["bar_au"],
      historyFields: {},
      status: "active",
      horizonSessions: 20,
      evidence: { dev_ic: 0.02 },
      measured: null,
      frozenAt: "2026-01-01T00:00:00Z",
    });
  }
  if (!split) return;
  await db.execute(
    "INSERT INTO lineage (id, created_d, parent) VALUES ('AU:F1', '2026-01-01', NULL)",
  );
  await db.execute(`INSERT INTO lineage_split (lineage_id, version, block_sessions, holdout_len,
      validation_len, purge, data_end_d, deferred_until_d, reason)
      VALUES ('AU:F1', 1, 20, 60, 60, 5, '2026-01-01', '2027-01-01', 'create')`);
}

const count = async (db: Client, sql: string): Promise<number> =>
  Number((await db.execute(sql)).rows[0]!.n);

const dayRow = (d: string, angleId: string, horizon: 1 | 20, ic: number): AngleDayRow => ({
  market: M,
  d,
  angleId,
  angleVersion: 1,
  horizon,
  featureD: "2026-01-01",
  n: 39,
  ic,
  topExcessPpm: null,
  bottomExcessPpm: null,
  basePpm: null,
  regime: "RISK-ON",
  resultsSeason: 0,
  psiPpm: 0,
  excludedNews: 0,
  activeSetHash: "zzhash",
  manifestId: "zzmanifest",
});

/** Deterministic small noise in [-0.02, 0.02]. */
const wobble = (i: number): number => (((i * 7919) % 41) - 20) / 1000;

describe("weekly stage 'cortex'", () => {
  it("first run writes generation 0 of F1.learn: embargoed, charged before, logged; a re-run is a no-op", async () => {
    const db = await freshDb("main");
    await seedRule(db);
    const r = await cortexLearnWeekly(db, {
      market: M,
      d: "2026-11-14", // Saturday
      calendar: [],
      now: NOW,
      config: CONFIG,
      hooks: {},
    });
    expect(r).toEqual([
      expect.objectContaining({
        family: "F1",
        action: "generation_zero",
        generation: 0,
        lastSession: "2026-11-13",
        charged: true,
      }),
    ]);
    // one-session embargo: not in force on Friday, in force on Monday
    expect((await latestMaps(db, M, "2026-11-13")).map((m) => m.ruleVersion)).toEqual(["F1.zz.1"]);
    const mon = await latestMaps(db, M, "2026-11-16");
    const learner = mon.find((m) => m.ruleVersion === "F1.learn")!;
    const p = learner.params as unknown as Record<string, unknown>;
    const w = {
      angle: { "A-D1-02": 1, "A-D2-01": 1 },
      cluster: Object.fromEntries(CLUSTERS.map((c) => [c, 1])),
    };
    expect(p).toMatchObject({ learner: true, based_on: "F1.zz.1", generation: 0, weights: w });
    expect(p.weights_hash).toBe(weightsHash(w));
    expect(p.angles).toEqual(ANGLES);
    expect(learner.activeSetHash).toBe(FIXED.activeSetHash);
    const trials = await db.execute("SELECT id, kind, rule_version, d FROM trial_ledger");
    expect(trials.rows.map((x) => [x.id, x.kind, x.rule_version, x.d])).toEqual([
      ["cortex-learn:AU:F1.learn:0", "challenger", "cortex:F1.learn@0", "2026-11-13"],
    ]);
    const ev = await eventsSince(db, M, "2026-11-13");
    expect(ev.map((e) => [e.kind, e.seq, e.generation])).toEqual([["reweight", 100, 0]]);
    expect(cleanWords(ev[0]!.words)).toBe(true);
    // the same week again: nothing new
    await cortexLearnWeekly(db, {
      market: M,
      d: "2026-11-14",
      calendar: [],
      now: NOW,
      config: CONFIG,
      hooks: {},
    });
    expect(await count(db, "SELECT COUNT(*) AS n FROM cortex_map")).toBe(2);
    expect(await count(db, "SELECT COUNT(*) AS n FROM trial_ledger")).toBe(1);
    expect(await count(db, "SELECT COUNT(*) AS n FROM cortex_learn_event")).toBe(1);
  });

  it("without a fixed F1 rule it does nothing; without a split the generation is written uncharged", async () => {
    const empty = await freshDb("main");
    expect(
      (
        await cortexLearnWeekly(empty, {
          market: M,
          d: "2026-11-14",
          calendar: [],
          now: NOW,
          config: CONFIG,
          hooks: {},
        })
      )[0]!.action,
    ).toBe("no_fixed_rule");
    const db = await freshDb("main");
    await seedRule(db, false);
    const r = await cortexLearnWeekly(db, {
      market: M,
      d: "2026-11-13",
      calendar: [],
      now: NOW,
      config: CONFIG,
      hooks: {},
    });
    expect(r[0]).toMatchObject({
      action: "generation_zero",
      charged: false,
      lastSession: "2026-11-13",
    });
  });

  it("a later run re-weights on a finding: generation 1, raisedMost, placebo twin; a re-run is a no-op", async () => {
    const db = await freshDb("main");
    await seedRule(db);
    await cortexLearnWeekly(db, {
      market: M,
      d: "2026-11-14",
      calendar: [],
      now: NOW,
      config: CONFIG,
      hooks: {},
    });
    const days = weekdays("2026-08-01", "2026-11-20").slice(-60);
    await insertAngleDays(
      db,
      days.flatMap((d, i) => [
        dayRow(d, "A-D1-02", 20, 0.15 + wobble(i)),
        dayRow(d, "A-D2-01", 20, -0.15 + wobble(i + 3)),
      ]),
    );
    const r = await cortexLearnWeekly(db, {
      market: M,
      d: "2026-11-21",
      calendar: [],
      now: NOW,
      config: CONFIG,
      hooks: {},
    });
    expect(r[0]).toMatchObject({
      action: "reweight",
      generation: 1,
      charged: true,
      lastSession: "2026-11-20",
    });
    expect(r[0]!.maxMove).toBeGreaterThan(0);
    const gen1 = (await latestMaps(db, M, "2026-11-23")).find((m) => m.ruleVersion === "F1.learn")!;
    const w = (gen1.params as unknown as { weights: { angle: Record<string, number> } }).weights;
    expect(w.angle["A-D1-02"]!).toBeGreaterThan(w.angle["A-D2-01"]!);
    expect((gen1.params as unknown as { generation: number }).generation).toBe(1);
    const ev = await eventsSince(db, M, "2026-11-20");
    expect(ev.map((e) => [e.kind, e.seq, e.generation])).toEqual([
      ["reweight", 100, 1],
      ["placebo", 101, 1],
    ]);
    expect((ev[0]!.evidence as { raisedMost: string }).raisedMost).toBe("A-D1-02");
    for (const e of ev) expect(cleanWords(e.words)).toBe(true);
    await cortexLearnWeekly(db, {
      market: M,
      d: "2026-11-21",
      calendar: [],
      now: NOW,
      config: CONFIG,
      hooks: {},
    });
    expect(await count(db, "SELECT COUNT(*) AS n FROM cortex_map")).toBe(3);
    expect(await count(db, "SELECT COUNT(*) AS n FROM trial_ledger")).toBe(2);
  });

  it("no finding: a 'no_change' event and no new row; an edited C.9 key starts a new generation", async () => {
    const db = await freshDb("main");
    await seedRule(db);
    await cortexLearnWeekly(db, {
      market: M,
      d: "2026-11-14",
      calendar: [],
      now: NOW,
      config: CONFIG,
      hooks: {},
    });
    const days = weekdays("2026-08-01", "2026-11-20").slice(-60);
    await insertAngleDays(
      db,
      days.flatMap((d, i) => ANGLES.map((a, j) => dayRow(d, a, 20, wobble(i + j)))),
    );
    const r = await cortexLearnWeekly(db, {
      market: M,
      d: "2026-11-21",
      calendar: [],
      now: NOW,
      config: CONFIG,
      hooks: {},
    });
    expect(r[0]).toMatchObject({ action: "no_change", generation: 0, charged: false });
    expect(await count(db, "SELECT COUNT(*) AS n FROM cortex_map")).toBe(2);
    const edited = learnConfig({ replicates: 200, maxStep: 0.3 }, { relaxed: true });
    const r2 = await cortexLearnWeekly(db, {
      market: M,
      d: "2026-11-28",
      calendar: [],
      now: NOW,
      config: edited,
    });
    expect(r2[0]).toMatchObject({ action: "reweight", generation: 1 });
  });

  it("a new fixed F1 rule from the Owner restarts the learner on it (equal weights, next generation)", async () => {
    const db = await freshDb("main");
    await seedRule(db);
    await cortexLearnWeekly(db, {
      market: M,
      d: "2026-11-14",
      calendar: [],
      now: NOW,
      config: CONFIG,
      hooks: {},
    });
    await insertMap(db, { ...FIXED, ruleVersion: "F1.zz.2", fittedAt: "2026-11-16T00:00:00.000Z" });
    const r = await cortexLearnWeekly(db, {
      market: M,
      d: "2026-11-21",
      calendar: [],
      now: NOW,
      config: CONFIG,
      hooks: {},
    });
    expect(r[0]).toMatchObject({ action: "generation_zero", generation: 1 });
    const l = (await latestMaps(db, M, "2026-11-23")).find((m) => m.ruleVersion === "F1.learn")!;
    expect((l.params as unknown as { based_on: string }).based_on).toBe("F1.zz.2");
  });

  it("the weekly-run wrapper returns one statistic per family", async () => {
    const db = await freshDb("main");
    await seedRule(db);
    await db.execute({
      sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('learn_window_sessions', 'global', '60', ?)",
      args: [NOW],
    });
    // the production hooks: the base step writes base version 1 and reports one statistic
    const out = await cortexWeeklyStage({ db, market: M, d: "2026-11-14", calendar: [] });
    expect(out.stats).toEqual([
      {
        scope: M,
        metric: "cortex_learn:F1",
        value: expect.objectContaining({ action: "generation_zero", generation: 0 }),
      },
      {
        scope: M,
        metric: "cortex_base",
        value: {
          families: [{ family: "F1", version: 1, change: "initial" }],
          closed: 0,
          restarts: 0,
        },
      },
    ]);
  });

  it("D-972: the baseWeekly hook runs BEFORE the re-weighting, at the embargo instant; its failure is not fatal", async () => {
    const db = await freshDb("main");
    await seedRule(db);
    const seen: string[] = [];
    const r = await cortexLearnWeekly(db, {
      market: M,
      d: "2026-11-14",
      calendar: [],
      now: NOW,
      config: CONFIG,
      hooks: {
        baseWeekly: async (_db, ctx) => {
          seen.push(
            `${ctx.lastSession}:${ctx.learner?.ruleVersion}:${ctx.fixed?.ruleVersion}:${ctx.seqBase}:${ctx.now}`,
          );
          throw new Error("boom");
        },
      },
    });
    // no learner yet when the base step runs; the instant is 3 s after Friday's cut-off
    expect(seen).toEqual([
      `2026-11-13:undefined:F1.zz.1:200:${embargoFittedAt("2026-11-13", BASE_FIT_OFFSET_MS)}`,
    ]);
    expect(r[0]).toMatchObject({ action: "generation_zero", generation: 0 });
  });

  it("D-972: a base change restarts the learner the same week on the new base (equal weights, based_on the base row)", async () => {
    const db = await freshDb("main");
    await seedRule(db);
    await cortexLearnWeekly(db, {
      market: M,
      d: "2026-11-14",
      calendar: [],
      now: NOW,
      config: CONFIG,
      hooks: {},
    });
    const baseRow: MapRow = {
      ...FIXED,
      ruleVersion: "F1.zz.1+b2",
      fittedAt: embargoFittedAt("2026-11-20", BASE_FIT_OFFSET_MS),
      params: {
        ...FIXED.params,
        angles: ["A-D1-02"],
        system: true,
        base_version: 2,
        claims_p: false,
        admitted: ["A-D1-02"],
      } as unknown as MapParams,
      pool: "system",
      fitSplit: "base_change",
    };
    const res = await cortexLearnWeeklyRun(db, {
      market: M,
      d: "2026-11-21",
      calendar: [],
      now: NOW,
      config: CONFIG,
      hooks: {
        baseWeekly: async (hdb, ctx) => {
          await insertMap(hdb, { ...baseRow, fittedAt: ctx.now });
          return {
            lines: ["base changed"],
            stats: [{ metric: "cortex_base", value: { restarts: 1 } }],
            restartLearner: [
              { family: "F1", ruleVersion: "F1.zz.1+b2", baseVersion: 2, sinceD: "2026-11-23" },
              { family: "F1", ruleVersion: "F1.unknown", baseVersion: 3, sinceD: "2026-11-23" },
            ],
          };
        },
      },
    });
    expect(res.results[0]).toMatchObject({ action: "generation_zero", generation: 1 });
    expect(res.hook?.lines).toEqual(["base changed"]);
    // on Friday the base row is not in force; from Monday it is the fixed rule and the learner follows it
    const fri = await latestMaps(db, M, "2026-11-20");
    expect(fri.some((m) => m.ruleVersion === "F1.zz.1+b2")).toBe(false);
    const mon = await latestMaps(db, M, "2026-11-23");
    const l = mon.find((m) => m.ruleVersion === "F1.learn")!;
    const p = l.params as unknown as Record<string, unknown>;
    expect(p).toMatchObject({ based_on: "F1.zz.1+b2", generation: 1 });
    expect(Object.keys((p.weights as { angle: object }).angle)).toEqual(["A-D1-02"]);
    const ev = await eventsSince(db, M, "2026-11-20");
    expect(ev.map((e) => [e.kind, e.seq, e.generation])).toEqual([["reweight", 100, 1]]);
    expect(ev[0]!.evidence).toMatchObject({ basedOn: "F1.zz.1+b2", restart: "base_change" });
    // the next week: the base row is the fixed rule, the learner re-weights on it (no new restart)
    const next = await cortexLearnWeekly(db, {
      market: M,
      d: "2026-11-28",
      calendar: [],
      now: NOW,
      config: CONFIG,
      hooks: {},
    });
    expect(next[0]!.action).not.toBe("generation_zero");
  });
});

// ---- nightly --------------------------------------------------------------------------------------

function world(n = 40): World {
  const shares = new Map(
    [...bars(n)].map(([code, list]) => [
      code,
      {
        code,
        tier: "U1",
        bars: list.map((b) => ({ d: b.d, o: b.c, h: b.c, l: b.c, c: b.c, v: 1000 })),
      },
    ]),
  );
  return {
    d: D,
    prev: PREV,
    tierOf: new Map(codes(n).map((c) => [c, "U1"])),
    moves: [],
    indexMovePpm: null,
    sectorOf: new Map(),
    shares,
    liquidCodes: codes(n),
    sensitive: new Map(),
    names: new Map(),
    signals: new Map(),
  };
}

async function seedNight(db: Client, d: string, n = 40): Promise<void> {
  const night = featureNight(d, n);
  const stmts: InStatement[] = night.rows.map((r) => ({
    sql: `INSERT INTO cortex_feature_daily (market, d, code, features_json, flags_json, active_set_hash, manifest_id)
          VALUES ('AU', ?, ?, ?, '{}', ?, ?)`,
    args: [d, r.code, JSON.stringify(r.features), r.activeSetHash, r.manifestId],
  }));
  for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500), "write");
}

/** A learner start whose session count to D is even, so D is a checkpoint night. */
function checkpointStart(): string {
  for (const s of ["2026-09-01", "2026-09-02"]) {
    const cal = weekdays(s, "2026-12-31");
    if (
      isCheckpointNight({
        startD: s,
        d: D,
        calendar: cal,
        abstainTonight: false,
        abstainLastNight: false,
      })
    )
      return s;
  }
  throw new Error("unreachable");
}

async function seedLearnerWorld(db: Client, n = 40, hold?: number): Promise<MapRow> {
  await seedRule(db);
  const start = checkpointStart();
  const base =
    hold === undefined
      ? FIXED
      : { ...FIXED, params: { ...FIXED.params, plan: "time_hold", hold } as unknown as MapParams };
  // generation 0, fitted just before the start session's cut-off (18:10 Melbourne = 08:10Z in Sept)
  const gen0 = generationZero(base, ANGLES, {
    fittedAt: `${start}T08:00:00.000Z`,
    configHash: "x",
  });
  await insertMap(db, gen0);
  await seedNight(db, PREV, n);
  await seedNight(db, BACK21, n);
  await db.execute({
    sql: `INSERT INTO regime_daily (market, d, version, close_micro, raw_state, state, exit_streak)
          VALUES ('AU', ?, 1, 1, 'RISK-ON', 'RISK-ON', 0)`,
    args: ["2026-09-01"],
  });
  await db.execute({
    sql: "INSERT INTO daily_learning (market, d, body_json, created_at) VALUES ('AU', ?, ?, ?)",
    args: [
      D,
      JSON.stringify({
        d: D,
        summary: [],
        movers: [],
        lessons: [],
        improvements: [],
        hypothesesOpened: [],
      }),
      NOW,
    ],
  });
  const dec = (bookId: string, code: string, ruleVersion: string) =>
    insertDecision(db, {
      market: M,
      d: BACK21,
      bookId,
      code,
      arm: "shadow",
      family: "F1",
      s: 1,
      p: null,
      expectedNetMicro: null,
      rankKey: "[1,0,0]",
      limitMicro: 1_000_000,
      stopMicro: 900_000,
      qty: 10,
      gateTrace: [],
      firstFailGate: null,
      signalId: null,
      orderId: null,
      cardId: null,
      sectorTilt: null,
      manifestId: "zzmanifest",
      ruleVersion,
    });
  await dec("E01", "ZZ001", "F1.zz.1");
  await dec("E01#learn", "ZZ040", "F1.learn");
  return gen0;
}

const mover = (code: string): MoverExplanation => ({
  code,
  name: null,
  side: "gainer",
  movePpm: 50_000,
  cause: "stock_specific",
  causeText: "",
  indexMovePpm: null,
  sectorName: null,
  sectorMovePpm: null,
  volumeVsUsualPpm: null,
  setupBefore: [],
  caughtBy: null,
  nearMiss: null,
});

const nightOpts = (over: Partial<Parameters<typeof cortexLearnNight>[1]> = {}) => ({
  market: M,
  d: D,
  calendar: [],
  world: world(),
  movers: [mover("ZZ039")],
  now: NOW,
  config: CONFIG,
  hooks: {},
  ...over,
});

describe("nightly: duel, checkpoint, leader", () => {
  it("matures the d-21 duel, writes the comparison and the duel and review lines; a re-run is a no-op", async () => {
    const db = await freshDb("main");
    await seedLearnerWorld(db);
    const s = (await cortexLearnNight(db, nightOpts()))!;
    const l = s.numbers.learner!;
    expect(l).toMatchObject({
      family: "F1",
      generation: 0,
      leader: "fixed",
      compareMatured: 1,
      duelNights: 1,
      duelAgree: 0,
      checkpoint: true,
      leaderChange: null,
    });
    const cmp = await compareRowsSince(db, M, BACK21);
    expect(cmp).toEqual([
      expect.objectContaining({
        decisionD: BACK21,
        bookId: "E01",
        fixedCode: "ZZ001",
        learnerCode: "ZZ040",
        agree: 0,
        fixedRet20Ppm: 2000,
        learnerRet20Ppm: 80000,
        maturedD: D,
        learnerRuleVersion: "F1.learn",
        learnerGeneration: 0,
      }),
    ]);
    expect(s.lines.some((x) => x.startsWith("Learning Cortex vs fixed Cortex"))).toBe(true);
    expect(s.lines.some((x) => x.startsWith("Review:"))).toBe(true);
    for (const x of s.lines) expect(cleanWords(x), x).toBe(true);
    const ev = await eventsSince(db, M, D);
    expect(ev.map((e) => e.kind)).toEqual(["scorecard", "checkpoint"]);
    const again = await cortexLearnNight(db, nightOpts({ now: "2026-11-10T11:00:00.000Z" }));
    expect(again).toEqual(s);
    expect(await count(db, "SELECT COUNT(*) AS n FROM cortex_learn_compare")).toBe(1);
    expect(await count(db, "SELECT COUNT(*) AS n FROM cortex_learn_event")).toBe(2);
  });

  it("a fall alarm caps the angle: a new learner row (tag c) in force from the next session only", async () => {
    const db = await freshDb("main");
    const gen0 = await seedLearnerWorld(db);
    const days = weekdays("2026-04-01", PREV).slice(-119);
    await insertAngleDays(
      db,
      days.flatMap((d, i) => [
        dayRow(d, "A-D1-02", 1, i < days.length - 20 ? 0.05 + wobble(i) : -0.3),
        dayRow(d, "A-D2-01", 1, wobble(i + 5)),
      ]),
    );
    const s = (await cortexLearnNight(db, nightOpts()))!;
    expect(s.numbers.learner!.actions).toContain("cap");
    expect(s.numbers.learner!.mapRowWritten).toBe(true);
    expect(s.lines.some((x) => x.includes("halved"))).toBe(true);
    const tonight = (await latestMaps(db, M, D)).find((m) => m.ruleVersion === "F1.learn")!;
    expect(tonight.fittedAt).toBe(gen0.fittedAt);
    const next = (await latestMaps(db, M, AFTER)).find((m) => m.ruleVersion === "F1.learn")!;
    const p = next.params as unknown as Record<string, unknown> & {
      weights: { angle: Record<string, number> };
      caps: Record<string, string>;
    };
    expect(p.generation_tag).toBe("0c");
    expect(p.weights.angle["A-D1-02"]).toBe(0.5);
    expect(Object.keys(p.caps)).toContain("A-D1-02");
    expect(p.weights_hash).toBe(weightsHash(p.weights as never));
    const cap = (await eventsSince(db, M, D)).find(
      (e) => e.kind === "cap" && e.angleId === "A-D1-02",
    )!;
    expect(cap.expiresD).toBe(p.caps["A-D1-02"]);
  });

  /** 25 matured four-week comparisons since the learner started, the learner ahead by `edge`. */
  async function seedDuel(db: Client, edge: number): Promise<void> {
    const nights = weekdays("2026-09-03", "2026-10-08").slice(0, 25);
    for (const [i, d] of nights.entries()) {
      await db.execute({
        sql: `INSERT INTO cortex_learn_compare (market, decision_d, family, book_id, fixed_rule_version,
                learner_rule_version, learner_generation, fixed_code, learner_code, agree, fixed_ret1_ppm,
                learner_ret1_ppm, fixed_ret20_ppm, learner_ret20_ppm, matured_d, regime)
              VALUES ('AU', ?, 'F1', 'E09', 'F1.zz.1', 'F1.learn', 0, 'ZZA', 'ZZB', 0, 0, 0, 0, ?, ?, 'RISK-ON')`,
        args: [d, Math.round(edge * 1e6) + (i % 3) * 1000, D],
      });
    }
  }

  it("the nightly evaluator switches to the learner on strict four-week evidence (hold of four weeks)", async () => {
    const db = await freshDb("main");
    await seedLearnerWorld(db, 40, 20);
    await seedDuel(db, 0.06);
    const cfg = learnConfig({ replicates: 200, switchMinNights: 20 }, { relaxed: true });
    const s = (await cortexLearnNight(db, nightOpts({ config: cfg })))!;
    expect(s.numbers.learner!.leaderChange).toBe("switch");
    expect((await leaderMap(db, M, AFTER)).get("F1")).toMatchObject({
      leader: "learner",
      setBy: "evaluator",
      sinceD: AFTER,
    });
    expect(s.lines.some((x) => x.startsWith("The learning Cortex now makes the decisions"))).toBe(
      true,
    );
    // the same evidence with a long hold binds on the matured net, which has no result yet: no switch
    const db2 = await freshDb("main");
    await seedLearnerWorld(db2);
    await seedDuel(db2, 0.06);
    const t = (await cortexLearnNight(db2, nightOpts({ config: cfg })))!;
    expect(t.numbers.learner!.leaderChange).toBeNull();
  });

  it("a checkpoint falls back to the fixed Cortex when the leading learner falls behind", async () => {
    const db = await freshDb("main");
    await seedLearnerWorld(db);
    await insertLeader(db, {
      market: M,
      family: "F1",
      sinceD: "2026-09-02",
      leader: "learner",
      learnerRuleVersion: "F1.learn",
      learnerGeneration: 0,
      evidence: {},
      setBy: "evaluator",
    });
    await seedDuel(db, -0.06);
    const s = (await cortexLearnNight(db, nightOpts()))!;
    expect(s.numbers.learner).toMatchObject({ checkpoint: true, leaderChange: "fallback" });
    expect((await leaderMap(db, M, AFTER)).get("F1")).toMatchObject({
      leader: "fixed",
      setBy: "fallback",
    });
    expect((await eventsSince(db, M, D)).map((e) => e.kind)).toContain("fallback");
  });

  it("the Owner kill hands the decisions back to the fixed Cortex from the next session", async () => {
    const db = await freshDb("main");
    await seedLearnerWorld(db);
    await insertLeader(db, {
      market: M,
      family: "F1",
      sinceD: "2026-10-01",
      leader: "learner",
      learnerRuleVersion: "F1.learn",
      learnerGeneration: 0,
      evidence: {},
      setBy: "evaluator",
    });
    const off = learnConfig({ replicates: 200, learnerOff: 1 }, { relaxed: true });
    const s = (await cortexLearnNight(db, nightOpts({ config: off })))!;
    expect(s.numbers.learner).toMatchObject({ leader: "learner", leaderChange: "owner_kill" });
    expect((await leaderMap(db, M, D)).get("F1")!.leader).toBe("learner");
    const after = (await leaderMap(db, M, AFTER)).get("F1")!;
    expect(after).toMatchObject({ leader: "fixed", setBy: "owner_kill", sinceD: AFTER });
    const kinds = (await eventsSince(db, M, D)).map((e) => e.kind);
    expect(kinds.filter((k) => k === "fallback")).toHaveLength(1);
  });

  it("a young learner: no comparison yet, no checkpoint tonight, and a cap ending tomorrow is lifted", async () => {
    const db = await freshDb("main");
    await seedRule(db);
    const start = ["2026-10-14", "2026-10-15"].find(
      (st) =>
        !isCheckpointNight({
          startD: st,
          d: D,
          calendar: weekdays(st, "2026-12-31"),
          abstainTonight: false,
          abstainLastNight: false,
        }),
    )!;
    const gen0 = generationZero(FIXED, ANGLES, {
      fittedAt: `${start}T07:00:00.000Z`,
      configHash: "x",
    });
    await insertMap(db, gen0);
    const capped = nightlyRow(gen0, {
      nextSession: "2026-10-20",
      decisions: [
        {
          kind: "cap",
          reason: "fall_alarm",
          angleId: "A-D1-02",
          family: null,
          generation: null,
          reversesD: null,
          reversesSeq: null,
          expiresD: AFTER,
          evidence: {},
          words: "",
        },
      ],
      fittedAt: "2026-11-02T07:00:00.000Z",
    })!.row;
    await insertMap(db, capped);
    await seedNight(db, PREV);
    const s = (await cortexLearnNight(db, nightOpts()))!;
    expect(s.numbers.learner).toMatchObject({
      compareMatured: 0,
      duelNights: 0,
      checkpoint: false,
      mapRowWritten: true,
    });
    expect(s.lines.some((x) => x.includes("no four-week result is in yet"))).toBe(true);
    expect(s.lines.some((x) => x.includes("back to its weekly level"))).toBe(true);
    const next = (await latestMaps(db, M, AFTER)).find((m) => m.ruleVersion === "F1.learn")!;
    expect((next.params as unknown as { generation_tag: string }).generation_tag).toBe("0e");
  });

  it("a learner failure keeps the scorecard and says the comparison runs again", async () => {
    const db = await freshDb("main");
    await seedLearnerWorld(db);
    const broken = { ...db, execute: db.execute.bind(db), batch: db.batch.bind(db) } as Client;
    let calls = 0;
    const flaky = {
      execute: async (x: InStatement) => {
        const sql = typeof x === "string" ? x : x.sql;
        if (/FROM cortex_learn_compare/.test(sql) && ++calls > 0) throw new Error("boom");
        return broken.execute(x);
      },
      batch: broken.batch,
    } as unknown as Client;
    const s = (await cortexLearnNight(flaky, nightOpts()))!;
    expect(s.numbers.learner).toBeUndefined();
    expect(s.lines[s.lines.length - 1]).toMatch(/comparison runs again tomorrow/);
  });

  it("the probeNight hook sees the learner and adds its lines; a failing hook is not fatal", async () => {
    const db = await freshDb("main");
    await seedLearnerWorld(db);
    const s = (await cortexLearnNight(
      db,
      nightOpts({
        hooks: {
          probeNight: async (_db, ctx) => ({
            lines: [
              `probe ${ctx.learner?.ruleVersion === learnerRuleVersion("F1")} ${ctx.seqBase}`,
            ],
          }),
        },
      }),
    ))!;
    expect(s.lines[s.lines.length - 1]).toBe("probe true 200");
    const db2 = await freshDb("main");
    await seedLearnerWorld(db2);
    const t = await cortexLearnNight(
      db2,
      nightOpts({ hooks: { probeNight: async () => Promise.reject(new Error("boom")) } }),
    );
    expect(t!.numbers.learner).toBeDefined();
  });

  it("LRN-AT-10: a checkpoint night on a full-size universe reads at most 15,000 rows", async () => {
    const n = 2450;
    const db = await freshDb("main");
    await seedLearnerWorld(db, n);
    // 120 nights x 50 angles at both horizons (the checkpoint reads the horizon-1 half only)
    const days = weekdays("2026-03-01", PREV).slice(-119);
    const ids = Array.from({ length: 50 }, (_, i) => `A-ZZ-${String(i).padStart(2, "0")}`);
    await insertAngleDays(
      db,
      days.flatMap((d, i) =>
        ids.flatMap((a, j) => [dayRow(d, a, 1, wobble(i + j)), dayRow(d, a, 20, wobble(i * j))]),
      ),
    );
    let rowsRead = 0;
    const counting = {
      execute: async (s: InStatement) => {
        const r = await db.execute(s);
        rowsRead += r.rows.length;
        return r;
      },
      batch: async (ss: InStatement[], mode?: "write" | "read") => {
        const r = await db.batch(ss, mode);
        rowsRead += r.reduce((a, x) => a + x.rows.length, 0);
        return r;
      },
    } as unknown as Client;
    const s = (await cortexLearnNight(counting, nightOpts({ world: world(n) })))!;
    expect(s.numbers.learner!.checkpoint).toBe(true);
    expect(rowsRead).toBeGreaterThan(2 * n + days.length * ids.length - 1);
    expect(rowsRead).toBeLessThanOrEqual(15_000);
  }, 120_000);
});
