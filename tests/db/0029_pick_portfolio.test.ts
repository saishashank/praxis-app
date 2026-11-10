// @vitest-environment node
// Migration 0029_pick_portfolio (D-913): the "Follow the picks" practice portfolio tables; rolls back
// and comes back identical, and their CHECK constraints hold.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const TRADE_COLS =
  "(market, profile, pub_d, rank, code, entry_d, entry_micro, qty, cost_micro, exit_d, exit_micro, exit_reason, net_micro)";
const trade = (rank: number, exit: string) =>
  `INSERT INTO pick_portfolio_trade ${TRADE_COLS} VALUES ('AU','balanced','2026-11-02',${rank},'AAA','2026-11-03',1000000,10,10000000,${exit})`;
const day = (cash: number, holdings: number, value: number) =>
  `INSERT INTO pick_portfolio_day (market, profile, d, cash_micro, holdings_micro, value_micro, holdings) VALUES ('AU','balanced','2026-11-03',${cash},${holdings},${value},1)`;

describe("0029_pick_portfolio", () => {
  it("creates both tables, rolls back and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[28]).toMatchObject({ version: 29, name: "pick_portfolio" });
    await migrateUp(db, ms);
    const after = await schemaOf(db);

    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 28 });
    const tables = (
      await db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pick_portfolio_%'",
      )
    ).rows;
    expect(tables).toHaveLength(0);
    expect(await migrateUp(db, ms)).toEqual({ applied: 1, version: 29 });
    expect(await schemaOf(db)).toEqual(after);
  });

  it("pick_portfolio_day: value must equal cash plus holdings", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    await db.execute(day(600, 400, 1000));
    await expect(db.execute(day(600, 400, 999))).rejects.toThrow();
    await db.execute("DELETE FROM pick_portfolio_day");
    await expect(db.execute(day(-1, 1001, 1000))).rejects.toThrow();
  });

  it("pick_portfolio_trade: exit columns are all null or all set, with a known reason", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    // open trade: every exit column null
    await db.execute(trade(1, "NULL,NULL,NULL,NULL"));
    // closed trade: every exit column set
    await db.execute(trade(2, "'2026-11-05',1100000,'aim',1000000"));
    // partly set: refused
    await expect(db.execute(trade(3, "'2026-11-05',NULL,NULL,NULL"))).rejects.toThrow();
    await expect(db.execute(trade(3, "NULL,1100000,'aim',1000000"))).rejects.toThrow();
    await expect(db.execute(trade(3, "'2026-11-05',1100000,'aim',NULL"))).rejects.toThrow();
    await expect(db.execute(trade(3, "'2026-11-05',1100000,NULL,1000000"))).rejects.toThrow();
    // exit_reason values
    for (const [i, reason] of ["stop", "gap", "aim", "time_frame", "weak"].entries()) {
      await db.execute(trade(4 + i, `'2026-11-05',1100000,'${reason}',1000000`));
    }
    await expect(db.execute(trade(9, "'2026-11-05',1100000,'bogus',1000000"))).rejects.toThrow();
    // rank range and primary key
    await expect(db.execute(trade(11, "NULL,NULL,NULL,NULL"))).rejects.toThrow();
    await expect(db.execute(trade(1, "NULL,NULL,NULL,NULL"))).rejects.toThrow();
  });
});
