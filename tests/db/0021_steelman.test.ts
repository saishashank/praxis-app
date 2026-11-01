// @vitest-environment node
// Migration 0021_steelman (M11-lite WP2; docs/M11L_design.md "Schema"): applies, rolls back and comes back
// identical; every trigger fires (append-only tables, the point and suggestion insert guards, the suggestion
// status guard, the pick_market insert guard and its immutability). Synthetic ZZ data only (SEC-110).
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import {
  closeSuggestion,
  insertNight,
  insertPack,
  insertPoint,
  insertSuggestion,
  listPacks,
  pointIdOf,
  readNight,
  readNights,
  readOpenSuggestions,
  readPack,
  readPackForCard,
  readPackForSubject,
  readPoints,
  readShownPoints,
  readSuggestion,
  type PackRow,
  type PointRow,
} from "@/lib/steelman/store";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const NEW_TABLES = [
  "steelman_pack",
  "steelman_point",
  "steelman_night",
  "steelman_suggestion",
  "pick_market",
  "pick_reflection",
];
const PACK_ID = "a".repeat(64);
const SHA = "b".repeat(64);

const pack = (over: Partial<PackRow> = {}): PackRow => ({
  packId: PACK_ID,
  market: "ZZ",
  d: "2030-03-05",
  subjectKind: "order",
  subjectId: "card1",
  code: "ZZA",
  cardId: "card1",
  cutoffAt: "2030-03-04T23:00:00.000Z",
  items: [
    { id: "E01", kind: "card", text: "Signal rank 3" },
    { id: "E02", kind: "event", text: "Results due", at: "2030-03-04T01:00:00.000Z" },
  ],
  itemCount: 2,
  createdAt: "2030-03-05T08:00:00.000Z",
  ...over,
});

const point = (side: "bull" | "bear", n: number, over: Partial<PointRow> = {}): PointRow => ({
  pointId: pointIdOf(PACK_ID, side, n),
  packId: PACK_ID,
  side,
  n,
  text: "A short claim citing the evidence.",
  citations: ["E01"],
  monitorable: false,
  state: "shown",
  authorProvider: "pa",
  authorModel: "ma",
  criticProvider: "pc",
  criticModel: "mc",
  criticNote: null,
  createdAt: "2030-03-05T08:00:01.000Z",
  ...over,
});

const night = {
  market: "ZZ",
  d: "2030-03-05",
  requested: 8,
  written: 5,
  notWrittenLimit: 1,
  notWrittenBudget: 1,
  notWrittenNoModel: 1,
  notWrittenCritic: 0,
  claimsTotal: 40,
  claimsValid: 39,
  validityPpm: 975_000,
  criticHidden: 2,
  createdAt: "2030-03-05T08:05:00.000Z",
};

