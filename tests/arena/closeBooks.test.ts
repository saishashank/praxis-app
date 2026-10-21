// @vitest-environment node
// The daily orchestrator, batch 2a (M3 T10): preconditions and the data-only guard (D-066), run
// records and duplicate runs (PLT-076), stage-level resume, fills at the open against the raw bar,
// the quality gate at fill time (DAT-210), IS stops, dividends and a split, a halted holding at
// the liquidation (legacy ledger), the sleeve, and the invariant freeze (ARN-101). Synthetic ZZ
// data on a real migrated libSQL file; the long golden replay is in replay.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { closeBooksDay, closeBooksKey, type CloseBooksResult } from "@/lib/arena/closeBooks";
import { writeFill } from "@/lib/arena/fillWriter";
import type { SimulatedFill } from "@/lib/arena/fills";
import { toBig } from "@/lib/arena/ledgerWriter";
import { cleanupTempDbs } from "../db/helpers";
import {
  MARKET,
  NOW,
  NO_TERMINAL,
  dumpTables,
  paramOverridesFor,
  setMode,
  setupReplay,
  type FullSetup,
} from "./replayHarness";

afterEach(cleanupTempDbs);

const BASE = { startD: "2030-01-07", sessions: 70, seed: 3 };

const closeDay = (
  db: Client,
  d: string,
  extra: { replay?: boolean } = {},
): Promise<CloseBooksResult> =>
  closeBooksDay(db, { market: MARKET, d, replay: true, now: NOW, ...extra });

async function closeThrough(s: FullSetup, last: number): Promise<CloseBooksResult[]> {
  const out: CloseBooksResult[] = [];
  for (let i = 0; i <= last; i++) out.push(await closeDay(s.db, s.ds.dates[i]));
  return out;
}

type OrderSpec = {
  id: string;
  cohortId: string;
  decidedD: string;
  code: string;
  kind: "entry" | "exit_cs";
  qty: number;
  stop?: bigint;
};

