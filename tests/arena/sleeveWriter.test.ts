// @vitest-environment node
// DB side of the sleeve engine (M3 T8) against a real migrated database in bigint mode (decision
// 18). HIGH-RISK (money): each step atomic, idempotent, conflicts raise, a locked sleeve opens no
// real trade, shadow trades leave no cash or fill, and the stored books pass the invariant suite.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { COST_PROFILES } from "@/lib/arena/costs";
import type { FillEnv } from "@/lib/arena/fills";
import { writeFill } from "@/lib/arena/fillWriter";
import { checkCohortBooks, isFatal } from "@/lib/arena/invariants";
import { fillTxns, seedTxn, type LedgerFill } from "@/lib/arena/ledger";
import {
  loadLedgerFills,
  loadLedgerRows,
  toBig,
  writeLedgerTxn,
  writeNavDay,
} from "@/lib/arena/ledgerWriter";
import { computeNavDay } from "@/lib/arena/nav";
import {
  defaultSleeveConfig,
  openTrade,
  quoteSleeveEntry,
  quoteSleeveExit,
  sleeveUnrealAt,
  type SleeveConfig,
  type SleeveExitMode,
  type SleeveTrade,
} from "@/lib/arena/sleeve";
import {
  loadEntryBrokerage,
  loadSleeveStates,
  loadSleeveTrades,
  runSleeveUnlockCheck,
  SleeveWriteError,
  writeSleeveClose,
  writeSleeveFinancing,
  writeSleeveOpen,
} from "@/lib/arena/sleeveWriter";
import { fillCloseSignalExit } from "@/lib/arena/fills";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const P5 = COST_PROFILES.P5;
const cfg = defaultSleeveConfig(P5);
const envOf = (o: bigint, h: bigint, l: bigint, c: bigint): FillEnv => ({
  bar: { openMicro: o, highMicro: h, lowMicro: l, closeMicro: c },
  advMicro: 5_000_000_000_000n,
  profile: P5,
});
/** Open 9.99 -> entry fill exactly A$10.00 (10 bps = 9,990 < one tick 10,000 -> +10,000). */
const ENTRY_ENV = envOf(9_990_000n, 10_100_000n, 9_900_000n, 10_000_000n);

