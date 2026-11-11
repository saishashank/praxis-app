// @vitest-environment node
// The learner's store and stage side (design C.2, C.4, C.5; D-923, D-924): latestMaps as of a
// night's cut-off, learnerMaps, currentMap and newestPerFamily skipping learner rows unless the
// learner leads, the cortex_leader read (tolerant of a database without migration 0031),
// ruleFromMap's learner fields, buildNightInputs' challengers and leader swap, persistNight's rule
// versions on #learn rows, and scoreOutcomes costing a #learn row as its real book. Synthetic ZZ only.
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Family } from "@/lib/agents/families/types";
import { defaultAgentParams } from "@/lib/agents/params";
import { runNight, type NightChallenger } from "@/lib/cortex/night";
import { weightsHash } from "@/lib/cortex/score/map";
import type { ScoreWeights } from "@/lib/cortex/score/types";
import {
  buildNightInputs,
  loadStoreReads,
  newestPerFamily,
  persistNight,
  readLeaders,
  ruleFromMap,
  scoreOutcomes,
  type LeaderMap,
  type LeaderRow,
  type StoreReads,
} from "@/lib/cortex/stage";
import {
  currentMap,
  insertMap,
  isLearnerRow,
  latestMaps,
  learnerMaps,
  mapCutoffOf,
  type MapParams,
  type MapRow,
} from "@/lib/cortex/store";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import {
  barsFor,
  BOOKS,
  calendarFor,
  CLUSTERS,
  HASH,
  mapFor,
  nightInputs,
  nightView,
  nightWorld,
  ruleFor,
  SESSIONS,
  weekdays,
} from "../night/zzNight";

afterAll(cleanupTempDbs);

const M = "AU";
const W: ScoreWeights = { cluster: { liquidity: 0.9 } };
const FIXED_PARAMS: MapParams = {
  a: 1.2,
  b: 0.1,
  s_mean: 0,
  s_sd: 0.5,
  K: 3,
  clusters: [...CLUSTERS],
  top3_min_s: -1,
  family_mean_net: 0.01,
  gain: 0.1,
  loss: 0.06,
  tiers: ["U1"],
} as MapParams;
const LEARN_PARAMS = (generation: number): MapParams => ({
  ...FIXED_PARAMS,
  learner: true,
  based_on: "F1.zz.1",
  generation,
  weights: W,
  weights_hash: weightsHash(W),
});
const row = (
  ruleVersion: string,
  fittedAt: string,
  params: MapParams,
  family: MapRow["family"] = "F1",
): MapRow => ({
  market: M,
  family,
  ruleVersion,
  fittedAt,
  params,
  activeSetHash: HASH,
  nEff: 250,
  pool: "zz",
  fitSplit: "development",
});

// 18:10 Melbourne in January (AEDT, UTC+11) is 07:10 UTC
const FIXED = row("F1.zz.1", "2030-01-01T00:00:00.000Z", FIXED_PARAMS);
const GEN0 = row("F1.learn", "2030-01-03T08:00:00.000Z", LEARN_PARAMS(0)); // after the 3 Jan cut-off
const GEN1 = row("F1.learn", "2030-01-10T06:00:00.000Z", LEARN_PARAMS(1)); // before the 10 Jan cut-off

async function seeded(): Promise<Client> {
  const db = await freshDb("main");
  for (const m of [FIXED, GEN0, GEN1]) await insertMap(db, m);
  return db;
}

describe("D-924: latestMaps as of a night's decision cut-off", () => {
  it("the cut-off is decisionCutoffUtc of the night (default decision_cutoff 18:10)", () => {
    expect(mapCutoffOf("2030-01-03", "18:10")).toBe("2030-01-03T07:10:00.000Z");
    expect(mapCutoffOf("2030-01-03")).toBe(mapCutoffOf("2030-01-03", "18:10"));
    expect(mapCutoffOf("2030-07-03", "18:10")).toBe("2030-07-03T08:10:00.000Z"); // AEST
  });

  it("a fit after the cut-off is first in force the next night; without asOfD the newest wins", async () => {
    const db = await seeded();
    const at = async (d?: string) =>
      (await latestMaps(db, M, d, "18:10")).map((m) => [
        m.ruleVersion,
        (m.params as MapParams).generation ?? null,
      ]);
    expect(await at("2029-12-31")).toEqual([]);
    expect(await at("2030-01-02")).toEqual([["F1.zz.1", null]]);
    expect(await at("2030-01-03")).toEqual([["F1.zz.1", null]]);
    expect(await at("2030-01-06")).toEqual([
      ["F1.learn", 0],
      ["F1.zz.1", null],
    ]);
    expect(await at("2030-01-10")).toEqual([
      ["F1.learn", 1],
      ["F1.zz.1", null],
    ]);
    expect(await at()).toEqual(await at("2030-01-10"));
  });

  it("learnerMaps: only learner rows, as of the night", async () => {
    const db = await seeded();
    expect(await learnerMaps(db, M, "2030-01-03")).toEqual([]);
    const l = await learnerMaps(db, M, "2030-01-07", "18:10");
    expect(l.map((m) => [m.ruleVersion, m.params.generation])).toEqual([["F1.learn", 0]]);
    expect(l.every(isLearnerRow)).toBe(true);
  });

  it("currentMap (the look's map) never returns a learner row", async () => {
    const db = await seeded();
    expect((await currentMap(db, M, "F1"))!.ruleVersion).toBe("F1.zz.1");
  });
});