async function placeOrder(db: Client, o: OrderSpec): Promise<void> {
  await db.execute({
    sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, ref_stop_micro, tier)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'U1')`,
    args: [
      o.id,
      o.cohortId,
      o.decidedD,
      o.code,
      o.kind === "entry" ? "buy" : "sell",
      o.kind,
      o.qty,
      o.stop ?? null,
    ],
  });
}

const one = async (db: Client, sql: string, args: unknown[] = []) =>
  (await db.execute({ sql, args: args as never })).rows[0];
const rowsOf = async (db: Client, sql: string, args: unknown[] = []) =>
  (await db.execute({ sql, args: args as never })).rows;
const n = async (db: Client, sql: string, args: unknown[] = []): Promise<bigint> =>
  toBig((await one(db, sql, args)).n);

const E01 = (s: FullSetup) => s.cohortIds.find((id) => id.startsWith("E01@")) as string;
const E02 = (s: FullSetup) => s.cohortIds.find((id) => id.startsWith("E02@")) as string;

describe("preconditions and the data-only guard (D-066, BLD-024)", () => {
  it("production (no replay) with a data_only market records a skip and writes no arena row", async () => {
    const s = await setupReplay(BASE);
    const before = await dumpTables(s.db);
    const r = await closeBooksDay(s.db, { market: MARKET, d: s.ds.dates[2], now: NOW });
    expect(r).toMatchObject({ status: "skipped", reason: "data_only_guard", closed: [] });
    expect(await dumpTables(s.db)).toEqual(before);
    for (const t of [
      "fill",
      "nav_daily",
      "nav_daily_pos",
      "arena_order",
      "trade",
      "sleeve_trade",
    ]) {
      expect(await n(s.db, `SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0n);
    }
    const run = await one(s.db, "SELECT * FROM run_record WHERE concurrency_key = ?", [
      closeBooksKey(MARKET, s.ds.dates[2]),
    ]);
    expect(String(run.job)).toBe("arena-close");
    expect(String(run.status)).toBe("skipped");
    expect(JSON.parse(String(run.details_json))).toEqual({ reason: "data_only_guard" });
    // a skip does not block the real run later (only a success does)
    expect((await closeDay(s.db, s.ds.dates[2])).status).toBe("success");
  });

  it("an off market is skipped even as a replay; a full market runs without the replay flag", async () => {
    const s = await setupReplay(BASE);
    await setMode(s.db, "off");
    expect(await closeDay(s.db, s.ds.dates[2])).toMatchObject({
      status: "skipped",
      reason: "market_off",
    });
    await setMode(s.db, "full");
    const r = await closeBooksDay(s.db, { market: MARKET, d: s.ds.dates[2], now: NOW });
    expect(r.status).toBe("success");
    expect(r.closed).toEqual(s.cohortIds.slice().sort());
    expect(await n(s.db, "SELECT COUNT(*) AS n FROM nav_daily")).toBe(BigInt(s.cohortIds.length));
  });

  it("skips (with a run record, nothing written) on a weekend, a holiday and a missing marker", async () => {
    const s = await setupReplay({ ...BASE, stopAfter: 20 });
    const sat = "2030-01-12";
    expect(await closeDay(s.db, sat)).toMatchObject({
      status: "skipped",
      reason: "non_trading_day",
    });
    const holiday = s.ds.dates[10];
    await s.db.execute({
      sql: "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES ('AU', ?, 'holiday', NULL, 1, 'synthetic')",
      args: [holiday],
    });
    expect(await closeDay(s.db, holiday)).toMatchObject({
      status: "skipped",
      reason: "non_trading_day",
    });
    const late = await closeDay(s.db, s.ds.dates[30]);
    expect(late).toMatchObject({ status: "skipped", reason: "no_completion_marker" });
    expect(await n(s.db, "SELECT COUNT(*) AS n FROM nav_daily")).toBe(0n);
    expect(await n(s.db, "SELECT COUNT(*) AS n FROM run_record WHERE status = 'skipped'")).toBe(3n);
  });

  it("a non-trading marker alone is not a data marker", async () => {
    const s = await setupReplay({ ...BASE, stopAfter: 10 });
    const d = s.ds.dates[20];
    await s.db.execute({
      sql: `INSERT INTO completion_marker (market, d, kind, at, run_id, outcome)
            VALUES ('AU', ?, 'non-trading', '2030-02-01T00:00:00.000Z', NULL, 'non-trading')`,
      args: [d],
    });
    expect(await closeDay(s.db, d)).toMatchObject({ status: "skipped", reason: "non_trading_day" });
  });
});

