// @vitest-environment node
// D-870 / D-876: batch 3 round trips against a remote database. A counting wrapper pins that the
// replay_stat insert is one batch per 500 rows (not one execute per row) and that the ARN-101 re-check
// reads cohorts in bounded parallel chunks with the same result as the plain run.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { putStats, recheckInvariants } from "@/lib/agents/batch3";
import { loadCalendar } from "@/lib/arena/closeBooks";
import type { ReplayStatRow } from "@/lib/replay/scorecards";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  MARKET,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "./batch2bHarness";
import { buildGolden } from "./batch2bScenario";

vi.setConfig({ testTimeout: 300000, hookTimeout: 600000 });

type Counts = { execute: number; batch: number; statements: number; maxInFlight: number };

function counting(db: Client): { db: Client; counts: Counts } {
  const counts: Counts = { execute: 0, batch: 0, statements: 0, maxInFlight: 0 };
  let inFlight = 0;
  const track = async <T>(f: () => Promise<T>): Promise<T> => {
    inFlight += 1;
    counts.maxInFlight = Math.max(counts.maxInFlight, inFlight);
    try {
      return await f();
    } finally {
      inFlight -= 1;
    }
  };
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === "execute") {
        return (s: never) => {
          counts.execute += 1;
          counts.statements += 1;
          return track(() => target.execute(s));
        };
      }
      if (prop === "batch") {
        return (stmts: unknown[], mode: never) => {
          counts.batch += 1;
          counts.statements += stmts.length;
          return track(() => target.batch(stmts as never, mode));
        };
      }
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: wrapped, counts };
}

const params = testParams();
const KEEP = ["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"];
const FIRST = 295;
const LAST = 300;
let db: Client;

beforeAll(async () => {
  db = await freshReplayDb();
  await buildGolden(db);
  await setMode(db, "full");
  await startCohortsAt(db, FIRST, KEEP);
  await runNights(db, params, FIRST, LAST, async () => undefined);
});
afterAll(cleanupTempDbs);

describe("batch 3 round trips", () => {
  const rows = (n: number): ReplayStatRow[] =>
    Array.from({ length: n }, (_, i) => ({
      run_id: "rt:test",
      scope: `s${i}`,
      metric: "m",
      d: "2030-01-02",
      value_json: "{}",
    }));

  it("putStats writes 1,200 rows in 3 batches and no single executes, ignoring duplicates", async () => {
    const { db: c, counts } = counting(db);
    expect(await putStats(c, rows(1200))).toBe(1200);
    expect(counts.batch).toBe(3);
    expect(counts.execute).toBe(0);
    expect(counts.statements).toBe(1200);
    // the same rows again: ON CONFLICT DO NOTHING, nothing written, still 3 more batches
    expect(await putStats(c, rows(1200))).toBe(0);
    expect(counts.batch).toBe(6);
    expect(await putStats(c, [])).toBe(0);
    expect(counts.batch).toBe(6);
  });

  it("recheckInvariants reads cohorts in parallel chunks and returns the plain result", async () => {
    const calendar = await loadCalendar(db, MARKET);
    const d = DATES[LAST]!;
    const plain = await recheckInvariants(db, d, calendar);
    const { db: c, counts } = counting(db);
    const wrapped = await recheckInvariants(c, d, calendar);
    expect(wrapped).toEqual(plain);
    expect(plain.cohorts).toBeGreaterThan(1);
    expect(counts.maxInFlight).toBeGreaterThan(1);
  });
});