describe("C.5: cortex_leader read", () => {
  const leaderTable = `CREATE TABLE cortex_leader (
    market TEXT NOT NULL, family TEXT NOT NULL, since_d TEXT NOT NULL,
    leader TEXT NOT NULL CHECK (leader IN ('fixed','learner')),
    learner_rule_version TEXT, learner_generation INTEGER,
    evidence_json TEXT NOT NULL, set_by TEXT NOT NULL,
    PRIMARY KEY (market, family, since_d)) STRICT, WITHOUT ROWID`;
  const insert = (
    family: string,
    since: string,
    leader: string,
    rv: string | null,
    g: number | null,
  ): { sql: string; args: (string | number | null)[] } => ({
    sql: `INSERT INTO cortex_leader VALUES (?, ?, ?, ?, ?, ?, '{}', 'evaluator')`,
    args: [M, family, since, leader, rv, g],
  });

  it("a database without the table (before migration 0031) has no leader", async () => {
    const db = await freshDb("main");
    await db.execute("DROP TABLE IF EXISTS cortex_leader");
    expect((await readLeaders(db, M, "2030-01-10")).size).toBe(0);
  });

  it("the latest row with since_d <= d per family; F7 and other markets ignored", async () => {
    const db = await freshDb("main");
    await db.execute("DROP TABLE IF EXISTS cortex_leader");
    await db.execute(leaderTable);
    await db.execute(insert("F1", "2030-01-05", "learner", "F1.learn", 0));
    await db.execute(insert("F1", "2030-01-20", "fixed", null, null));
    await db.execute(insert("F4", "2030-01-08", "learner", null, null));
    await db.execute(insert("F7", "2030-01-01", "learner", null, null));
    await db.execute({
      sql: `INSERT INTO cortex_leader VALUES ('XX', 'F1', '2030-01-01', 'learner', NULL, NULL, '{}', 'evaluator')`,
      args: [],
    });
    const at = async (d: string) => [...(await readLeaders(db, M, d)).values()];
    expect(await at("2030-01-04")).toEqual([]);
    expect(await at("2030-01-10")).toEqual([
      {
        family: "F1",
        sinceD: "2030-01-05",
        leader: "learner",
        learnerRuleVersion: "F1.learn",
        learnerGeneration: 0,
      },
      {
        family: "F4",
        sinceD: "2030-01-08",
        leader: "learner",
        learnerRuleVersion: null,
        learnerGeneration: null,
      },
    ]);
    expect((await at("2030-01-21"))[0]).toMatchObject({ family: "F1", leader: "fixed" });
  });

  it("any other read error is not swallowed", async () => {
    const broken = {
      execute: async () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    } as unknown as Client;
    await expect(readLeaders(broken, M, "2030-01-10")).rejects.toThrow(/locked/);
  });
});

const lead = (family: Family, leader: LeaderRow["leader"], rv: string | null = null): LeaderMap =>
  new Map([
    [
      family,
      { family, sinceD: "2030-01-01", leader, learnerRuleVersion: rv, learnerGeneration: null },
    ],
  ]);

describe("newestPerFamily with leaders (D-923)", () => {
  const rows = [FIXED, GEN0, GEN1, row("F4.zz.1", "2030-01-01T00:00:00.000Z", FIXED_PARAMS, "F4")];

  it("skips learner rows by default, even when they are newer", () => {
    const m = newestPerFamily(rows);
    expect(m.get("F1")!.ruleVersion).toBe("F1.zz.1");
    expect(m.get("F4")!.ruleVersion).toBe("F4.zz.1");
  });

  it("the learner's newest generation when the learner leads", () => {
    expect(newestPerFamily(rows, lead("F1", "learner")).get("F1")).toBe(GEN1);
    expect(newestPerFamily(rows, lead("F1", "learner", "F1.learn")).get("F1")).toBe(GEN1);
    expect(newestPerFamily(rows, lead("F1", "fixed")).get("F1")).toBe(FIXED);
  });

  it("a leader naming a learner that has no row keeps the fixed rule", () => {
    expect(newestPerFamily(rows, lead("F1", "learner", "F1.gone")).get("F1")).toBe(FIXED);
    expect(newestPerFamily(rows, lead("F4", "learner")).get("F4")!.ruleVersion).toBe("F4.zz.1");
  });
});