describe("run records and idempotency (PLT-076, design 4.6)", () => {
  it("one record per session keyed arena-2a:<market>:<d>; a second run is a no-op", async () => {
    const s = await setupReplay(BASE);
    const d = s.ds.dates[3];
    const first = await closeDay(s.db, d);
    expect(first.status).toBe("success");
    const key = closeBooksKey(MARKET, d);
    expect(key).toBe(`arena-2a:AU:${d}`);
    expect(
      await n(s.db, "SELECT COUNT(*) AS n FROM run_record WHERE concurrency_key = ?", [key]),
    ).toBe(1n);
    const before = await dumpTables(s.db);
    const second = await closeDay(s.db, d);
    expect(second.status).toBe("already_done");
    expect(
      await n(s.db, "SELECT COUNT(*) AS n FROM run_record WHERE concurrency_key = ?", [key]),
    ).toBe(1n);
    expect(await dumpTables(s.db)).toEqual(before);
  });

  it("a failed run is retried and writes nothing new (every writer is idempotent)", async () => {
    const s = await setupReplay(BASE);
    const cohort = E01(s);
    await placeOrder(s.db, {
      id: "O1",
      cohortId: cohort,
      decidedD: s.ds.dates[1],
      code: "ZZA",
      kind: "entry",
      qty: 40,
      stop: 1_000_000n,
    });
    await closeThrough(s, 6);
    const before = await dumpTables(s.db);
    await s.db.execute(
      "UPDATE run_record SET status = 'failed' WHERE concurrency_key LIKE 'arena-2a:%'",
    );
    for (let i = 0; i <= 6; i++)
      expect((await closeDay(s.db, s.ds.dates[i])).status).toBe("success");
    expect(await dumpTables(s.db)).toEqual(before);
  });

  it("resumes after a kill between the fill and its ledger postings: same rows as an undisturbed run", async () => {
    const make = async (): Promise<FullSetup> => {
      const s = await setupReplay({ ...BASE, keep: ["E02"] });
      await placeOrder(s.db, {
        id: "O1",
        cohortId: E02(s),
        decidedD: s.ds.dates[2],
        code: "ZZA",
        kind: "entry",
        qty: 30,
        stop: 800_000n,
      });
      return s;
    };
    const a = await make();
    await closeThrough(a, 6);

    // B is killed after the fill and trade rows were written but before anything was posted
    const fillRow = await one(a.db, "SELECT * FROM fill WHERE order_id = 'O1'");
    const bar = {
      openMicro: toBig(fillRow.bar_o_micro),
      highMicro: toBig(fillRow.bar_h_micro),
      lowMicro: toBig(fillRow.bar_l_micro),
      closeMicro: toBig(fillRow.bar_c_micro),
    };
    // days 0..2 close normally; then do by hand what the engine does first on the fill day
    const fresh = await make();
    await closeThrough(fresh, 2);
    const fill: SimulatedFill = {
      rule: String(fillRow.rule) as SimulatedFill["rule"],
      side: "buy",
      qty: toBig(fillRow.qty),
      refPriceMicro: toBig(fillRow.ref_price_micro),
      slipMicro: toBig(fillRow.slip_micro),
      fillPriceMicro: toBig(fillRow.fill_price_micro),
      valueMicro: toBig(fillRow.value_micro),
      brokerageMicro: toBig(fillRow.brokerage_micro),
      costProfile: String(fillRow.cost_profile),
      bar,
    };
    await writeFill(fresh.db, {
      fillId: String(fillRow.id),
      orderId: "O1",
      cohortId: E02(fresh),
      d: s3(a),
      code: "ZZA",
      fill,
      trade: {
        kind: "open",
        tradeId: "T:O1",
        stopMicro: toBig(
          (await one(a.db, "SELECT stop_micro FROM trade WHERE id = 'T:O1'")).stop_micro,
        ),
      },
    });
    expect(
      await n(fresh.db, "SELECT COUNT(*) AS n FROM cash_ledger WHERE txn_id LIKE 'fill:%'"),
    ).toBe(0n);
    for (let i = 3; i <= 6; i++) await closeDay(fresh.db, fresh.ds.dates[i]);
    const da = await dumpTables(a.db);
    const db2 = await dumpTables(fresh.db);
    for (const t of Object.keys(da)) expect(db2[t] === da[t], t).toBe(true);
    expect(
      await n(fresh.db, "SELECT COUNT(*) AS n FROM cash_ledger WHERE txn_id LIKE 'fill:%'"),
    ).toBeGreaterThan(0n);
  });
});

function s3(s: FullSetup): string {
  return s.ds.dates[3];
}

