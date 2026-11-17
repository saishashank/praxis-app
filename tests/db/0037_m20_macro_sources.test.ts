// @vitest-environment node
// Migration 0037_m20_macro_sources (M20 integration; D-1147, closes the hand-offs of D-1171 and D-1189): `macro_series.source`
// admits the India sources `rbi` and `mospi` and the US source `fred` beside `rba` and `abs`. SQLite cannot alter a CHECK,
// so the table is rebuilt (same columns, STRICT, WITHOUT ROWID, same primary key) and the rows are copied. The table has
// no `market` column, so the 0035/0036 guard does not reach it: 0037 adds a SOURCE guard (two triggers) that refuses an
// `rbi`/`mospi` row while IN is not enabled and a `fred` row while US is not enabled; `rba` and `abs` are untouched (AU).
// Up, down and up again give an identical schema; the rows survive; a source outside the list is still refused.
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import {
  allowMarket,
  cleanupTempDbs,
  freshDb,
  MIGRATIONS,
  schemaOf,
  tempDbUrl,
  track,
} from "./helpers";

afterEach(cleanupTempDbs);
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const ins = (source: string, series = "S1", d = "2030-01-02", value = 4_350_000) =>
  `INSERT INTO macro_series (source, series_id, d, value_micro, fetched_at)
   VALUES ('${source}','${series}','${d}', ${value}, '2030-01-03T00:00:00.000Z')`;
const count = async (c: Client, where = "1 = 1") =>
  Number((await c.execute(`SELECT COUNT(*) AS n FROM macro_series WHERE ${where}`)).rows[0]!.n);