describe("ruleFromMap reads the learner fields (D-923)", () => {
  it("weights, learner, generation and based_on; a fixed map reads exactly as before", () => {
    const r = ruleFromMap("F1", GEN1);
    expect(r).toMatchObject({
      ruleVersion: "F1.learn",
      weights: W,
      learner: true,
      generation: 1,
      basedOn: "F1.zz.1",
    });
    const f = ruleFromMap("F1", FIXED);
    for (const k of ["weights", "learner", "generation", "basedOn"])
      expect(f).not.toHaveProperty(k);
  });

  it("malformed weights never score as given: non-numbers become NaN, a non-object {}", () => {
    const bad = row("F1.learn", "2030-01-10T06:00:00.000Z", {
      ...LEARN_PARAMS(2),
      weights: { angle: { x: "2" }, cluster: "oops" } as never,
    });
    expect(ruleFromMap("F1", bad).weights!.angle!.x).toBeNaN();
    expect(ruleFromMap("F1", bad).weights!.cluster).toBeUndefined();
    const notObj = row("F1.learn", "2030-01-10T06:00:00.000Z", {
      ...LEARN_PARAMS(2),
      weights: [1, 2] as never,
    });
    expect(ruleFromMap("F1", notObj).weights).toEqual({});
  });
});

// ---- buildNightInputs ---------------------------------------------------------------------------------

const T = SESSIONS.length - 1;
const D = SESSIONS[T]!;
const LIVE_FIXED = row("F1.zz.1", "2026-01-31T00:00:00.000Z", FIXED_PARAMS);
const LIVE_LEARN = row("F1.learn", "2026-03-20T00:00:00.000Z", LEARN_PARAMS(4));
function store(maps: readonly MapRow[], leaders?: LeaderMap): StoreReads {
  return {
    status: {
      F1: "allowed",
      F2: "shadow",
      F3: "shadow",
      F4: "shadow",
      F5: "shadow",
      F6: "shadow",
      F7: "shadow",
    },
    maps,
    cellRows: [],
    passports: [],
    states: [],
    statesFromD: [],
    sourcesOff: new Set(),
    ...(leaders === undefined ? {} : { leaders }),
  };
}
const build = (s: StoreReads) =>
  buildNightInputs({
    market: M,
    d: D,
    view: nightView(nightWorld()),
    params: defaultAgentParams(),
    store: s,
    books: BOOKS,
    kills: { arena: false, families: new Set(), sourcesOff: new Set() },
    elapsedMinutes: 0,
  });

describe("buildNightInputs: challengers and the leader swap (C.4, C.5)", () => {
  it("no learner row → no challengers key at all (LRN-AT-1)", () => {
    expect(build(store([LIVE_FIXED]))).not.toHaveProperty("challengers");
  });

  it("the fixed rule leads; the learner is F1's challenger with its weights and guarded map", () => {
    const inputs = build(store([LIVE_FIXED, LIVE_LEARN]));
    expect(inputs.rules.get("F1")!.ruleVersion).toBe("F1.zz.1");
    expect(inputs.maps.get("F1")).not.toHaveProperty("weights");
    const ch = inputs.challengers!.get("F1")!;
    expect(ch.rule).toMatchObject({ ruleVersion: "F1.learn", learner: true, weights: W });
    expect(ch.map).toMatchObject({
      ruleVersion: "F1.learn",
      weights: W,
      weightsHash: weightsHash(W),
      generation: 4,
      learner: true,
    });
    expect([...inputs.challengers!.keys()]).toEqual(["F1"]);
  });

  it("the learner leads: it is F1's rule and map; the fixed rule becomes the challenger", () => {
    const inputs = build(store([LIVE_FIXED, LIVE_LEARN], lead("F1", "learner")));
    expect(inputs.rules.get("F1")!.ruleVersion).toBe("F1.learn");
    expect(inputs.maps.get("F1")!.learner).toBe(true);
    const ch = inputs.challengers!.get("F1")!;
    expect(ch.rule.ruleVersion).toBe("F1.zz.1");
    expect(ch.rule.learner).toBeUndefined();
  });

  it("the learner leads a family with no fixed map: no challenger", () => {
    const inputs = build(store([LIVE_LEARN], lead("F1", "learner")));
    expect(inputs.rules.get("F1")!.ruleVersion).toBe("F1.learn");
    expect(inputs).not.toHaveProperty("challengers");
  });
});