async function freshDb(): Promise<Client> {
  const db = track(createClient({ url: tempDbUrl(), intMode: "bigint" }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  await db.execute(
    `INSERT INTO execution (id, market, kind, family, variant, twin_group, rule_version, cost_profile)
     VALUES ('E01', 'AU', 'E', 'F1', 'L', 'T1', 'rv1', 'P5')`,
  );
  await db.execute(
    `INSERT INTO cohort (id, execution_id, start_d, seed_micro, rule_version, params_json,
       cost_profile_version, rng_seed)
     VALUES ('K1', 'E01', '2026-10-01', 600000000, 'rv1', '{}', 1, 42)`,
  );
  await writeLedgerTxn(db, "K1", seedTxn("2026-10-01", 600_000_000n));
  return db;
}

const q = async (db: Client, sql: string) => (await db.execute(sql)).rows;
const count = async (db: Client, table: string): Promise<bigint> =>
  toBig((await q(db, `SELECT COUNT(*) AS n FROM ${table}`))[0].n);
const balance = async (db: Client, account: string): Promise<bigint> =>
  toBig(
    (
      await q(
        db,
        `SELECT COALESCE(SUM(delta_micro), 0) AS s FROM cash_ledger WHERE account = '${account}'`,
      )
    )[0].s,
  );

function tradeFor(
  id: string,
  openD: string,
  over: { shadow?: boolean; margin?: bigint; config?: SleeveConfig } = {},
) {
  const config = over.config ?? cfg;
  const quote = quoteSleeveEntry(ENTRY_ENV, over.margin ?? 20_000_000n, config);
  const trade = openTrade({
    id,
    cohortId: "K1",
    code: "ZZA",
    openD,
    quote,
    entryFillId: over.shadow === true ? null : `EF-${id}`,
    shadow: over.shadow,
    cfg: config,
  });
  return { quote, trade };
}

async function openReal(db: Client, id = "S1", openD = "2026-10-12", config = cfg) {
  const { quote, trade } = tradeFor(id, openD, { config });
  const result = await writeSleeveOpen(db, {
    cohortId: "K1",
    trade,
    quote,
    orderId: `OO-${id}`,
    fillId: `EF-${id}`,
    decidedD: "2026-10-09",
  });
  return { quote, trade, result };
}

const exitOf = (env: FillEnv, trade: SleeveTrade, mode: SleeveExitMode, config = cfg) => {
  const exit = quoteSleeveExit(env, trade, mode, config);
  if (exit === null) throw new Error("exit not reached");
  return exit;
};

const closeInput = (
  trade: SleeveTrade,
  closeD: string,
  exit: ReturnType<typeof exitOf>,
  config = cfg,
) => ({
  cohortId: "K1",
  tradeId: trade.id,
  cfg: config,
  closeD,
  exit,
  orderId: `OX-${trade.id}`,
  fillId: `XF-${trade.id}`,
  decidedD: closeD,
});

/** Books of the stored cohort, run through the whole invariant suite incl. the sleeve checks. */
async function violations(db: Client, dates: string[], config = cfg) {
  const rows = await loadLedgerRows(db, "K1");
  const trades = await loadSleeveTrades(db, "K1");
  const states = await loadSleeveStates(db, "K1");
  const closes = new Map(dates.map((d) => [d, 10_000_000n]));
  return checkCohortBooks(
    {
      cohortId: "K1",
      rows,
      fills: await loadLedgerFills(db, "K1"),
      markFor: (d) => {
        const c = closes.get(d);
        return c === undefined ? undefined : { closeMicro: c, advMicro: 5_000_000_000_000n };
      },
      profile: P5,
      sleeveUnrealFor: (d) =>
        sleeveUnrealAt({ trades, d, closeFor: (_code, dd) => closes.get(dd), cfg: config }),
    },
    {
      mode: "matched",
      calendar: [],
      dates,
      seedMicro: 600_000_000n,
      sleeve: { trades, states, cfg: config },
    },
  ).filter(isFatal);
}

const dump = async (db: Client): Promise<string> => {
  const parts: string[] = [];
  for (const sql of [
    "SELECT * FROM arena_order ORDER BY id",
    "SELECT * FROM fill ORDER BY id",
    "SELECT * FROM sleeve_trade ORDER BY id",
    "SELECT * FROM sleeve_state ORDER BY seq",
    "SELECT * FROM cohort_event ORDER BY seq",
    "SELECT * FROM cash_ledger ORDER BY id",
  ]) {
    for (const r of (await db.execute(sql)).rows) {
      parts.push(JSON.stringify(Object.values(r).map(String)));
    }
  }
  return parts.join("\n");
};

const failsWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(Error);
  expect((error as { code?: string }).code).toBe(code);
};

describe("open (ARN-040/041)", () => {
  it("writes order, fill, sleeve_trade and the margin posting together; stock loaders ignore the sleeve fill", async () => {
    const db = await freshDb();
    const { trade, quote, result } = await openReal(db);
    expect(result.written).toBe(true);
    expect(quote.entryPriceMicro).toBe(10_000_000n);
    const t = (await q(db, "SELECT * FROM sleeve_trade"))[0];
    expect(t).toMatchObject({
      id: "S1",
      shadow: 0n,
      margin_micro: 20_000_000n,
      leverage: 10n,
      notional_micro: 200_000_000n,
      open_d: "2026-10-12",
      entry_price_micro: 10_000_000n,
      entry_fill_id: "EF-S1",
      closed_by: null,
    });
    expect((await q(db, "SELECT status, kind, side FROM arena_order"))[0]).toMatchObject({
      status: "filled",
      kind: "sleeve_open",
      side: "buy",
    });
    expect((await q(db, "SELECT brokerage_micro, rule FROM fill"))[0]).toMatchObject({
      brokerage_micro: 5_000_000n,
      rule: "open",
    });
    expect(await balance(db, "cash_settled")).toBe(600_000_000n - 25_000_000n);
    expect(await balance(db, "sleeve_margin")).toBe(20_000_000n);
    expect(await balance(db, "fees_paid")).toBe(5_000_000n);
    // a sleeve is not a holding: stock loaders see no fill
    expect(await loadLedgerFills(db, "K1")).toEqual([]);
    expect(await count(db, "fill")).toBe(1n);
    expect(await loadEntryBrokerage(db, trade, cfg)).toBe(5_000_000n);
    expect(await violations(db, ["2026-10-12"])).toEqual([]);
  });

  it("a stock fill still loads while the sleeve fill does not", async () => {
    const db = await freshDb();
    await openReal(db);
    await db.execute(
      `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty)
       VALUES ('OS', 'K1', '2026-10-09', 'ZZA', 'buy', 'entry', 19)`,
    );
    const stock = fillCloseSignalExit(
      envOf(10_000_000n, 10_000_000n, 10_000_000n, 10_000_000n),
      19n,
    );
    await writeFill(db, {
      fillId: "FS",
      orderId: "OS",
      cohortId: "K1",
      d: "2026-10-12",
      code: "ZZA",
      fill: { ...stock, side: "buy", rule: "open" },
    });
    const fills = await loadLedgerFills(db, "K1");
    expect(fills.map((f) => f.id)).toEqual(["FS"]);
  });

  it("is idempotent; a different stored trade raises sleeve_conflict; a second open trade is refused", async () => {
    const db = await freshDb();
    await openReal(db);
    const before = await dump(db);
    const again = await openReal(db);
    expect(again.result.written).toBe(false);
    expect(await dump(db)).toBe(before);
    const other = tradeFor("S1", "2026-10-12", { margin: 16_000_000n });
    await failsWith(
      writeSleeveOpen(db, {
        cohortId: "K1",
        trade: other.trade,
        quote: other.quote,
        orderId: "OO-X",
        fillId: "EF-S1",
      }),
      "sleeve_conflict",
    );
    const second = tradeFor("S2", "2026-10-12");
    await failsWith(
      writeSleeveOpen(db, {
        cohortId: "K1",
        trade: second.trade,
        quote: second.quote,
        orderId: "OO-2",
        fillId: "EF-S2",
      }),
      "sleeve_already_open",
    );
    expect(await dump(db)).toBe(before); // nothing written by the refusals
  });

  it("rolls back as a whole when the ledger posting fails (no half-open sleeve)", async () => {
    const db = await freshDb();
    // block the sleeveopen txn id with a different stored txn
    await writeLedgerTxn(db, "K1", {
      txnId: "sleeveopen:S1",
      d: "2026-10-12",
      kind: "sleeve_open",
      refType: "sleeve_trade",
      refId: "S1",
      postings: [
        { account: "cash_settled", deltaMicro: -1n },
        { account: "sleeve_margin", deltaMicro: 1n },
      ],
    });
    const { trade, quote } = tradeFor("S1", "2026-10-12");
    await failsWith(
      writeSleeveOpen(db, { cohortId: "K1", trade, quote, orderId: "OO-S1", fillId: "EF-S1" }),
      "txn_conflict",
    );
    expect(await count(db, "sleeve_trade")).toBe(0n);
    expect(await count(db, "arena_order")).toBe(0n);
    expect(await count(db, "fill")).toBe(0n);
  });

  it("needs ids for a real trade", async () => {
    const db = await freshDb();
    const { trade, quote } = tradeFor("S1", "2026-10-12");
    await expect(writeSleeveOpen(db, { cohortId: "K1", trade, quote })).rejects.toThrow(/order id/);
  });
});

describe("financing (close the books, step 3)", () => {
  it("posts the cumulative figure; a rerun adds nothing; weekends are counted", async () => {
    const db = await freshDb();
    await openReal(db, "S1", "2026-10-09"); // a Friday
    const f = (d: string) => writeSleeveFinancing(db, { cohortId: "K1", tradeId: "S1", d, cfg });
    expect(await f("2026-10-09")).toMatchObject({ written: false, accruedMicro: 0n });
    expect(await f("2026-10-12")).toMatchObject({ written: true, accruedMicro: 147_945n });
    expect(await balance(db, "fin_accrued")).toBe(-147_945n);
    const before = await dump(db);
    expect(await f("2026-10-12")).toMatchObject({ written: false, accruedMicro: 147_945n });
    expect(await dump(db)).toBe(before);
    expect(await f("2026-10-13")).toMatchObject({ written: true, accruedMicro: 197_260n });
    // daily rows sum to the one-shot cumulative figure
    expect(await balance(db, "fin_accrued")).toBe(-197_260n);
    expect(await balance(db, "equity")).toBe(-600_000_000n + 197_260n);
    expect(await violations(db, ["2026-10-09", "2026-10-12", "2026-10-13"])).toEqual([]);
  });

  it("refuses a stored day that differs from the formula; unknown and closed trades", async () => {
    const db = await freshDb();
    await openReal(db);
    await writeSleeveFinancing(db, { cohortId: "K1", tradeId: "S1", d: "2026-10-13", cfg });
    // a different rate means the same day would post another amount under the same txn id
    const richer: SleeveConfig = { ...cfg, financingRate: { num: 27n, den: 100n } };
    await failsWith(
      writeSleeveFinancing(db, { cohortId: "K1", tradeId: "S1", d: "2026-10-13", cfg: richer }),
      "financing_mismatch",
    );
    const poorer: SleeveConfig = { ...cfg, financingRate: { num: 1n, den: 100n } };
    await failsWith(
      writeSleeveFinancing(db, { cohortId: "K1", tradeId: "S1", d: "2026-10-13", cfg: poorer }),
      "financing_mismatch",
    );
    await failsWith(
      writeSleeveFinancing(db, { cohortId: "K1", tradeId: "NOPE", d: "2026-10-13", cfg }),
      "sleeve_not_found",
    );
  });
});

describe("close-out and loss cap through the database (TST101-036/037)", () => {
  it("TST101-036: 9.48 fill, P/L -10,400,000, cash back 4,600,000, lock with loss_to_recover 20,400,000", async () => {
    const db = await freshDb();
    const { trade } = await openReal(db);
    const exit = exitOf(envOf(9_800_000n, 9_800_000n, 9_500_000n, 9_600_000n), trade, {
      kind: "closeout",
      financingMicro: 0n,
    });
    const r = await writeSleeveClose(db, closeInput(trade, "2026-10-12", exit));
    expect(r.written).toBe(true);
    expect(r.result.cashDeltaMicro).toBe(4_600_000n);
    expect(r.lock).toEqual({
      seq: 1,
      state: "locked",
      d: "2026-10-12",
      lossToRecoverMicro: 20_400_000n,
      mode: "REC-2",
    });
    expect((await q(db, "SELECT * FROM sleeve_trade"))[0]).toMatchObject({
      closed_by: "closeout",
      price_pl_micro: -10_400_000n,
      financing_micro: 0n,
      close_d: "2026-10-12",
      exit_price_micro: 9_480_000n,
      costs_micro: 10_000_000n,
      exit_fill_id: "XF-S1",
    });
    expect(await balance(db, "sleeve_margin")).toBe(0n);
    expect(await balance(db, "cash_settled")).toBe(600_000_000n - 25_000_000n + 4_600_000n);
    expect(await balance(db, "equity")).toBe(-(600_000_000n - 10_400_000n));
    expect((await q(db, "SELECT kind, detail_json FROM cohort_event"))[0].kind).toBe("lock");
    expect(
      JSON.parse(String((await q(db, "SELECT detail_json FROM cohort_event"))[0].detail_json)),
    ).toMatchObject({
      loss_to_recover_micro: "20400000",
      trade_id: "S1",
    });
    expect(await violations(db, ["2026-10-12"])).toEqual([]);
  });

  it("TST101-037: gap to 8.49 caps the loss at the margin; brokerage 5,000,000 comes from main cash", async () => {
    const db = await freshDb();
    const { trade } = await openReal(db);
    const exit = exitOf(envOf(8_500_000n, 8_600_000n, 8_400_000n, 8_450_000n), trade, {
      kind: "closeout",
      financingMicro: 0n,
    });
    expect(exit.fill.rule).toBe("gap_open");
    const r = await writeSleeveClose(db, closeInput(trade, "2026-10-12", exit));
    expect(r.result.rawPricePlMicro).toBe(-30_200_000n);
    expect(r.result.closed.pricePlMicro).toBe(-20_000_000n);
    expect(r.result.marginReturnedMicro).toBe(0n);
    expect(r.result.cashDeltaMicro).toBe(-5_000_000n);
    expect(await balance(db, "cash_settled")).toBe(600_000_000n - 25_000_000n - 5_000_000n);
    expect(await balance(db, "sleeve_margin")).toBe(0n);
    expect((await loadSleeveStates(db, "K1"))[0].lossToRecoverMicro).toBe(
      20_000_000n + 5_000_000n + 5_000_000n,
    );
    expect(await violations(db, ["2026-10-12"])).toEqual([]);
  });

  it("a winning close over a weekend pays financing out of the margin and does not lock", async () => {
    const db = await freshDb();
    const { trade } = await openReal(db, "S1", "2026-10-09");
    const exit = exitOf(envOf(11_000_000n, 11_100_000n, 10_900_000n, 11_000_000n), trade, {
      kind: "cs",
    });
    const r = await writeSleeveClose(db, closeInput(trade, "2026-10-12", exit));
    expect(r.lock).toBeNull();
    expect(r.result.closed.financingMicro).toBe(147_945n);
    expect(await balance(db, "fin_accrued")).toBe(0n); // catch-up posted and paid in the close
    expect(await balance(db, "sleeve_margin")).toBe(0n);
    expect(await count(db, "sleeve_state")).toBe(0n);
    const fin = await q(db, "SELECT COUNT(*) AS n FROM cash_ledger WHERE kind = 'financing'");
    expect(toBig(fin[0].n)).toBe(2n); // the catch-up posting is an expense/liability pair
    expect(await violations(db, ["2026-10-09", "2026-10-12"])).toEqual([]);
  });

  it("is idempotent; a differently-priced replay raises sleeve_conflict and changes nothing", async () => {
    const db = await freshDb();
    const { trade } = await openReal(db);
    const env = envOf(9_800_000n, 9_800_000n, 9_500_000n, 9_600_000n);
    const exit = exitOf(env, trade, { kind: "closeout", financingMicro: 0n });
    await writeSleeveClose(db, closeInput(trade, "2026-10-12", exit));
    const before = await dump(db);
    const again = await writeSleeveClose(db, closeInput(trade, "2026-10-12", exit));
    expect(again.written).toBe(false);
    expect(again.result.cashDeltaMicro).toBe(4_600_000n);
    expect(await dump(db)).toBe(before);
    const worse = exitOf(envOf(9_400_000n, 9_400_000n, 9_300_000n, 9_350_000n), trade, {
      kind: "closeout",
      financingMicro: 0n,
    });
    await failsWith(
      writeSleeveClose(db, closeInput(trade, "2026-10-12", worse)),
      "sleeve_conflict",
    );
    expect(await dump(db)).toBe(before);
  });

  it("rolls back whole when a later step fails (fill id collision): trade stays open, no extra rows", async () => {
    const db = await freshDb();
    const { trade } = await openReal(db);
    await writeSleeveFinancing(db, { cohortId: "K1", tradeId: "S1", d: "2026-10-12", cfg });
    const before = await dump(db);
    const exit = exitOf(envOf(10_300_000n, 10_400_000n, 10_200_000n, 10_300_000n), trade, {
      kind: "cs",
    });
    await expect(
      writeSleeveClose(db, { ...closeInput(trade, "2026-10-14", exit), fillId: "EF-S1" }),
    ).rejects.toBeInstanceOf(SleeveWriteError);
    expect(await dump(db)).toBe(before);
    expect(String((await q(db, "SELECT closed_by FROM sleeve_trade"))[0].closed_by)).toBe("null");
  });

  it("needs ids for a real close; refuses an unknown trade", async () => {
    const db = await freshDb();
    const { trade } = await openReal(db);
    const exit = exitOf(envOf(10_300_000n, 10_400_000n, 10_200_000n, 10_300_000n), trade, {
      kind: "cs",
    });
    await expect(
      writeSleeveClose(db, { cohortId: "K1", tradeId: "S1", cfg, closeD: "2026-10-12", exit }),
    ).rejects.toThrow(/order id/);
    await failsWith(
      writeSleeveClose(db, { ...closeInput(trade, "2026-10-12", exit), tradeId: "NOPE" }),
      "sleeve_not_found",
    );
  });
});

describe("lock, shadow log and recovery (ARN-046..048)", () => {
  async function lockedDb(config = cfg) {
    const db = await freshDb();
    const { trade } = await openReal(db, "S1", "2026-10-12", config);
    const exit = exitOf(
      envOf(9_800_000n, 9_800_000n, 9_500_000n, 9_600_000n),
      trade,
      { kind: "closeout", financingMicro: 0n },
      config,
    );
    await writeSleeveClose(db, closeInput(trade, "2026-10-12", exit, config));
    return db;
  }

  it("a locked sleeve opens no real trade; a shadow trade is logged without cash or fills", async () => {
    const db = await lockedDb();
    const cashBefore = await balance(db, "cash_settled");
    const fillsBefore = await count(db, "fill");
    const real = tradeFor("S2", "2026-10-13");
    await failsWith(
      writeSleeveOpen(db, {
        cohortId: "K1",
        trade: real.trade,
        quote: real.quote,
        orderId: "OO-2",
        fillId: "EF-S2",
      }),
      "sleeve_locked",
    );
    const sh = tradeFor("SH1", "2026-10-13", { shadow: true });
    const w = await writeSleeveOpen(db, { cohortId: "K1", trade: sh.trade, quote: sh.quote });
    expect(w.written).toBe(true);
    expect(
      (await q(db, "SELECT shadow, entry_fill_id FROM sleeve_trade WHERE id = 'SH1'"))[0],
    ).toMatchObject({
      shadow: 1n,
      entry_fill_id: null,
    });
    expect(await balance(db, "cash_settled")).toBe(cashBefore);
    expect(await count(db, "fill")).toBe(fillsBefore);
    // one shadow at a time; replay is a no-op
    const sh2 = tradeFor("SH2", "2026-10-13", { shadow: true });
    await failsWith(
      writeSleeveOpen(db, { cohortId: "K1", trade: sh2.trade, quote: sh2.quote }),
      "sleeve_already_open",
    );
    expect(
      (await writeSleeveOpen(db, { cohortId: "K1", trade: sh.trade, quote: sh.quote })).written,
    ).toBe(false);
    // close the shadow with the same arithmetic: a +10 % exit
    const exit = exitOf(envOf(11_000_000n, 11_100_000n, 10_900_000n, 11_000_000n), sh.trade, {
      kind: "cs",
    });
    const closed = await writeSleeveClose(db, {
      cohortId: "K1",
      tradeId: "SH1",
      cfg,
      closeD: "2026-10-14",
      exit,
    });
    expect(closed.lock).toBeNull();
    expect(closed.written).toBe(true);
    expect(
      (
        await q(
          db,
          "SELECT closed_by, exit_fill_id, costs_micro FROM sleeve_trade WHERE id = 'SH1'",
        )
      )[0],
    ).toMatchObject({
      closed_by: "exit",
      exit_fill_id: null,
      costs_micro: 10_000_000n,
    });
    expect(await balance(db, "cash_settled")).toBe(cashBefore);
    expect(await count(db, "fill")).toBe(fillsBefore);
    expect(await violations(db, ["2026-10-12", "2026-10-13", "2026-10-14"])).toEqual([]);
  });

  it("a shadow trade cannot be logged while the sleeve is unlocked", async () => {
    const db = await freshDb();
    const sh = tradeFor("SH1", "2026-10-13", { shadow: true });
    await failsWith(
      writeSleeveOpen(db, { cohortId: "K1", trade: sh.trade, quote: sh.quote }),
      "sleeve_not_locked",
    );
  });

  it("REC-2: unlocks when unlevered realised net P/L since the lock reaches loss_to_recover (TST101-043)", async () => {
    const db = await lockedDb();
    const calendar: never[] = [];
    const check = (nav = 580_000_000n) =>
      runSleeveUnlockCheck(db, { cohortId: "K1", d: "2026-10-13", navMicro: nav, calendar, cfg });
    expect((await check()).unlocked).toBeNull();
    // a stock round trip realised on 2026-10-13: +25,400,000 less 5,010,000 fee = 20,390,000
    const sale: LedgerFill = {
      id: "F9",
      d: "2026-10-13",
      code: "ZZA",
      side: "sell",
      qty: 100n,
      valueMicro: 1_025_400_000n,
      brokerageMicro: 5_010_000n,
    };
    for (const t of fillTxns(sale, 1_000_000_000n)) await writeLedgerTxn(db, "K1", t);
    expect((await check()).unlocked).toBeNull(); // 10,000 micro short
    // 10,000 micro more of realised gain from a second sale (a dividend would not count)
    const sale2: LedgerFill = {
      id: "F10",
      d: "2026-10-13",
      code: "ZZA",
      side: "sell",
      qty: 1n,
      valueMicro: 19_990n,
      brokerageMicro: 0n,
    };
    for (const t of fillTxns(sale2, 9_990n)) await writeLedgerTxn(db, "K1", t);
    const unlocked = (await check()).unlocked;
    expect(unlocked).toMatchObject({
      seq: 2,
      state: "unlocked",
      d: "2026-10-13",
      lossToRecoverMicro: 0n,
    });
    expect((await loadSleeveStates(db, "K1")).map((s) => s.state)).toEqual(["locked", "unlocked"]);
    expect((await q(db, "SELECT kind FROM cohort_event ORDER BY seq")).map((r) => r.kind)).toEqual([
      "lock",
      "unlock",
    ]);
    // a rerun finds the sleeve unlocked and writes nothing; a real trade may open again
    const before = await dump(db);
    expect((await check()).unlocked).toBeNull();
    expect(await dump(db)).toBe(before);
    const again = tradeFor("S2", "2026-10-14");
    await writeSleeveOpen(db, {
      cohortId: "K1",
      trade: again.trade,
      quote: again.quote,
      orderId: "OO-2",
      fillId: "EF-S2",
    });
    expect(await count(db, "sleeve_trade")).toBe(2n);
  });

  it("REC-4: 10 sessions after the lock; REC-1: NAV back to the pre-trade NAV (seed when no earlier NAV)", async () => {
    const rec4: SleeveConfig = { ...cfg, recoveryMode: "REC-4" };
    const db4 = await lockedDb(rec4);
    const at = (d: string) =>
      runSleeveUnlockCheck(db4, { cohortId: "K1", d, navMicro: 1n, calendar: [], cfg: rec4 });
    expect((await at("2026-10-23")).unlocked).toBeNull(); // 9 sessions after Mon 12th
    expect((await at("2026-10-26")).unlocked?.state).toBe("unlocked"); // the 10th

    const rec1: SleeveConfig = { ...cfg, recoveryMode: "REC-1" };
    const db1 = await lockedDb(rec1);
    const nav = (n: bigint) =>
      runSleeveUnlockCheck(db1, {
        cohortId: "K1",
        d: "2026-10-13",
        navMicro: n,
        calendar: [],
        cfg: rec1,
      });
    expect((await nav(599_999_999n)).unlocked).toBeNull();
    expect((await nav(600_000_000n)).unlocked?.state).toBe("unlocked");
  });

  it("REC-1 uses the stored NAV of the close before the losing trade opened", async () => {
    const rec1: SleeveConfig = { ...cfg, recoveryMode: "REC-1" };
    const db = await freshDb();
    // NAV of the close before the trade opens (2026-10-12): 2026-10-09 = 650,000,000
    const day = computeNavDay({
      cohortId: "K1",
      d: "2026-10-09",
      balances: {
        cash_settled: 650_000_000n,
        cash_recv: 0n,
        cash_pay: 0n,
        div_recv: 0n,
        sleeve_margin: 0n,
        fin_accrued: 0n,
        fees_paid: 0n,
        position_cost: 0n,
        equity: 0n,
      },
      positions: new Map(),
      markFor: () => undefined,
      profile: P5,
    });
    await writeNavDay(db, day);
    const { trade } = await openReal(db, "S1", "2026-10-12", rec1);
    const exit = exitOf(
      envOf(9_800_000n, 9_800_000n, 9_500_000n, 9_600_000n),
      trade,
      { kind: "closeout", financingMicro: 0n },
      rec1,
    );
    await writeSleeveClose(db, closeInput(trade, "2026-10-12", exit, rec1));
    const nav = (n: bigint) =>
      runSleeveUnlockCheck(db, {
        cohortId: "K1",
        d: "2026-10-13",
        navMicro: n,
        calendar: [],
        cfg: rec1,
      });
    expect((await nav(600_000_000n)).unlocked).toBeNull(); // seed would have unlocked; the stored NAV is higher
    expect((await nav(650_000_000n)).unlocked?.state).toBe("unlocked");
  });

  it("REC-3: shadow trades closed since the lock earn loss_to_recover", async () => {
    const rec3: SleeveConfig = { ...cfg, recoveryMode: "REC-3" };
    const db = await lockedDb(rec3);
    const check = (d: string) =>
      runSleeveUnlockCheck(db, { cohortId: "K1", d, navMicro: 1n, calendar: [], cfg: rec3 });
    expect((await check("2026-10-13")).unlocked).toBeNull();
    // shadow: +21 % = 42,000,000 price P/L - 10,000,000 costs = 32,000,000 >= 20,400,000
    const sh = tradeFor("SH1", "2026-10-13", { shadow: true, config: rec3 });
    await writeSleeveOpen(db, { cohortId: "K1", trade: sh.trade, quote: sh.quote });
    expect((await check("2026-10-13")).unlocked).toBeNull(); // still open
    const exit = exitOf(
      envOf(12_100_000n, 12_200_000n, 12_000_000n, 12_100_000n),
      sh.trade,
      { kind: "cs" },
      rec3,
    );
    await writeSleeveClose(db, {
      cohortId: "K1",
      tradeId: "SH1",
      cfg: rec3,
      closeD: "2026-10-14",
      exit,
    });
    expect((await check("2026-10-14")).unlocked?.state).toBe("unlocked");
  });

  it("the append-only tables refuse tampering with the lock history", async () => {
    const db = await lockedDb();
    await expect(db.execute("UPDATE sleeve_state SET state = 'unlocked'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM sleeve_state")).rejects.toThrow(/append-only/);
    await expect(db.execute("UPDATE sleeve_trade SET price_pl_micro = 0")).rejects.toThrow();
  });
});

describe("replay: the whole day sequence twice gives identical rows", () => {
  it("open, financing, close, lock, shadow: run twice, byte-identical dump", async () => {
    const db = await freshDb();
    const run = async () => {
      const { trade } = await openReal(db, "S1", "2026-10-09");
      await writeSleeveFinancing(db, { cohortId: "K1", tradeId: "S1", d: "2026-10-12", cfg });
      const exit = exitOf(envOf(9_800_000n, 9_800_000n, 9_300_000n, 9_400_000n), trade, {
        kind: "closeout",
        financingMicro: 147_945n,
      });
      await writeSleeveClose(db, closeInput(trade, "2026-10-12", exit));
      const sh = tradeFor("SH1", "2026-10-13", { shadow: true });
      await writeSleeveOpen(db, { cohortId: "K1", trade: sh.trade, quote: sh.quote });
    };
    await run();
    const first = await dump(db);
    await run();
    expect(await dump(db)).toBe(first);
    expect(await violations(db, ["2026-10-09", "2026-10-12", "2026-10-13"])).toEqual([]);
  });
});
