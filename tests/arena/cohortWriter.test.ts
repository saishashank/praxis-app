// @vitest-environment node
// DB writers for executions, cohorts, terminal states, group restarts, the legacy ledger (M3 T9)
// against a real migrated database in bigint mode. HIGH-RISK: atomic, idempotent, conflicts raise,
// twins restart together, shadow cohorts run on, replays are byte-identical (AT-11, AT-13).
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExecutionRegistry,
  cohortIdFor,
  effectiveN,
  planCohortStart,
  planInitialStart,
  resolveCohortParams,
  type CohortStart,
} from "@/lib/arena/cohort";
import {
  CohortWriteError,
  evaluateCohort,
  loadCloseHistory,
  loadCohort,
  loadCohortsOfExecution,
  loadExecutions,
  loadLiveCohorts,
  loadPendingLiquidationOrders,
  loadUnresolvedCohorts,
  runTerminalChecks,
  seedExecutions,
  startCohorts,
  writeLegacyMoves,
  writeLiquidated,
  type RestartConfig,
} from "@/lib/arena/cohortWriter";
import { suspensionMark } from "@/lib/arena/corpActions";
import { COST_PROFILES } from "@/lib/arena/costs";
import { fillEntryAtOpen } from "@/lib/arena/fills";
import { writeFill } from "@/lib/arena/fillWriter";
import { loadLedgerRows, toBig } from "@/lib/arena/ledgerWriter";
import { planLegacy } from "@/lib/arena/terminal";
import { sessionsBetween } from "@/lib/data/calendar";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const MASTER = 20_261_011n;
const registry = buildExecutionRegistry();
const exec = new Map(registry.map((e) => [e.id, e]));
const executionFor = (id: string) => {
  const e = exec.get(id);
  if (e === undefined) throw new Error(`no execution ${id}`);
  return e;
};
const RESTART: RestartConfig = {
  executionFor,
  paramsFor: () => resolveCohortParams(),
  masterSeed: MASTER,
};
const DATES = sessionsBetween("2026-03-02", "2026-06-30", []);
const D0 = DATES[0];
const CONTROLS = 2;