describe("fills, stops and the quality gate", () => {
  it("an entry fills at the next open with slippage; the initial stop comes from the actual fill", async () => {
    const s = await setupReplay({ ...BASE, keep: ["E01"] });
    const cohort = E01(s);
    await placeOrder(s.db, {
      id: "O1",
      cohortId: cohort,
      decidedD: s.ds.dates[1],
      code: "ZZA",
      kind: "entry",
      qty: 30,
      stop: 500_000n,
    });
    const results = await closeThrough(s, 5);
    expect(results.every((r) => r.status === "success")).toBe(true);
    const order = await one(s.db, "SELECT status, fill_d FROM arena_order WHERE id = 'O1'");
    expect(String(order.status)).toBe("filled");
    expect(String(order.fill_d)).toBe(s.ds.dates[2]);
    const fill = await one(s.db, "SELECT * FROM fill WHERE order_id = 'O1'");
    expect(String(fill.rule)).toBe("open");
    expect(toBig(fill.fill_price_micro)).toBeGreaterThan(toBig(fill.bar_o_micro)); // adverse slippage
    expect(toBig(fill.ref_price_micro)).toBe(toBig(fill.bar_o_micro));
    const trade = await one(s.db, "SELECT * FROM trade WHERE entry_fill_id = ?", [String(fill.id)]);
    expect(toBig(trade.stop_micro)).toBe(toBig(fill.fill_price_micro) - 500_000n);
    // posted: payable + position cost + brokerage, settled two sessions later
    expect(
      await n(s.db, "SELECT COUNT(*) AS n FROM cash_ledger WHERE txn_id = ?", [
        `fill:${String(fill.id)}`,
      ]),
    ).toBe(2n);
    const settled = await rowsOf(
      s.db,
      "SELECT d FROM cash_ledger WHERE kind = 'settle' AND cohort_id = ? AND account = 'cash_settled'",
      [cohort],
    );
    expect(String(settled[0].d)).toBe(s.ds.dates[4]);
  });

  it("an IS stop one tick below the fill is hit on the entry session (afterOpen) at the stop level", async () => {
    const s = await setupReplay({ ...BASE, keep: ["E01"] });
    await placeOrder(s.db, {
      id: "O1",
      cohortId: E01(s),
      decidedD: s.ds.dates[1],
      code: "ZZB",
      kind: "entry",
      qty: 40,
      stop: 10_000n,
    });
    await closeThrough(s, 3);
    const trade = await one(s.db, "SELECT exit_type, exit_fill_id FROM trade");
    expect(String(trade.exit_type)).toBe("IS");
    const exit = await one(s.db, "SELECT rule, d FROM fill WHERE id = ?", [
      String(trade.exit_fill_id),
    ]);
    expect(String(exit.rule)).toBe("level"); // the open cannot gap through a stop set after it
    expect(String(exit.d)).toBe(s.ds.dates[2]);
    const order = await one(
      s.db,
      "SELECT kind, decided_d, status FROM arena_order WHERE id LIKE 'IS:%'",
    );
    expect(String(order.kind)).toBe("exit_is");
    expect(String(order.status)).toBe("filled");
    // bought and sold in one session: the sale is posted after the purchase (fill ids F2: < F3:)
    expect(
      await n(
        s.db,
        "SELECT COUNT(DISTINCT txn_id) AS n FROM cash_ledger WHERE txn_id LIKE 'fill:F%'",
      ),
    ).toBe(2n);
    expect(
      await n(
        s.db,
        "SELECT COALESCE(SUM(delta_micro), 0) AS n FROM cash_ledger WHERE account = 'position_cost'",
      ),
    ).toBe(0n);
    expect(await n(s.db, "SELECT COUNT(*) AS n FROM nav_daily WHERE invariants_ok = 0")).toBe(0n);
  });

  it("DAT-210: a failed gate cancels a pending entry at fill time; an exit still executes that day", async () => {
    const s = await setupReplay({ ...BASE, keep: ["E01"], gateFailEvery: 9 });
    const cohort = E01(s);
    // ZZA bought on day 2, exit decided on day 8 fills on day 9, the day the U1 gate fails
    await placeOrder(s.db, {
      id: "O1",
      cohortId: cohort,
      decidedD: s.ds.dates[1],
      code: "ZZA",
      kind: "entry",
      qty: 30,
      stop: 5_000_000n,
    });
    await placeOrder(s.db, {
      id: "X1",
      cohortId: cohort,
      decidedD: s.ds.dates[8],
      code: "ZZA",
      kind: "exit_cs",
      qty: 30,
    });
    await placeOrder(s.db, {
      id: "O2",
      cohortId: cohort,
      decidedD: s.ds.dates[8],
      code: "ZZB",
      kind: "entry",
      qty: 30,
      stop: 5_000_000n,
    });
    await closeThrough(s, 10);
    const o2 = await one(s.db, "SELECT status, reject_reason FROM arena_order WHERE id = 'O2'");
    expect(String(o2.status)).toBe("cancelled");
    expect(String(o2.reject_reason)).toBe("gate");
    expect(await n(s.db, "SELECT COUNT(*) AS n FROM fill WHERE order_id = 'O2'")).toBe(0n);
    const x1 = await one(s.db, "SELECT status, fill_d FROM arena_order WHERE id = 'X1'");
    expect(String(x1.status)).toBe("filled");
    expect(String(x1.fill_d)).toBe(s.ds.dates[9]);
    const trade = await one(s.db, "SELECT exit_type FROM trade WHERE id = 'T:O1'");
    expect(["CS", "IS"]).toContain(String(trade.exit_type));
  });

  it("an entry the cash cannot cover at the actual open is cancelled with reason cash (ARN-101)", async () => {
    const s = await setupReplay({ ...BASE, keep: ["E01"] });
    await placeOrder(s.db, {
      id: "O1",
      cohortId: E01(s),
      decidedD: s.ds.dates[1],
      code: "ZZC",
      kind: "entry",
      qty: 400,
      stop: 500_000n,
    });
    const results = await closeThrough(s, 3);
    expect(results.every((r) => r.status === "success")).toBe(true);
    const o = await one(s.db, "SELECT status, reject_reason FROM arena_order WHERE id = 'O1'");
    expect(String(o.status)).toBe("cancelled");
    expect(String(o.reject_reason)).toBe("cash");
    expect(await n(s.db, "SELECT COUNT(*) AS n FROM nav_daily WHERE invariants_ok = 0")).toBe(0n);
  });
});

