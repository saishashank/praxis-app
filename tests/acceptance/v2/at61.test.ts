// @vitest-environment node
// AT-61 (M17 WP6; docs/M17_requirements.md AT-61 (d)(e); AGT-144, D-386, D-399, D-456..D-458):
// (d) every intraday candidate has an outcome after a synthetic run: night_pick, rejected:<gate>,
//     rejected:rank, not_in_universe; running it twice writes nothing the second time;
// (e) the replay is byte-identical with and without candidates: sha256 of the ordered dumps of
//     arena_order, fill, trade, cash_ledger, nav_daily, nav_daily_pos, sleeve_trade, lesson,
//     cortex_decision over the ZZ fixture world; recordOutcomes touches only the candidate table.
// Synthetic ZZ data only (SEC-110). (a)(b)(c) live in the WP5 scan tests.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { insertDecision } from "@/lib/cortex/store/decisions";
import { outcomeOf, recordOutcomes } from "@/lib/intraday/outcome";
import { MATCHED_CELL_KIND } from "@/lib/cortex/stage";
import {
  insertFamilyStatus,
  insertMap,
  insertPassport,
  logCell,
  setCellResult,
} from "@/lib/cortex/store";
import { VOL_BUCKETS } from "@/lib/cortex/night";
import { cellKey, TOP3_BAND_KEY } from "@/lib/stats/cells";
import { cellStat, CLUSTERS, HASH, NIGHT_ANGLES } from "../../cortex/night/zzNight";
import {
  DATES,
  MARKET,
  buildNight,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "../../agents/batch2bHarness";
import { D, goldenCodes } from "../../agents/batch2bScenario";
import { freshReplayDb } from "../../arena/replayHarness";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

vi.setConfig({ testTimeout: 240000, hookTimeout: 240000 });
afterAll(cleanupTempDbs);

const sha = (t: string): string => createHash("sha256").update(t).digest("hex");

async function insertCandidate(db: Client, sessionD: string, code: string): Promise<void> {
  await db.execute({
    sql:
      "INSERT INTO intraday_candidate (market, session_d, code, found_slot, found_at, item_source, " +
      "item_ann_id, item_category, materiality, polarity, move_ppm, gates_json) " +
      "VALUES (?, ?, ?, 'scan-1030', '2030-01-01T00:00:00Z', 'asx', ?, 'earnings', 2, 'positive', 50000, '[]')",
    args: [MARKET, sessionD, code, `ann-${code}`],
  });
}
const outcomes = async (db: Client, sessionD: string): Promise<Record<string, string | null>> =>
  Object.fromEntries(
    (
      await db.execute({
        sql: "SELECT code, decision_outcome FROM intraday_candidate WHERE market = ? AND session_d = ?",
        args: [MARKET, sessionD],
      })
    ).rows.map((r) => [
      String(r.code),
      r.decision_outcome === null ? null : String(r.decision_outcome),
    ]),
  );

describe("AT-61 (d): outcome per candidate", () => {
  it("maps each case and is idempotent", async () => {
    const db = await freshDb("main");
    const d = "2030-03-01";
    for (const [code, tier] of [
      ["ZZPK", "U1"],
      ["ZZBL", "U1"],
      ["ZZRK", "U2"],
      ["ZZNB", "U1"],
    ] as const) {
      await db.execute({
        sql: "INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES (?, ?, ?, 'active', ?)",
        args: [MARKET, "2030-02-28", code, tier],
      });
    }
    await db.execute({
      sql: "INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES (?, '2030-02-28', 'ZZU3X', 'active', 'U3')",
      args: [MARKET],
    });
    await db.execute({
      sql:
        "INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label, " +
        "reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, size_micro, risk_micro, " +
        "factors_json, based_on_json, pick_sha, created_at) VALUES (?, ?, 'p', 1, 'ZZPK', 'F1', 'U1', 'r', 's', 'l', " +
        "1000000, 1010000, '2030-03-05', 900000, 1100000, 0, 0, 0, '{}', '{}', ?, '2030-03-01T00:00:00Z')",
      args: [MARKET, d, "a".repeat(64)],
    });
    const dec = (code: string, arm: "live" | "shadow", gate: string | null) =>
      insertDecision(db, {
        market: MARKET,
        d,
        bookId: "E01",
        code,
        arm,
        family: "F1",
        s: 0,
        p: null,
        expectedNetMicro: null,
        rankKey: null,
        limitMicro: null,
        stopMicro: null,
        qty: null,
        gateTrace: [],
        firstFailGate: gate,
        signalId: null,
        orderId: null,
        cardId: null,
        sectorTilt: null,
        manifestId: "m",
      });
    await dec("ZZBL", "live", "G03");
    await dec("ZZBL", "shadow", "G07");
    await dec("ZZNB", "live", "G03");
    await dec("ZZNB", "shadow", null);
    // D-459: a night with candidates but neither picks nor decisions yet records nothing
    await insertCandidate(db, "2030-03-02", "ZZRK");
    expect(await recordOutcomes(db, MARKET, "2030-03-02")).toEqual({ written: 0 });
    for (const c of ["ZZPK", "ZZBL", "ZZRK", "ZZNB", "ZZOUT", "ZZU3X"])
      await insertCandidate(db, d, c);
    await dec("ZZPK", "shadow", "G05"); // a pick wins over a blocked row

    const first = await recordOutcomes(db, MARKET, d);
    expect(first.written).toBe(6);
    expect(await outcomes(db, d)).toEqual({
      ZZPK: "night_pick",
      ZZBL: "rejected:G07", // the shadow arm decides (D-457)
      ZZRK: "rejected:rank", // in a family tier, no row
      ZZNB: "rejected:rank", // scored, not blocked, not a pick
      ZZOUT: "not_in_universe",
      ZZU3X: "rejected:rank", // U3 is a family tier (F5)
    });
    expect(await recordOutcomes(db, MARKET, d)).toEqual({ written: 0 });
    expect(await recordOutcomes(db, MARKET, "2030-03-04")).toEqual({ written: 0 });
  });

  it("outcomeOf is pure: blocked on every arm only", () => {
    const row = (arm: "live" | "shadow", g: string | null) =>
      ({ code: "X", arm, firstFailGate: g }) as never;
    expect(outcomeOf("X", new Set(), [row("shadow", "G11"), row("live", "G03")], false)).toBe(
      "rejected:G11",
    );
    expect(outcomeOf("X", new Set(), [row("shadow", null), row("live", "G03")], false)).toBe(
      "rejected:rank",
    );
    expect(outcomeOf("X", new Set(), [], false)).toBe("not_in_universe");
  });
});

// ---- (e) replay identity ------------------------------------------------------------------------------------------

const TABLES = [
  "arena_order",
  "fill",
  "trade",
  "cash_ledger",
  "nav_daily",
  "nav_daily_pos",
  "sleeve_trade",
  "lesson",
  "cortex_decision",
];
async function dumpHash(db: Client): Promise<{ hash: string; decisions: number }> {
  let all = "";
  let decisions = 0;
  for (const t of TABLES) {
    const cols = (await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => String(r.name));
    const rs = await db.execute(
      `SELECT * FROM ${t} ORDER BY ${cols.map((_, i) => i + 1).join(", ")}`,
    );
    if (t === "cortex_decision") decisions = rs.rows.length;
    all += `${t}:${JSON.stringify(rs.rows.map((r) => cols.map((c) => String(r[c]))))}\n`;
  }
  return { hash: sha(all), decisions };
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
  // the DAT-234 list is loaded (an unrelated code): without it gate 8a fails closed (D-338)
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

const SESSION = DATES[D]!;
const CAND = ["ZZD1", "ZZD2", "ZZUP", "ZZ00", "ZZQQ"]; // ZZQQ: no universe row at all

async function world(withCandidates: boolean): Promise<Client> {
  const db = await freshReplayDb();
  await buildNight(db, { codes: goldenCodes() });
  await setMode(db, "full");
  await startCohortsAt(db, 296, ["E01", "E07"]);
  await seedCortex(db);
  if (withCandidates) for (const c of CAND) await insertCandidate(db, SESSION, c);
  await runNights(db, testParams(), 297, 301, undefined, { cortex: { angles: NIGHT_ANGLES } });
  return db;
}

describe("AT-61 (e): replay hash identical with and without candidates", () => {
  it("hashes equal; every candidate gets an outcome; the outcome step moves no engine byte", async () => {
    const off = await world(false);
    const on = await world(true);
    const a = await dumpHash(off);
    const b = await dumpHash(on);
    expect(b.hash).toBe(a.hash);
    expect(a.decisions).toBeGreaterThan(0);

    const w = await recordOutcomes(on, MARKET, SESSION);
    expect(w.written).toBe(CAND.length);
    const o = await outcomes(on, SESSION);
    for (const c of CAND) expect(o[c], c).not.toBeNull();
    expect(o.ZZQQ).toBe("not_in_universe");
    expect((await dumpHash(on)).hash).toBe(a.hash);
    expect(await recordOutcomes(on, MARKET, SESSION)).toEqual({ written: 0 });
  });
});
