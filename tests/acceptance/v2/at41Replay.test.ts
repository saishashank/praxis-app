// @vitest-environment node
// AT-41 (M13-lite WP7; PRD-035, D-525, D-642): expert data never changes a decision. The golden ZZ world of
// AT-61 (e) is replayed twice: with every expert table empty, and with the full ZZ seed present (experts,
// items, claims, clusters, a tracked call), a screening run with results, a proposal and a settled call
// already in the database BEFORE the nights run, and the weekly steps that write (call settlement and the KB
// documents) run after them. The sha256 of the ordered dumps of every table of the main database is identical
// except the expert tables, the `experts` replay_stat and the expert documents (D-586 style: the proof is the
// complement of a short allowlist, so a new decision, book, learning or Cortex table is covered the day it
// is created). The expert side was not empty, so the equality is not vacuous. Synthetic ZZ data only (SEC-110).
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { settleCalls } from "@/lib/experts/calls";
import { insertClaim } from "@/lib/experts/store";
import { EXPERT_TABLES } from "@/lib/experts/types";
import { syncExpertDocs } from "@/lib/experts/weeklyStage";
import {
  DATES,
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
import { addOutcome, addProposal, addScreening, importZzSeed } from "../../experts/zzWorld";

vi.setConfig({ testTimeout: 480000, hookTimeout: 480000 });
afterAll(cleanupTempDbs);

const sha = (t: string): string => createHash("sha256").update(t).digest("hex");

/** The only tables the expert side may move (D-525): the expert tables themselves. */
const EXPERT_OWN = new Set<string>(EXPERT_TABLES);

/**
 * Rows of a shared table that are the expert side's: the experts stage's one replay_stat, and the KB mirror
 * (knowledge/common/experts and knowledge/common/techniques). The rest of those tables is hashed.
 */
const ROW_FILTER: Record<string, string> = {
  replay_stat: "metric <> 'experts'",
  document:
    "path NOT LIKE 'knowledge/common/experts/%' AND path NOT LIKE 'knowledge/common/techniques/%'",
};

/** Decision, order, book, pick, lesson, rule and Cortex tables that must be in the scan. */
const NAMED = [
  "signal",
  "decision_card",
  "arena_order",
  "fill",
  "trade",
  "cash_ledger",
  "nav_daily",
  "sleeve_trade",
  "stop_level",
  "lesson",
  "rule_version",
  "rule_version_status",
  "challenger",
  "trial_ledger",
  "family_status",
  "pick",
  "pick_outcome",
  "cortex_decision",
  "document",
  "replay_stat",
];

/** Wallclock columns the migrations stamp with the real clock; the column is dropped, the table stays. */
const WALLCLOCK: Record<string, readonly string[]> = {
  schema_migrations: ["applied_at"],
  source_register_history: ["changed_at"],
  cortex_night: ["runtime_ms"],
};

async function hashedTables(db: Client): Promise<string[]> {
  const r = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const names = r.rows.map((x) => String(x.name)).filter((n) => !EXPERT_OWN.has(n));
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
    const where = ROW_FILTER[t] === undefined ? "" : ` WHERE ${ROW_FILTER[t]}`;
    const rs = await db.execute(
      `SELECT ${cols.join(", ")} FROM ${t}${where} ORDER BY ${cols.map((_, i) => i + 1).join(", ")}`,
    );
    rows[t] = rs.rows.length;
    const text = `${t}:${JSON.stringify(rs.rows.map((r) => cols.map((c) => String(r[c]))))}\n`;
    perTable[t] = sha(text);
    all += text;
  }
  return { hash: sha(all), rows, perTable };
}

const differing = (a: Dump, b: Dump): string[] =>
  [...new Set([...Object.keys(a.perTable), ...Object.keys(b.perTable)])]
    .filter((t) => a.perTable[t] !== b.perTable[t])
    .sort();

const one = async (db: Client, sql: string): Promise<number> =>
  Number((await db.execute(sql)).rows[0]!.n ?? 0);
const count = (db: Client, table: string): Promise<number> =>
  one(db, `SELECT COUNT(*) AS n FROM ${table}`);

const AT = "2030-01-01T00:00:00.000Z";

/** A tracked call on a golden code, dated well before the replayed nights, so settlement has bars. */
async function addGoldenCall(db: Client): Promise<void> {
  await insertClaim(db, {
    id: "C-ZZ-F41",
    type: "call",
    testability: "testable_eod",
    clusterId: null,
    statement: "ZZ call on a golden code",
    actor: "seed",
    at: AT,
  });
  await db.execute({
    sql: `INSERT INTO expert_call (claim_id, market, code, direction, call_d, horizon_sessions, target_micro,
            stop_micro, tracked, created_at) VALUES ('C-ZZ-F41', ?, 'ZZD1', 'long', ?, 5, NULL, NULL, 1, ?)`,
    args: [MARKET, DATES[290]!, AT],
  });
}

