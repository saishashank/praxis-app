// @vitest-environment node
// M20 S1 (F: the kill). AT-71 c, MKT-111, CTX-028, D-1101, D-1194: `closeBooksKill` closes every open book of a market
// that was rolled back (`full -> off`, enabled still 1, rollback_at set) at the open of the next trading day with reason
// `market_off`, settles per the profile (IN: T+1), posts nothing else, and disables the market in the same transaction
// as its last close row. Synthetic IN data on a real migrated libSQL file; the IN cohorts carry the IN-P1 cost profile.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeBooksMain } from "@/lib/arena/cli";
import {
  buildExecutionRegistry,
  paramsJson,
  parseCohortParams,
  planCohortStart,
  resolveCohortParams,
} from "@/lib/arena/cohort";
import { loadCohort, seedExecutions, startCohorts } from "@/lib/arena/cohortWriter";
import { costProfilesOfMarket, feeFor } from "@/lib/arena/costs";
import { writeFill } from "@/lib/arena/fillWriter";
import { fillOrder } from "@/lib/arena/fills";
import { fillTxns, pendingSettlements, settleTxn } from "@/lib/arena/ledger";
import { loadLedgerFills, writeLedgerTxn } from "@/lib/arena/ledgerWriter";
import { closeBooksKill, killKey, KILL_REASON } from "@/lib/arena/kill";
import { cleanupTempDbs, allowMarket } from "../db/helpers";
import { NO_TERMINAL, freshReplayDb } from "./replayHarness";

afterEach(cleanupTempDbs);

const NOW = () => "2030-01-10T04:00:00.000Z";
// Mon 7 Jan: cohort start; Tue 8: the entries fill; Wed 9: the rollback is clicked; Thu 10: the kill (open + 2).
const D0 = "2030-01-07";
const D1 = "2030-01-08";
const D2 = "2030-01-09";
const KD = "2030-01-10";
const CAL = [D0, D1, D2, KD, "2030-01-11", "2030-01-14", "2030-01-15"];
const INR = (r: number) => BigInt(r) * 1_000_000n;

let db: Client;
let cohortId: string;
let tradeA: string;
let tradeB: string;

const one = async (sql: string, args: (string | number)[] = []) =>
  (await db.execute({ sql, args })).rows[0]!;
const n = async (sql: string, args: (string | number)[] = []) => Number((await one(sql, args)).n);
async function counts(): Promise<Record<string, number>> {
  const t = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const out: Record<string, number> = {};
  for (const r of t.rows) {
    out[String(r.name)] = Number(
      (await db.execute(`SELECT COUNT(*) AS n FROM "${String(r.name)}"`)).rows[0]!.n,
    );
  }
  return out;
}
const diff = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(b)
      .filter(([k, v]) => a[k] !== v)
      .map(([k, v]) => [k, v - a[k]!]),
  );

