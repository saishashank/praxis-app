// @vitest-environment node
// M5 T7 (AGT-111, AGT-003; D-102 draft): replay == live for thesis-breakers. The golden world runs
// through batch 2a/2b with a price-sensitive trading halt on the held ZZUP (session 302) and the
// in-memory cohort replay runs over the same bars and the same A2 event rows. Every stored NAV,
// liquidation NAV and position of both cohorts agrees session by session: the red breaker exits
// ZZUP at the open of 303 on both sides (the same pure evaluator), and without the halt both keep it.
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { eventRowOf } from "@/lib/agents/candidates";
import { eventFactFromRow } from "@/lib/agents/families/facts";
import { ASX_SOURCE } from "@/lib/data/asxToken";
import { replayCohorts, type CohortDayTrace } from "@/lib/replay/cohortReplay";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  MARKET,
  NO_TERMINAL,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "../agents/batch2bHarness";
import { FILLERS, buildGolden } from "../agents/batch2bScenario";
import { MASTER_SEED } from "../arena/replayHarness";
import { buildCohortWorld, seriesFromHarness } from "../fixtures/replay/cohortWorld";

vi.setConfig({ testTimeout: 240000, hookTimeout: 240000 });
afterAll(cleanupTempDbs);

const START = 295;
const END = 305;
const KEEP = ["E01", "E07"];
const CODES = ["ZZD1", "ZZD2", "ZZD3", "ZZUP", ...FILLERS];
const params = testParams();

type Stored = Map<string, { nav: bigint; liq: bigint; open: bigint }>;

async function storedNav(db: Client): Promise<Stored> {
  const rs = await db.execute(
    "SELECT cohort_id, d, nav_micro, liq_nav_micro, open_positions FROM nav_daily ORDER BY cohort_id, d",
  );
  return new Map(
    rs.rows.map((r) => [
      `${r.cohort_id}|${r.d}`,
      {
        nav: BigInt(r.nav_micro as never),
        liq: BigInt(r.liq_nav_micro as never),
        open: BigInt(r.open_positions as never),
      },
    ]),
  );
}

async function both(halt: boolean): Promise<{ stored: Stored; traces: CohortDayTrace[] }> {
  const db = await freshReplayDb();
  await buildGolden(db);
  await setMode(db, "full");
  if (halt) {
    await db.execute({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
            VALUES (?, 'ZZUP', 'HALT-1', ?, ?, 'Trading Halt', 1, 'Trading Halt', NULL, ?)`,
      args: [MARKET, `${DATES[302]}T03:00:00.000Z`, `${DATES[302]}T03:01:00.000Z`, ASX_SOURCE],
    });
  }
  const ids = await startCohortsAt(db, START, KEEP);
  await runNights(db, params, START, END);
  const stored = await storedNav(db);
  const series = await seriesFromHarness(
    db,
    DATES,
    Object.fromEntries(CODES.map((c) => [c, { tier: "U1" as const }])),
  );
  const events = (await db.execute("SELECT * FROM event ORDER BY source, ann_id")).rows.map((r) =>
    eventFactFromRow(eventRowOf(r as Record<string, unknown>), null),
  );
  expect(events.length).toBe(halt ? 1 : 0);
  const traces: CohortDayTrace[] = [];
  const result = replayCohorts(buildCohortWorld(DATES, series, params, { events }), {
    params,
    from: DATES[START],
    to: DATES[END],
    step: 1000,
    masterSeed: MASTER_SEED,
    controlsPerFamily: 1,
    executions: KEEP,
    realityLeverage: null,
    cohortParams: () => ({ ...NO_TERMINAL, costProfile: "P5" }),
    trace: (e) => traces.push(e),
  });
  expect(result.cohorts.map((c) => c.id).sort()).toEqual([...ids].sort());
  return { stored, traces };
}

describe("replay == live for a red thesis-breaker on a held position", () => {
  it("a halt on the held code exits it at the next open, identically in both engines", async () => {
    const { stored, traces } = await both(true);
    expect(traces.length).toBe(2 * (END - START + 1));
    for (const t of traces) {
      const want = stored.get(`${t.cohortId}|${t.d}`);
      expect(want, `${t.cohortId} ${t.d}`).toBeDefined();
      expect(
        { nav: t.navMicro, liq: t.liqNavMicro, open: BigInt(t.openPositions) },
        `${t.cohortId} ${t.d}`,
      ).toEqual(want);
    }
    const e01 = (d: string): bigint | undefined => stored.get(`E01@${DATES[START]}|${d}`)?.open;
    expect(e01(DATES[302]!)).toBe(1n); // still held when the night decides
    expect(e01(DATES[303]!)).toBe(0n); // gone at the next open
  });

  it("without the halt both engines keep the position", async () => {
    const { stored, traces } = await both(false);
    for (const t of traces) {
      const want = stored.get(`${t.cohortId}|${t.d}`);
      expect(
        { nav: t.navMicro, liq: t.liqNavMicro, open: BigInt(t.openPositions) },
        `${t.cohortId} ${t.d}`,
      ).toEqual(want);
    }
    expect(stored.get(`E01@${DATES[START]}|${DATES[303]}`)?.open).toBe(1n);
  });
});
