// @vitest-environment node
// D-870 / D-876: batch 3 round trips against a remote database. A counting wrapper pins that the
// replay_stat insert is one batch per 500 rows (not one execute per row) and that the ARN-101 re-check
// reads cohorts in bounded parallel chunks with the same result as the plain run.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { storeLedgerCandidates } from "@/lib/agents/batch2b";
import { putStats, recheckInvariants } from "@/lib/agents/batch3";
import { loadDayInputs } from "@/lib/agents/candidates";
import { decisionCutoffUtc } from "@/lib/agents/decisionView";
import { runFamilies } from "@/lib/agents/families";
import {
  decodeJson,
  encodeJson,
  fwdRunId,
  loadDayCandidates,
  syncForwardLedger,
} from "@/lib/agents/forwardLedger";
import { liveParams, loadVersionSet } from "@/lib/agents/versionRuns";
import { ARENA_MASTER_SEED, loadCalendar } from "@/lib/arena/closeBooks";
import { loadExecutions } from "@/lib/arena/cohortWriter";
import { knownBy } from "@/lib/arena/corpActions";
import { loadConfirmedActions } from "@/lib/arena/corpActionWriter";
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

// D-872 / D-880: what batch 2b stores under `fwd:<market>` / `cand:<D>` is byte-identical to what the
// forward-ledger sync would rebuild for the day (base parameters, no held codes, the day's actions),
// and nothing is stored on a replay night or when a live rule version lays its slice over the parameters.
describe("2b stored candidates equal the forward-ledger rebuild", () => {
  const HOURS = { tz: "Australia/Sydney", open_time: "10:00", close_time: "16:00" };
  const candRow = async (d: string): Promise<string | null> => {
    const rs = await db.execute({
      sql: "SELECT value_json FROM replay_stat WHERE run_id = ? AND scope = ? AND metric = 'candidates'",
      args: [fwdRunId(MARKET), `cand:${d}`],
    });
    return rs.rows.length === 0 ? null : String(rs.rows[0]!.value_json);
  };

  it("stores the sync's own value on a live night, nothing on a replay or with a live version", async () => {
    const d = DATES[LAST]!;
    const calendar = await loadCalendar(db, MARKET);
    expect(await candRow(d)).toBeNull(); // the harness nights are replays: batch 3 never ran
    // the night as 2b builds it: the live parameters, the held codes of the open trades, actions by cut-off
    const versionSet = await loadVersionSet(db, MARKET, await loadExecutions(db));
    const live = liveParams(params, versionSet);
    // held codes as 2b passes them: open-trade codes, in and outside the day's universe (a code the
    // universe lacks is loaded as a non-universe fact and must not enter `inputs`)
    const uni = (
      await db.execute({
        sql: "SELECT code FROM universe_snapshot WHERE market = ? AND d = ? ORDER BY code LIMIT 3",
        args: [MARKET, d],
      })
    ).rows.map((r) => String(r.code));
    expect(uni.length).toBe(3);
    const held = [...uni, "ZZHELD"].sort();
    const cutoff = decisionCutoffUtc(d, live.decisionCutoff);
    const night = await loadDayInputs(db, {
      market: MARKET,
      d,
      calendar,
      hours: HOURS,
      params: live,
      replay: true,
      heldCodes: held,
      actions: knownBy(await loadConfirmedActions(db, MARKET, d), cutoff),
    });
    // the sync's rebuild (`dayInputs` in forwardLedger.ts): base parameters, no held codes, all actions
    const rebuilt = await loadDayInputs(db, {
      market: MARKET,
      d,
      calendar,
      hours: HOURS,
      params,
      replay: true,
      heldCodes: [],
      actions: await loadConfirmedActions(db, MARKET, d),
    });
    const expected = runFamilies(rebuilt.inputs, params);
    const expectedJson = encodeJson({ candidates: expected.candidates, blocked: expected.blocked });
    expect(expected.candidates.length + expected.blocked.length).toBeGreaterThan(0);

    // a replay night stores nothing
    await storeLedgerCandidates(db, { market: MARKET, d, replay: true }, params, live, night);
    expect(await candRow(d)).toBeNull();
    // a live rule version over the parameters: the inputs are not the sync's, nothing stored
    await storeLedgerCandidates(db, { market: MARKET, d }, params, { ...params }, night);
    expect(await candRow(d)).toBeNull();
    // a live night with the base parameters: the stored bytes are the sync's rebuild
    await storeLedgerCandidates(db, { market: MARKET, d }, params, live, night);
    expect(await candRow(d)).toBe(expectedJson);
    // and the sync then finds the day stored: nothing rebuilt for it, the stored value unchanged
    const sync = await syncForwardLedger(db, {
      market: MARKET,
      d,
      calendar,
      hours: HOURS,
      params,
      replay: true,
      masterSeed: ARENA_MASTER_SEED,
    });
    expect(sync.candidateDays).toBeGreaterThan(0);
    expect((await loadDayCandidates(db, MARKET, [d])).get(d)).toEqual(decodeJson(expectedJson));
    expect(await candRow(d)).toBe(expectedJson);
  });
});
