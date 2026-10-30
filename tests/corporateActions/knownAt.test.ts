// @vitest-environment node
// GL-02 (D-207 item 2): corporate_action.known_at. Migration 0016 (set once, backfill), the engine
// writer (auto-confirm, Owner resolve), and the readers: an action confirmed on D+5 changes nothing
// for D..D+4 and applies from D+5. Synthetic ZZ* data only (SEC-110).
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { adjustBars, splitActionsByCode, splitsKnownOn } from "@/lib/agents/candidates";
import { decisionCutoffUtc } from "@/lib/agents/decisionView";
import { knownBy } from "@/lib/arena/corpActions";
import { loadConfirmedActions } from "@/lib/arena/corpActionWriter";
import { adjustedBars, effectiveFactors } from "@/lib/data/adjusted";
import { resolveAction, runCorporateActions } from "@/lib/data/corporateActions/engine.mjs";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { corpRecordsOf } from "@/lib/replay/snapshotWorld";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";
import { announced, caDb, D0, D1, D2, D3, D4, D5, D6, io, nowOf, putBar, rows } from "./helpers";

afterEach(cleanupTempDbs);

const split21 = { new: 2, old: 1 };
const HHMM = "18:10";
const owner = (
  db: Awaited<ReturnType<typeof caDb>>,
  id: number,
  decision: "confirm" | "reverse",
  d: string,
) =>
  resolveAction(db, {
    market: "AU",
    actionId: id,
    decision,
    by: "owner:1",
    now: nowOf(d),
    d,
    io: io(),
  });
/** The instant of the newest (confirming) event of an action. */
const eventAt = async (db: Awaited<ReturnType<typeof caDb>>, id: number) =>
  (
    await rows(db, "SELECT at FROM corporate_action_event WHERE action_id = ? ORDER BY id DESC", [
      id,
    ])
  )[0]!.at;
const knownAtOf = async (db: Awaited<ReturnType<typeof caDb>>, id: number) =>
  (await rows(db, "SELECT known_at FROM corporate_action WHERE id = ?", [id]))[0]!.known_at;

describe("migration 0016_known_at", () => {
  it("adds the column without a backfill (legacy rows stay NULL) and sets it once", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    await migrateDown(db, ms, 4); // 0019, 0018 and 0017 sit on top of 0016: the schema as of 0015
    expect(
      (await rows(db, "PRAGMA table_info(corporate_action)")).map((c) => c.name),
    ).not.toContain("known_at");
    const ins = (id: number, ex: string, status: string) =>
      db.batch([
        {
          sql: `INSERT INTO corporate_action (id, market, code, type, ex_date, payload_json)
                VALUES (?, 'AU', 'ZZA', 'split', ?, '{}')`,
          args: [id, ex],
        },
        {
          sql: "INSERT INTO corporate_action_event (action_id, at, status, by) VALUES (?, 't', ?, 'x')",
          args: [id, status],
        },
      ]);
    await ins(1, "2024-03-05", "auto_confirmed");
    await ins(2, "2024-07-01", "queued");
    await ins(3, "2024-08-02", "resolved");
    await migrateUp(db, ms);
    expect(await rows(db, "SELECT id, known_at FROM corporate_action ORDER BY id")).toEqual([
      { id: 1, known_at: null },
      { id: 2, known_at: null },
      { id: 3, known_at: null },
    ]);
    // known_at may be set once from NULL; nothing else on the row changes, and it never moves
    await db.execute(
      "UPDATE corporate_action SET known_at = '2026-01-01T00:00:00.000Z' WHERE id = 2",
    );
    await expect(
      db.execute("UPDATE corporate_action SET known_at = '2026-01-02T00:00:00.000Z' WHERE id = 2"),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.execute("UPDATE corporate_action SET code = 'ZZB' WHERE id = 1"),
    ).rejects.toThrow(/append-only/);
    await expect(db.execute("DELETE FROM corporate_action WHERE id = 1")).rejects.toThrow(
      /append-only/,
    );
    // down restores the strict trigger; up again works (0018 and 0017 first, then 0016)
    await migrateDown(db, ms, 4);
    await expect(
      db.execute("UPDATE corporate_action SET code = 'ZZB' WHERE id = 1"),
    ).rejects.toThrow(/append-only/);
    await migrateUp(db, ms);
  });
});

