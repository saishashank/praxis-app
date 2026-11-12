// @vitest-environment node
// M20 A3 (D-1097, MKT-110 b, AT-68 b): calendar rows are written when a market is enabled, never before.
// Under the production seed (IN and US off) nothing is written and the guard refuses a direct insert; enabling a
// market and calling ensureCalendarYears writes two years of provisional rows once.
import { afterEach, describe, expect, it } from "vitest";
import { ensureCalendarYears } from "@/lib/data/calendarAdmin";
import { MarketNotEnabled } from "@/lib/market/errors.mjs";
import { allowMarket, cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);
const NOW = () => new Date("2026-11-13T00:00:00Z");

async function count(db: Awaited<ReturnType<typeof freshDb>>, market: string) {
  const r = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM trading_calendar WHERE market = ?",
    args: [market],
  });
  return Number(r.rows[0].n);
}

describe("ensureCalendarYears", () => {
  it("under the production seed nothing is written and the guard refuses a direct insert", async () => {
    const db = await freshDb("main");
    expect(await count(db, "IN")).toBe(0);
    expect(await count(db, "US")).toBe(0);
    await expect(ensureCalendarYears(db, "IN", undefined, { now: NOW })).rejects.toBeInstanceOf(
      MarketNotEnabled,
    );
    expect(await count(db, "IN")).toBe(0);
    await expect(
      db.execute(
        "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES ('IN', '2026-01-02', 'session', NULL, 0, 'x')",
      ),
    ).rejects.toThrow(/MarketNotEnabled/);
  });

  it("enabling IN writes two years of provisional rows with the per-year source; a second call writes nothing", async () => {
    const db = await freshDb("main");
    await allowMarket(db, "IN");
    const au = await count(db, "AU");
    const r = await ensureCalendarYears(db, "IN", undefined, { now: NOW });
    expect(r).toMatchObject({ status: "written", market: "IN", years: [2026, 2027] });
    expect(r.inserted).toBe(522);
    expect(await count(db, "IN")).toBe(522);
    const src = await db.execute(
      "SELECT substr(d, 1, 4) AS y, source, MIN(confirmed) AS c, COUNT(*) AS n FROM trading_calendar WHERE market = 'IN' GROUP BY y, source ORDER BY y",
    );
    expect(src.rows.map((x) => [x.y, x.source, Number(x.c), Number(x.n)])).toEqual([
      ["2026", "draft:nse-holiday-list-2026", 0, 261],
      ["2027", "draft:nse-holiday-list-2027-pending", 0, 261],
    ]);
    const again = await ensureCalendarYears(db, "IN", undefined, { now: NOW });
    expect(again).toMatchObject({ status: "exists", inserted: 0 });
    expect(await count(db, "IN")).toBe(522);
    expect(await count(db, "AU")).toBe(au); // AU untouched
    expect(await count(db, "US")).toBe(0);
  });

  it("enabling US writes the NYSE rows with early closes at 13:00", async () => {
    const db = await freshDb("main");
    await allowMarket(db, "US");
    const r = await ensureCalendarYears(db, "US", [2026], { now: NOW });
    expect(r).toMatchObject({ status: "written", years: [2026], inserted: 261 });
    const early = await db.execute(
      "SELECT d, close_time, source FROM trading_calendar WHERE market = 'US' AND kind = 'early_close' ORDER BY d",
    );
    expect(early.rows.map((x) => [x.d, x.close_time, x.source])).toEqual([
      ["2026-11-27", "13:00", "draft:nyse-rules-v1"],
      ["2026-12-24", "13:00", "draft:nyse-rules-v1"],
    ]);
  });

  it("a year that already has a row is never touched; a market without rules writes nothing", async () => {
    const db = await freshDb("main");
    await allowMarket(db, "IN");
    await db.execute(
      "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES ('IN', '2027-01-04', 'session', NULL, 1, 'owner')",
    );
    const r = await ensureCalendarYears(db, "IN", undefined, { now: NOW });
    expect(r).toMatchObject({ status: "written", years: [2026], inserted: 261 });
    expect(await count(db, "IN")).toBe(262);
    expect(await ensureCalendarYears(db, "ZZ", undefined, { now: NOW })).toMatchObject({
      status: "no_rules",
      inserted: 0,
    });
  });

  it("rejects a year outside 2000 to 2100", async () => {
    const db = await freshDb("main");
    await allowMarket(db, "US");
    await expect(ensureCalendarYears(db, "US", [1999])).rejects.toThrow(RangeError);
  });
});
