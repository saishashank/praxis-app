// @vitest-environment node
// DAT-160, D-057 #11: the trading calendar status line in the System Health summary.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getHealthSummary } from "@/lib/health/summary";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

// 2026-12-31T20:00Z is already 2027-01-01 in Sydney, so the "current year" is 2027.
const OCT = new Date("2026-10-11T01:00:00.000Z");
const NEW_YEAR = new Date("2026-12-31T20:00:00.000Z");

describe("health summary: AU trading calendar", () => {
  it("shows the current and next seeded year to every role, unconfirmed", async () => {
    for (const role of ["owner", "editor", "viewer"] as const) {
      const s = await getHealthSummary(db, OCT, role);
      expect(s.calendar).toEqual([
        { market: "AU", year: 2026, tradingDays: 254, holidays: 7, unconfirmed: 261, total: 261 },
        { market: "AU", year: 2027, tradingDays: 254, holidays: 7, unconfirmed: 261, total: 261 },
      ]);
    }
  });

  it("uses the Sydney year, not the UTC year", async () => {
    const s = await getHealthSummary(db, NEW_YEAR, "viewer");
    expect(s.calendar?.map((c) => c.year)).toEqual([2027]); // 2028 has no rows
  });

  it("reflects a confirmation", async () => {
    await db.execute("UPDATE trading_calendar SET confirmed = 1 WHERE d LIKE '2026-%'");
    const s = await getHealthSummary(db, OCT, "viewer");
    expect(s.calendar?.[0]).toMatchObject({ year: 2026, unconfirmed: 0 });
    expect(s.calendar?.[1]).toMatchObject({ year: 2027, unconfirmed: 261 });
  });

  it("is an empty list when no calendar rows exist and null when the table cannot be read", async () => {
    await db.execute("DROP TRIGGER trading_calendar_no_delete");
    await db.execute("DELETE FROM trading_calendar");
    expect((await getHealthSummary(db, OCT, "viewer")).calendar).toEqual([]);
    await db.execute("DROP TABLE trading_calendar");
    const s = await getHealthSummary(db, OCT, "viewer");
    expect(s.calendar).toBeNull();
    expect(s.jobs.length).toBeGreaterThan(0); // calendar trouble never hides job status
  });
});
