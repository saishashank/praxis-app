// @vitest-environment node
// Parity of the in-memory cohort replay with the database engine (M4 T14; design 4.7, decision 30):
// the golden nights of batch 2b (real migrations, closeBooksDay + signalsDay) are replayed against a
// local file, and the same bars go through replayCohorts. Every stored NAV, liquidation NAV and
// open-position count of the chosen cohorts must agree session by session -- entries, IS and CS
// exits, C2/C3 matched controls, the leverage sleeve with its lock and shadow trades, and (second
// scenario) a cash dividend and a 2-for-1 split in the hold.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  NO_TERMINAL,
  addAction,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "../agents/batch2bHarness";
import { MASTER_SEED } from "../arena/replayHarness";
import { buildGolden, FILLERS } from "../agents/batch2bScenario";
import { buildCohortWorld, seriesFromHarness } from "../fixtures/replay/cohortWorld";
import { replayCohorts, type CohortDayTrace } from "@/lib/replay/cohortReplay";
import type { CorpActionRecord } from "@/lib/arena/corpActions";

vi.setConfig({ testTimeout: 240000, hookTimeout: 240000 });
afterEach(cleanupTempDbs);

const START = 295;
const END = 322;
const params = testParams();
const CODES = ["ZZD1", "ZZD2", "ZZD3", "ZZUP", ...FILLERS];

type Stored = Map<string, Map<string, { nav: bigint; liq: bigint; open: bigint }>>;

async function storedNav(db: Client): Promise<Stored> {
  const stored: Stored = new Map();
  const rs = await db.execute(
    "SELECT cohort_id, d, nav_micro, liq_nav_micro, open_positions FROM nav_daily ORDER BY cohort_id, d",
  );
  for (const r of rs.rows) {
    const m = stored.get(String(r.cohort_id)) ?? new Map();
    m.set(String(r.d), {
      nav: BigInt(r.nav_micro as never),
      liq: BigInt(r.liq_nav_micro as never),
      open: BigInt(r.open_positions as never),
    });
    stored.set(String(r.cohort_id), m);
  }
  return stored;
}

async function parity(
  keep: readonly string[],
  actions: readonly { code: string; type: string; ex: number; payload: Record<string, unknown> }[],
  splitAt?: number,
): Promise<{ entries: number; cohorts: number; accruals: number; rebases: number }> {
  const db = await freshReplayDb();
  await buildGolden(db, {}, splitAt);
  await setMode(db, "full");
  const ids = await startCohortsAt(db, START, keep);
  for (const a of actions) await addAction(db, a.code, a.type, a.ex, a.payload);
  await runNights(db, params, START, END);
  const stored = await storedNav(db);
  const count = async (sql: string): Promise<number> => Number((await db.execute(sql)).rows[0]!.n);
  const accruals = await count("SELECT COUNT(*) AS n FROM cash_ledger WHERE kind = 'div_accrue'");
  const rebases = await count("SELECT COUNT(*) AS n FROM cohort_event WHERE kind = 'ca_adjust'");

  const series = await seriesFromHarness(
    db,
    DATES,
    Object.fromEntries(CODES.map((c) => [c, { tier: "U1" as const }])),
  );
  const records: CorpActionRecord[] = actions.map((a, i) => ({
    id: String(i + 1),
    code: a.code,
    type: a.type,
    exDate: DATES[a.ex]!,
    payload: a.payload,
  }));
  const world = buildCohortWorld(DATES, series, params, { actions: records });
  const traces: CohortDayTrace[] = [];
  const result = replayCohorts(world, {
    params,
    from: DATES[START],
    to: DATES[END],
    step: 1000,
    masterSeed: MASTER_SEED,
    controlsPerFamily: 1,
    executions: keep,
    realityLeverage: null,
    cohortParams: () => ({ ...NO_TERMINAL, costProfile: "P5" }),
    trace: (e) => traces.push(e),
  });
  expect(result.cohorts.map((c) => c.id).sort()).toEqual([...ids].sort());
  for (const t of traces) {
    const want = stored.get(t.cohortId)?.get(t.d);
    expect(want, `${t.cohortId} ${t.d}`).toBeDefined();
    expect(
      { nav: t.navMicro, liq: t.liqNavMicro, open: BigInt(t.openPositions) },
      `${t.cohortId} ${t.d}`,
    ).toEqual(want);
  }
  expect(traces.length).toBe(ids.length * (END - START + 1));
  return {
    entries: result.cohorts.reduce((s, c) => s + c.entries, 0),
    cohorts: result.cohorts.length,
    accruals,
    rebases,
  };
}

describe("replayCohorts equals the database engine on the golden nights", () => {
  it("entries, IS and CS exits, matched controls and the sleeve (lock, shadow trades)", async () => {
    const r = await parity(["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"], []);
    expect(r.cohorts).toBe(6);
    expect(r.entries).toBeGreaterThan(5);
  });

  it("a cash dividend and a 2-for-1 split inside the hold", async () => {
    const r = await parity(
      ["E07", "E08", "C2-F4"],
      [
        {
          code: "ZZD1",
          type: "cash_dividend",
          ex: 302,
          payload: { dps: "0.05", pay_date: DATES[306]! },
        },
        { code: "ZZD1", type: "split", ex: 302, payload: { new: 2, old: 1 } },
      ],
      302,
    );
    expect(r.entries).toBeGreaterThan(0);
    // the actions really hit a held position in the database engine this test is compared with
    expect(r.accruals).toBeGreaterThan(0);
    expect(r.rebases).toBeGreaterThan(0);
  });
});
