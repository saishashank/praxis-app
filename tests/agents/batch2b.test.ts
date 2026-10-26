// @vitest-environment node
// Batch 2b golden nights (M4 T8; docs/M4_design.md 4.4, 4.12; FAM-001, FAM-002, ARN-020/021,
// ARN-003, ARN-004; AT-15 pieces). Synthetic multi-day scenarios run end to end through batch 2a
// (closeBooksDay) and batch 2b (signalsDay) against a local file with the real migrations.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signalsDay, signalsKey } from "@/lib/agents/batch2b";
import { initialStopAtFill, parsePlan } from "@/lib/agents/orderPlan";
import { toBig } from "@/lib/arena/ledgerWriter";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  MARKET,
  NOW,
  dump,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
  type NightRun,
} from "./batch2bHarness";
import { buildGolden, D } from "./batch2bScenario";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const KEEP = ["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"];
const params = testParams();
const d = (i: number): string => DATES[i]!;

type Row = Record<string, unknown>;
const rows = async (db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

let db: Client;
let run: NightRun;
let ids: string[];
const cohort = (prefix: string): string =>
  ids.find((x) => x.startsWith(`${prefix}@`) || x.startsWith(`${prefix}#`))!;

beforeAll(async () => {
  db = await freshReplayDb();
  await buildGolden(db);
  await setMode(db, "full");
  ids = await startCohortsAt(db, 295, KEEP);
  run = await runNights(db, params, 295, 322);
});
afterAll(cleanupTempDbs);

describe("the decision night (session 300)", () => {
  it("every 2a and 2b of the run succeeded and recorded one run each", async () => {
    expect(run.closes.every((c) => c.status === "success")).toBe(true);
    for (const [, r] of run.signals) expect(r.status).toBe("success");
    const keys = await rows(
      db,
      "SELECT concurrency_key FROM run_record WHERE job = 'arena-signals'",
    );
    expect(keys.length).toBe(28);
    expect(keys.map((k) => String(k.concurrency_key))).toContain(signalsKey(MARKET, d(D)));
  });

  it("records the regime and one signal per candidate, deterministic ids, cut-off as decided_at", async () => {
    const regime = await rows(db, "SELECT state FROM regime_daily WHERE d = ?", [d(D)]);
    expect(regime).toEqual([{ state: "RISK-ON" }]);
    const sig = await rows(
      db,
      "SELECT id, family, variant, code, regime, decided_at, partial, schema_version, inputs_ref FROM signal WHERE d = ? ORDER BY id",
      [d(D)],
    );
    expect(sig.map((s) => `${s.family}:${s.code}`)).toEqual(["F1:ZZUP", "F4:ZZD1", "F4:ZZD2"]);
    for (const s of sig) {
      expect(s.id).toBe(`sig:AU:${d(D)}:${s.family}:${s.family}.v1:${s.variant}:${s.code}`);
      expect(s.regime).toBe("RISK-ON");
      expect(s.partial).toBe(0n);
      expect(String(s.decided_at)).toBe("2031-02-26T07:10:00.000Z"); // 18:10 Melbourne (AEDT)
      expect(String(s.inputs_ref)).toBe("batch1:301@2031-02-26T07:00:00.000Z");
    }
  });

  it("FAM-001: with A$600 and two candidates only the top-ranked is bought (one leg)", async () => {
    const e07 = cohort("E07");
    const orders = await rows(
      db,
      "SELECT id, code, kind, qty, status, tier, signal_id, max_open_micro, ref_stop_micro FROM arena_order WHERE cohort_id = ? AND decided_d = ?",
      [e07, d(D)],
    );
    expect(orders.map((o) => `${o.code}:${o.kind}:${o.status}`)).toEqual(["ZZD1:entry:filled"]);
    const o = orders[0]!;
    expect(o.id).toBe(`EN:${e07}:${d(D)}:ZZD1`);
    expect(o.signal_id).toBe(`sig:AU:${d(D)}:F4:F4.v1:F4:ZZD1`);
    expect(o.tier).toBe("U1");
    expect(o.max_open_micro).toBeNull();
    expect(o.ref_stop_micro).toBeNull();
    // the order value meets the A$500 parcel and fits A$600
    const bar = await rows(db, "SELECT c FROM price_bar WHERE code = 'ZZD1' AND d = ?", [d(D)]);
    const value = toBig(o.qty) * BigInt(Math.round(Number(bar[0]!.c) * 1e6));
    expect(value >= 500_000_000n && value <= 600_000_000n).toBe(true);
  });

  it("the initial stop is computed from the ACTUAL fill by the stored plan (ARN-021)", async () => {
    const e07 = cohort("E07");
    const [order] = await rows(db, "SELECT stop_spec FROM arena_order WHERE id = ?", [
      `EN:${e07}:${d(D)}:ZZD1`,
    ]);
    const plan = parsePlan(String(order!.stop_spec));
    expect(plan.family).toBe("F4");
    expect(plan.caThrough).toBe(d(D));
    expect(plan.plan.initialStops).toHaveLength(1);
    expect(plan.plan.initialStops[0]!.spec.k).toEqual({ num: 2n, den: 1n });
    const [trade] = await rows(
      db,
      `SELECT t.stop_micro, f.fill_price_micro, f.d FROM trade t JOIN fill f ON f.id = t.entry_fill_id
       WHERE t.id = ?`,
      [`T:EN:${e07}:${d(D)}:ZZD1`],
    );
    expect(String(trade!.d)).toBe(d(D + 1));
    expect(toBig(trade!.stop_micro)).toBe(initialStopAtFill(plan, toBig(trade!.fill_price_micro)));
  });

  it("ARN-003: a sleeve cohort sizes with the margin and its brokerage kept free", async () => {
    const qty = async (prefix: string): Promise<bigint> => {
      const r = await rows(
        db,
        "SELECT qty FROM arena_order WHERE cohort_id = ? AND decided_d = ? AND kind = 'entry'",
        [cohort(prefix), d(D)],
      );
      return toBig(r[0]!.qty);
    };
    expect(await qty("E08")).toBeLessThan(await qty("E07"));
  });

  it("F1 takes its breakout and the trailing stop is appended every close", async () => {
    const e01 = cohort("E01");
    const orders = await rows(
      db,
      "SELECT code, status, signal_id FROM arena_order WHERE cohort_id = ? AND decided_d = ?",
      [e01, d(D)],
    );
    expect(orders).toEqual([
      { code: "ZZUP", status: "filled", signal_id: `sig:AU:${d(D)}:F1:F1.v1:F1:ZZUP` },
    ]);
    const levels = await rows(
      db,
      "SELECT d, rule, level_micro FROM stop_level WHERE cohort_id = ? ORDER BY d",
      [e01],
    );
    expect(levels.length).toBeGreaterThan(5);
    expect(new Set(levels.map((l) => l.rule))).toEqual(new Set(["trail"]));
    expect(String(levels[0]!.d)).toBe(d(D + 1));
  });

  it("the IS stop uses the highest trailing level written at the earlier close (decision 7)", async () => {
    const e01 = cohort("E01");
    const [trade] = await rows(
      db,
      "SELECT id, exit_type, stop_micro, exit_fill_id FROM trade WHERE cohort_id = ?",
      [e01],
    );
    expect(trade!.exit_type).toBe("IS");
    const [fill] = await rows(db, "SELECT d, rule, ref_price_micro FROM fill WHERE id = ?", [
      String(trade!.exit_fill_id),
    ]);
    expect(String(fill!.d)).toBe(d(311));
    expect(fill!.rule).toBe("level");
    const [level] = await rows(
      db,
      "SELECT MAX(level_micro) AS m FROM stop_level WHERE trade_id = ? AND d = ?",
      [String(trade!.id), d(310)],
    );
    expect(toBig(fill!.ref_price_micro)).toBe(toBig(level!.m));
    expect(toBig(level!.m)).toBeGreaterThan(toBig(trade!.stop_micro));
  });

  it("CS exits are decided at the close for the next open and carry the rule that fired", async () => {
    const e07 = cohort("E07");
    const exits = await rows(
      db,
      "SELECT id, decided_d, fill_d, code, stop_spec, status FROM arena_order WHERE cohort_id = ? AND kind = 'exit_cs' ORDER BY id",
      [e07],
    );
    expect(exits.length).toBeGreaterThan(0);
    for (const e of exits) {
      expect(e.status).toBe("filled");
      expect(String(e.fill_d) > String(e.decided_d)).toBe(true);
      const spec = JSON.parse(String(e.stop_spec)) as { ca_through: string; exit_rule: string };
      expect(spec.ca_through).toBe(e.decided_d);
      expect(["close_above_sma", "time_stop"]).toContain(spec.exit_rule);
    }
    const closed = await rows(
      db,
      "SELECT exit_type FROM trade WHERE cohort_id = ? AND exit_type = 'CS'",
      [e07],
    );
    expect(closed.length).toBeGreaterThan(0);
  });
});

describe("FAM-002 and the C2/C3 controls", () => {
  it("a code stopped out is not re-entered by the same execution for reentry_block sessions", async () => {
    const e07 = cohort("E07");
    const bought = await rows(
      db,
      "SELECT decided_d FROM arena_order WHERE cohort_id = ? AND code = 'ZZD3' AND kind = 'entry' AND status = 'filled' ORDER BY decided_d",
      [e07],
    );
    expect(bought.map((b) => String(b.decided_d))).toEqual([d(303)]);
    const stopped = await rows(
      db,
      `SELECT t.code, f.d FROM trade t JOIN fill f ON f.id = t.exit_fill_id
       WHERE t.cohort_id = ? AND t.exit_type = 'IS'`,
      [e07],
    );
    expect(stopped.map((x) => `${x.code}@${x.d}`)).toEqual([`ZZD3@${d(304)}`]);
    // the rule still fires on 304 (signal recorded) but no order follows for ten sessions
    expect(
      (await rows(db, "SELECT 1 FROM signal WHERE d = ? AND code = 'ZZD3'", [d(304)])).length,
    ).toBe(1);
    const blocked = await rows(
      db,
      `SELECT decided_d FROM arena_order WHERE cohort_id = ? AND code = 'ZZD3' AND kind = 'entry'
       AND decided_d >= ? AND decided_d <= ?`,
      [e07, d(304), d(314)],
    );
    expect(blocked).toEqual([]);
  });

  it("each matched entry gets one seeded control per C2/C3 cohort, recorded with its pool", async () => {
    const sel = await rows(
      db,
      `SELECT cohort_id, d, matched_signal_id, code, skipped, skip_reason, pool_size, rng_draw
       FROM c2_selection WHERE d = ? ORDER BY cohort_id`,
      [d(D)],
    );
    const byCohort = Object.fromEntries(sel.map((x) => [String(x.cohort_id).split("@")[0], x]));
    expect(Object.keys(byCohort).sort()).toEqual(["C2-F1#01", "C2-F4#01", "C3-F4#01"]);
    // F1: ZZUP is matched; its volatility decile holds other codes, one is drawn
    const f1 = byCohort["C2-F1#01"]!;
    expect(f1.matched_signal_id).toBe(`sig:AU:${d(D)}:F1:F1.v1:F1:ZZUP`);
    expect(f1.skipped).toBe(0n);
    expect(toBig(f1.pool_size)).toBeGreaterThan(0n);
    expect(toBig(f1.rng_draw)).toBeLessThan(toBig(f1.pool_size));
    expect(f1.code).not.toBe("ZZUP");
    const [order] = await rows(
      db,
      "SELECT code, signal_id, stop_spec, status FROM arena_order WHERE cohort_id = ? AND decided_d = ?",
      [cohort("C2-F1"), d(D)],
    );
    expect(order!.signal_id).toBe(f1.matched_signal_id);
    expect(order!.code).toBe(f1.code);
    expect(parsePlan(String(order!.stop_spec)).plan.initialStops[0]!.spec.k).toEqual({
      num: 2n,
      den: 1n,
    });
    // F4: the matched ZZD1 sits in the top volatility decile; the pool is what is left after the
    // same-day qualifying codes are removed, and the draw comes from it
    for (const id of ["C2-F4#01", "C3-F4#01"]) {
      const x = byCohort[id]!;
      expect(x.matched_signal_id).toBe(`sig:AU:${d(D)}:F4:F4.v1:F4:ZZD1`);
      expect(x.skipped).toBe(0n);
      expect(toBig(x.pool_size)).toBeGreaterThan(0n);
      expect(["ZZD1", "ZZD2"]).not.toContain(x.code);
    }
  });

  it("a later matched entry (ZZD3, session 303) draws controls for both control cohorts", async () => {
    const sel = await rows(
      db,
      "SELECT cohort_id, code, skipped, pool_size FROM c2_selection WHERE d = ? ORDER BY cohort_id",
      [d(303)],
    );
    expect(sel.map((x) => String(x.cohort_id).split("@")[0])).toEqual(["C2-F4#01", "C3-F4#01"]);
    for (const x of sel) {
      expect(toBig(x.pool_size)).toBeGreaterThan(0n);
      expect(x.code).not.toBe("ZZD3");
    }
  });

  it("the control follows the F1 exit rules mapped: trailing levels are appended for it too", async () => {
    const levels = await rows(db, "SELECT rule FROM stop_level WHERE cohort_id = ?", [
      cohort("C2-F1"),
    ]);
    expect(levels.length).toBeGreaterThan(0);
  });
});

describe("idempotency and guards", () => {
  let idb: Client;
  beforeAll(async () => {
    idb = await freshReplayDb();
    await buildGolden(idb);
    await setMode(idb, "full");
    await startCohortsAt(idb, 295, ["E01", "E07", "C2-F1"]);
    await runNights(idb, params, 295, D);
  });

  it("a finished night is not run again", async () => {
    const again = await signalsDay(idb, {
      withLeverage: true, // D-191: the full engine, sleeve included

      market: MARKET,
      d: d(D),
      replay: true,
      now: NOW,
      params,
    });
    expect(again.status).toBe("already_done");
  });

  const tables = [
    "signal",
    "arena_order",
    "stop_level",
    "c2_selection",
    "regime_daily",
    "insider_flow_score",
  ];
  const snapshot = (): Promise<string[]> =>
    Promise.all(tables.map((t) => dump(idb, `SELECT * FROM ${t} ORDER BY 1, 2, 3`)));
  const fail = (): Promise<unknown> =>
    idb.execute({
      sql: "UPDATE run_record SET status = 'failed' WHERE concurrency_key = ? AND status = 'success'",
      args: [signalsKey(MARKET, d(D))],
    });

  it("a killed run resumes: re-running writes no new row and changes no stored row", async () => {
    const before = await snapshot();
    expect(before[0]).not.toBe("[]");
    await fail();
    const again = await signalsDay(idb, {
      withLeverage: true, // D-191: the full engine, sleeve included

      market: MARKET,
      d: d(D),
      replay: true,
      now: NOW,
      params,
    });
    expect(again.status).toBe("success");
    expect(again.stats).toMatchObject({
      signals: 0,
      orders: 0,
      rejected: 0,
      exits: 0,
      stopLevels: 0,
      agentRows: 0,
      controls: 0,
      skips: 0,
    });
    expect(await snapshot()).toEqual(before);
  });

  it("a stored row that differs raises: the run fails and nothing is overwritten", async () => {
    const before = await snapshot();
    await fail();
    // a different stop multiple changes the plan stored on an order: same ids, other content
    const other = testParams({ f4_stop_atr: 3, f1_initial_stop_atr: 3 });
    const bad = await signalsDay(idb, {
      withLeverage: true, // D-191: the full engine, sleeve included

      market: MARKET,
      d: d(D),
      replay: true,
      now: NOW,
      params: other,
    });
    expect(bad.status).toBe("failed");
    expect(bad.reason).toBe("row_conflict");
    expect(await snapshot()).toEqual(before);
    const log = await rows(idb, "SELECT message FROM app_log WHERE source = 'arena-signals'");
    expect(String(log[0]!.message)).toContain("row_conflict");
  });

  it("data-only guard: production in data_only mode records a skip and writes nothing (D-066)", async () => {
    const g = await freshReplayDb();
    await buildGolden(g, { through: D });
    await startCohortsAt(g, 295, ["E07"]);
    const r = await signalsDay(g, {
      withLeverage: true, // D-191: the full engine, sleeve included
      market: MARKET,
      d: d(D),
      now: NOW,
      params,
    });
    expect(r).toMatchObject({ status: "skipped", reason: "data_only_guard" });
    for (const t of [
      "signal",
      "regime_daily",
      "event",
      "insider_flow_score",
      "arena_order",
      "stop_level",
      "c2_selection",
    ]) {
      expect((await rows(g, `SELECT COUNT(*) AS n FROM ${t}`))[0]!.n, t).toBe(0n);
    }
    const run = await rows(g, "SELECT job, status, concurrency_key FROM run_record");
    expect(run).toEqual([
      { job: "arena-signals", status: "skipped", concurrency_key: signalsKey(MARKET, d(D)) },
    ]);
  });

  it("market off and non-trading days are skipped; 2b waits for a successful 2a", async () => {
    const g = await freshReplayDb();
    await buildGolden(g, { through: D });
    await startCohortsAt(g, 295, ["E07"]);
    await setMode(g, "full");
    expect(
      await signalsDay(g, {
        withLeverage: true, // D-191: the full engine, sleeve included
        market: MARKET,
        d: d(D),
        now: NOW,
        params,
      }),
    ).toMatchObject({
      status: "skipped",
      reason: "no_2a_success",
    });
    expect(
      await signalsDay(g, {
        withLeverage: true, // D-191: the full engine, sleeve included
        market: MARKET,
        d: "2031-03-01",
        now: NOW,
        params,
      }),
    ).toMatchObject({ status: "skipped", reason: "non_trading_day" }); // a Saturday
    await setMode(g, "off");
    expect(
      await signalsDay(g, {
        withLeverage: true, // D-191: the full engine, sleeve included
        market: MARKET,
        d: d(D),
        now: NOW,
        params,
      }),
    ).toMatchObject({
      status: "skipped",
      reason: "market_off",
    });
    expect((await rows(g, "SELECT COUNT(*) AS n FROM signal"))[0]!.n).toBe(0n);
  });
});
