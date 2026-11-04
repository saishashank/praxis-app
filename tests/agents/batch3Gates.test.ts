// @vitest-environment node
// D-873 / D-874 / D-878 branches of batch 3 on the batch 2b golden world: the forward-ledger catch-up
// cap spares only context days before the write zone; the nightly rank-IC rebuild is gated by
// `review_rank_ic_nightly` on a live night (a replay always computes); `onStage` reports every stage.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewDay } from "@/lib/agents/batch3";
import { loadDayCandidates, syncForwardLedger } from "@/lib/agents/forwardLedger";
import { ARENA_MASTER_SEED, loadCalendar } from "@/lib/arena/closeBooks";
import { setConfig } from "@/lib/config/store";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  MARKET,
  NOW,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "./batch2bHarness";
import { buildGolden } from "./batch2bScenario";

vi.setConfig({ testTimeout: 300000, hookTimeout: 600000 });

const HOURS = { tz: "Australia/Sydney", open_time: "10:00", close_time: "16:00" };
const KEEP = ["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"];
const params = testParams();
const FIRST = 295;
const LAST = 300;
const CAP_LAST = 320; // the signals of this world sit on sessions 301, 303 and 312

async function world(last: number): Promise<Client> {
  const db = await freshReplayDb();
  await buildGolden(db);
  await setMode(db, "full");
  await startCohortsAt(db, FIRST, KEEP);
  await runNights(db, params, FIRST, last, async () => undefined);
  return db;
}

afterAll(cleanupTempDbs);

describe("forward-ledger catch-up cap (D-873)", () => {
  let db: Client;
  beforeAll(async () => {
    db = await world(CAP_LAST);
  });

  it("rebuilds the capped number of context days, every write-zone day and tonight", async () => {
    const calendar = await loadCalendar(db, MARKET);
    const d = DATES[CAP_LAST]!;
    const sync = await syncForwardLedger(db, {
      market: MARKET,
      d,
      calendar,
      hours: HOURS,
      params,
      replay: true,
      masterSeed: ARENA_MASTER_SEED,
      reach: 4,
      maxCatchUp: 1,
    });
    // reach 4: window = sessions 312..320, context days 312..315, write zone 316..320
    expect(sync).toMatchObject({ windowSessions: 9, candidatesRebuilt: 6 });
    const stored = await loadDayCandidates(db, MARKET, DATES.slice(CAP_LAST - 8, CAP_LAST + 1));
    // the cap spares all but one context day; the write zone and tonight are always rebuilt
    expect([...stored.keys()].sort()).toEqual(
      [CAP_LAST - 8, ...[4, 3, 2, 1, 0].map((k) => CAP_LAST - k)].map((i) => DATES[i]!).sort(),
    );
  });
});

describe("batch 3 stage timing and the rank-IC gate (D-874, D-878)", () => {
  let db: Client;
  const stages = new Map<string, string[]>();
  const review = async (day: string, replay: boolean) => {
    const seen: string[] = [];
    stages.set(day, seen);
    return reviewDay(db, {
      market: MARKET,
      d: day,
      replay,
      now: NOW,
      params,
      masterSeed: ARENA_MASTER_SEED,
      onStage: (stage, ms, note) => {
        expect(ms).toBeGreaterThanOrEqual(0);
        seen.push(note === undefined ? stage : `${stage} ${note}`);
      },
    });
  };
  const liveRows = async (d: string): Promise<number> =>
    Number(
      (
        await db.execute({
          sql: "SELECT COUNT(*) AS n FROM rank_ic_daily WHERE d = ? AND source = 'live'",
          args: [d],
        })
      ).rows[0]!.n,
    );
  const gate = (value: number) =>
    setConfig(db, {
      key: "review_rank_ic_nightly",
      value,
      userId: null,
      reason: "test",
      now: NOW(),
    });

  beforeAll(async () => {
    db = await world(LAST);
  });

  it("a replay night computes the day even with the gate off", async () => {
    await gate(0);
    const r = await review(DATES[LAST - 2]!, true);
    expect(r.status).toBe("success");
    expect(await liveRows(DATES[LAST - 4]!)).toBeGreaterThan(0);
    const seen = stages.get(DATES[LAST - 2]!)!;
    expect(seen.some((s) => s.startsWith("start sessions="))).toBe(true);
    expect(seen.some((s) => s === "cortex_outcome")).toBe(true); // a stage reported without a note
  });

  it("a live night with the gate off writes no live row for its day", async () => {
    const r = await review(DATES[LAST - 1]!, false);
    expect(r.status).toBe("success");
    expect(await liveRows(DATES[LAST - 3]!)).toBe(0);
  });

  it("a live night with the gate on computes it", async () => {
    await gate(1);
    const r = await review(DATES[LAST]!, false);
    expect(r.status).toBe("success");
    expect(await liveRows(DATES[LAST - 2]!)).toBeGreaterThan(0);
  });
});