describe("corporate actions through the orchestrator (TST-102, ARN-036, ARN-043)", () => {
  it("a dividend accrues on the ex-date and is paid on the pay date; a split re-bases the quantity", async () => {
    const s = await setupReplay({
      ...BASE,
      keep: ["E01"],
      dividendAt: 12,
      splitAt: 30,
      params: NO_TERMINAL,
    });
    const cohort = E01(s);
    await placeOrder(s.db, {
      id: "OB",
      cohortId: cohort,
      decidedD: s.ds.dates[5],
      code: "ZZB",
      kind: "entry",
      qty: 20,
      stop: 5_000_000n,
    });
    await placeOrder(s.db, {
      id: "OC",
      cohortId: cohort,
      decidedD: s.ds.dates[5],
      code: "ZZC",
      kind: "entry",
      qty: 6,
      stop: 15_000_000n,
    });
    await closeThrough(s, 40);
    expect(await n(s.db, "SELECT COUNT(*) AS n FROM nav_daily WHERE invariants_ok = 0")).toBe(0n);
    const exD = s.ds.dates[12];
    // ZZB: 30 shares (if it was not stopped out before the ex-date)
    const heldB = await one(
      s.db,
      "SELECT qty FROM nav_daily_pos WHERE cohort_id = ? AND d = ? AND code = 'ZZB'",
      [cohort, s.ds.dates[11]],
    );
    expect(heldB).toBeDefined();
    {
      const accrue = await one(
        s.db,
        "SELECT delta_micro FROM cash_ledger WHERE cohort_id = ? AND kind = 'div_accrue' AND account = 'div_recv'",
        [cohort],
      );
      expect(toBig(accrue.delta_micro)).toBe(toBig(heldB.qty) * 120_000n);
      const nav = await one(
        s.db,
        "SELECT div_recv_micro FROM nav_daily WHERE cohort_id = ? AND d = ?",
        [cohort, exD],
      );
      expect(toBig(nav.div_recv_micro)).toBe(toBig(heldB.qty) * 120_000n);
      const paid = await one(
        s.db,
        "SELECT d FROM cash_ledger WHERE cohort_id = ? AND kind = 'div_pay' AND account = 'cash_settled'",
        [cohort],
      );
      expect(String(paid.d) >= exD).toBe(true);
      const after = await one(
        s.db,
        "SELECT div_recv_micro FROM nav_daily WHERE cohort_id = ? AND d = ?",
        [cohort, String(paid.d)],
      );
      expect(toBig(after.div_recv_micro)).toBe(0n);
    }
    // ZZC: the 2-for-1 split on day 30 doubles the held quantity, the raw close roughly halves
    const before = await one(
      s.db,
      "SELECT qty, close_micro FROM nav_daily_pos WHERE cohort_id = ? AND d = ? AND code = 'ZZC'",
      [cohort, s.ds.dates[29]],
    );
    expect(before).toBeDefined();
    {
      const post = await one(
        s.db,
        "SELECT qty, close_micro FROM nav_daily_pos WHERE cohort_id = ? AND d = ? AND code = 'ZZC'",
        [cohort, s.ds.dates[30]],
      );
      expect(toBig(post.qty)).toBe(toBig(before.qty) * 2n);
      expect(toBig(post.close_micro) * 2n).toBeLessThan((toBig(before.close_micro) * 12n) / 10n);
      expect(toBig(post.close_micro) * 2n).toBeGreaterThan((toBig(before.close_micro) * 8n) / 10n);
      expect(
        await n(
          s.db,
          "SELECT COUNT(*) AS n FROM cohort_event WHERE cohort_id = ? AND kind = 'ca_adjust'",
          [cohort],
        ),
      ).toBe(1n);
    }
  });
});

