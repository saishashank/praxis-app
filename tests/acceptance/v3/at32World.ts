// The AT-32 golden ZZ world (steelman stage off) and its table dump, for tests/acceptance/v3/at77Hash.test.ts (M21 A1,
// D-1237). A copy of the world and the dump of replayHash.test.ts (the identity test itself is not edited: its baseline
// is never rewritten); the two must be kept the same, and at77Hash.test.ts compares two runs of THIS copy, so a drift
// can only make that test less strict, never move the identity baseline.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { VOL_BUCKETS } from "@/lib/cortex/night";
import { MATCHED_CELL_KIND } from "@/lib/cortex/stage";
import {
  insertFamilyStatus,
  insertMap,
  insertPassport,
  logCell,
  setCellResult,
} from "@/lib/cortex/store";
import { cellKey, TOP3_BAND_KEY } from "@/lib/stats/cells";
import { NIGHT_ANGLES, cellStat, CLUSTERS, HASH } from "../../cortex/night/zzNight";
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

const sha = (t: string): string => createHash("sha256").update(t).digest("hex");

/** The tables the steelman stage owns (D-586); excluded exactly as in at32Steelman.test.ts. */
export const STEELMAN_OWN = new Set([
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
export const MIGRATION_OWNED = new Set(["schema_migrations", "market"]);

/** Wallclock columns stamped with the real clock (same list as at32Steelman.test.ts). */
const WALLCLOCK: Record<string, readonly string[]> = {
  source_register_history: ["changed_at"],
  cortex_night: ["runtime_ms"],
};

export type Dump = { perTable: Record<string, string>; rows: Record<string, number> };

export async function dump(db: Client): Promise<Dump> {
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

export async function at32World(prepare?: (db: Client) => Promise<void>): Promise<Client> {
  const db = await freshReplayDb();
  if (prepare) await prepare(db);
  await buildNight(db, { codes: goldenCodes() });
  await setMode(db, "full");
  await startCohortsAt(db, 296, ["E01", "E07"]);
  await seedCortex(db);
  await runNights(db, testParams(), 297, 301, async () => {}, {
    cortex: { angles: NIGHT_ANGLES },
  });
  return db;
}
