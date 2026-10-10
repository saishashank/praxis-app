// @vitest-environment node
// DAT-160, TST-103 (exchange holidays, early closes), D-057 #11: the AU calendar seed generator
// and main migration 0005_au_calendar_seed.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { calendarYearSummary, loadCalendarRows } from "@/lib/data/calendarAdmin";
import { isTradingDay, nextTradingDay, sessionsBetween } from "@/lib/data/calendar";
import {
  allRows,
  easterSunday,
  holidays,
  MIGRATION_PATH,
  renderMigration,
  SOURCE,
} from "../../scripts/data/make-au-calendar.mjs";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf } from "../db/helpers";

afterEach(cleanupTempDbs);

// Hard-coded expectations (standard national / NSW rules as observed by ASX; [VERIFY] against the
// ASX calendar before the Owner confirms).
const HOLIDAYS_2026 = [
  "2026-01-01", // New Year's Day (Thu)
  "2026-01-26", // Australia Day (Mon)
  "2026-04-03", // Good Friday
  "2026-04-06", // Easter Monday (Easter Sunday 5 Apr)
  "2026-06-08", // King's Birthday (2nd Monday of June)
  "2026-12-25", // Christmas Day (Fri)
  "2026-12-28", // Boxing Day observed (26 Dec is a Saturday)
];
const HOLIDAYS_2027 = [
  "2027-01-01", // New Year's Day (Fri)
  "2027-01-26", // Australia Day (Tue)
  "2027-03-26", // Good Friday
  "2027-03-29", // Easter Monday (Easter Sunday 28 Mar)
  "2027-06-14", // King's Birthday
  "2027-12-27", // Christmas Day observed (25 Dec is a Saturday)
  "2027-12-28", // Boxing Day observed (26 Dec is a Sunday)
];
// Anzac Day 2026 (Sat) and 2027 (Sun): ASX has no substitute day, so it is not a holiday row.

