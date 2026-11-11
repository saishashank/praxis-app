// @vitest-environment node
// Migration 0032_my_portfolio (D-950): the My portfolio tables (the 0029 trade and day tables in their
// new shape, the open holdings and the strategy split); rolls back to the 0029 shapes and comes back
// identical, and the CHECK constraints hold.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const COLS =
  "(market, profile, seq, d, side, code, strategy, pub_d, rank, pos, qty, price_micro, fee_micro, net_micro, reason, closes, words)";
const trade = (seq: number, rest: string) =>
  `INSERT INTO pick_portfolio_trade ${COLS} VALUES ('AU','balanced',${seq},'2026-11-11',${rest},'Words.')`;
const buy = (seq: number, strategy = "F1") =>
  trade(seq, `'buy','AAA','${strategy}','2026-11-10',1,${seq},10,1000000,1000000,NULL,'pick',0`);
const sell = (seq: number, reason: string, closes = 1, net = "500000") =>
  trade(seq, `'sell','AAA','F1','2026-11-10',1,1,10,1100000,1000000,${net},'${reason}',${closes}`);

describe("0032_my_portfolio", () => {
  it("recreates the tables, rolls back to the 0029 shapes and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[31]).toMatchObject({ version: 32, name: "my_portfolio" });
    await migrateUp(
      db,
      ms.filter((m) => m.version <= 31),
    );
    const before = await schemaOf(db);
    expect(await migrateUp(db, ms)).toEqual({ applied: 1, version: 32 });
    const after = await schemaOf(db);
    for (const t of ["pick_portfolio_hold", "pick_portfolio_split"])
      expect(after.some((s) => s.startsWith(`table:${t}:`))).toBe(true);
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 31 });
    expect(await schemaOf(db)).toEqual(before);
    expect(await migrateUp(db, ms)).toEqual({ applied: 1, version: 32 });
    expect(await schemaOf(db)).toEqual(after);
  });

  it("pick_portfolio_trade: a buy is a pick with no net and opens its own holding; a sale has a reason", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    await db.execute(buy(1));
    for (const [i, reason] of [
      "stop",
      "gap",
      "aim",
      "time_frame",
      "weak",
      "strategy_exit",
      "rebalance",
    ].entries())
      await db.execute(sell(2 + i, reason, reason === "rebalance" ? 0 : 1));
    await expect(db.execute(sell(20, "bogus"))).rejects.toThrow();
    await expect(db.execute(sell(21, "pick"))).rejects.toThrow(); // a sale is never a pick
    await expect(db.execute(sell(22, "aim", 1, "NULL"))).rejects.toThrow(); // a sale has a net
    await expect(db.execute(buy(23, "F7"))).rejects.toThrow(); // unknown strategy
    await expect(
      db.execute(trade(24, `'buy','AAA','SL','2026-11-10',1,1,10,1000000,0,NULL,'pick',0`)),
    ).rejects.toThrow(); // a buy opens its own holding (pos = seq)
    await expect(db.execute(buy(1))).rejects.toThrow(); // primary key
    await db.execute(buy(30, "SL"));
  });

  it("pick_portfolio_day, _hold and _split: value, fall, JSON and shares in range", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    const day = (v: number, fall: number) =>
      `INSERT INTO pick_portfolio_day (market, profile, d, cash_micro, holdings_micro, value_micro, holdings, fall_ppm) VALUES ('AU','balanced','2026-11-11',600,400,${v},1,${fall})`;
    await expect(db.execute(day(999, 0))).rejects.toThrow();
    await expect(db.execute(day(1000, 1))).rejects.toThrow();
    await db.execute(day(1000, -5000));
    const split = (json: string, cash: number) =>
      `INSERT INTO pick_portfolio_split (market, profile, d, shares_json, cash_ppm, words) VALUES ('AU','balanced','2026-11-11','${json}',${cash},'Follow the trend 40%, cash 60%.')`;
    await expect(db.execute(split("nope", 600000))).rejects.toThrow();
    await expect(db.execute(split("[]", 1000001))).rejects.toThrow();
    await db.execute(split('[{"strategy":"F1","target_ppm":400000}]', 600000));
    const hold = (code: string, strategy: string) =>
      `INSERT INTO pick_portfolio_hold (market, profile, code, pos, strategy, pub_d, entry_d, entry_micro, qty, cost_micro) VALUES ('AU','balanced','${code}',1,'${strategy}','2026-11-10','2026-11-11',1000000,10,10000000)`;
    await db.execute(hold("AAA", "SL"));
    await expect(db.execute(hold("AAA", "F1"))).rejects.toThrow(); // one row per stock
    await expect(db.execute(hold("BBB", "CAND"))).rejects.toThrow();
  });
});