describe("loadStoreReads (D-924, C.5)", () => {
  it("reads the maps in force at the night's cut-off and the leaders through the stub", async () => {
    const db = await seeded();
    const stub = vi.fn(async () => lead("F1", "learner"));
    const s = await loadStoreReads(db, {
      market: M,
      d: "2030-01-03",
      cutoffHhmm: "18:10",
      readLeaders: stub,
    });
    expect(s.maps.map((m) => m.ruleVersion)).toEqual(["F1.zz.1"]);
    expect(stub).toHaveBeenCalledWith(db, M, "2030-01-03");
    expect(s.leaders!.get("F1")!.leader).toBe("learner");
  });

  it("without a stub reads cortex_leader (empty before migration 0031)", async () => {
    const db = await seeded();
    await db.execute("DROP TABLE IF EXISTS cortex_leader");
    const s = await loadStoreReads(db, { market: M, d: "2030-01-10" });
    expect(s.leaders!.size).toBe(0);
    expect(s.maps.map((m) => m.ruleVersion)).toEqual(["F1.learn", "F1.zz.1"]);
  });
});

// ---- persistNight and scoreOutcomes with #learn rows ------------------------------------------------------

const learnerInputs = () =>
  nightInputs(T, {
    challengers: new Map<Family, NightChallenger>([
      [
        "F1",
        {
          rule: ruleFor("F1", { ruleVersion: "F1.learn", learner: true, weights: W }),
          map: {
            ...mapFor("F1"),
            ruleVersion: "F1.learn",
            weights: W,
            weightsHash: weightsHash(W),
          },
        },
      ],
    ]),
  });

describe("persistNight and scoreOutcomes with challenger rows", () => {
  it("writes the #learn rows with the learner's rule version, the family rows with theirs", async () => {
    const db = await freshDb("main");
    const inputs = learnerInputs();
    await persistNight(db, {
      market: M,
      d: D,
      inputs,
      out: runNight(inputs),
      runtimeMs: 1,
      createdAt: "2026-03-28T08:00:00.000Z",
    });
    const r = await db.execute(
      "SELECT DISTINCT book_id, rule_version FROM cortex_decision WHERE book_id LIKE 'E01%' ORDER BY 1",
    );
    expect(r.rows.map((x) => [x.book_id, x.rule_version])).toEqual([
      ["E01", "F1.zz.1"],
      ["E01#learn", "F1.learn"],
    ]);
  });

  it("scoreOutcomes costs a #learn row as its real book (profileOf strips the suffix)", async () => {
    const db = await freshDb("main");
    const inputs = learnerInputs();
    const out = runNight(inputs);
    await persistNight(db, {
      market: M,
      d: D,
      inputs,
      out,
      runtimeMs: 1,
      createdAt: "2026-03-28T08:00:00.000Z",
    });
    const learnCodes = [
      ...new Set(out.shadow.filter((x) => x.bookId === "E01#learn").map((x) => x.code)),
    ];
    expect(learnCodes.length).toBeGreaterThan(0);
    for (const code of learnCodes) {
      for (const b of barsFor(code)) {
        await db.execute({
          sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'zz', ?, ?)`,
          args: [
            M,
            code,
            b.d,
            Number(b.open) / 1e6,
            Number(b.high) / 1e6,
            Number(b.low) / 1e6,
            Number(b.close) / 1e6,
            Number(b.volume),
            `${b.d}T07:00:00Z`,
            `${b.d}T07:00:00Z`,
          ],
        });
      }
    }
    const spy = vi.spyOn(db, "execute");
    const res = await scoreOutcomes(db, {
      market: M,
      d: D,
      params: defaultAgentParams(),
      now: () => "2026-03-28T09:00:00.000Z",
      calendar: calendarFor(weekdays("2026-02-02", 45)),
    });
    const cohortReads = spy.mock.calls
      .map((c) => c[0] as unknown)
      .filter(
        (s): s is { sql: string; args: unknown[] } =>
          typeof s === "object" &&
          s !== null &&
          /FROM cohort WHERE id/.test(String((s as { sql: unknown }).sql)),
      )
      .map((s) => s.args[0]);
    expect(cohortReads).toContain("E01");
    expect(cohortReads.some((id) => String(id).includes("#"))).toBe(false);
    expect(res.open).toBeGreaterThan(0); // the holds are still open (no later bar)
  });
});