async function seedExperts(db: Client): Promise<void> {
  await importZzSeed(db);
  await addGoldenCall(db);
  await addScreening(db, {
    market: MARKET,
    d: DATES[296]!,
    clusterIds: ["K-ZZ1", "K-ZZ2", "K-ZZ3"],
  });
  await addProposal(db, { market: MARKET, d: DATES[296]!, clusterId: "K-ZZ1", status: "refused" });
  await addOutcome(db);
  await db.execute({
    sql: "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES ('zz-experts-run', ?, 'experts', ?, ?)",
    args: [
      MARKET,
      DATES[296]!,
      JSON.stringify({ degraded: ["degraded:docs"], f7: { fires: true }, parked: 0 }),
    ],
  });
}

async function world(withExperts: boolean): Promise<{ db: Client }> {
  const db = await freshReplayDb();
  await buildNight(db, { codes: goldenCodes() });
  await setMode(db, "full");
  await startCohortsAt(db, 296, ["E01", "E07"]);
  if (withExperts) await seedExperts(db); // present BEFORE the nights: the replay runs beside the expert data
  await runNights(db, testParams(), 297, 301);
  if (withExperts) {
    // the weekly steps that write, as the experts stage runs them
    const settle = await settleCalls(db, MARKET, DATES[301]!, DATES);
    expect(settle.settled).toBeGreaterThanOrEqual(1);
    const docs = await syncExpertDocs(db, { d: DATES[301]!, now: `${DATES[301]}T00:00:00.000Z` });
    expect(docs.written).toBe(12);
  }
  return { db };
}

describe("AT-41: replay hash identical with expert data absent and present", () => {
  it("hashes equal; the expert side was not empty (c)", async () => {
    const empty = await world(false);
    const full = await world(true);
    const a = await dumpHash(empty.db);
    const b = await dumpHash(full.db);

    // the world is not empty: signals, cards, orders and decisions exist
    expect(a.rows.signal).toBeGreaterThan(0);
    expect(a.rows.arena_order).toBeGreaterThan(0);
    expect(a.rows.nav_daily).toBeGreaterThan(0);
    expect(Object.keys(a.rows).length).toBeGreaterThan(NAMED.length);

    expect(differing(a, b), "tables moved by the expert side").toEqual([]);
    expect(b.hash).toBe(a.hash);
    expect(b.rows).toEqual(a.rows);

    // non-vacuous: the empty world has no expert row, the full world has all of these
    for (const t of EXPERT_TABLES) expect(await count(empty.db, t), `${t} empty`).toBe(0);
    expect(await count(full.db, "expert")).toBe(6);
    expect(await count(full.db, "claim")).toBe(21);
    expect(await count(full.db, "cluster")).toBe(5);
    expect(await count(full.db, "screening_run")).toBe(1);
    expect(await count(full.db, "screening_result")).toBe(3);
    expect(await count(full.db, "expert_proposal")).toBe(1);
    expect(await count(full.db, "expert_call_outcome")).toBe(2);
    expect(
      await one(
        full.db,
        "SELECT COUNT(*) AS n FROM document WHERE path LIKE 'knowledge/common/experts/%'",
      ),
    ).toBe(7);
    expect(
      await one(full.db, "SELECT COUNT(*) AS n FROM replay_stat WHERE metric = 'experts'"),
    ).toBe(1);
    // and no expert document in the empty world
    expect(
      await one(
        empty.db,
        "SELECT COUNT(*) AS n FROM document WHERE path LIKE 'knowledge/common/%experts/%'",
      ),
    ).toBe(0);
  });

  it("settlement used the golden bars: the call is a real paper outcome, never an order", async () => {
    const { db } = await world(true);
    const o = (await db.execute("SELECT * FROM expert_call_outcome WHERE claim_id = 'C-ZZ-F41'"))
      .rows[0]!;
    expect(o.state).toBe("closed_horizon");
    expect(o.entry_d).toBe(DATES[291]);
    expect(o.exit_d).toBe(DATES[296]);
    expect(o.index_code).toBe("AXJO");
    expect(o.vs_market_ppm).not.toBeNull();
    expect(o.luck_pct).not.toBeNull(); // the golden universe has both closes
  });

  it("a second run of the weekly steps moves nothing, and the hash holds", async () => {
    const { db } = await world(true);
    const before = await dumpHash(db);
    const outcomes = await count(db, "expert_call_outcome");
    const docs = await count(db, "document");
    const settle = await settleCalls(db, MARKET, DATES[301]!, DATES);
    expect(settle.settled).toBe(0);
    const again = await syncExpertDocs(db, { d: DATES[302]!, now: `${DATES[302]}T00:00:00.000Z` });
    expect(again.written).toBe(0);
    expect(await count(db, "expert_call_outcome")).toBe(outcomes);
    expect(await count(db, "document")).toBe(docs);
    const after = await dumpHash(db);
    expect(differing(before, after)).toEqual([]);
    expect(after.hash).toBe(before.hash);
  });
});