const fails = async (db: Client, sql: string): Promise<string> => {
  try {
    await db.execute(sql);
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error(`expected to fail: ${sql}`);
};

/** A pick, its luck twin's outcome rows in the given states (edges taken through the real guards). */
async function outcome(
  db: Client,
  profile: string,
  rank: number,
  state: "waiting" | "closed" | "missed",
) {
  await db.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
       reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm,
       typical_ppm, good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json,
       pick_sha, created_at)
     VALUES ('ZZ', '2030-03-05', ?, ?, 'ZZA1', 'F1', 'U1', 'F1.v1', 'sig', 'UNVALIDATED', 10000000, 10050000,
       '2030-03-08', 9200000, 11000000, 50, -60000, 20000, 110000, 4, 1000000000, 100000000, '[]', '[]', ?,
       '2030-03-05T07:00:00.000Z')`,
    args: [profile, rank, SHA],
  });
  await db.execute({
    sql: `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
          VALUES ('ZZ', '2030-03-05', ?, ?, 'pick', 'ZZA1', ?, 'waiting', '2030-03-05')`,
    args: [profile, rank, SHA],
  });
  const where = "market = 'ZZ' AND d = '2030-03-05' AND profile = ? AND rank = ? AND kind = 'pick'";
  if (state === "missed") {
    await db.execute({
      sql: `UPDATE pick_outcome SET state = 'missed', updated_d = '2030-03-06' WHERE ${where}`,
      args: [profile, rank],
    });
  } else if (state === "closed") {
    await db.execute({
      sql: `UPDATE pick_outcome SET state = 'bought', entry_d = '2030-03-06', entry_micro = 10000000,
              updated_d = '2030-03-06' WHERE ${where}`,
      args: [profile, rank],
    });
    await db.execute({
      sql: `UPDATE pick_outcome SET state = 'closed', exit_d = '2030-03-08', exit_micro = 10500000,
              exit_reason = 'time_frame', net_micro = 500000, net_ppm = 50000, updated_d = '2030-03-08'
            WHERE ${where}`,
      args: [profile, rank],
    });
  }
}

const marketRow = (profile: string, rank: number) =>
  `INSERT INTO pick_market (market, d, profile, rank, kind, window_from_d, window_to_d, index_code, basis,
     index_from_micro, index_to_micro, market_ret_ppm, pick_net_ppm, vs_market_ppm, missed, settled_d)
   VALUES ('ZZ', '2030-03-05', '${profile}', ${rank}, 'pick', '2030-03-05', '2030-03-08', 'ZZIDX',
     'total_return', 100000000, 101000000, 10000, 50000, 40000, 0, '2030-03-08')`;

describe("migration 0021_steelman: apply, roll back, apply again", () => {
  it("creates the six tables, rolls back to 0020 and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    for (const t of NEW_TABLES) expect(after.some((s) => s.startsWith(`table:${t}:`))).toBe(true);

    expect(await migrateDown(db, ms, 3)).toEqual({ rolledBack: 3, version: 20 });
    const mid = await schemaOf(db);
    for (const t of NEW_TABLES) expect(mid.some((s) => s.startsWith(`table:${t}:`))).toBe(false);

    expect(await migrateUp(db, ms)).toEqual({ applied: 3, version: 23 });
    expect(await schemaOf(db)).toEqual(after);
  });
});

describe("steelman store and triggers", () => {
  it("round-trips pack, points, night and suggestion; inserts are idempotent", async () => {
    const db = await freshDb("main");
    expect((await insertPack(db, pack())).inserted).toBe(true);
    expect((await insertPack(db, pack())).inserted).toBe(false);
    expect(await readPack(db, PACK_ID)).toEqual(pack());
    expect(await readPackForSubject(db, "ZZ", "2030-03-05", "order", "card1")).toEqual(pack());
    expect(await readPackForCard(db, "card1")).toEqual(pack());
    expect(await listPacks(db, "ZZ", "2030-03-05")).toHaveLength(1);

    const bear = point("bear", 1, { monitorable: true });
    expect((await insertPoint(db, point("bull", 1))).inserted).toBe(true);
    expect((await insertPoint(db, bear)).inserted).toBe(true);
    expect((await insertPoint(db, bear)).inserted).toBe(false);
    await insertPoint(db, point("bear", 2, { state: "hidden_critic", criticNote: "unsupported" }));
    expect(await readPoints(db, PACK_ID)).toHaveLength(3);
    expect((await readShownPoints(db, PACK_ID)).map((p) => p.pointId)).toEqual([
      pointIdOf(PACK_ID, "bear", 1),
      pointIdOf(PACK_ID, "bull", 1),
    ]);

    expect((await insertNight(db, night)).inserted).toBe(true);
    expect((await insertNight(db, night)).inserted).toBe(false);
    expect(await readNight(db, "ZZ", "2030-03-05")).toEqual(night);
    expect(await readNights(db, "ZZ", 5)).toHaveLength(1);

    const s = {
      market: "ZZ",
      d: "2030-03-05",
      pointId: bear.pointId,
      cardId: "card1",
      code: "ZZA",
      family: "F1",
      createdAt: "2030-03-05T08:06:00.000Z",
    };
    expect((await insertSuggestion(db, s)).inserted).toBe(true);
    expect((await insertSuggestion(db, s)).inserted).toBe(false);
    expect((await readOpenSuggestions(db, "ZZ")).map((x) => x.suggestionId)).toEqual([
      bear.pointId,
    ]);
    expect(
      await closeSuggestion(db, bear.pointId, "dismissed", "2030-03-06T00:00:00.000Z", "u1"),
    ).toBe(true);
    expect(
      await closeSuggestion(db, bear.pointId, "expired", "2030-03-07T00:00:00.000Z", "system"),
    ).toBe(false);
    expect(await readOpenSuggestions(db, "ZZ")).toHaveLength(0);
    expect(await readSuggestion(db, bear.pointId)).toMatchObject({
      status: "dismissed",
      closedBy: "u1",
    });
  });

  it("pack, point and night rows are append-only; a point needs its pack", async () => {
    const db = await freshDb("main");
    await insertPack(db, pack());
    await insertPoint(db, point("bull", 1));
    await insertNight(db, night);
    for (const sql of [
      "UPDATE steelman_pack SET code = 'X'",
      "DELETE FROM steelman_pack",
      "UPDATE steelman_point SET text = 'x'",
      "DELETE FROM steelman_point",
      "UPDATE steelman_night SET written = 9",
      "DELETE FROM steelman_night",
    ]) {
      expect(await fails(db, sql)).toMatch(/append-only/);
    }
    const orphan = point("bull", 2, { packId: "c".repeat(64), pointId: "c:bull:2" });
    await expect(insertPoint(db, orphan)).rejects.toThrow(/needs its steelman_pack/);
  });

  it("checks: one pack per subject, bull is never monitorable, citations non-empty", async () => {
    const db = await freshDb("main");
    await insertPack(db, pack());
    expect(
      await fails(
        db,
        `INSERT INTO steelman_pack SELECT '${"d".repeat(64)}', market, d, subject_kind, subject_id, code, card_id, cutoff_at, items_json, item_count, created_at FROM steelman_pack`,
      ),
    ).toMatch(/UNIQUE/);
    await expect(insertPoint(db, point("bull", 1, { monitorable: true }))).rejects.toThrow(/CHECK/);
    await expect(insertPoint(db, point("bull", 1, { citations: [] }))).rejects.toThrow(/CHECK/);
    await expect(insertPoint(db, point("bull", 1, { state: "weird" as never }))).rejects.toThrow(
      /CHECK/,
    );
  });

  it("the suggestion insert guard needs a shown, monitorable bear point", async () => {
    const db = await freshDb("main");
    await insertPack(db, pack());
    await insertPoint(db, point("bull", 1));
    await insertPoint(db, point("bear", 1)); // not monitorable
    await insertPoint(db, point("bear", 2, { monitorable: true, state: "hidden_critic" }));
    await insertPoint(db, point("bear", 3, { monitorable: true }));
    const mk = (pointId: string) => ({
      market: "ZZ",
      d: "2030-03-05",
      pointId,
      cardId: null,
      code: "ZZA",
      family: "F1",
      createdAt: "t",
    });
    for (const n of [
      pointIdOf(PACK_ID, "bull", 1),
      pointIdOf(PACK_ID, "bear", 1),
      pointIdOf(PACK_ID, "bear", 2),
      "nope",
    ]) {
      await expect(insertSuggestion(db, mk(n))).rejects.toThrow(
        /needs a shown monitorable bear point/,
      );
    }
    expect((await insertSuggestion(db, mk(pointIdOf(PACK_ID, "bear", 3)))).inserted).toBe(true);
    expect(
      await fails(
        db,
        `INSERT INTO steelman_suggestion (suggestion_id, market, d, point_id, code, family,
      status, created_at) VALUES ('other', 'ZZ', '2030-03-05', '${pointIdOf(PACK_ID, "bear", 3)}', 'ZZA', 'F1',
      'open', 't')`,
      ),
    ).toMatch(/CHECK/);
  });

  it("the suggestion status guard: open moves once, only status/closed_*, never deleted", async () => {
    const db = await freshDb("main");
    await insertPack(db, pack());
    const id = pointIdOf(PACK_ID, "bear", 1);
    await insertPoint(db, point("bear", 1, { monitorable: true }));
    await insertSuggestion(db, {
      market: "ZZ",
      d: "2030-03-05",
      pointId: id,
      cardId: "card1",
      code: "ZZA",
      family: "F1",
      createdAt: "t0",
    });
    const guard = /an open row moves once/;
    // another column while still open: refused
    expect(await fails(db, "UPDATE steelman_suggestion SET family = 'F2'")).toMatch(guard);
    expect(await fails(db, "UPDATE steelman_suggestion SET code = 'ZZB'")).toMatch(guard);
    // closing with the status columns is the one allowed move
    await db.execute(
      "UPDATE steelman_suggestion SET status = 'expired', closed_at = 't1', closed_by = 'system'",
    );
    // a closed row is frozen: no reopen, no second close, no column edit
    expect(
      await fails(
        db,
        "UPDATE steelman_suggestion SET status = 'open', closed_at = NULL, closed_by = NULL",
      ),
    ).toMatch(guard);
    expect(
      await fails(db, "UPDATE steelman_suggestion SET status = 'dismissed', closed_by = 'u1'"),
    ).toMatch(guard);
    expect(await fails(db, "UPDATE steelman_suggestion SET family = 'F2'")).toMatch(guard);
    expect(await fails(db, "DELETE FROM steelman_suggestion")).toMatch(/append-only/);
    // an open row cannot close without closed_* (CHECK) and cannot carry them while open
    const db2 = await freshDb("main");
    await insertPack(db2, pack());
    await insertPoint(db2, point("bear", 1, { monitorable: true }));
    await insertSuggestion(db2, {
      market: "ZZ",
      d: "2030-03-05",
      pointId: id,
      cardId: null,
      code: "ZZA",
      family: "F1",
      createdAt: "t0",
    });
    expect(await fails(db2, "UPDATE steelman_suggestion SET status = 'dismissed'")).toMatch(
      /CHECK/,
    );
  });

  it("pick_market: insert guard needs a closed or missed outcome; update and delete are refused", async () => {
    const db = await freshDb("main");
    await outcome(db, "balanced", 1, "closed");
    await outcome(db, "balanced", 2, "missed");
    await outcome(db, "balanced", 3, "waiting");

    // waiting outcome and no outcome at all: refused
    expect(await fails(db, marketRow("balanced", 3))).toMatch(
      /needs a closed or missed pick_outcome/,
    );
    expect(await fails(db, marketRow("bold", 1))).toMatch(/needs a closed or missed pick_outcome/);
    // the luck twin has no outcome row here: refused by the same key
    expect(
      await fails(db, marketRow("balanced", 1).replace("'pick', '2030", "'luck', '2030")),
    ).toMatch(/needs a closed or missed pick_outcome/);

    await db.execute(marketRow("balanced", 1));
    await db.execute(`INSERT INTO pick_market (market, d, profile, rank, kind, window_from_d, window_to_d,
      index_code, basis, index_from_micro, index_to_micro, market_ret_ppm, pick_net_ppm, vs_market_ppm, missed,
      settled_d) VALUES ('ZZ', '2030-03-05', 'balanced', 2, 'pick', '2030-03-05', '2030-03-06', 'ZZIDX',
      'price_only', 100000000, 100500000, 5000, NULL, NULL, 1, '2030-03-06')`);

    // consistency: a missed row has no pick result, a settled row has one
    expect(
      await fails(
        db,
        `INSERT INTO pick_market (market, d, profile, rank, kind, window_from_d, window_to_d,
      index_code, basis, index_from_micro, index_to_micro, market_ret_ppm, pick_net_ppm, vs_market_ppm, missed,
      settled_d) VALUES ('ZZ', '2030-03-05', 'balanced', 2, 'luck', '2030-03-05', '2030-03-06', 'ZZIDX',
      'price_only', 1, 1, 0, 1, 1, 1, '2030-03-06')`,
      ),
    ).toMatch(/CHECK|needs a closed/);
    expect(await fails(db, "UPDATE pick_market SET vs_market_ppm = 0")).toMatch(/append-only/);
    expect(await fails(db, "UPDATE pick_market SET basis = 'price_only'")).toMatch(/append-only/);
    expect(await fails(db, "DELETE FROM pick_market")).toMatch(/append-only/);
    expect(await fails(db, marketRow("balanced", 1))).toMatch(/UNIQUE|PRIMARY/);
  });

  it("pick_reflection is append-only", async () => {
    const db = await freshDb("main");
    await db.execute(`INSERT INTO pick_reflection (market, d, profile, rank, text, state, created_at)
      VALUES ('ZZ', '2030-03-05', 'balanced', 1, 'Looked back.', 'written', 't')`);
    expect(await fails(db, "UPDATE pick_reflection SET text = 'x'")).toMatch(/append-only/);
    expect(await fails(db, "DELETE FROM pick_reflection")).toMatch(/append-only/);
    expect(
      await fails(
        db,
        `INSERT INTO pick_reflection (market, d, profile, rank, text, state, created_at)
      VALUES ('ZZ', '2030-03-05', 'balanced', 2, '', 'written', 't')`,
      ),
    ).toMatch(/CHECK/);
  });
});
