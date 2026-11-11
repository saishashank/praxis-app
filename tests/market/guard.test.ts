// @vitest-environment node
// M19 A2 (D-995; AT-68 b): the application side of the write guard. A refused insert becomes the typed
// MarketNotEnabled (the class errors.mjs defines, re-exported by guard.mjs), the incident is written once, AU
// passes, any other database error passes through unchanged, and assertMarketEnabled refuses a market that is off.
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mainDb, marketRefusalReporter, resetMarketRefusalReports } from "@/lib/db/client";
import {
  assertMarketEnabled,
  isMarketNotEnabled,
  marketNotEnabledFrom,
  marketOfStatement,
  MarketNotEnabled,
  refusedTable,
  wrapClient,
} from "@/lib/market/guard.mjs";
import * as errors from "@/lib/market/errors.mjs";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
});
beforeEach(resetMarketRefusalReports);

async function migrated(url = tempDbUrl()): Promise<Client> {
  const c = track(createClient({ url }));
  await migrateUp(c, await loadMigrations(MIGRATIONS("main")));
  return c;
}

const bar = (market: string, code = "AAA") => ({
  sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
        VALUES (?, ?, '2026-11-11', 1, 1, 1, 1, 1, 't', 't', 't')`,
  args: [market, code],
});

describe("the typed error", () => {
  it("guard.mjs re-exports the class errors.mjs defines (D-1013), it does not redefine it", () => {
    expect(MarketNotEnabled).toBe(errors.MarketNotEnabled);
    expect(isMarketNotEnabled).toBe(errors.isMarketNotEnabled);
  });

  it("a refused insert is rethrown as MarketNotEnabled with the market and the table", async () => {
    const seen: Array<[string, string | null]> = [];
    const c = wrapClient(await migrated(), (e, info) => void seen.push([e.market, info.table]));
    const err = await c.execute(bar("IN")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketNotEnabled);
    expect(isMarketNotEnabled(err)).toBe(true);
    expect(err).toMatchObject({ market: "IN", table: "price_bar", name: "MarketNotEnabled" });
    expect((err as Error).message).toBe("MarketNotEnabled IN price_bar");
    expect((err as Error).cause).toBeInstanceOf(Error); // the database error stays reachable
    expect(seen).toEqual([["IN", "price_bar"]]);
  });

  it("the market is found in string arguments and in quoted literals, an unknown one is named so", async () => {
    const c = wrapClient(await migrated());
    const lit = await c
      .execute(
        "INSERT INTO quote_latest (market, code, last_micro, quote_at, fetched_at) VALUES ('US','A',1,'t','t')",
      )
      .catch((e: unknown) => e);
    expect(lit).toMatchObject({ market: "US", table: "quote_latest" });
    const named = await c
      .execute({
        sql: "INSERT INTO quote_latest (market, code, last_micro, quote_at, fetched_at) VALUES (:m,:c,1,'t','t')",
        args: { m: "ZZ", c: "AAA" },
      })
      .catch((e: unknown) => e);
    expect(named).toMatchObject({ market: "ZZ" });
    expect(marketOfStatement("SELECT 1")).toBe("unknown");
    expect(marketOfStatement(bar("IN", "AAA"), (x) => x === "IN")).toBe("AAA"); // enabled ones are dropped
  });

  it("batch and transaction statements are mapped the same way", async () => {
    const seen: string[] = [];
    const c = wrapClient(await migrated(), (e) => void seen.push(e.market));
    await expect(c.batch([bar("AU", "OK"), bar("IN", "BAD")], "write")).rejects.toBeInstanceOf(
      MarketNotEnabled,
    );
    const tx = await c.transaction("write");
    await expect(tx.execute(bar("US"))).rejects.toBeInstanceOf(MarketNotEnabled);
    await tx.rollback();
    expect(seen).toEqual(["IN", "US"]);
    expect((await c.execute("SELECT COUNT(*) n FROM price_bar")).rows[0]!.n).toBe(0);
  });

  it("an AU insert passes, onRefusal is not called, other errors pass through unchanged", async () => {
    const onRefusal = vi.fn();
    const c = wrapClient(await migrated(), onRefusal);
    await c.execute(bar("AU"));
    await c.batch([bar("AU", "BBB")], "write");
    const tx = await c.transaction("write");
    await tx.execute(bar("AU", "CCC"));
    await tx.commit();
    expect((await c.execute("SELECT COUNT(*) n FROM price_bar")).rows[0]!.n).toBe(3);
    const syntax = await c.execute("SELEKT 1").catch((e: unknown) => e);
    expect(isMarketNotEnabled(syntax)).toBe(false);
    expect(syntax).toBeInstanceOf(Error);
    expect(onRefusal).not.toHaveBeenCalled();
  });

  it("a failing onRefusal is swallowed: the typed error still comes out", async () => {
    const c = wrapClient(await migrated(), () => {
      throw new Error("incident writer down");
    });
    await expect(c.execute(bar("IN"))).rejects.toBeInstanceOf(MarketNotEnabled);
    const c2 = wrapClient(await migrated(), async () => {
      throw new Error("async down");
    });
    await expect(c2.execute(bar("IN"))).rejects.toBeInstanceOf(MarketNotEnabled);
  });

  it("wrapping twice returns the same wrapper; closed and close are forwarded", async () => {
    const raw = await migrated();
    const a = wrapClient(raw);
    expect(wrapClient(raw)).toBe(a);
    expect(a.closed).toBe(false);
    a.close();
    expect(raw.closed).toBe(true);
    expect(a.closed).toBe(true);
  });

  it("marketNotEnabledFrom and refusedTable read the trigger text only", () => {
    expect(refusedTable(new Error("SQLITE_CONSTRAINT: MarketNotEnabled price_bar"))).toBe(
      "price_bar",
    );
    expect(refusedTable(new Error("UNIQUE constraint failed"))).toBeNull();
    expect(
      refusedTable(new Error("outer", { cause: new Error("MarketNotEnabled run_record") })),
    ).toBe("run_record");
    expect(marketNotEnabledFrom(new Error("other"))).toBeNull();
    expect(marketNotEnabledFrom(new Error("MarketNotEnabled alert"), "IN")).toMatchObject({
      market: "IN",
      table: "alert",
    });
    const typed = new MarketNotEnabled("IN", "x");
    expect(marketNotEnabledFrom(typed)).toBe(typed);
  });
});

describe("assertMarketEnabled", () => {
  it("passes for AU, throws MarketNotEnabled for IN, US and an unknown code", async () => {
    const db = await migrated();
    await expect(assertMarketEnabled(db, "AU")).resolves.toBe("AU");
    for (const code of ["IN", "US", "ZZ"]) {
      await expect(assertMarketEnabled(db, code)).rejects.toMatchObject({
        name: "MarketNotEnabled",
        market: code,
      });
    }
  });

  it("follows the enabled column: enabled passes, disabled again throws", async () => {
    const db = await migrated();
    await db.execute("UPDATE market SET enabled = 1 WHERE code = 'IN'");
    await expect(assertMarketEnabled(db, "IN")).resolves.toBe("IN");
    await db.execute("UPDATE market SET enabled = 0 WHERE code = 'IN'");
    await expect(assertMarketEnabled(db, "IN")).rejects.toBeInstanceOf(MarketNotEnabled);
  });

  it("is a single primary-key read", async () => {
    const db = await migrated();
    const stmts: string[] = [];
    const spy = { execute: (s: { sql: string }) => (stmts.push(s.sql), db.execute(s)) };
    await assertMarketEnabled(spy as never, "AU");
    expect(stmts).toEqual(["SELECT 1 FROM market WHERE code = ? AND enabled = 1"]);
  });
});

describe("the incident (S2 market_not_enabled)", () => {
  const incidents = async (db: Client) =>
    (await db.execute("SELECT severity, kind, detail_json FROM incident")).rows;

  it("is written once however often the same market is refused", async () => {
    const raw = await migrated();
    const c = wrapClient(raw, marketRefusalReporter(raw));
    for (let i = 0; i < 3; i += 1) await c.execute(bar("IN", `A${i}`)).catch(() => undefined);
    const rows = await incidents(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "S2", kind: "market_not_enabled" });
    expect(JSON.parse(String(rows[0]!.detail_json))).toEqual({ market: "IN", table: "price_bar" });
  });

  it("a second market the same day is remembered separately but the open incident stays one", async () => {
    const raw = await migrated();
    const c = wrapClient(raw, marketRefusalReporter(raw));
    await c.execute(bar("IN")).catch(() => undefined);
    await c.execute(bar("US")).catch(() => undefined);
    expect(await incidents(raw)).toHaveLength(1);
  });

  it("is reported again on a later day (once per market per day)", async () => {
    const raw = await migrated();
    let day = new Date("2026-11-12T01:00:00.000Z");
    const c = wrapClient(
      raw,
      marketRefusalReporter(raw, () => day),
    );
    await c.execute(bar("IN")).catch(() => undefined);
    await raw.execute("UPDATE incident SET resolved_at = '2026-11-12T02:00:00.000Z'");
    day = new Date("2026-11-13T01:00:00.000Z");
    await c.execute(bar("IN", "B")).catch(() => undefined);
    expect(await incidents(raw)).toHaveLength(2);
  });

  it("an AU write writes no incident", async () => {
    const raw = await migrated();
    const c = wrapClient(raw, marketRefusalReporter(raw));
    await c.execute(bar("AU"));
    expect(await incidents(raw)).toHaveLength(0);
  });

  it("mainDb() is wrapped: its client maps the refusal and writes the incident", async () => {
    const url = tempDbUrl();
    const raw = await migrated(url);
    vi.stubEnv("TURSO_MAIN_URL", url);
    vi.stubEnv("TURSO_MAIN_TOKEN", "");
    const c = mainDb();
    expect(mainDb()).toBe(c); // one wrapper per client (D-204)
    await expect(c.execute(bar("IN"))).rejects.toBeInstanceOf(MarketNotEnabled);
    expect(await incidents(raw)).toHaveLength(1);
    await c.execute(bar("AU"));
    c.close();
  });
});