const bar = (code: string, d: string, o: number, h: number, l: number, c: number) =>
  db.execute({
    sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
          VALUES ('IN', ?, ?, ?, ?, ?, ?, 5000000, 'synthetic', ?, ?)`,
    args: [code, d, o, h, l, c, `${d}T10:00:00.000Z`, `${d}T10:30:00.000Z`],
  });

/** One IN cohort that holds ZZA (5 shares) and ZZB (3 shares), both filled at the D1 open. */
async function world(): Promise<void> {
  db = await freshReplayDb();
  await allowMarket(db, "IN");
  await db.execute("UPDATE market SET mode = 'full' WHERE code = 'IN'");
  for (const d of CAL) {
    await db.execute({
      sql: "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES ('IN', ?, 'session', NULL, 1, 'synthetic')",
      args: [d],
    });
  }
  for (const d of [D0, D1, D2]) {
    for (const code of ["ZZA", "ZZB"]) {
      await db.execute({
        sql: "INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES ('IN', ?, ?, 'active', 'U1')",
        args: [d, code],
      });
    }
  }
  // ZZA: bars on D1, D2 and the kill day (the session opens at Rs 95 after a close of Rs 101). ZZB: no bar on the kill
  // day (nothing was fetched for an off market): it sells at the last known close, Rs 120.
  await bar("ZZA", D1, 100, 102, 98, 101);
  await bar("ZZA", D2, 101, 103, 99, 101);
  await bar("ZZA", KD, 95, 96, 93, 94);
  await bar("ZZB", D1, 118, 121, 117, 120);
  await bar("ZZB", D2, 120, 122, 119, 120);

  const registry = buildExecutionRegistry({ market: "IN" });
  await seedExecutions(db, registry);
  const execution = registry.find((e) => e.id === "E01")!;
  const params = resolveCohortParams({ ...NO_TERMINAL, market: "IN" });
  const start = planCohortStart({
    execution,
    controlIdx: null,
    startD: D0,
    params,
    masterSeed: 20_261_011n,
  });
  await startCohorts(db, [
    {
      ...start,
      sleeveJson: null,
      paramsJson: paramsJson({ ...params, costProfile: "IN-P1" as never }),
    },
  ]);
  cohortId = start.id;
  tradeA = await openPos("ZZA", 5n, 100, 102, 98, 101, "O:A");
  tradeB = await openPos("ZZB", 3n, 118, 121, 117, 120, "O:B");
  await postAndSettleBuys(cohortId);
}

/** Post the fills of a cohort and settle its purchases on their T+1 session (what the nights before the rollback did). */
async function postAndSettleBuys(id: string) {
  const fills = await loadLedgerFills(db, id);
  for (const f of fills) {
    for (const txn of fillTxns(f)) await writeLedgerTxn(db, id, txn);
  }
  const calendar = CAL.map((d) => ({
    d,
    kind: "session" as const,
    close_time: null,
    confirmed: 1 as const,
  }));
  for (const item of pendingSettlements(fills, new Set(), calendar, 1)) {
    if (item.side === "buy") await writeLedgerTxn(db, id, settleTxn(item, item.settleD));
  }
}

/** An entry order filled on D1 from the given bar; returns the trade id. */
async function openPos(
  code: string,
  qty: bigint,
  o: number,
  h: number,
  l: number,
  c: number,
  id: string,
  cohort = cohortId,
) {
  const profile = costProfilesOfMarket("IN")["IN-P1"]!;
  {
    await db.execute({
      sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, ref_stop_micro, tier)
            VALUES (?, ?, ?, ?, 'buy', 'entry', ?, ?, 'U1')`,
      args: [id, cohort, D0, code, qty, INR(5)],
    });
    const out = fillOrder(
      { kind: "entry", qty, stopDistanceMicro: INR(5) },
      {
        bar: { openMicro: INR(o), highMicro: INR(h), lowMicro: INR(l), closeMicro: INR(c) },
        advMicro: INR(500_000_000),
        profile,
        gate: { allowed: true, reason: "ok" } as never,
      },
    );
    if (out.status !== "filled") throw new Error("entry not filled");
    await writeFill(db, {
      fillId: `F2:${id}`,
      orderId: id,
      cohortId: cohort,
      d: D1,
      code,
      fill: out.fill,
      trade: { kind: "open", tradeId: `T:${id}`, stopMicro: out.initialStopMicro as bigint },
    });
    return `T:${id}`;
  }
}

/** What the Owner's click did: mode off, rollback_at set, enabled stays 1. */
const rollback = () =>
  db.execute(
    "UPDATE market SET mode = 'off', rollback_at = '2030-01-09T09:00:00.000Z' WHERE code = 'IN'",
  );
const kill = (d = KD) => closeBooksKill(db, { market: "IN", d, now: NOW });

beforeEach(world);