describe("make-au-calendar generator", () => {
  it("Easter Sunday for known years", () => {
    const e = (y: number) => easterSunday(y).toISOString().slice(0, 10);
    expect(e(2024)).toBe("2024-03-31");
    expect(e(2025)).toBe("2025-04-20");
    expect(e(2026)).toBe("2026-04-05");
    expect(e(2027)).toBe("2027-03-28");
    expect(e(2038)).toBe("2038-04-25");
  });

  it("2026 and 2027 holidays are exactly the expected lists", () => {
    expect(holidays(2026)).toEqual(HOLIDAYS_2026);
    expect(holidays(2027)).toEqual(HOLIDAYS_2027);
  });

  it("applies the observed-day rules in other years (New Year/Australia Day on a weekend, Anzac on a weekday, Christmas shapes)", () => {
    expect(holidays(2022)).toContain("2022-01-03"); // 1 Jan Sat -> Mon
    expect(holidays(2022)).toContain("2022-01-26");
    expect(holidays(2022)).toContain("2022-12-26"); // 25 Sun: Boxing Day Mon 26
    expect(holidays(2022)).toContain("2022-12-27"); // Christmas substitute Tue 27
    expect(holidays(2023)).toContain("2023-01-02"); // 1 Jan Sun -> Mon
    expect(holidays(2023)).toContain("2023-04-25"); // Anzac Day on a Tuesday
    expect(holidays(2023)).toContain("2023-12-25");
    expect(holidays(2023)).toContain("2023-12-26"); // Mon + Tue
    expect(holidays(2021)).toContain("2021-01-26");
    expect(holidays(2021)).toContain("2021-12-27"); // 25 Sat -> Mon 27
    expect(holidays(2021)).toContain("2021-12-28"); // 26 Sun -> Tue 28
    expect(holidays(2025)).toContain("2025-04-25"); // Fri
    expect(holidays(2024)).toContain("2024-01-26");
    expect(holidays(2027)).not.toContain("2027-04-25");
    expect(holidays(2026)).not.toContain("2026-04-25");
    // 2nd Monday of June, in a year where 1 June is a Sunday (2025) and a Monday (2026 -> 8th).
    expect(holidays(2025)).toContain("2025-06-09");
    expect(holidays(2026)).toContain("2026-06-08");
    expect(holidays(2030)).toContain("2030-06-10"); // 1 Jun 2030 is a Saturday
  });

  it("emits one row per weekday for 2026-01-01..2027-12-31 with the right kinds", () => {
    const rows = allRows();
    expect(rows).toHaveLength(522);
    expect(rows[0][0]).toBe("2026-01-01");
    expect(rows.at(-1)![0]).toBe("2027-12-31");
    expect(new Set(rows.map((r) => r[0])).size).toBe(rows.length);
    expect(rows.filter((r) => r[1] === "holiday").map((r) => r[0])).toEqual([
      ...HOLIDAYS_2026,
      ...HOLIDAYS_2027,
    ]);
    expect(rows.filter((r) => r[1] === "early_close")).toEqual([
      ["2026-12-24", "early_close", "14:10"],
      ["2026-12-31", "early_close", "14:10"],
      ["2027-12-24", "early_close", "14:10"],
      ["2027-12-31", "early_close", "14:10"],
    ]);
    for (const [d] of rows) {
      const day = new Date(`${d}T00:00:00Z`).getUTCDay();
      expect(day === 0 || day === 6, d).toBe(false);
    }
  });

  it("is deterministic and the committed migration matches it byte for byte", () => {
    expect(renderMigration()).toBe(renderMigration());
    const disk = readFileSync(MIGRATION_PATH, "utf8").replace(/\r\n/g, "\n");
    expect(disk).toBe(renderMigration());
  });

  it("marks the list as unconfirmed and to be verified", () => {
    const text = renderMigration();
    expect(text).toContain("[VERIFY]");
    expect(text).toContain("decision 11");
    expect(text).not.toMatch(/, 1, 'seed:/); // every row confirmed = 0
  });
});

describe("main migration 0005_au_calendar_seed", () => {
  it("is the fifth main migration", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[4]).toMatchObject({ version: 5, name: "au_calendar_seed" });
  });

  it("seeds 522 unconfirmed AU rows with the documented counts per year", async () => {
    const db = await freshDb("main");
    const all = await loadCalendarRows(db, "AU");
    expect(all).toHaveLength(522);
    expect(all.every((r) => r.confirmed === 0)).toBe(true);
    const src = await db.execute("SELECT DISTINCT source FROM trading_calendar");
    expect(src.rows.map((r) => r.source)).toEqual([SOURCE]);
    expect(await calendarYearSummary(db, "AU", 2026)).toEqual({
      market: "AU",
      year: 2026,
      tradingDays: 254,
      holidays: 7,
      unconfirmed: 261,
      total: 261,
    });
    expect((await calendarYearSummary(db, "AU", 2027)).tradingDays).toBe(254);
    expect((await calendarYearSummary(db, "AU", 2028)).total).toBe(0);
  });

  it("the seeded rows drive the library (holiday, early close, year end)", async () => {
    const db = await freshDb("main");
    const rows = await loadCalendarRows(db, "AU");
    expect(isTradingDay("2026-04-03", rows)).toBe(false);
    expect(isTradingDay("2026-12-24", rows)).toBe(true);
    expect(nextTradingDay("2026-12-31", rows)).toBe("2027-01-04");
    expect(sessionsBetween("2026-04-01", "2026-04-08", rows)).toEqual([
      "2026-04-01",
      "2026-04-02",
      "2026-04-07",
      "2026-04-08",
    ]);
    const early = await db.execute(
      "SELECT d, close_time FROM trading_calendar WHERE kind = 'early_close'",
    );
    expect(early.rows).toHaveLength(4);
  });

  it("re-running migrations leaves the seed exactly once", async () => {
    const db = await freshDb("main");
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(await migrateUp(db, ms)).toEqual({ applied: 0, version: 5 });
    expect(await loadCalendarRows(db, "AU")).toHaveLength(522);
  });

  it("down removes the seed and restores the delete guard; up again gives the same schema and rows", async () => {
    const db = await freshDb("main");
    const ms = await loadMigrations(MIGRATIONS("main"));
    const before = await schemaOf(db);
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 4 });
    expect(await loadCalendarRows(db, "AU")).toHaveLength(0);
    expect(await schemaOf(db)).toEqual(before); // guard trigger is back, identical definition
    // The delete guard works again after down (a row outside the seed range stays).
    await db.execute(
      "INSERT INTO trading_calendar (market, d, kind, confirmed, source) VALUES ('AU','2030-02-04','session',0,'x')",
    );
    await expect(db.execute("DELETE FROM trading_calendar")).rejects.toThrow(/forever table/);
    expect(await migrateUp(db, ms)).toEqual({ applied: 1, version: 5 });
    expect(await loadCalendarRows(db, "AU")).toHaveLength(523);
    expect(await schemaOf(db)).toEqual(before);
  });

  it("the table guard still holds on seeded rows: only confirmed 0 to 1 may change, deletes refused", async () => {
    const db = await freshDb("main");
    await expect(
      db.execute("UPDATE trading_calendar SET kind = 'holiday' WHERE d = '2026-02-02'"),
    ).rejects.toThrow(/only confirmed 0 to 1/);
    await expect(
      db.execute("UPDATE trading_calendar SET close_time = '12:00' WHERE d = '2026-02-02'"),
    ).rejects.toThrow(/only confirmed 0 to 1/);
    await expect(db.execute("DELETE FROM trading_calendar WHERE d = '2026-02-02'")).rejects.toThrow(
      /forever table/,
    );
    await db.execute("UPDATE trading_calendar SET confirmed = 1 WHERE d = '2026-02-02'");
    await expect(
      db.execute("UPDATE trading_calendar SET confirmed = 0 WHERE d = '2026-02-02'"),
    ).rejects.toThrow(/only confirmed 0 to 1/);
  });
});
