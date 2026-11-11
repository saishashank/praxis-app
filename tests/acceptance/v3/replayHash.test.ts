// @vitest-environment node
// M19 integration step 0 (D-1007, CXA-001, A-20): the AT-32 and AT-50 identity proof. The two replay
// hashes were recorded on the pre-refactor `build` tree (tests/acceptance/v3/replay-hash.baseline.json)
// and never change in M19: every M19 branch and the exit tree must reproduce them. "Any difference is a
// defect, not a tuning." The worlds are the ones of tests/acceptance/v2/at50.test.ts (the recorded
// night replayed with the Cortex hook) and at32Steelman.test.ts (the golden ZZ world, stage off).
//
// AT-32 hash scope (D-1008): every table of the main database except `schema_migrations` and `market`
// (the two tables a migration legitimately changes: the applied-version list, and the market row that
// gains its enabled/slots columns and the IN/US rows in 0034) and except tables absent from the
// baseline (the tables M19 adds). Each remaining table is compared by its own hash, so a failure names
// the table; the combined hash over the baseline's tables is compared as well.
// Record (only ever on the pre-refactor tree): RECORD_BASELINE=1 npx vitest run tests/acceptance/v3/replayHash.test.ts
// Synthetic ZZ data only (SEC-110).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { nightOutputJson, VOL_BUCKETS, type NightOutput } from "@/lib/cortex/night";
import { MATCHED_CELL_KIND } from "@/lib/cortex/stage";
import {
  insertFamilyStatus,
  insertMap,
  insertPassport,
  logCell,
  setCellResult,
} from "@/lib/cortex/store";
import { replayCohorts, type CohortReplayResult } from "@/lib/replay/cohortReplay";
import { createCortexReplay } from "@/lib/replay/cortexReplay";
import { plain } from "@/lib/replay/scorecards";
import { cellKey, TOP3_BAND_KEY } from "@/lib/stats/cells";
import {
  NIGHT_ANGLES,
  PASSPORTS,
  cellStat,
  CLUSTERS,
  HASH,
  cellsFor,
  mapFor,
  ruleFor,
} from "../../cortex/night/zzNight";
import { replayWorld } from "../../fixtures/m15/replayWorld";
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

vi.setConfig({ testTimeout: 480000, hookTimeout: 480000 });
afterAll(cleanupTempDbs);