describe("the kill closes every open book at the open, with reason market_off", () => {
  it("sells ZZA at the open of the kill day and ZZB at its last close; every fill is a close-signal exit", async () => {
    await rollback();
    const r = await kill();
    expect(r).toMatchObject({
      market: "IN",
      d: KD,
      status: "success",
      reason: null,
      sold: 2,
      sleeveClosed: 0,
      remaining: 0,
      disabled: true,
      basis: { open: 1, lastClose: 1 },
    });
    const fills = (
      await db.execute({ sql: "SELECT * FROM fill WHERE d = ? ORDER BY code", args: [KD] })
    ).rows;
    expect(
      fills.map((f) => [
        String(f.id),
        String(f.code),
        String(f.side),
        Number(f.qty),
        String(f.rule),
      ]),
    ).toEqual([
      [`F1:KILL:${tradeA}:${KD}`, "ZZA", "sell", 5, "close_signal"],
      [`F1:KILL:${tradeB}:${KD}`, "ZZB", "sell", 3, "close_signal"],
    ]);
    const [a, b] = fills;
    // the reference price is the open: Rs 95 for ZZA (its bar), Rs 120 for ZZB (the last close stands in, a flat bar)
    expect(BigInt(a!.ref_price_micro as bigint)).toBe(INR(95));
    expect(BigInt(a!.bar_o_micro as bigint)).toBe(INR(95));
    expect(BigInt(b!.ref_price_micro as bigint)).toBe(INR(120));
    // a sale never fills above its reference (slippage works against the seller)
    for (const f of fills)
      expect(BigInt(f.fill_price_micro as bigint) <= BigInt(f.ref_price_micro as bigint)).toBe(
        true,
      );
    // costs are the market's own IN-P1 schedule on the sale value
    const P = costProfilesOfMarket("IN")["IN-P1"]!;
    for (const f of fills) {
      expect(BigInt(f.brokerage_micro as bigint)).toBe(
        feeFor(P, BigInt(f.value_micro as bigint), "sell"),
      );
      expect(BigInt(f.value_micro as bigint)).toBe(
        BigInt(f.fill_price_micro as bigint) * BigInt(f.qty as bigint),
      );
    }
    // both trades closed with exit type terminal; no position is left
    const trades = (await db.execute("SELECT id, exit_type, exit_fill_id FROM trade ORDER BY id"))
      .rows;
    expect(
      trades.map((t) => [String(t.exit_type), String(t.exit_fill_id).startsWith("F1:KILL:")]),
    ).toEqual([
      ["terminal", true],
      ["terminal", true],
    ]);
  });

  it("settles per the profile: T+1 (IN), Thursday's sale settles Friday; a Friday sale settles Monday", async () => {
    await rollback();
    await kill(KD);
    const settle = (
      await db.execute(
        "SELECT txn_id, d, account, delta_micro FROM cash_ledger WHERE txn_id LIKE 'settle:F1:KILL:%' ORDER BY txn_id, account",
      )
    ).rows;
    expect(settle.length).toBeGreaterThan(0);
    expect(new Set(settle.map((r) => String(r.d)))).toEqual(new Set(["2030-01-11"])); // Thu + 1 session = Fri
    // the fill rows are posted on the sale day, a receipt of the net proceeds goes pending then settled
    const posted = (
      await db.execute("SELECT DISTINCT d FROM cash_ledger WHERE txn_id LIKE 'fill:F1:KILL:%'")
    ).rows;
    expect(posted.map((r) => String(r.d))).toEqual([KD]);
    // a Friday kill: the next session after Fri 11 Jan is Mon 14 Jan (weekend skipped)
    await world();
    await bar("ZZA", "2030-01-11", 95, 96, 93, 94);
    await rollback();
    await kill("2030-01-11");
    const fri = (
      await db.execute("SELECT DISTINCT d FROM cash_ledger WHERE txn_id LIKE 'settle:F1:KILL:%'")
    ).rows;
    expect(fri.map((r) => String(r.d))).toEqual(["2030-01-14"]);
  });

  it("the settled cash equals the sale proceeds net of the fee: seed - purchases + (value - brokerage) per sale", async () => {
    await rollback();
    await kill();
    const rows = (
      await db.execute("SELECT account, SUM(delta_micro) AS s FROM cash_ledger GROUP BY account")
    ).rows;
    const by = Object.fromEntries(rows.map((r) => [String(r.account), BigInt(r.s as bigint)]));
    // every receipt and payment of the cohort is settled: nothing stays pending
    expect(by.cash_recv ?? 0n).toBe(0n);
    expect(by.cash_pay ?? 0n).toBe(0n);
    const sales = (
      await db.execute("SELECT value_micro, brokerage_micro FROM fill WHERE side = 'sell'")
    ).rows;
    const buys = (
      await db.execute("SELECT value_micro, brokerage_micro FROM fill WHERE side = 'buy'")
    ).rows;
    const proceeds = sales.reduce(
      (a, r) => a + BigInt(r.value_micro as bigint) - BigInt(r.brokerage_micro as bigint),
      0n,
    );
    const cost = buys.reduce(
      (a, r) => a + BigInt(r.value_micro as bigint) + BigInt(r.brokerage_micro as bigint),
      0n,
    );
    const params = parseCohortParams(
      String(await loadCohort(db, cohortId).then((c) => c!.paramsJson)),
    );
    expect(by.cash_settled).toBe(params.seedMicro - cost + proceeds);
  });

  it("posts nothing else: no NAV row, no terminal event, no new entry, no new cohort; only the fills, the ledger and the run", async () => {
    await rollback();
    const before = await counts();
    await kill();
    const d = diff(before, await counts());
    expect(Object.keys(d).sort()).toEqual(
      ["arena_order", "cash_ledger", "fill", "run_record"].sort(),
    );
    expect(d.fill).toBe(2);
    expect(d.arena_order).toBe(2); // the two KILL orders
    expect(d.run_record).toBe(1);
    for (const t of [
      "nav_daily",
      "nav_daily_pos",
      "cohort_event",
      "cohort",
      "trade",
      "sleeve_trade",
    ]) {
      expect(d[t], t).toBeUndefined();
    }
  });

  it("cancels every pending order with reason market_off and fills none of them", async () => {
    await db.execute({
      sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, ref_stop_micro, tier)
            VALUES ('P:entry', ?, ?, 'ZZA', 'buy', 'entry', 2, ?, 'U1'), ('P:exit', ?, ?, 'ZZB', 'sell', 'exit_cs', 3, NULL, 'U1')`,
      args: [cohortId, D2, INR(5), cohortId, D2],
    });
    await rollback();
    const r = await kill();
    expect(r.cancelled).toBe(2);
    const o = (
      await db.execute(
        "SELECT id, status, reject_reason FROM arena_order WHERE id LIKE 'P:%' ORDER BY id",
      )
    ).rows;
    expect(o.map((x) => [String(x.status), String(x.reject_reason)])).toEqual([
      ["cancelled", KILL_REASON],
      ["cancelled", KILL_REASON],
    ]);
    expect(await n("SELECT COUNT(*) AS n FROM fill WHERE order_id LIKE 'P:%'")).toBe(0);
  });
});

describe("the age of the close that stands in (D-1194)", () => {
  it("a close from the last full session is not stale; one older is counted separately and the oldest date is recorded", async () => {
    await rollback();
    const fresh = await kill(); // ZZB's last close is Wed 9 Jan = the session before the Thursday kill
    expect(fresh.basis).toMatchObject({ open: 1, lastClose: 1, staleClose: 0, oldestCloseD: D2 });
    const det = JSON.parse(
      String(
        (
          await one("SELECT details_json FROM run_record WHERE concurrency_key = ?", [
            killKey("IN", KD),
          ])
        ).details_json,
      ),
    );
    expect(det.basis).toMatchObject({ staleClose: 0, oldestCloseD: D2 });
    // a Friday kill with the same last close (Wed): the previous session is Thu, so the Wed close is stale
    await world();
    await bar("ZZA", "2030-01-11", 95, 96, 93, 94);
    await rollback();
    const stale = await kill("2030-01-11");
    expect(stale.basis).toMatchObject({ lastClose: 1, staleClose: 1, oldestCloseD: D2 });
  });

  it("the S2 incident names the stale close when the run could not finish", async () => {
    await openPos("ZZC", 2n, 50, 51, 49, 50, "O:C"); // no price at all: stays open
    await rollback();
    await closeBooksKill(db, { market: "IN", d: "2030-01-11", now: NOW });
    const inc = await one("SELECT detail_json FROM incident WHERE kind = 'market_kill_incomplete'");
    const d = JSON.parse(String(inc.detail_json));
    expect(d).toMatchObject({ remaining: 1, staleClose: 1, oldestCloseD: D2 });
  });
});

describe("the market is disabled in the same transaction as the last close row", () => {
  it("run record success and enabled = 0, rollback_at NULL land together; afterwards the guard refuses every write", async () => {
    await rollback();
    await kill();
    const m = await one("SELECT enabled, mode, rollback_at FROM market WHERE code = 'IN'");
    expect([Number(m.enabled), String(m.mode), m.rollback_at]).toEqual([0, "off", null]);
    const run = await one(
      "SELECT status, details_json, items_processed FROM run_record WHERE concurrency_key = ?",
      [killKey("IN", KD)],
    );
    expect(String(run.status)).toBe("success");
    expect(Number(run.items_processed)).toBe(2);
    expect(JSON.parse(String(run.details_json))).toMatchObject({
      reason: KILL_REASON,
      sold: 2,
      remaining: 0,
      disabled: true,
    });
    await expect(
      db.execute(
        "INSERT INTO announcement_category (market, source, ann_id, category, materiality, verifiable, map_version) VALUES ('IN', 'nse', 'x', 'results', 1, 1, 'v1')",
      ),
    ).rejects.toThrow(/MarketNotEnabled/);
  });

  it("a failure of that transaction leaves the market enabled with rollback_at, and a retry finishes without selling twice", async () => {
    await rollback();
    // only the closing transaction fails: the statement that finishes the run record as a success throws
    const flaky = new Proxy(db, {
      get(t, p, r) {
        if (p === "transaction") {
          return async (...a: unknown[]) => {
            const tx = await (
              t.transaction as unknown as (...x: unknown[]) => Promise<Record<string, unknown>>
            ).apply(t, a);
            return new Proxy(tx, {
              get(tt, pp, rr) {
                if (pp === "execute") {
                  return (q: unknown) => {
                    const sql = typeof q === "string" ? q : String((q as { sql: string }).sql);
                    if (sql.includes("SET status = 'success'"))
                      return Promise.reject(new Error("db down"));
                    return (tt.execute as (x: unknown) => Promise<unknown>)(q);
                  };
                }
                const v = Reflect.get(tt, pp, rr);
                return typeof v === "function" ? v.bind(tt) : v;
              },
            });
          };
        }
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Client;
    await expect(closeBooksKill(flaky, { market: "IN", d: KD, now: NOW })).rejects.toThrow();
    // the fills are in, the market is not disabled, the run is recorded as failed
    expect(await n("SELECT COUNT(*) AS n FROM fill WHERE side = 'sell'")).toBe(2);
    const m = await one("SELECT enabled, rollback_at FROM market WHERE code = 'IN'");
    expect(Number(m.enabled)).toBe(1);
    expect(m.rollback_at).not.toBeNull();
    expect(
      String(
        (await one("SELECT status FROM run_record WHERE concurrency_key = ?", [killKey("IN", KD)]))
          .status,
      ),
    ).toBe("failed");
    // the retry (the next dispatch of the same day) finds no open position and finishes
    const again = await kill();
    expect(again).toMatchObject({ status: "success", sold: 0, remaining: 0, disabled: true });
    expect(await n("SELECT COUNT(*) AS n FROM fill WHERE side = 'sell'")).toBe(2);
    expect(Number((await one("SELECT enabled FROM market WHERE code = 'IN'")).enabled)).toBe(0);
  });

  it("a halted position stays open: the run fails, the market stays enabled, an S2 opens; the next day finishes", async () => {
    await db.execute({
      sql: "INSERT INTO universe_snapshot (market, d, code, status, tier, halted) VALUES ('IN', ?, 'ZZB', 'suspended', 'U1', 1)",
      args: [KD],
    });
    await rollback();
    const r = await kill();
    expect(r).toMatchObject({
      status: "failed",
      reason: "positions_remaining",
      sold: 1,
      remaining: 1,
      disabled: false,
    });
    expect(Number((await one("SELECT enabled FROM market WHERE code = 'IN'")).enabled)).toBe(1);
    expect(
      (await one("SELECT rollback_at FROM market WHERE code = 'IN'")).rollback_at,
    ).not.toBeNull();
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM incident WHERE kind = 'market_kill_incomplete' AND resolved_at IS NULL",
      ),
    ).toBe(1);
    // ZZB resumes trading the next session: a flat bar exists, the kill sells it and disables the market
    await bar("ZZB", "2030-01-11", 119, 121, 118, 120);
    const next = await closeBooksKill(db, { market: "IN", d: "2030-01-11", now: NOW });
    expect(next).toMatchObject({ status: "success", sold: 1, remaining: 0, disabled: true });
  });

  it("a position with no price at all (no bar, no earlier close) also stays open and fails visibly", async () => {
    await openPos("ZZC", 2n, 50, 51, 49, 50, "O:C"); // ZZC has no price_bar row in this world
    await rollback();
    const r = await kill();
    expect(r).toMatchObject({ status: "failed", sold: 2, remaining: 1, disabled: false });
    expect(Number((await one("SELECT enabled FROM market WHERE code = 'IN'")).enabled)).toBe(1);
  });
});

describe("refusals: the kill never touches a running market", () => {
  const writes = ["fill", "arena_order", "cash_ledger", "trade", "nav_daily", "cohort_event"];
  it.each([
    [
      "a full market (no rollback)",
      "UPDATE market SET mode = 'full' WHERE code = 'IN'",
      "kill_not_pending",
    ],
    [
      "a data_only market",
      "UPDATE market SET mode = 'data_only' WHERE code = 'IN'",
      "kill_not_pending",
    ],
    [
      "an off market with no rollback_at",
      "UPDATE market SET mode = 'off' WHERE code = 'IN'",
      "kill_not_pending",
    ],
  ])("%s: recorded as skipped, no arena row written", async (_n, sql, reason) => {
    await db.execute(sql);
    const before = await counts();
    const r = await kill();
    expect(r).toMatchObject({ status: "skipped", reason, sold: 0, disabled: false });
    const d = diff(before, await counts());
    for (const t of writes) expect(d[t], t).toBeUndefined();
    expect(Number((await one("SELECT enabled FROM market WHERE code = 'IN'")).enabled)).toBe(1);
  });

  it("a weekend or a holiday: skipped non_trading_day, and the rollback stays pending", async () => {
    await rollback();
    const r = await closeBooksKill(db, { market: "IN", d: "2030-01-12", now: NOW }); // Saturday
    expect(r).toMatchObject({ status: "skipped", reason: "non_trading_day" });
    expect(await n("SELECT COUNT(*) AS n FROM fill WHERE side = 'sell'")).toBe(0);
    expect(
      (await one("SELECT rollback_at FROM market WHERE code = 'IN'")).rollback_at,
    ).not.toBeNull();
  });

  it("a market that is already disabled writes nothing at all, not even a run record", async () => {
    await rollback();
    await kill();
    const before = await counts();
    const again = await kill("2030-01-11");
    expect(again).toMatchObject({ status: "skipped", reason: "market_not_enabled" });
    expect(await counts()).toEqual(before);
  });

  it("a second run for the same day after success is already_done", async () => {
    await rollback();
    await kill();
    await db.execute(
      "UPDATE market SET enabled = 1, rollback_at = '2030-01-09T09:00:00.000Z' WHERE code = 'IN'",
    );
    expect(await kill()).toMatchObject({ status: "already_done" });
  });

  it("another market's cohorts are never touched (an AU book stays open, nothing is sold for it)", async () => {
    await db.execute(
      "INSERT INTO execution (id, market, kind, family, variant, twin_group, rule_version, cost_profile) VALUES ('E99', 'AU', 'E', 'momentum', 'U', 'tg', 'v1', 'P5')",
    );
    const au = planCohortStart({
      execution: {
        id: "E99",
        market: "AU",
        kind: "E",
        family: "momentum",
        variant: "U",
        twin_group: "tg",
        rule_version: "v1",
        cost_profile: "P5",
        status: "active",
      } as never,
      controlIdx: null,
      startD: D0,
      params: resolveCohortParams({ ...NO_TERMINAL }),
      masterSeed: 1n,
    });
    await startCohorts(db, [au]);
    await openPos("ZZA", 2n, 100, 102, 98, 101, "O:AU", au.id);
    await rollback();
    await kill();
    expect(
      await n("SELECT COUNT(*) AS n FROM fill WHERE cohort_id = ? AND side = 'sell'", [au.id]),
    ).toBe(0);
    expect(
      await n("SELECT COUNT(*) AS n FROM trade WHERE cohort_id = ? AND exit_type IS NULL", [au.id]),
    ).toBe(1);
  });
});

describe("the command line: closeBooksMain --kill market_off", () => {
  const run = async (argv: string[], over: Record<string, string> = {}) => {
    const lines: string[] = [];
    const code = await closeBooksMain(
      argv,
      { TURSO_MAIN_URL: "file:ignored", ...over },
      {
        openDb: () =>
          new Proxy(db, {
            get(t, p, r) {
              if (p === "close") return () => undefined;
              const v = Reflect.get(t, p, r);
              return typeof v === "function" ? v.bind(t) : v;
            },
          }) as Client,
        nowMs: () => Date.parse("2030-01-10T04:00:00.000Z"),
        out: (l) => lines.push(l),
      },
    );
    return { code, lines };
  };

  it("runs the kill for the market and prints counts only", async () => {
    await rollback();
    const { code, lines } = await run(["--kill", "market_off", "--market", "IN", "--date", KD]);
    expect(code).toBe(0);
    expect(lines).toEqual([
      `arena-kill IN ${KD}: success sold=2 sleeve=0 cancelled=0 open=1 lastClose=1 remaining=0 disabled=true`,
    ]);
  });

  it("uses the market's own local date when --date is absent (04:00 UTC is 09:30 in Kolkata, the same day)", async () => {
    await rollback();
    const { code } = await run(["--kill", "market_off", "--market", "IN"]);
    expect(code).toBe(0);
    expect(Number((await one("SELECT enabled FROM market WHERE code = 'IN'")).enabled)).toBe(0);
  });

  it.each([
    [["--kill", "something_else", "--market", "IN"]],
    [["--kill", "--market", "IN"]],
    [["--kill", "market_off", "--replay", "--market", "IN"]],
  ])("refuses a bad --kill usage with exit 2: %j", async (argv) => {
    const { code, lines } = await run(argv);
    expect(code).toBe(2);
    expect(lines[0]).toContain("arena-kill: refused");
  });

  it("exits 1 when a position could not be sold", async () => {
    await db.execute({
      sql: "INSERT INTO universe_snapshot (market, d, code, status, tier, halted) VALUES ('IN', ?, 'ZZB', 'suspended', 'U1', 1)",
      args: [KD],
    });
    await rollback();
    expect((await run(["--kill", "market_off", "--market", "IN", "--date", KD])).code).toBe(1);
  });

  it("without the database variables it fails (1) and prints no value", async () => {
    const lines: string[] = [];
    expect(await closeBooksMain(["--kill", "market_off"], {}, { out: (l) => lines.push(l) })).toBe(
      1,
    );
    expect(lines[0]).toBe("arena-kill: failed (database not configured)");
  });
});