describe("engine writer", () => {
  it("auto-confirm stamps known_at with the confirming event; a queued item gets it at the Owner click", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 5.1);
    await putBar(db, "ZZB", D0, 10);
    await putBar(db, "ZZB", D1, 5.1);
    await runCorporateActions({
      db,
      market: "AU",
      d: D1,
      io: io(),
      now: nowOf(D1),
      candidates: [announced("ZZA", "split", D1, split21)] as never,
    });
    expect(await knownAtOf(db, 1)).toBe(await eventAt(db, 1));

    // a vendor-only reading queues; it has no known_at until the Owner confirms (a later night)
    await runCorporateActions({
      db,
      market: "AU",
      d: D1,
      io: io(),
      now: nowOf(D1),
      candidates: [
        { code: "ZZB", type: "split", ex_date: D1, payload: split21, source: "vendor" },
      ] as never,
    });
    expect(await knownAtOf(db, 2)).toBe(null);
    expect((await owner(db, 2, "confirm", D5)).ok).toBe(true);
    expect(await knownAtOf(db, 2)).toBe(nowOf(D5));
    // a reversal never re-dates it
    expect((await owner(db, 2, "reverse", D6)).ok).toBe(true);
    expect(await knownAtOf(db, 2)).toBe(nowOf(D5));
  });
});