async function freshDb(): Promise<Client> {
  const db = track(createClient({ url: tempDbUrl(), intMode: "bigint" }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  return db;
}

function initialStarts(startD = D0): CohortStart[] {
  return planInitialStart({
    registry,
    startD,
    paramsFor: () => resolveCohortParams(),
    masterSeed: MASTER,
    controlsPerFamily: CONTROLS,
  });
}

async function startedDb(): Promise<Client> {
  const db = await freshDb();
  await seedExecutions(db, registry);
  await startCohorts(db, initialStarts());
  return db;
}

async function nav(db: Client, cohortId: string, d: string, liq: bigint, open = 0n): Promise<void> {
  await db.execute({
    sql: `INSERT INTO nav_daily (cohort_id, d, cash_settled_micro, recv_micro, pay_micro,
            positions_micro, div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro,
            fin_accrued_micro, nav_micro, liq_nav_micro, open_positions, invariants_ok)
          VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?, ?, 1)`,
    args: [cohortId, d, liq, liq, liq, open],
  });
}

/** E01 holds 60 shares of ZZA (one open trade) from the second session. */
async function openPosition(db: Client, cohortId: string, code = "ZZA"): Promise<void> {
  const fill = fillEntryAtOpen(
    {
      bar: {
        openMicro: 9_800_000n,
        highMicro: 9_900_000n,
        lowMicro: 9_700_000n,
        closeMicro: 9_800_000n,
      },
      advMicro: 5_000_000_000_000n,
      profile: COST_PROFILES.P5,
    },
    60n,
  );
  await db.execute({
    sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty)
          VALUES (?, ?, ?, ?, 'buy', 'entry', 60)`,
    args: [`O-${cohortId}-${code}`, cohortId, DATES[0], code],
  });
  await writeFill(db, {
    fillId: `F-${cohortId}-${code}`,
    orderId: `O-${cohortId}-${code}`,
    cohortId,
    d: DATES[1],
    code,
    fill,
    trade: { kind: "open", tradeId: `T-${cohortId}-${code}`, stopMicro: 9_000_000n },
  });
}

const count = async (db: Client, table: string, where = "1 = 1"): Promise<bigint> =>
  toBig((await db.execute(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)).rows[0].n);

const dump = async (db: Client): Promise<string> => {
  const parts: string[] = [];
  for (const sql of [
    "SELECT * FROM execution ORDER BY id",
    "SELECT * FROM cohort ORDER BY id",
    "SELECT * FROM cohort_event ORDER BY cohort_id, seq",
    "SELECT * FROM cash_ledger ORDER BY cohort_id, txn_id, account",
    "SELECT * FROM arena_order ORDER BY id",
    "SELECT * FROM trade ORDER BY id",
  ]) {
    for (const r of (await db.execute(sql)).rows) {
      parts.push(JSON.stringify(Object.values(r).map(String)));
    }
  }
  return parts.join("\n");
};

const failWith = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

describe("executions and cohort starts", () => {
  it("seeds the 25 executions once; a second seed is a no-op; a differing row raises", async () => {
    const db = await freshDb();
    expect(await seedExecutions(db, registry)).toEqual({ written: 25 });
    expect(await seedExecutions(db, registry)).toEqual({ written: 0 });
    expect(await loadExecutions(db)).toEqual([...registry].sort((a, b) => (a.id < b.id ? -1 : 1)));
    const e = await failWith(seedExecutions(db, [{ ...registry[0], variant: "L" }]));
    expect(e).toBeInstanceOf(CohortWriteError);
    expect((e as CohortWriteError).code).toBe("execution_conflict");
    // rule_version and status may change later and are not compared
    expect(
      await seedExecutions(db, [{ ...registry[0], rule_version: "v9", status: "paused" }]),
    ).toEqual({ written: 0 });
  });

  it("starts every cohort with A$600, a balanced seed txn and a start event, once", async () => {
    const db = await freshDb();
    await seedExecutions(db, registry);
    const starts = initialStarts();
    expect(starts).toHaveLength(13 + 12 + 12);
    expect(await startCohorts(db, starts)).toEqual({ written: 37 });
    expect(await startCohorts(db, starts)).toEqual({ written: 0 });
    expect(
      await count(db, "cohort", "live = 1 AND terminal_kind IS NULL AND seed_micro = 600000000"),
    ).toBe(37n);
    expect(await count(db, "cohort_event", "kind = 'start' AND seq = 1")).toBe(37n);
    const rows = await loadLedgerRows(db, "E01@" + D0);
    expect(rows.map((r) => [r.account, r.deltaMicro, r.kind, r.d])).toEqual(
      [
        ["cash_settled", 600_000_000n, "seed", D0],
        ["equity", -600_000_000n, "seed", D0],
      ].sort(),
    );
    const sum = await db.execute("SELECT SUM(delta_micro) AS s FROM cash_ledger");
    expect(toBig(sum.rows[0].s)).toBe(0n);
    const stored = await loadCohort(db, "E02@" + D0);
    expect(stored).toMatchObject({
      executionId: "E02",
      live: true,
      terminalKind: null,
      restartOf: null,
      twinGroup: "TW-F1",
    });
    expect((await loadLiveCohorts(db, "TW-F1")).map((c) => c.id)).toHaveLength(6);
    expect((await loadUnresolvedCohorts(db, D0)).length).toBe(37);
    expect((await loadUnresolvedCohorts(db, "2026-01-01")).length).toBe(0);
  });

  it("a different stored cohort raises cohort_conflict; an unseeded execution raises execution_missing; both write nothing", async () => {
    const db = await startedDb();
    const e01 = initialStarts().find((s) => s.id === `E01@${D0}`) as CohortStart;
    const other = await failWith(startCohorts(db, [{ ...e01, seedMicro: 700_000_000n }]));
    expect((other as CohortWriteError).code).toBe("cohort_conflict");
    const before = await dump(db);
    const ghost = planCohortStart({
      execution: { ...executionFor("E01"), id: "E99" },
      controlIdx: null,
      startD: D0,
      params: resolveCohortParams(),
      masterSeed: MASTER,
    });
    const missing = await failWith(startCohorts(db, [initialStarts(DATES[3])[0], ghost]));
    expect((missing as CohortWriteError).code).toBe("execution_missing");
    expect(await dump(db)).toBe(before); // the good cohort in the same call was rolled back too
  });
});

describe("AT-11 golden path: target, liquidation, twin and control restart, shadow continuation", () => {
  // E01 (F1 U) reaches the target at D; the group is TW-F1.
  const D = DATES[7];
  const prev = DATES[6];
  const E01 = `E01@${D0}`;
  const E02 = `E02@${D0}`;

  it("records the terminal state once, queues liquidation at D+1, restarts the group together", async () => {
    const db = await startedDb();
    await openPosition(db, E01);
    // nav_daily is append-only: insert the final values directly
    await nav(db, E01, D, 1_230_000_000n, 1n);
    await nav(db, E02, D, 640_000_000n);
    await nav(db, `C3-F1#02@${D0}`, D, 580_000_000n);

    const result = await runTerminalChecks(db, [E01, E02], {
      d: D,
      calendar: [],
      signalsThroughD: prev,
      restart: RESTART,
    });
    expect(result.written).toBe(true);
    expect(result.resolved.map((r) => r.cohort.id)).toEqual([E01]);
    expect(result.restarts).toHaveLength(1);
    expect(result.restarts[0]).toMatchObject({
      group: "TW-F1",
      liquidationD: DATES[8],
      restartD: DATES[9],
    });

    // the resolved cohort: terminal fixed once, TTD and outcome from the liquidation NAV
    expect(await loadCohort(db, E01)).toMatchObject({
      terminalKind: "target",
      terminalD: D,
      ttdSessions: 8n,
      outcomeMicro: 1_230_000_000n,
      live: false,
    });
    expect((await loadCohort(db, E01))?.ttdDays).toBe(9n); // Mon 2 Mar to Wed 11 Mar

    // liquidation order for the position, filled at the next open under normal rules (the order
    // is a plain exit_cs; the orchestrator fills it)
    const orders = await loadPendingLiquidationOrders(db, E01);
    expect(orders).toEqual([{ id: `LQ:${E01}:${D}:ZZA`, code: "ZZA", qty: 60n, fillD: null }]);
    const stored = await db.execute(
      `SELECT decided_d, side, kind, status FROM arena_order WHERE id = 'LQ:${E01}:${D}:ZZA'`,
    );
    expect(stored.rows[0]).toMatchObject({
      decided_d: D,
      side: "sell",
      kind: "exit_cs",
      status: "pending",
    });

    // events on the resolved cohort
    const ev = await db.execute({
      sql: "SELECT kind, d, detail_json FROM cohort_event WHERE cohort_id = ? ORDER BY seq",
      args: [E01],
    });
    expect(ev.rows.map((r) => String(r.kind))).toEqual(["start", "terminal", "restart"]);
    expect(JSON.parse(String(ev.rows[1].detail_json))).toMatchObject({
      kind: "target",
      rule: "target",
      liq_nav_micro: "1230000000",
      liquidation_d: DATES[8],
    });

    // the whole group restarts on the same session, A$600 each, restart_of the old cohort
    const fresh = await db.execute(
      `SELECT id, restart_of, start_d, live, seed_micro FROM cohort WHERE start_d = '${DATES[9]}' ORDER BY id`,
    );
    expect(fresh.rows.map((r) => String(r.id))).toEqual([
      `C2-F1#01@${DATES[9]}`,
      `C2-F1#02@${DATES[9]}`,
      `C3-F1#01@${DATES[9]}`,
      `C3-F1#02@${DATES[9]}`,
      `E01@${DATES[9]}`,
      `E02@${DATES[9]}`,
    ]);
    expect(
      fresh.rows.every((r) => toBig(r.live) === 1n && toBig(r.seed_micro) === 600_000_000n),
    ).toBe(true);
    expect(fresh.rows.map((r) => String(r.restart_of))).toEqual([
      `C2-F1#01@${D0}`,
      `C2-F1#02@${D0}`,
      `C3-F1#01@${D0}`,
      `C3-F1#02@${D0}`,
      E01,
      E02,
    ]);
    expect(
      await count(
        db,
        "cash_ledger",
        `d = '${DATES[9]}' AND kind = 'seed' AND account = 'cash_settled'`,
      ),
    ).toBe(6n);

    // the unfinished twin and controls continue in shadow (live = 0), unresolved, with an event
    for (const id of [E02, `C2-F1#01@${D0}`, `C3-F1#02@${D0}`]) {
      expect(await loadCohort(db, id)).toMatchObject({ live: false, terminalKind: null });
      const kinds = (
        await db.execute({
          sql: "SELECT kind FROM cohort_event WHERE cohort_id = ? ORDER BY seq",
          args: [id],
        })
      ).rows.map((r) => String(r.kind));
      expect(kinds).toEqual(["start", "shadow_continue"]);
    }
    const sc = await db.execute({
      sql: "SELECT detail_json FROM cohort_event WHERE cohort_id = ? AND kind = 'shadow_continue'",
      args: [E02],
    });
    expect(JSON.parse(String(sc.rows[0].detail_json))).toMatchObject({
      new_cohort_id: `E02@${DATES[9]}`,
      trigger: E01,
      live_liquidation_nav_micro: "640000000",
      restart_d: DATES[9],
    });
    // other groups are untouched
    expect(await loadCohort(db, `E03@${D0}`)).toMatchObject({ live: true, terminalKind: null });
    expect((await loadLiveCohorts(db, "TW-F1")).every((c) => c.startD === DATES[9])).toBe(true);
  });

  it("running the step again writes nothing", async () => {
    const db = await startedDb();
    await openPosition(db, E01);
    await nav(db, E01, D, 1_230_000_000n, 1n);
    await nav(db, E02, D, 640_000_000n);
    const input = { d: D, calendar: [], signalsThroughD: prev, restart: RESTART };
    const first = await runTerminalChecks(db, [E01, E02], input);
    expect(first.written).toBe(true);
    const before = await dump(db);
    const second = await runTerminalChecks(db, [E01, E02], input);
    expect(second.written).toBe(false);
    expect(second.resolved).toEqual([]); // already resolved: nothing to judge
    expect(await dump(db)).toBe(before);
  });

  it("a shadow cohort that later resolves records its own terminal state and restarts nothing", async () => {
    const db = await startedDb();
    await openPosition(db, E01);
    await nav(db, E01, D, 1_230_000_000n, 1n);
    await runTerminalChecks(db, [E01], {
      d: D,
      calendar: [],
      signalsThroughD: prev,
      restart: RESTART,
    });
    const cohortsBefore = await count(db, "cohort");

    // E02's old (shadow) cohort sits below the stall floor for 5 consecutive sessions
    const stallDays = DATES.slice(8, 13);
    for (const d of stallDays) await nav(db, E02, d, 505_000_000n);
    const last = stallDays[4];
    const r = await runTerminalChecks(db, [E02], {
      d: last,
      calendar: [],
      signalsThroughD: DATES[11],
      restart: RESTART,
    });
    expect(r.resolved.map((x) => x.verdict.kind)).toEqual(["stalled"]);
    expect(r.restarts).toEqual([]);
    expect(await count(db, "cohort")).toBe(cohortsBefore); // no new cohorts
    const shadow = await loadCohort(db, E02);
    expect(shadow).toMatchObject({
      terminalKind: "stalled",
      terminalD: last,
      ttdSessions: 13n,
      live: false,
    });
    // its live successor carries on untouched
    expect(await loadCohort(db, `E02@${DATES[9]}`)).toMatchObject({
      live: true,
      terminalKind: null,
    });

    // effective N reads the stored fields: the shadow cohort counts; its overlapping live successor
    // is unresolved (censored) and never counts
    const all = await loadCohortsOfExecution(db, "E02");
    const eff = effectiveN(all);
    expect(eff.counted).toEqual([E02]);
    const e01s = await loadCohortsOfExecution(db, "E01");
    expect(effectiveN(e01s)).toEqual({ n: 1, counted: [E01] });
  });

  it("both twins resolving on the same close restart once; nobody goes to shadow among them", async () => {
    const db = await startedDb();
    await nav(db, E01, D, 1_250_000_000n);
    await nav(db, E02, D, 290_000_000n);
    const r = await runTerminalChecks(db, [E02, E01], {
      d: D,
      calendar: [],
      signalsThroughD: prev,
      restart: RESTART,
    });
    expect(r.resolved.map((x) => [x.cohort.id, x.verdict.kind])).toEqual([
      [E01, "target"],
      [E02, "bust"],
    ]);
    expect(r.restarts).toHaveLength(1);
    expect(r.restarts[0].ended.map((e) => e.cohortId)).toEqual([E01, E02]);
    expect(
      await count(
        db,
        "cohort_event",
        "kind = 'shadow_continue' AND cohort_id IN ('" + E01 + "', '" + E02 + "')",
      ),
    ).toBe(0n);
    expect(await count(db, "cohort", `start_d = '${DATES[9]}'`)).toBe(6n);
  });

  it("is atomic: if a successor cannot be written, no terminal state is recorded for the group", async () => {
    const db = await startedDb();
    await nav(db, E01, D, 1_230_000_000n);
    const before = await dump(db);
    const broken: RestartConfig = {
      ...RESTART,
      executionFor: (id) =>
        id === "E02" ? { ...executionFor("E02"), id: "E98" } : executionFor(id),
    };
    const e = await failWith(
      runTerminalChecks(db, [E01], { d: D, calendar: [], signalsThroughD: prev, restart: broken }),
    );
    expect((e as CohortWriteError).code).toBe("execution_missing");
    expect(await dump(db)).toBe(before);
    expect((await loadCohort(db, E01))?.terminalKind).toBeNull();
  });

  it("an unstarted or already resolved cohort is skipped; a missing NAV or cohort is loud", async () => {
    const db = await startedDb();
    expect(
      await evaluateCohort(db, E01, { d: D0, calendar: [], signalsThroughD: D0 }).catch(
        (e: unknown) => e,
      ),
    ).toBeInstanceOf(CohortWriteError);
    const missing = await failWith(
      evaluateCohort(db, "NOPE", { d: D, calendar: [], signalsThroughD: prev }),
    );
    expect((missing as CohortWriteError).code).toBe("cohort_missing");
    const noNav = await failWith(
      evaluateCohort(db, E01, { d: D, calendar: [], signalsThroughD: prev }),
    );
    expect((noNav as CohortWriteError).code).toBe("no_nav");
    await startCohorts(db, initialStarts(DATES[5]));
    expect(
      await evaluateCohort(db, `E01@${DATES[5]}`, {
        d: DATES[3],
        calendar: [],
        signalsThroughD: DATES[3],
      }),
    ).toBeNull();
  });

  it("the same scenario on two databases gives identical bytes (AT-13)", async () => {
    const run = async () => {
      const db = await startedDb();
      await openPosition(db, E01);
      await nav(db, E01, D, 1_230_000_000n, 1n);
      await nav(db, E02, D, 640_000_000n);
      await runTerminalChecks(db, [E01, E02], {
        d: D,
        calendar: [],
        signalsThroughD: prev,
        restart: RESTART,
      });
      return dump(db);
    };
    const a = await run();
    expect(await run()).toBe(a);
    expect(a.length).toBeGreaterThan(1000);
  });
});

