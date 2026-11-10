// @vitest-environment node
// OPS-104 e (D-960; AT-83 "row invariant"): no rows may exist for a market that is switched off or
// unknown. A planted foreign-market row alarms; the enabled market's own rows are quiet; the table list
// is derived from the schema and equals a scan of the migration files.
import type { Client } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkMarketRows,
  countRowsByMarket,
  enabledMarkets,
  marketTables,
  MARKET_ROWS_INCIDENT,
} from "@/lib/maintenance/rowsByMarket";
import { runMaintenance } from "@/lib/maintenance/retention";
import { cleanupTempDbs, freshDb, MIGRATIONS } from "../db/helpers";

afterEach(cleanupTempDbs);
let db: Client;
let auth: Client;
beforeEach(async () => {
  db = await freshDb("main");
  auth = await freshDb("auth");
});

const NOW = new Date("2026-11-12T00:30:00.000Z");
const D = "2026-11-12";

// A foreign code that is not in the `market` table at all, and a code made off through a market row.
const FOREIGN = "ZQ";
const OFF = "ZO";

async function runRow(market: string | null, key: string) {
  await db.execute({
    sql: "INSERT INTO run_record (job, market, concurrency_key, started_at, status) VALUES ('x', ?, ?, '2026-11-11T00:00:00.000Z', 'success')",
    args: [market, key],
  });
}
async function quoteRow(market: string, code: string) {
  await db.execute({
    sql: `INSERT INTO quote_latest (market, code, last_micro, prev_close_micro, quote_at, fetched_at)
          VALUES (?, ?, 1000000, NULL, 't', 't')`,
    args: [market, code],
  });
}
async function addMarket(code: string, mode: string) {
  await db.execute({
    sql: `INSERT INTO market (code, tz, open_time, close_time, cutoff_time, currency, mode)
          VALUES (?, 'UTC', '10:00', '16:00', '16:10', 'XXX', ?)`,
    args: [code, mode],
  });
}
const rowsOf = async () =>
  (
    await db.execute("SELECT d, tbl, market, n FROM market_row_count ORDER BY tbl, market")
  ).rows.map((r) => [String(r.d), String(r.tbl), String(r.market), Number(r.n)]);

describe("the table list", () => {
  it("is derived from the schema and equals a scan of the migrations (up sections)", async () => {
    const dir = MIGRATIONS("main");
    const fromFiles = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      const up = readFileSync(path.join(dir, f), "utf8").split("-- +down")[0]!;
      for (const m of up.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\)/g)) {
        if (/^\s+market\s/m.test(m[2]!)) fromFiles.add(m[1]!);
      }
      for (const m of up.matchAll(/ALTER TABLE (\w+) ADD COLUMN market\b/g)) fromFiles.add(m[1]!);
    }
    fromFiles.delete("market_row_count"); // the invariant's own table is never counted
    const derived = (await marketTables(db)).map((t) => t.table);
    expect(derived.sort()).toEqual([...fromFiles].sort());
    expect(derived).toContain("price_bar");
    expect(derived).toContain("run_record");
  });

  it("marks a table indexed when a key or index starts with market, unindexed otherwise", async () => {
    const by = new Map((await marketTables(db)).map((t) => [t.table, t.indexed]));
    expect(by.get("price_bar")).toBe(true); // primary key starts with market
    expect(by.get("announcement")).toBe(true); // idx_announcement_code starts with market
    expect(by.get("run_record")).toBe(false); // no index starts with market
  });
});