describe("a halted holding and the liquidation (ARN-026, ARN-053)", () => {
  it("a suspended code keeps its last price, takes the 1/2 haircut from the 21st halted session, and cannot be sold", async () => {
    const s = await setupReplay({
      ...BASE,
      sessions: 62,
      keep: ["E01"],
      haltFrom: 12,
      haltTo: 55,
      params: NO_TERMINAL,
    });
    const cohort = E01(s);
    await placeOrder(s.db, {
      id: "OE",
      cohortId: cohort,
      decidedD: s.ds.dates[8],
      code: "ZZE",
      kind: "entry",
      qty: 100,
      stop: 3_000_000n,
    });
    await placeOrder(s.db, {
      id: "XE",
      cohortId: cohort,
      decidedD: s.ds.dates[15],
      code: "ZZE",
      kind: "exit_cs",
      qty: 100,
    });
    const results = await closeThrough(s, 50);
    expect(results.every((r) => r.status === "success")).toBe(true);
    const entry = await one(s.db, "SELECT status FROM arena_order WHERE id = 'OE'");
    expect(String(entry.status)).toBe("filled");
    const trade = await one(s.db, "SELECT exit_type FROM trade WHERE id = 'T:OE'");
    expect(trade.exit_type).toBeNull(); // still held when the halt starts
    // frozen at the last close, unsellable, pending until the halt ends
    const last = await one(
      s.db,
      "SELECT close_micro FROM nav_daily_pos WHERE cohort_id = ? AND d = ? AND code = 'ZZE'",
      [cohort, s.ds.dates[11]],
    );
    for (let i = 12; i <= 32; i++) {
      const row = await one(
        s.db,
        "SELECT close_micro, haircut FROM nav_daily_pos WHERE cohort_id = ? AND d = ? AND code = 'ZZE'",
        [cohort, s.ds.dates[i]],
      );
      expect(toBig(row.close_micro), s.ds.dates[i]).toBe(toBig(last.close_micro));
      // halted session number = i - 11; the haircut applies once 20 have fully elapsed
      expect(toBig(row.haircut), s.ds.dates[i]).toBe(i - 11 >= 21 ? 1n : 0n);
    }
    const x = await one(s.db, "SELECT status FROM arena_order WHERE id = 'XE'");
    expect(String(x.status)).toBe("pending");
  });

  it("a cohort that ends while its holding is halted moves it to the legacy ledger", async () => {
    const s = await setupReplay({
      ...BASE,
      sessions: 62,
      keep: ["E01"],
      haltFrom: 12,
      haltTo: 55,
      params: { terminal: { timeoutSessions: 30 } },
    });
    const cohort = E01(s);
    await placeOrder(s.db, {
      id: "OE",
      cohortId: cohort,
      decidedD: s.ds.dates[8],
      code: "ZZE",
      kind: "entry",
      qty: 100,
      stop: 3_000_000n,
    });
    const results = await closeThrough(s, 40);
    expect(results.every((r) => r.status === "success")).toBe(true);
    const entry = await one(s.db, "SELECT status FROM arena_order WHERE id = 'OE'");
    const trade = await one(s.db, "SELECT exit_type FROM trade WHERE id = 'T:OE'");
    expect(String(entry.status)).toBe("filled");
    expect(trade.exit_type).toBe("legacy");
    const c = await one(s.db, "SELECT terminal_kind, terminal_d FROM cohort WHERE id = ?", [
      cohort,
    ]);
    expect(String(c.terminal_kind)).toBe("timeout");
    const lq = await one(
      s.db,
      "SELECT status, reject_reason FROM arena_order WHERE id LIKE 'LQ:%'",
    );
    expect(String(lq.status)).toBe("cancelled");
    expect(String(lq.reject_reason)).toBe("halted");
    const t = await one(s.db, "SELECT exit_type, legacy FROM trade WHERE id = 'T:OE'");
    expect(String(t.exit_type)).toBe("legacy");
    expect(toBig(t.legacy)).toBe(1n);
    const done = await one(
      s.db,
      "SELECT detail_json FROM cohort_event WHERE cohort_id = ? AND kind = 'liquidated'",
      [cohort],
    );
    const detail = JSON.parse(String(done.detail_json)) as { legacy_value_micro: string };
    expect(BigInt(detail.legacy_value_micro)).toBeGreaterThan(0n);
    expect(await n(s.db, "SELECT COUNT(*) AS n FROM cohort WHERE restart_of = ?", [cohort])).toBe(
      1n,
    );
  });
});

