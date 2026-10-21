// @vitest-environment node
// Fill writer (M3 T5): fill row + order move + optional trade open/close in ONE transaction,
// respecting the 0007 triggers. HIGH-RISK (ledger integrity): atomicity, idempotent replay and
// typed trigger refusals are all tested against a real migrated database.
import { type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { COST_PROFILES } from "@/lib/arena/costs";
import { fillCloseSignalExit, fillEntryAtOpen, type SimulatedFill } from "@/lib/arena/fills";
import { FillWriteError, writeFill, type FillWriteInput } from "@/lib/arena/fillWriter";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const q = async (db: Client, sql: string, args: (string | number | bigint)[] = []) =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const run = (db: Client, sql: string) => db.execute(sql);

const BAR = {
  openMicro: 10_000_000n,
  highMicro: 10_200_000n,
  lowMicro: 9_900_000n,
  closeMicro: 10_100_000n,
};
const env = { bar: BAR, advMicro: 5_000_000_000_000n, profile: COST_PROFILES.P5 };
const entryFill = (qty = 60n): SimulatedFill => fillEntryAtOpen(env, qty);
const exitFill = (qty = 60n): SimulatedFill => fillCloseSignalExit(env, qty);

async function seeded(): Promise<Client> {
  const db = await freshDb("main");
  await run(
    db,
    `INSERT INTO execution (id, market, kind, family, variant, twin_group, rule_version, cost_profile)
     VALUES ('E01', 'AU', 'E', 'F1', 'U', 'T1', 'rv1', 'P5')`,
  );
  await run(
    db,
    `INSERT INTO cohort (id, execution_id, start_d, seed_micro, rule_version, params_json,
       cost_profile_version, rng_seed)
     VALUES ('K1', 'E01', '2026-10-12', 600000000, 'rv1', '{}', 1, 42)`,
  );
  return db;
}
const order = (
  db: Client,
  id: string,
  side: "buy" | "sell",
  kind: string,
  qty: number,
  decided = "2026-10-12",
) =>
  run(
    db,
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty)
     VALUES ('${id}', 'K1', '${decided}', 'ZZAA', '${side}', '${kind}', ${qty})`,
  );

const entryInput = (over: Partial<FillWriteInput> = {}): FillWriteInput => ({
  fillId: "F1",
  orderId: "O1",
  cohortId: "K1",
  d: "2026-10-13",
  code: "ZZAA",
  fill: entryFill(),
  trade: { kind: "open", tradeId: "T1", stopMicro: 9_510_000n },
  ...over,
});
const exitInput = (over: Partial<FillWriteInput> = {}): FillWriteInput => ({
  fillId: "F2",
  orderId: "O2",
  cohortId: "K1",
  d: "2026-10-14",
  code: "ZZAA",
  fill: exitFill(),
  trade: { kind: "close", tradeId: "T1", exitType: "CS" },
  ...over,
});

async function counts(db: Client) {
  return {
    fills: (await q(db, "SELECT COUNT(*) AS n FROM fill"))[0].n,
    pending: (await q(db, "SELECT COUNT(*) AS n FROM arena_order WHERE status = 'pending'"))[0].n,
    trades: (await q(db, "SELECT COUNT(*) AS n FROM trade"))[0].n,
  };
}

async function expectWriteError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FillWriteError);
  expect((error as FillWriteError).code).toBe(code);
  return error as FillWriteError;
}

describe("writeFill: entry", () => {
  it("inserts the fill, moves the order to filled and opens the trade with the initial stop", async () => {
    const db = await seeded();
    await order(db, "O1", "buy", "entry", 60);
    expect(await writeFill(db, entryInput())).toEqual({ written: true });
    const fill = (await q(db, "SELECT * FROM fill WHERE id = 'F1'"))[0];
    expect(fill).toMatchObject({
      order_id: "O1",
      cohort_id: "K1",
      d: "2026-10-13",
      code: "ZZAA",
      side: "buy",
      qty: 60,
      rule: "open",
      ref_price_micro: 10_000_000,
      slip_micro: 10_000,
      fill_price_micro: 10_010_000,
      value_micro: 600_600_000,
      brokerage_micro: 5_000_000,
      cost_profile: "P5",
      bar_o_micro: 10_000_000,
      bar_h_micro: 10_200_000,
      bar_l_micro: 9_900_000,
      bar_c_micro: 10_100_000,
    });
    expect((await q(db, "SELECT status, fill_d FROM arena_order WHERE id = 'O1'"))[0]).toEqual({
      status: "filled",
      fill_d: "2026-10-13",
    });
    expect((await q(db, "SELECT * FROM trade WHERE id = 'T1'"))[0]).toMatchObject({
      entry_fill_id: "F1",
      stop_micro: 9_510_000,
      exit_type: null,
      exit_fill_id: null,
    });
  });

  it("works without a trade write (fill and order only)", async () => {
    const db = await seeded();
    await order(db, "O1", "buy", "entry", 60);
    await writeFill(db, entryInput({ trade: undefined }));
    expect(await counts(db)).toEqual({ fills: 1, pending: 0, trades: 0 });
  });

  it("a partial fill below the order quantity is allowed by the trigger", async () => {
    const db = await seeded();
    await order(db, "O1", "buy", "entry", 100);
    await writeFill(db, entryInput({ fill: entryFill(60n), trade: undefined }));
    expect((await q(db, "SELECT qty FROM fill WHERE id = 'F1'"))[0].qty).toBe(60);
  });
});

describe("writeFill: exit", () => {
  it("closes the open trade with the exit type", async () => {
    const db = await seeded();
    await order(db, "O1", "buy", "entry", 60);
    await writeFill(db, entryInput());
    await order(db, "O2", "sell", "exit_cs", 60);
    expect(await writeFill(db, exitInput())).toEqual({ written: true });
    const trade = (await q(db, "SELECT * FROM trade WHERE id = 'T1'"))[0];
    expect(trade).toMatchObject({ exit_fill_id: "F2", exit_type: "CS" });
    expect((await q(db, "SELECT fill_price_micro FROM fill WHERE id = 'F2'"))[0]).toEqual({
      fill_price_micro: 9_990_000,
    });
  });
});

describe("writeFill: idempotent replay", () => {
  it("the same fill again writes nothing and reports written false", async () => {
    const db = await seeded();
    await order(db, "O1", "buy", "entry", 60);
    await writeFill(db, entryInput());
    expect(await writeFill(db, entryInput())).toEqual({ written: false });
    expect(await counts(db)).toEqual({ fills: 1, pending: 0, trades: 1 });
  });

  it("a different fill id for an already filled order is refused", async () => {
    const db = await seeded();
    await order(db, "O1", "buy", "entry", 60);
    await writeFill(db, entryInput());
    await expectWriteError(writeFill(db, entryInput({ fillId: "F9" })), "order_not_pending");
  });
});

describe("writeFill: typed refusals and atomicity", () => {
  it("unknown order", async () => {
    const db = await seeded();
    await expectWriteError(writeFill(db, entryInput()), "order_not_found");
  });

  it("an order of another cohort is not found", async () => {
    const db = await seeded();
    await order(db, "O1", "buy", "entry", 60);
    await expectWriteError(writeFill(db, entryInput({ cohortId: "K9" })), "order_not_found");
  });

  it("rejected and cancelled orders cannot be filled", async () => {
    const db = await seeded();
    await run(
      db,
      `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status, reject_reason)
       VALUES ('O1', 'K1', '2026-10-12', 'ZZAA', 'buy', 'entry', 60, 'rejected', 'parcel')`,
    );
    const error = await expectWriteError(writeFill(db, entryInput()), "order_not_pending");
    expect(error.message).toContain("rejected");
    expect((await counts(db)).fills).toBe(0);
  });

  it("trigger refusal: fill quantity above the order, nothing written", async () => {
    const db = await seeded();
    await order(db, "O1", "buy", "entry", 50);
    const error = await expectWriteError(writeFill(db, entryInput()), "trigger_refused");
    expect(error.message).toContain("fill: needs a matching pending order");
    expect(await counts(db)).toEqual({ fills: 0, pending: 1, trades: 0 });
  });

  it("trigger refusal: side or code that does not match the order", async () => {
    const db = await seeded();
    await order(db, "O1", "buy", "entry", 60);
    await expectWriteError(writeFill(db, entryInput({ fill: exitFill() })), "trigger_refused");
    await expectWriteError(writeFill(db, entryInput({ code: "ZZBB" })), "trigger_refused");
    expect(await counts(db)).toEqual({ fills: 0, pending: 1, trades: 0 });
  });

  it("trigger refusal on the trade: a sell fill cannot open a trade; the fill is rolled back", async () => {
    const db = await seeded();
    await order(db, "O1", "sell", "exit_cs", 60);
    const error = await expectWriteError(
      writeFill(
        db,
        entryInput({ fill: exitFill(), trade: { kind: "open", tradeId: "T1", stopMicro: 1n } }),
      ),
      "trigger_refused",
    );
    expect(error.message).toContain("trade:");
    expect(await counts(db)).toEqual({ fills: 0, pending: 1, trades: 0 });
  });

  it("rolls back the fill and the order move when closing an unknown trade", async () => {
    const db = await seeded();
    await order(db, "O1", "sell", "exit_cs", 60);
    await expectWriteError(
      writeFill(
        db,
        exitInput({ orderId: "O1", trade: { kind: "close", tradeId: "NOPE", exitType: "CS" } }),
      ),
      "trade_not_found",
    );
    expect(await counts(db)).toEqual({ fills: 0, pending: 1, trades: 0 });
    expect((await q(db, "SELECT status FROM arena_order WHERE id = 'O1'"))[0].status).toBe(
      "pending",
    );
  });

  it("an already closed trade cannot be closed twice", async () => {
    const db = await seeded();
    await order(db, "O1", "buy", "entry", 60);
    await writeFill(db, entryInput());
    await order(db, "O2", "sell", "exit_cs", 60);
    await writeFill(db, exitInput());
    await order(db, "O3", "sell", "exit_cs", 60, "2026-10-13");
    await expectWriteError(
      writeFill(db, exitInput({ fillId: "F3", orderId: "O3" })),
      "trade_not_found",
    );
    expect((await q(db, "SELECT status FROM arena_order WHERE id = 'O3'"))[0].status).toBe(
      "pending",
    );
  });

  it("constraint refusal after the fill insert (duplicate trade id) rolls everything back", async () => {
    const db = await seeded();
    await order(db, "O1", "buy", "entry", 60);
    await writeFill(db, entryInput());
    await order(db, "O4", "buy", "entry", 60, "2026-10-13");
    // second entry in the same cohort on another day reusing trade id T1
    const error = await expectWriteError(
      writeFill(db, entryInput({ fillId: "F4", orderId: "O4", d: "2026-10-14" })),
      "constraint_refused",
    );
    expect(error.message.length).toBeGreaterThan(0);
    expect((await counts(db)).fills).toBe(1);
    expect((await q(db, "SELECT status FROM arena_order WHERE id = 'O4'"))[0].status).toBe(
      "pending",
    );
  });

  it("constraint refusal on the fill itself (reused fill id)", async () => {
    const db = await seeded();
    await order(db, "O1", "buy", "entry", 60);
    await writeFill(db, entryInput());
    await order(db, "O4", "buy", "entry", 60, "2026-10-13");
    await expectWriteError(
      writeFill(db, entryInput({ fillId: "F1", orderId: "O4", trade: undefined })),
      "constraint_refused",
    );
    expect((await q(db, "SELECT status FROM arena_order WHERE id = 'O4'"))[0].status).toBe(
      "pending",
    );
  });

  it("an amount outside int64 is a RangeError and nothing is written", async () => {
    const db = await seeded();
    await order(db, "O1", "buy", "entry", 60);
    const huge: SimulatedFill = { ...entryFill(), valueMicro: 9_223_372_036_854_775_808n };
    await expect(writeFill(db, entryInput({ fill: huge }))).rejects.toThrow(RangeError);
    expect(await counts(db)).toEqual({ fills: 0, pending: 1, trades: 0 });
  });

  it("an unrelated database error is rethrown untouched", async () => {
    const db = await seeded();
    await run(db, "DROP TABLE trade");
    await order(db, "O1", "buy", "entry", 60);
    const error = await writeFill(db, entryInput()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    expect(error).not.toBeInstanceOf(FillWriteError);
    // the fill insert happened inside the failed transaction and was rolled back
    expect((await q(db, "SELECT COUNT(*) AS n FROM fill"))[0].n).toBe(0);
    expect((await q(db, "SELECT status FROM arena_order WHERE id = 'O1'"))[0].status).toBe(
      "pending",
    );
  });
});
