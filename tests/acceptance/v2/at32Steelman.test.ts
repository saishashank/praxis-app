// @vitest-environment node
// AT-32 (steelman part; M11-lite WP7; PRD-033, AGT-133, D-485, D-494): the steelman never changes
// ranking, sizing, orders, cards, signals or the arena tables. The golden ZZ world of AT-61 (e) is
// replayed three times: with no steelman stage, with the stage on (mock author and critic on two
// providers, run after every night's signals), and with the stage on and its model chain down. The
// sha256 of the ordered dumps of the decision and book tables is identical in all three, and the
// stage did write in the runs where it is on, so the equality is not vacuous. A second run of the
// stage on the same world writes nothing new. The hash covers every table of the main database except
// the stage's own and its side tracks (D-586), so the proof is the complement of a short allowlist.
// Synthetic ZZ data only (SEC-110).
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MATCHED_CELL_KIND } from "@/lib/cortex/stage";
import {
  insertFamilyStatus,
  insertMap,
  insertPassport,
  logCell,
  setCellResult,
} from "@/lib/cortex/store";
import { VOL_BUCKETS } from "@/lib/cortex/night";
import { MemoryStore } from "@/lib/llm/store";
import { steelmanNight, type NightOptions } from "@/lib/steelman/night";
import { cellKey, TOP3_BAND_KEY } from "@/lib/stats/cells";
import { cellStat, CLUSTERS, HASH, NIGHT_ANGLES } from "../../cortex/night/zzNight";
import {
  MARKET,
  buildNight,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "../../agents/batch2bHarness";
import { goldenCodes } from "../../agents/batch2bScenario";
import { freshReplayDb } from "../../arena/replayHarness";
import { cleanupTempDbs } from "../../db/helpers";
import {
  criticAnswer,
  genericAuthor,
  KEYS,
  llmOf,
  params,
  routerOf,
  scripted,
} from "../../steelman/nightHarness";

vi.setConfig({ testTimeout: 480000, hookTimeout: 480000 });
afterAll(cleanupTempDbs);

const sha = (t: string): string => createHash("sha256").update(t).digest("hex");

/**
 * The only tables the stage may move (D-586): its own five, its opinion side track (CTX-041, written
 * through recordOpinion / settleRecordedOpinion) and the router's own call log. Every other table of
 * the main database is hashed, so the proof is the complement, not a chosen list: a new decision,
 * book, learning or Cortex table is covered the day it is created.
 */
const STEELMAN_OWN = new Set([
  "steelman_pack",
  "steelman_point",
  "steelman_night",
  "steelman_suggestion",
  "pick_reflection",
  "opinion_track",
  "llm_call",
  "llm_cache",
]);

/** Decision, order, book, pick, lesson, Cortex and thesis-breaker tables that must be in the scan. */
const NAMED = [
  "signal",
  "decision_card",
  "arena_order",
  "fill",
  "trade",
  "cash_ledger",
  "nav_daily",
  "nav_daily_pos",
  "sleeve_trade",
  "sleeve_state",
  "stop_level",
  "blocked_trade",
  "lesson",
  "lesson_window",
  "rule_version",
  "rule_version_status",
  "family_status",
  "pick",
  "pick_outcome",
  "pick_market",
  "cortex_decision",
  "cortex_state",
  "cortex_night",
  "thesis_breaker_eval",
];

/**
 * Wallclock columns the migrations and the Cortex stamp with the real clock (they differ between any
 * two builds of the same world, stage or not); the column is dropped, the table stays in the hash.
 */
const WALLCLOCK: Record<string, readonly string[]> = {
  schema_migrations: ["applied_at"],
  source_register_history: ["changed_at"], // trigger: strftime('now') on the seeded register
  cortex_night: ["runtime_ms"], // measured runtime of the Cortex night
};

async function hashedTables(db: Client): Promise<string[]> {
  const r = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const names = r.rows.map((x) => String(x.name)).filter((n) => !STEELMAN_OWN.has(n));
  for (const t of NAMED) expect(names, `${t} is hashed`).toContain(t);
  return names;
}

type Dump = { hash: string; rows: Record<string, number>; perTable: Record<string, string> };

async function dumpHash(db: Client): Promise<Dump> {
  let all = "";
  const rows: Record<string, number> = {};
  const perTable: Record<string, string> = {};
  for (const t of await hashedTables(db)) {
    const skip = new Set(WALLCLOCK[t] ?? []);
    const cols = (await db.execute(`PRAGMA table_info(${t})`)).rows
      .map((r) => String(r.name))
      .filter((c) => !skip.has(c));
    expect(cols.length, `${t} exists`).toBeGreaterThan(0);
    const rs = await db.execute(
      `SELECT ${cols.join(", ")} FROM ${t} ORDER BY ${cols.map((_, i) => i + 1).join(", ")}`,
    );
    rows[t] = rs.rows.length;
    const text = `${t}:${JSON.stringify(rs.rows.map((r) => cols.map((c) => String(r[c]))))}\n`;
    perTable[t] = sha(text);
    all += text;
  }
  return { hash: sha(all), rows, perTable };
}

/** The tables whose dump differs between two worlds (named in the failure, not only a hash). */
const differing = (a: Dump, b: Dump): string[] =>
  [...new Set([...Object.keys(a.perTable), ...Object.keys(b.perTable)])]
    .filter((t) => a.perTable[t] !== b.perTable[t])
    .sort();

const one = async (db: Client, sql: string): Promise<number> =>
  Number((await db.execute(sql)).rows[0]!.n ?? 0);
const count = (db: Client, table: string): Promise<number> =>
  one(db, `SELECT COUNT(*) AS n FROM ${table}`);

async function seedCortex(db: Client): Promise<void> {
  for (const a of NIGHT_ANGLES) {
    await insertPassport(db, {
      market: MARKET,
      angleId: a.id,
      version: 1,
      domain: a.domain,
      cluster: a.cluster as never,
      orientation: a.orientation,
      kind: "score",
      inputs: ["bar_au"],
      historyFields: {},
      status: "active",
      horizonSessions: a.horizonSessions,
      evidence: {},
      measured: null,
      frozenAt: "2030-01-01T00:00:00.000Z",
    });
  }
  for (const family of ["F1", "F4"] as const) {
    await insertMap(db, {
      market: MARKET,
      family,
      ruleVersion: `${family}.zz.1`,
      fittedAt: "2030-01-01T00:00:00.000Z",
      params: {
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
      } as never,
      activeSetHash: HASH,
      nEff: 250,
      pool: "zz",
      fitSplit: "development",
    });
    for (const v of VOL_BUCKETS) {
      const key = cellKey(family, TOP3_BAND_KEY, v, "U1");
      const cellId = `cell:${key}`;
      await logCell(db, {
        cellId,
        market: MARKET,
        family,
        angleId: null,
        kind: MATCHED_CELL_KIND,
        spec: { key },
        loggedAt: "2030-01-01T00:00:00.000Z",
        split: "development",
        lineageId: null,
      });
      await setCellResult(db, cellId, "2030-01-02T00:00:00.000Z", cellStat(key));
    }
  }
  await db.execute({
    sql: `INSERT INTO index_change (market, code, index_name, kind, announced_d, effective_d, source, loaded_at)
          VALUES (?, 'ZZX', 'ASX200', 'add', '2029-12-01', '2029-12-15', 'manual', '2029-12-02T00:00:00Z')`,
    args: [MARKET],
  });
  await insertFamilyStatus(db, {
    market: MARKET,
    family: "F1",
    sinceD: "2030-01-02",
    status: "shadow",
    evidence: {},
    statementId: null,
    setBy: "import",
  });
}

type Mode = "off" | "on" | "down";

const NOW_ISO = "2031-01-01T00:00:00.000Z";

function optionsFor(mode: Exclude<Mode, "off">, d: string): NightOptions {
  if (mode === "on") {
    return {
      market: MARKET,
      d,
      llmParams: params.llm,
      keys: KEYS,
      llm: llmOf([scripted("alpha", genericAuthor())], [scripted("beta", criticAnswer())]),
      calendar: [],
      now: NOW_ISO,
    };
  }
  const store = new MemoryStore();
  const dead = scripted("alpha", genericAuthor(), { available: () => false });
  return {
    market: MARKET,
    d,
    llmParams: params.llm,
    keys: KEYS,
    llm: {
      authorRouter: routerOf([dead], store),
      criticRouterFor: () => null,
      providers: [dead],
      store,
    },
    calendar: [],
    now: NOW_ISO,
  };
}

/** The AT-61 (e) world; the steelman stage runs after each night's signals when `mode` is not off. */
async function world(mode: Mode): Promise<{ db: Client; dates: string[] }> {
  const db = await freshReplayDb();
  await buildNight(db, { codes: goldenCodes() });
  await setMode(db, "full");
  await startCohortsAt(db, 296, ["E01", "E07"]);
  await seedCortex(db);
  const dates: string[] = [];
  await runNights(
    db,
    testParams(),
    297,
    301,
    async (d) => {
      dates.push(d);
      if (mode !== "off") await steelmanNight(db, optionsFor(mode, d));
    },
    { cortex: { angles: NIGHT_ANGLES } },
  );
  return { db, dates };
}

describe("AT-32 (steelman): replay hash identical with the stage on and off", () => {
  it("hashes equal across off, on and on-with-no-model; the stage wrote where it could", async () => {
    const off = await world("off");
    const on = await world("on");
    const down = await world("down");

    const a = await dumpHash(off.db);
    const b = await dumpHash(on.db);
    const c = await dumpHash(down.db);

    // the world is not empty: cards, signals, orders and decisions exist
    expect(a.rows.signal).toBeGreaterThan(0);
    expect(a.rows.decision_card).toBeGreaterThan(0);
    expect(a.rows.cortex_decision).toBeGreaterThan(0);
    expect(a.rows.arena_order).toBeGreaterThan(0);

    expect(differing(a, b), "tables moved by the stage (on vs off)").toEqual([]);
    expect(differing(a, c), "tables moved by the stage (no model vs off)").toEqual([]);
    expect(b.hash).toBe(a.hash);
    expect(c.hash).toBe(a.hash);
    expect(b.rows).toEqual(a.rows);
    expect(Object.keys(a.rows).length).toBeGreaterThan(NAMED.length);

    // non-vacuous: off wrote nothing, on wrote points and an opinion, down wrote only counters
    expect(await count(off.db, "steelman_pack")).toBe(0);
    expect(await count(off.db, "steelman_night")).toBe(0);
    expect(await count(on.db, "steelman_night")).toBe(on.dates.length);
    expect(await count(on.db, "steelman_pack")).toBeGreaterThan(0);
    expect(await count(on.db, "steelman_point")).toBeGreaterThan(0);
    expect(
      await one(on.db, "SELECT COUNT(*) AS n FROM opinion_track WHERE kind = 'steelman'"),
    ).toBeGreaterThan(0);
    expect(await count(down.db, "steelman_point")).toBe(0);
    expect(await count(down.db, "steelman_night")).toBe(down.dates.length);
    expect(await one(down.db, "SELECT SUM(written) AS n FROM steelman_night")).toBe(0);
  });

  it("a second run of the stage on the same world moves nothing, and the hash holds", async () => {
    const on = await world("on");
    const before = await dumpHash(on.db);
    const points = await count(on.db, "steelman_point");
    for (const d of on.dates) await steelmanNight(on.db, optionsFor("on", d));
    expect(await count(on.db, "steelman_point")).toBe(points);
    expect(await count(on.db, "steelman_night")).toBe(on.dates.length);
    const after = await dumpHash(on.db);
    expect(differing(before, after), "tables moved by the second run").toEqual([]);
    expect(after.hash).toBe(before.hash);
  });
});