describe("the sleeve inside the orchestrator (ARN-003, ARN-040..046)", () => {
  it("opens with the stock entry, accrues financing, and closes with the stock exit", async () => {
    const s = await setupReplay({ ...BASE, keep: ["E02"] });
    const cohort = E02(s);
    await placeOrder(s.db, {
      id: "O1",
      cohortId: cohort,
      decidedD: s.ds.dates[1],
      code: "ZZA",
      kind: "entry",
      qty: 25,
      stop: 400_000n,
    });
    await placeOrder(s.db, {
      id: "X1",
      cohortId: cohort,
      decidedD: s.ds.dates[9],
      code: "ZZA",
      kind: "exit_cs",
      qty: 25,
    });
    const results = await closeThrough(s, 12);
    expect(results.every((r) => r.status === "success")).toBe(true);
    const trade = await one(s.db, "SELECT * FROM sleeve_trade WHERE id = 'S:O1'");
    if (trade === undefined) throw new Error("the sleeve did not open");
    expect(toBig(trade.margin_micro)).toBe(20_000_000n); // min(A$20, 4 % of the A$600 NAV)
    expect(toBig(trade.notional_micro)).toBe(200_000_000n);
    expect(String(trade.open_d)).toBe(s.ds.dates[2]);
    expect(trade.closed_by).not.toBeNull();
    expect(["exit", "closeout"]).toContain(String(trade.closed_by));
    // margin left settled cash at once and came back (less costs) when the sleeve closed
    const open = await one(
      s.db,
      "SELECT delta_micro FROM cash_ledger WHERE kind = 'sleeve_open' AND account = 'sleeve_margin'",
    );
    expect(toBig(open.delta_micro)).toBe(20_000_000n);
    expect(
      await n(
        s.db,
        "SELECT COUNT(*) AS n FROM cash_ledger WHERE kind = 'sleeve_close' AND account = 'sleeve_margin'",
      ),
    ).toBe(1n);
    expect(await n(s.db, "SELECT COUNT(*) AS n FROM nav_daily WHERE invariants_ok = 0")).toBe(0n);
    const bal = await one(
      s.db,
      "SELECT SUM(delta_micro) AS n FROM cash_ledger WHERE account IN ('sleeve_margin', 'fin_accrued')",
    );
    expect(toBig(bal.n)).toBe(0n);
  });

  it("a sleeve that does not fit in settled cash is skipped; the stock entry still goes ahead", async () => {
    const s = await setupReplay({ ...BASE, keep: ["E02"] });
    const cohort = E02(s);
    // an order that takes almost all of the cash: margin plus fee no longer fits
    const open = await one(s.db, "SELECT o FROM price_bar WHERE code = 'ZZB' AND d = ?", [
      s.ds.dates[2],
    ]);
    const openMicro = BigInt(Math.round(Number(open.o) * 1e6));
    // spend all but about A$10: the A$20 margin plus its fee can no longer be found afterwards
    const qty = Number((600_000_000n - 16_000_000n) / (openMicro + 20_000n));
    await placeOrder(s.db, {
      id: "O1",
      cohortId: cohort,
      decidedD: s.ds.dates[1],
      code: "ZZB",
      kind: "entry",
      qty,
      stop: 1_000_000n,
    });
    await closeThrough(s, 4);
    const o = await one(s.db, "SELECT status FROM arena_order WHERE id = 'O1'");
    expect(String(o.status)).toBe("filled");
    expect(await n(s.db, "SELECT COUNT(*) AS n FROM sleeve_trade")).toBe(0n);
    expect(await n(s.db, "SELECT COUNT(*) AS n FROM trade")).toBe(1n);
  });
});