describe("readers use only actions known at the cut-off", () => {
  // ex-date D1, confirmed on the evening of D5
  async function lateSplit() {
    const db = await caDb();
    for (const d of [D0, D1, D2, D3, D4, D5]) await putBar(db, "ZZA", d, d === D0 ? 10 : 5.1);
    await runCorporateActions({
      db,
      market: "AU",
      d: D5,
      io: io(),
      now: nowOf(D5),
      candidates: [announced("ZZA", "split", D1, split21)] as never,
    });
    return db;
  }

  it("adjustedBars: nothing before the confirmation, the factor from D6's cut-off on", async () => {
    const db = await lateSplit();
    expect(await knownAtOf(db, 1)).toBe(await eventAt(db, 1));
    expect(String(await knownAtOf(db, 1)).slice(0, 19)).toBe(nowOf(D5).slice(0, 19)); // 18:30 Melbourne on D5, after its 18:10 cut-off
    for (const d of [D1, D2, D3, D4, D5]) {
      const bars = await adjustedBars(db, "ZZA", D0, d, {
        asOf: d,
        knownBy: decisionCutoffUtc(d, HHMM),
      });
      expect(bars[0]!.c).toBe(10); // unadjusted, as when D..D+4 were decided
      expect(bars[0]!.factor).toBe(1);
    }
    const d6 = await adjustedBars(db, "ZZA", D0, D5, {
      asOf: D6,
      knownBy: decisionCutoffUtc(D6, HHMM),
    });
    expect(d6[0]!.c).toBe(5);
    // without a cut-off the reader is unchanged (the DAT-126 ex-date bound only)
    expect((await adjustedBars(db, "ZZA", D0, D5))[0]!.c).toBe(5);
    expect(await effectiveFactors(db, "ZZA", "AU", decisionCutoffUtc(D4, HHMM))).toEqual([]);
    expect(await effectiveFactors(db, "ZZA", "AU", decisionCutoffUtc(D6, HHMM))).toHaveLength(1);
  });

  it("loadConfirmedActions carries known_at; knownBy and splitsKnownOn drop the late action", async () => {
    const db = await lateSplit();
    const actions = await loadConfirmedActions(db, "AU", D6);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.knownAt).toBe(await eventAt(db, 1));
    expect(knownBy(actions, decisionCutoffUtc(D4, HHMM))).toEqual([]);
    expect(knownBy(actions, decisionCutoffUtc(D6, HHMM))).toHaveLength(1);
    const splits = splitActionsByCode(actions).byCode.get("ZZA")!;
    for (const d of [D1, D2, D3, D4, D5]) expect(splitsKnownOn(splits, d, HHMM)).toEqual([]);
    expect(splitsKnownOn(splits, D6, HHMM)).toHaveLength(1);
    // the replay view of D4 builds the same bars as before the split existed
    const raw = [D0, D1, D2].map((d) => ({
      d,
      open: 10_000_000n,
      high: 10_000_000n,
      low: 10_000_000n,
      close: 10_000_000n,
      volume: 1000n,
    }));
    expect(adjustBars(raw, splitsKnownOn(splits, D4, HHMM)).map((b) => b.close)).toEqual(
      raw.map((b) => b.close),
    );
    expect(adjustBars(raw, splitsKnownOn(splits, D6, HHMM))[0]!.close).not.toBe(10_000_000n);
  });

  it("legacy NULL rows are known at every cut-off, as before the column existed", async () => {
    // a pre-0016 row: known_at NULL
    const legacy = await caDb();
    for (const d of [D0, D1, D2]) await putBar(legacy, "ZZA", d, d === D0 ? 10 : 5.1);
    await legacy.batch([
      {
        sql: "INSERT INTO corporate_action (id, market, code, type, ex_date, payload_json) VALUES (1, 'AU', 'ZZA', 'split', ?, '{\"new\":2,\"old\":1}')",
        args: [D1],
      },
      {
        sql: "INSERT INTO corporate_action_event (action_id, at, status, by) VALUES (1, ?, 'auto_confirmed', 'x')",
        args: [nowOf(D1)],
      },
      {
        sql: "INSERT INTO adjustment_factor (market, code, ex_date, factor, corporate_action_id, computed_at) VALUES ('AU', 'ZZA', ?, 0.5, 1, ?)",
        args: [D1, nowOf(D1)],
      },
    ]);
    expect(await knownAtOf(legacy, 1)).toBe(null);
    // known at the cut-off of the evening BEFORE its ex-date, exactly as today
    const bars = await adjustedBars(legacy, "ZZA", D0, D0, {
      asOf: D1,
      knownBy: decisionCutoffUtc(D0, HHMM),
    });
    expect(bars[0]!.c).toBe(5);
    const actions = await loadConfirmedActions(legacy, "AU", D1);
    expect(knownBy(actions, decisionCutoffUtc(D0, HHMM))).toHaveLength(1);
    // a later run (settle) does not stamp an old confirmation either
    await runCorporateActions({ db: legacy, market: "AU", d: D2, io: io(), now: nowOf(D2) });
    expect(await knownAtOf(legacy, 1)).toBe(null);
  });

  it("legacy records (known_at null or absent) behave as before", () => {
    const rec = [
      { id: "1", code: "ZZA", type: "split", exDate: D1, payload: split21, knownAt: null },
      { id: "2", code: "ZZA", type: "split", exDate: D2, payload: split21 },
      {
        id: "3",
        code: "ZZA",
        type: "split",
        exDate: D3,
        payload: split21,
        knownAt: "2026-10-14T13:00:00.000Z",
      },
    ];
    const splits = splitActionsByCode(rec).byCode.get("ZZA")!;
    expect(splitsKnownOn(splits, D3, HHMM)).toHaveLength(3);
    expect(splitsKnownOn(splits, D2, HHMM)).toHaveLength(2);
    expect(splitsKnownOn(splits, D1, HHMM)).toHaveLength(1);
  });

  it("snapshot rows carry known_at into the replay records", () => {
    const snap = {
      corporateActions: [
        { code: "ZZA", ex_date: D1, action_id: 1, type: "split", factor: 0.5, known_at: nowOf(D5) },
        { code: "ZZA", ex_date: D2, action_id: 2, type: "split", factor: 0.5 },
      ],
    } as never;
    expect(corpRecordsOf(snap).map((r) => r.knownAt)).toEqual([nowOf(D5), null]);
  });
});