describe("0037_m20_macro_sources", () => {
  it("is migration 37", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms).toHaveLength(40);
    expect(ms[36]).toMatchObject({ version: 37, name: "m20_macro_sources" });
  });

  it("rolls back and comes back identical, and the home rows survive both ways", async () => {
    const d2 = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    // a schema-36 database with home rows, as production has them before the deploy
    await migrateUp(
      d2,
      ms.filter((m) => m.version <= 36),
    );
    await d2.execute(ins("rba", "FXRINR", "2030-01-02", 55_750_000));
    await d2.execute(ins("abs", "CPI", "2029-12-31", 4_250_000));
    await expect(d2.execute(ins("rbi"))).rejects.toThrow(); // the 0033 CHECK
    expect(await migrateUp(d2, ms)).toEqual({ applied: 4, version: 40 });
    const after = await schemaOf(d2);
    expect(after.some((s) => s.startsWith("table:macro_series:"))).toBe(true);
    expect(
      after.some((s) => s.includes("macro_series_new") || s.includes("macro_series_old")),
    ).toBe(false);
    expect(after.filter((s) => s.includes("macro_series_source_guard_"))).toHaveLength(2);
    // the rows were copied, the primary key holds, the CHECK and the rebuilt table are STRICT and WITHOUT ROWID
    expect(await count(d2)).toBe(2);
    const r = await d2.execute(
      "SELECT value_micro FROM macro_series WHERE source = 'rba' AND series_id = 'FXRINR'",
    );
    expect(Number(r.rows[0]!.value_micro)).toBe(55_750_000);
    await expect(d2.execute(ins("rba", "FXRINR", "2030-01-02"))).rejects.toThrow(); // primary key
    const sql = String(
      (
        await d2.execute(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'macro_series'",
        )
      ).rows[0]!.sql,
    );
    expect(sql).toMatch(/STRICT, WITHOUT ROWID/);
    expect(sql).toMatch(/'rba','abs','rbi','mospi','fred'/);
    // an India row written while IN is enabled is removed by the down (the narrower CHECK cannot hold it, documented)
    await allowMarket(d2, "IN");
    await d2.execute(ins("rbi", "RBI_REPO"));
    expect(await count(d2)).toBe(3);
    expect(await migrateDown(d2, ms, 4)).toEqual({ rolledBack: 4, version: 36 });
    const down = await schemaOf(d2);
    expect(down.some((s) => s.includes("macro_series_source_guard_"))).toBe(false);
    expect(await count(d2)).toBe(2);
    expect(await count(d2, "source = 'rba'")).toBe(1);
    await expect(d2.execute(ins("rbi"))).rejects.toThrow(); // back to the 0033 list
    expect(await migrateUp(d2, ms)).toEqual({ applied: 4, version: 40 });
    expect(await schemaOf(d2)).toEqual(after);
    expect(await count(d2)).toBe(2);
  });

  it("the fresh schema equals the up-down-up schema (no rename residue differs between the two paths)", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    const fresh = await schemaOf(db);
    await migrateDown(db, ms, 4); // 0038 and 0037 (the macro_series rebuild)
    await migrateUp(db, ms);
    expect(await schemaOf(db)).toEqual(fresh);
  });

  it("the home sources pass, the India and US sources are refused while their market is off (the source guard)", async () => {
    await db.execute(ins("rba"));
    await db.execute(ins("abs"));
    for (const s of ["rbi", "mospi"]) {
      await expect(db.execute(ins(s)), s).rejects.toThrow(/MarketNotEnabled macro_series\b/);
    }
    await expect(db.execute(ins("fred"))).rejects.toThrow(/MarketNotEnabled macro_series\b/);
    expect(await count(db)).toBe(2);
    // also INSERT OR IGNORE / OR REPLACE and the upsert form: BEFORE triggers run first
    await expect(
      db.execute(ins("rbi").replace("INSERT INTO", "INSERT OR IGNORE INTO")),
    ).rejects.toThrow(/MarketNotEnabled macro_series\b/);
    await expect(
      db.execute(
        ins("fred") +
          " ON CONFLICT (source, series_id, d) DO UPDATE SET value_micro = excluded.value_micro",
      ),
    ).rejects.toThrow(/MarketNotEnabled macro_series\b/);
    expect(await count(db)).toBe(2);
  });

  it("with IN enabled the India sources pass and fred is still refused; with US enabled fred passes", async () => {
    await allowMarket(db, "IN");
    await db.execute(ins("rbi", "RBI_REPO"));
    await db.execute(ins("mospi", "MOSPI_CPI"));
    await expect(db.execute(ins("fred", "FEDFUNDS"))).rejects.toThrow(
      /MarketNotEnabled macro_series\b/,
    );
    await allowMarket(db, "US");
    await db.execute(ins("fred", "FEDFUNDS"));
    expect(await count(db)).toBe(3);
    // the home upsert (value changed) keeps working and never touches `source`
    await db.execute(ins("rba", "FXRINR", "2030-01-02", 55_000_000));
    await db.execute(
      ins("rba", "FXRINR", "2030-01-02", 55_750_000) +
        " ON CONFLICT (source, series_id, d) DO UPDATE SET value_micro = excluded.value_micro, fetched_at = excluded.fetched_at WHERE macro_series.value_micro <> excluded.value_micro",
    );
    const r = await db.execute(
      "SELECT value_micro FROM macro_series WHERE source = 'rba' AND series_id = 'FXRINR'",
    );
    expect(Number(r.rows[0]!.value_micro)).toBe(55_750_000);
  });

  it("a row cannot be moved onto an off market's source, and a source outside the list is still refused", async () => {
    await db.execute(ins("rba", "S1"));
    await expect(
      db.execute("UPDATE macro_series SET source = 'rbi' WHERE source = 'rba'"),
    ).rejects.toThrow(/MarketNotEnabled macro_series\b/);
    await expect(
      db.execute("UPDATE macro_series SET source = 'fred' WHERE source = 'rba'"),
    ).rejects.toThrow(/MarketNotEnabled macro_series\b/);
    // the CHECK, not the guard: an unknown source name never gets in, whatever is enabled
    await allowMarket(db, "IN");
    await allowMarket(db, "US");
    const err = await db.execute(ins("ecb")).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toMatch(/MarketNotEnabled/);
    await expect(db.execute(ins("RBA"))).rejects.toThrow(); // case matters, as in 0033
    expect(await count(db)).toBe(1);
  });
});