describe("ARN-101: a violation freezes the cohort and fails the run", () => {
  it("stores the day with invariants_ok = 0, logs an error, and runs no later phase for that cohort", async () => {
    const s = await setupReplay({ ...BASE, keep: ["E01", "E02"] });
    const [c1, c2] = [E01(s), E02(s)];
    await closeThrough(s, 3);
    // tamper: an unbalanced ledger row (append-only tables accept inserts)
    await s.db.execute({
      sql: `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind)
            VALUES (?, ?, 'tamper', 'cash_settled', 1000000, 'div_pay')`,
      args: [c1, s.ds.dates[3]],
    });
    await placeOrder(s.db, {
      id: "O9",
      cohortId: c1,
      decidedD: s.ds.dates[3],
      code: "ZZA",
      kind: "entry",
      qty: 20,
      stop: 400_000n,
    });
    const bad = await closeDay(s.db, s.ds.dates[4]);
    expect(bad.status).toBe("failed");
    expect(bad.failed).toEqual([c1]);
    expect(bad.closed).toEqual([c2]);
    const day = await one(
      s.db,
      "SELECT invariants_ok FROM nav_daily WHERE cohort_id = ? AND d = ?",
      [c1, s.ds.dates[4]],
    );
    expect(toBig(day.invariants_ok)).toBe(0n);
    const log = await one(s.db, "SELECT level, message FROM app_log WHERE level = 'error'");
    expect(String(log.message)).toContain(c1);
    expect(String(log.message)).toContain("txn_not_balanced");
    const run = await one(
      s.db,
      "SELECT status, error_summary FROM run_record WHERE concurrency_key = ?",
      [closeBooksKey(MARKET, s.ds.dates[4])],
    );
    expect(String(run.status)).toBe("failed");
    // the next session: c1 is frozen (no phase runs), the other cohort carries on, the run is degraded
    const next = await closeDay(s.db, s.ds.dates[5]);
    expect(next.status).toBe("degraded");
    expect(next.frozen).toEqual([c1]);
    expect(next.closed).toEqual([c2]);
    expect(
      await n(s.db, "SELECT COUNT(*) AS n FROM nav_daily WHERE cohort_id = ? AND d = ?", [
        c1,
        s.ds.dates[5],
      ]),
    ).toBe(0n);
    const o9 = await one(s.db, "SELECT status FROM arena_order WHERE id = 'O9'");
    expect(["pending", "filled"]).toContain(String(o9.status));
    expect(
      await n(s.db, "SELECT COUNT(*) AS n FROM fill WHERE cohort_id = ? AND d >= ?", [
        c1,
        s.ds.dates[5],
      ]),
    ).toBe(0n);
  });
});

describe("params and the restart configuration", () => {
  it("restarted cohorts take the injected parameters", async () => {
    const s = await setupReplay({
      ...BASE,
      keep: ["E01"],
      params: { terminal: { timeoutSessions: 12 } },
    });
    const results: CloseBooksResult[] = [];
    for (let i = 0; i < 20; i++) {
      results.push(
        await closeBooksDay(s.db, {
          market: MARKET,
          d: s.ds.dates[i],
          replay: true,
          now: NOW,
          restartParams: paramOverridesFor,
        }),
      );
    }
    expect(results.some((r) => r.terminal.length > 0)).toBe(true);
    const succ = await rowsOf(s.db, "SELECT params_json FROM cohort WHERE restart_of IS NOT NULL");
    expect(succ.length).toBeGreaterThan(0);
    const p = JSON.parse(String(succ[0].params_json)) as {
      params: { terminal: { timeout_sessions: number } };
    };
    expect(p.params.terminal.timeout_sessions).toBe(130);
  });
});