describe("the invariant", () => {
  it("is quiet for the enabled market's own rows (indexed and unindexed tables)", async () => {
    const [en] = await enabledMarkets(db);
    expect(en).toBeTruthy();
    await runRow(en!, "k1");
    await runRow(null, "k2"); // a run without a market belongs to none
    await quoteRow(en!, "AAA");
    const r = await checkMarketRows(db, D, NOW);
    expect(r.unexpected).toEqual([]);
    expect(await rowsOf()).toEqual([[D, "run_record", en!, 1]]); // only a full count is stored for an enabled market
    expect((await db.execute("SELECT 1 FROM incident")).rows).toHaveLength(0);
  });

  it("a planted foreign-market row alarms (S2) on an indexed table and on an unindexed one", async () => {
    await quoteRow(FOREIGN, "AAA");
    await quoteRow(FOREIGN, "BBB");
    await runRow(FOREIGN, "k1");
    const r = await checkMarketRows(db, D, NOW);
    expect(r.unexpected.map((u) => [u.tbl, u.market, u.n]).sort()).toEqual([
      ["quote_latest", FOREIGN, 2],
      ["run_record", FOREIGN, 1],
    ]);
    const inc = (await db.execute("SELECT severity, kind, detail_json FROM incident")).rows;
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ severity: "S2", kind: MARKET_ROWS_INCIDENT });
    expect(JSON.parse(String(inc[0]!.detail_json)).rows).toHaveLength(2);
    expect(await rowsOf()).toEqual([
      [D, "quote_latest", FOREIGN, 2],
      [D, "run_record", FOREIGN, 1],
    ]);
  });

  it("finds every unexpected market, also those sorting between and after the enabled ones", async () => {
    const [en] = await enabledMarkets(db);
    await addMarket("ZM", "data_only"); // enabled, sorts after FOREIGN? "ZM" < "ZQ" and > "ZO"
    await quoteRow(en!, "AAA");
    await quoteRow("ZM", "AAA"); // enabled: quiet
    await quoteRow("A0", "AAA"); // sorts before the AU market
    await quoteRow("ZN", "AAA"); // between two enabled markets
    await quoteRow("ZZ", "AAA"); // after the last
    const r = await countRowsByMarket(db);
    expect(r.unexpected.map((u) => u.market).sort()).toEqual(["A0", "ZN", "ZZ"]);
  });

  it("a market row with mode off makes its rows unexpected; data_only makes them fine", async () => {
    await addMarket(OFF, "off");
    await quoteRow(OFF, "AAA");
    expect((await countRowsByMarket(db)).unexpected.map((u) => u.market)).toEqual([OFF]);
    await db.execute({ sql: "UPDATE market SET mode = 'data_only' WHERE code = ?", args: [OFF] });
    expect((await countRowsByMarket(db)).unexpected).toEqual([]);
  });

  it("a re-run of the night replaces its rows and does not open a second incident", async () => {
    await quoteRow(FOREIGN, "AAA");
    await checkMarketRows(db, D, NOW);
    await quoteRow(FOREIGN, "BBB");
    await checkMarketRows(db, D, NOW);
    expect(await rowsOf()).toEqual([[D, "quote_latest", FOREIGN, 2]]);
    expect((await db.execute("SELECT 1 FROM incident")).rows).toHaveLength(1);
  });

  it("raise: false stores the counts without an incident", async () => {
    await quoteRow(FOREIGN, "AAA");
    await checkMarketRows(db, D, NOW, { raise: false });
    expect((await db.execute("SELECT 1 FROM incident")).rows).toHaveLength(0);
    expect(await rowsOf()).toHaveLength(1);
  });

  it("runs inside the nightly maintenance route and a clean night stays a success", async () => {
    const out = await runMaintenance(
      { mainDb: db, authDb: auth, piiHashKey: "4".repeat(64), now: NOW },
      D,
    );
    expect(out.status).toBe("success");
    await quoteRow(FOREIGN, "AAA");
    const bad = await runMaintenance(
      { mainDb: db, authDb: auth, piiHashKey: "4".repeat(64), now: NOW },
      "2026-11-13",
    );
    expect(bad.status).toBe("success"); // the alarm is the incident, not a failed run
    const inc = (await db.execute("SELECT kind FROM incident")).rows;
    expect(inc.map((r) => String(r.kind))).toEqual([MARKET_ROWS_INCIDENT]);
  });
});