describe("stall (b) from stored orders, books closed before signals (ARN-060)", () => {
  it("20 sessions of entry orders rejected only for parcel stall the cohort on the 21st close", async () => {
    const db = await startedDb();
    const id = `E03@${D0}`;
    const days = DATES.slice(0, 21);
    for (let i = 0; i < 20; i++) {
      await db.execute({
        sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status, reject_reason)
              VALUES (?, ?, ?, 'ZZA', 'buy', 'entry', 39, 'rejected', ?)`,
        args: [`R${i}`, id, days[i], i % 2 === 0 ? "parcel" : "parcel,whole_share"],
      });
    }
    for (const d of days) await nav(db, id, d, 520_000_000n);
    // at the 21st close the 21st day's signals are not written yet: signalsThrough = 20th day
    const history = await loadCloseHistory(db, id, days[20], days[19]);
    expect(history).toHaveLength(21);
    expect(history[19]).toMatchObject({ signals: 1, parcelOnlyRejections: 1 });
    expect(history[20]).toMatchObject({ signals: null });
    const r = await runTerminalChecks(db, [id], {
      d: days[20],
      calendar: [],
      signalsThroughD: days[19],
      restart: RESTART,
    });
    expect(r.resolved[0].verdict).toMatchObject({
      kind: "stalled",
      rule: "stall_parcel",
      ttdSessions: 21n,
    });
    // the F2 group (E03, E04, controls) restarted together
    expect(r.restarts[0].group).toBe("TW-F2");
    expect(r.restarts[0].shadow.length).toBe(5);
  });

  it("a rejection for another reason inside the window keeps the cohort alive", async () => {
    const db = await startedDb();
    const id = `E05@${D0}`;
    const days = DATES.slice(0, 21);
    for (let i = 0; i < 20; i++) {
      await db.execute({
        sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status, reject_reason)
              VALUES (?, ?, ?, 'ZZA', 'buy', 'entry', 39, 'rejected', ?)`,
        args: [`R${i}`, id, days[i], i === 4 ? "participation" : "parcel"],
      });
    }
    for (const d of days) await nav(db, id, d, 520_000_000n);
    const r = await runTerminalChecks(db, [id], {
      d: days[20],
      calendar: [],
      signalsThroughD: days[19],
      restart: RESTART,
    });
    expect(r.resolved).toEqual([]);
  });
});

