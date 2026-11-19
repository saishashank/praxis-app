// @vitest-environment node
// D-1848: the nightly forward-ledger sync against a remote database. The 13-18 Nov 2026 runs spent 30 to
// 74 minutes in this stage, growing with every session, because each pending control row's decision
// session was rebuilt with `loadDayInputs` and the control bars were read one code at a time. A counting
// wrapper pins that, once the pools are stored, a night reads no day inputs and no bars per code, that
// the stored-pool run writes exactly what the rebuilding run wrote, and that the number of queries does
// not grow with the number of pending rows.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewDay } from "@/lib/agents/batch3";
import {
  decodeJson,
  encodeJson,
  fwdRunId,
  loadDayPools,
  syncForwardLedger,
  type ForwardOptions,
} from "@/lib/agents/forwardLedger";
import { ARENA_MASTER_SEED, loadCalendar } from "@/lib/arena/closeBooks";
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

const KEEP = ["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"];
const params = testParams();
const HOURS = { tz: "Australia/Sydney", open_time: "10:00", close_time: "16:00" };
const FIRST = 295;
const LAST = 320;
let db: Client;

type Counted = { total: number; byPrefix: Map<string, number> };
function counting(c: Client): { db: Client; counts: Counted } {
  const counts: Counted = { total: 0, byPrefix: new Map() };
  const wrapped = new Proxy(c, {
    get(target, prop) {
      if (prop === "execute") {
        return (s: { sql: string } | string) => {
          const sql = (typeof s === "string" ? s : s.sql).replace(/\s+/g, " ");
          counts.total += 1;
          const key = sql.slice(0, 60);
          counts.byPrefix.set(key, (counts.byPrefix.get(key) ?? 0) + 1);
          return target.execute(s as never);
        };
      }
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: wrapped, counts };
}
const matching = (counts: Counted, re: RegExp): number =>
  [...counts.byPrefix].filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0);

type Row = Record<string, unknown>;
const dump = async (c: Client): Promise<string> => {
  const parts: string[] = [];
  for (const sql of [
    "SELECT * FROM ledger_row ORDER BY id",
    "SELECT * FROM ledger_control ORDER BY row_id, idx",
    "SELECT run_id, scope, metric, d, value_json FROM replay_stat WHERE run_id = 'fwd:AU' AND metric <> 'pool' ORDER BY scope, metric",
  ]) {
    const rs = await c.execute(sql);
    parts.push(
      JSON.stringify(
        rs.rows.map((r) =>
          Object.fromEntries(Object.entries(r as Row).map(([k, v]) => [k, String(v)])),
        ),
      ),
    );
  }
  return parts.join("\n");
};

beforeAll(async () => {
  db = await freshReplayDb();
  await buildGolden(db);
  await setMode(db, "full");
  await startCohortsAt(db, FIRST, KEEP);
  await runNights(db, params, FIRST, LAST, async (day) => {
    await reviewDay(db, { market: MARKET, d: day, replay: true, now: NOW, params });
  });
});
afterAll(cleanupTempDbs);

async function opts(): Promise<ForwardOptions> {
  return {
    market: MARKET,
    d: DATES[LAST]!,
    calendar: await loadCalendar(db, MARKET),
    hours: HOURS,
    params,
    replay: true,
    masterSeed: ARENA_MASTER_SEED,
  };
}

describe("forward-ledger sync round trips (D-1848)", () => {
  it("a night with stored pools writes what the rebuilding night wrote, with bounded queries", async () => {
    const o = await opts();
    const pending = Number(
      (
        await db.execute(
          `SELECT COUNT(*) AS n FROM ledger_row lr WHERE lr.forward = 1 AND lr.exit_d IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ledger_control c WHERE c.row_id = lr.id)`,
        )
      ).rows[0]!.n,
    );
    const stored = await db.execute(
      "SELECT COUNT(*) AS n FROM replay_stat WHERE run_id = 'fwd:AU' AND metric = 'pool'",
    );
    expect(Number(stored.rows[0]!.n)).toBeGreaterThan(0); // the nights stored the pools they needed
    const before = await dump(db);
    // the tables are append-only: this scratch database drops the delete guards to re-run a night
    await db.execute("DROP TRIGGER IF EXISTS replay_stat_prune_only");
    await db.execute("DROP TRIGGER IF EXISTS ledger_control_no_delete");

    // the cold path: no pool stored, no control written -> every pool is rebuilt from the day inputs
    await db.execute("DELETE FROM replay_stat WHERE run_id = 'fwd:AU' AND metric = 'pool'");
    await db.execute("DELETE FROM ledger_control");
    await db.execute("DELETE FROM replay_stat WHERE metric = 'controls_none'");
    const cold = counting(db);
    await syncForwardLedger(cold.db, o);
    const afterCold = await dump(db);
    expect(afterCold).toBe(before);
    expect(matching(cold.counts, /FROM universe_snapshot/)).toBeGreaterThan(0); // day inputs were rebuilt

    // the warm path: pools stored -> no day inputs, no bars one code at a time
    await db.execute("DELETE FROM ledger_control");
    await db.execute("DELETE FROM replay_stat WHERE metric = 'controls_none'");
    const warm = counting(db);
    await syncForwardLedger(warm.db, o);
    expect(await dump(db)).toBe(before);
    expect(matching(warm.counts, /FROM universe_snapshot/)).toBe(0);
    expect(
      matching(warm.counts, /FROM price_bar WHERE market = \? AND code = \?/),
    ).toBeLessThanOrEqual(5);
    console.log(
      `ledger sync queries: cold=${cold.counts.total} warm=${warm.counts.total} pendingRows=${pending}`,
    );
    // bounded: a fixed few dozen queries (59 on this fixture) plus a small multiple of the pending rows, never per code
    expect(warm.counts.total).toBeLessThan(90 + 4 * Math.max(pending, 1));
    expect(warm.counts.total).toBeLessThan(cold.counts.total);
  });

  it("a stored pool round-trips byte for byte", async () => {
    const d = DATES[300]!;
    const pools = await loadDayPools(db, MARKET, [d, DATES[301]!, DATES[303]!]);
    expect(pools.size).toBeGreaterThan(0);
    for (const pool of pools.values()) {
      expect(encodeJson(decodeJson(encodeJson(pool)))).toBe(encodeJson(pool));
    }
    const raw = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM replay_stat WHERE run_id = ? AND metric = 'pool'",
      args: [fwdRunId(MARKET)],
    });
    expect(Number(raw.rows[0]!.n)).toBeGreaterThan(0);
  });
});