const BASELINE_PATH = join(__dirname, "replay-hash.baseline.json");
const RECORD = process.env.RECORD_BASELINE === "1";
const sha = (t: string): string => createHash("sha256").update(t).digest("hex");
const jsonOf = (v: unknown): string =>
  JSON.stringify(plain(v), (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

// ---- AT-50: the recorded night replayed with the Cortex hook --------------------------------------------------

function at50Hash(): string {
  const params = defaultAgentParams();
  const world = replayWorld({ provenance: "notice", withShort: true, withMacro: true });
  const cr = createCortexReplay({
    world,
    params,
    status: { F1: "allowed" },
    maps: new Map([["F1", mapFor("F1")]]),
    cells: cellsFor(["F1"]),
    rules: new Map([["F1", ruleFor("F1")]]),
    passports: PASSPORTS,
    angles: NIGHT_ANGLES,
    indexChangesLoaded: true,
    regimeOverride: "NEUTRAL",
  });
  const res: CohortReplayResult = replayCohorts(world, { params, step: 10, cortex: cr.hook });
  const nights = cr.nights();
  const nightsJson = nights.map((n) => `${n.d}:${nightOutputJson(n.out)}`).join("\n");
  const decisions = nights.flatMap((n) => n.out.decisions);
  const decisionsJson = nights
    .map((n) => nightOutputJson({ decisions: n.out.decisions } as unknown as NightOutput))
    .join("\n");
  const cardsJson = nights
    .map((n) =>
      nightOutputJson({
        decisions: n.out.decisions.map((d) => d.card),
        shadow: n.out.shadow.map((d) => d.card),
      } as unknown as NightOutput),
    )
    .join("\n");
  const orders = jsonOf(cr.fillRules());
  const cohorts = jsonOf(res);
  // not vacuous; the same composition as AT-50 clause 1 (tests/acceptance/v2/at50.test.ts, replayRun().hash)
  expect(decisions.length).toBeGreaterThan(0);
  expect(cr.fillRules().length).toBeGreaterThan(0);
  return sha([nightsJson, decisionsJson, cardsJson, orders, cohorts].join("\n--\n"));
}

// ---- AT-32: the golden ZZ world, steelman stage off -------------------------------------------------------------

/** The tables the steelman stage owns (D-586); excluded exactly as in at32Steelman.test.ts. */
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

/** Tables a migration legitimately changes (D-1008): never part of the identity hash. */
const MIGRATION_OWNED = new Set(["schema_migrations", "market"]);

/** Wallclock columns stamped with the real clock (same list as at32Steelman.test.ts). */
const WALLCLOCK: Record<string, readonly string[]> = {
  source_register_history: ["changed_at"],
  cortex_night: ["runtime_ms"],
};

type Dump = { perTable: Record<string, string>; rows: Record<string, number> };

async function dump(db: Client): Promise<Dump> {
  const r = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const names = r.rows.map((x) => String(x.name)).filter((n) => !STEELMAN_OWN.has(n));
  const perTable: Record<string, string> = {};
  const rows: Record<string, number> = {};
  for (const t of names) {
    if (MIGRATION_OWNED.has(t)) continue;
    const skip = new Set(WALLCLOCK[t] ?? []);
    const cols = (await db.execute(`PRAGMA table_info(${t})`)).rows
      .map((c) => String(c.name))
      .filter((c) => !skip.has(c));
    const rs = await db.execute(
      `SELECT ${cols.join(", ")} FROM ${t} ORDER BY ${cols.map((_, i) => i + 1).join(", ")}`,
    );
    rows[t] = rs.rows.length;
    perTable[t] = sha(
      `${t}:${JSON.stringify(rs.rows.map((x) => cols.map((c) => String(x[c]))))}\n`,
    );
  }
  return { perTable, rows };
}

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

async function at32World(): Promise<Client> {
  const db = await freshReplayDb();
  await buildNight(db, { codes: goldenCodes() });
  await setMode(db, "full");
  await startCohortsAt(db, 296, ["E01", "E07"]);
  await seedCortex(db);
  await runNights(db, testParams(), 297, 301, async () => {}, {
    cortex: { angles: NIGHT_ANGLES },
  });
  return db;
}

type Baseline = {
  note: string;
  recordedAt: string;
  recordedOnCommit: string;
  at50: { hash: string };
  at32: { hash: string; tables: Record<string, string>; rows: Record<string, number> };
};

const combine = (tables: Record<string, string>, names: readonly string[]): string =>
  sha(names.map((n) => `${n}=${tables[n]}`).join("\n"));

let at50Recorded = "";

describe("M19 identity baselines (D-1007): AT-32 and AT-50 hashes never change", () => {
  it("AT-50: the recorded-night replay hash equals the step-0 baseline", () => {
    const hash = at50Hash();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    if (RECORD) {
      at50Recorded = hash;
      return;
    }
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    expect(hash).toBe(base.at50.hash);
  });

  it("AT-32: every baseline table of the golden world dumps to the baseline hash", async () => {
    const db = await at32World();
    const { perTable, rows } = await dump(db);
    const names = Object.keys(perTable).sort();
    const hash = combine(perTable, names);
    // the world is not empty: cards, signals, orders and decisions exist
    expect(rows.signal).toBeGreaterThan(0);
    expect(rows.decision_card).toBeGreaterThan(0);
    expect(rows.cortex_decision).toBeGreaterThan(0);
    expect(rows.arena_order).toBeGreaterThan(0);
    // D-1008 (Fable review): `market` is out of the combined hash because 0034 adds columns and the IN/US
    // rows; the AU row's pre-0034 columns (the 0004 table) are asserted literally instead, so a change to
    // AU's zone, hours, cut-off or currency cannot slip past the identity proof.
    const au = await db.execute(
      "SELECT code, tz, open_time, close_time, cutoff_time, currency, mode FROM market WHERE code = 'AU'",
    );
    expect(au.rows.map((r) => ({ ...r }))).toEqual([
      {
        code: "AU",
        tz: "Australia/Sydney",
        open_time: "10:00",
        close_time: "16:00",
        cutoff_time: "18:10",
        currency: "AUD",
        mode: "full",
      },
    ]);
    if (RECORD) {
      expect(at50Recorded, "AT-50 ran first").toMatch(/^[0-9a-f]{64}$/);
      const out: Baseline = {
        note:
          "M19 step 0 (D-1007): recorded on the pre-refactor build tree and never rewritten in M19. " +
          "AT-32 scope: every table except schema_migrations and market (D-1008) and the steelman tables.",
        recordedAt: "2026-11-12",
        recordedOnCommit: "fdc9e00",
        at50: { hash: at50Recorded },
        at32: { hash, tables: perTable, rows },
      };
      writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + "\n");
      return;
    }
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    const baseNames = Object.keys(base.at32.tables).sort();
    const differing = baseNames.filter((n) => perTable[n] !== base.at32.tables[n]);
    expect(differing, "tables whose dump moved against the baseline").toEqual([]);
    expect(combine(perTable, baseNames)).toBe(base.at32.hash);
    for (const n of baseNames) expect(rows[n], `${n} row count`).toBe(base.at32.rows[n]);
  });
});