describe("liquidation result and the legacy ledger (ARN-026, ARN-053)", () => {
  const D = DATES[7];
  const E01 = `E01@${D0}`;

  async function resolved(): Promise<Client> {
    const db = await startedDb();
    await openPosition(db, E01, "ZZA");
    await openPosition(db, E01, "ZZB");
    await nav(db, E01, D, 1_230_000_000n, 2n);
    await runTerminalChecks(db, [E01], {
      d: D,
      calendar: [],
      signalsThroughD: DATES[6],
      restart: RESTART,
    });
    return db;
  }

  it("two held codes get two liquidation orders; a halted one moves to the legacy ledger at its marked value", async () => {
    const db = await resolved();
    expect((await loadPendingLiquidationOrders(db, E01)).map((o) => o.code)).toEqual([
      "ZZA",
      "ZZB",
    ]);
    const items = planLegacy({
      positions: new Map([
        ["ZZA", 60n],
        ["ZZB", 60n],
      ]),
      openTrades: [
        { tradeId: `T-${E01}-ZZA`, code: "ZZA" },
        { tradeId: `T-${E01}-ZZB`, code: "ZZB" },
      ],
      halted: new Set(["ZZB"]),
      markFor: () =>
        suspensionMark({
          lastCloseMicro: 2_000_000n,
          advMicro: 1_000_000_000n,
          haltStartD: DATES[0],
          d: DATES[9],
          calendar: [],
        }),
    });
    expect(items).toHaveLength(1);
    expect(await writeLegacyMoves(db, { cohortId: E01, d: DATES[8], items })).toEqual({
      written: true,
    });
    const trade = await db.execute(
      `SELECT exit_type, legacy, exit_fill_id FROM trade WHERE id = 'T-${E01}-ZZB'`,
    );
    expect(trade.rows[0]).toMatchObject({ exit_type: "legacy", legacy: 1n, exit_fill_id: null });
    expect(
      (await db.execute(`SELECT legacy FROM trade WHERE id = 'T-${E01}-ZZA'`)).rows[0].legacy,
    ).toBe(0n);
    const order = await db.execute(
      `SELECT status, reject_reason FROM arena_order WHERE id = 'LQ:${E01}:${D}:ZZB'`,
    );
    expect(order.rows[0]).toMatchObject({ status: "cancelled", reject_reason: "halted" });
    expect((await loadPendingLiquidationOrders(db, E01)).map((o) => o.code)).toEqual(["ZZA"]);
    const ev = await db.execute({
      sql: "SELECT detail_json FROM cohort_event WHERE cohort_id = ? AND kind = 'data_event'",
      args: [E01],
    });
    expect(JSON.parse(String(ev.rows[0].detail_json)).legacy[0]).toMatchObject({
      code: "ZZB",
      qty: "60",
      haircut: false,
      value_micro: "120000000",
    });
    // the same move again is a no-op
    expect(await writeLegacyMoves(db, { cohortId: E01, d: DATES[8], items })).toEqual({
      written: false,
    });
  });

  it("legacy moves need a resolved cohort and an open trade of that cohort", async () => {
    const db = await resolved();
    const item = {
      tradeId: "T-nope",
      code: "ZZA",
      qty: 1n,
      closeMicro: 1n,
      haircut: false,
      valueMicro: 1n,
    };
    const unresolved = await failWith(
      writeLegacyMoves(db, { cohortId: `E03@${D0}`, d: D, items: [item] }),
    );
    expect((unresolved as CohortWriteError).code).toBe("not_terminal");
    const bad = await failWith(writeLegacyMoves(db, { cohortId: E01, d: D, items: [item] }));
    expect((bad as CohortWriteError).code).toBe("legacy_conflict");
    expect(await writeLegacyMoves(db, { cohortId: E01, d: D, items: [] })).toEqual({
      written: false,
    });
  });

  it("stores the realised value after liquidation once; a different figure raises", async () => {
    const db = await resolved();
    const input = {
      cohortId: E01,
      d: DATES[8],
      realisedNavMicro: 1_227_500_000n,
      legacyValueMicro: 120_000_000n,
    };
    expect(await writeLiquidated(db, input)).toEqual({ written: true });
    expect(await writeLiquidated(db, input)).toEqual({ written: false });
    const ev = await db.execute({
      sql: "SELECT detail_json FROM cohort_event WHERE cohort_id = ? AND kind = 'liquidated'",
      args: [E01],
    });
    expect(JSON.parse(String(ev.rows[0].detail_json))).toMatchObject({
      realised_nav_micro: "1227500000",
      legacy_value_micro: "120000000",
    });
    const e = await failWith(writeLiquidated(db, { ...input, realisedNavMicro: 1n }));
    expect((e as CohortWriteError).code).toBe("event_conflict");
    const open = await failWith(writeLiquidated(db, { ...input, cohortId: `E03@${D0}` }));
    expect((open as CohortWriteError).code).toBe("not_terminal");
  });

  it("the restart cohorts start fresh: new ids, no legacy position, A$600 cash", async () => {
    const db = await resolved();
    const fresh = `E01@${DATES[9]}`;
    expect(await loadCohort(db, fresh)).toMatchObject({ restartOf: E01, live: true });
    expect(await count(db, "trade", `cohort_id = '${fresh}'`)).toBe(0n);
    expect(cohortIdFor("E01", null, DATES[9])).toBe(fresh);
  });
});
