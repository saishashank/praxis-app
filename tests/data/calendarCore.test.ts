// @vitest-environment node
// V1-S3 / D-711: the one canonical trading-day definition (calendarCore.mjs), the fail-safe gates, the
// seed's coverage (so "a missing row is not a trading day" cannot hide a real session) and the
// horizon alarm.
import { afterEach, describe, expect, it } from "vitest";
import {
  addDays,
  calendarDayStatus,
  gateDayStatus,
  isTradingDay,
  type CalendarRow,
} from "@/lib/data/calendar";
import {
  CALENDAR_HORIZON_ALARM_DAYS,
  dayStatus,
  dayStatusRows,
  horizonAlarm,
  horizonDaysLeft,
  isTradingDayKind,
  isTradingDayRows,
  isWalkDay,
  isWeekendDate,
} from "@/lib/data/calendarCore.mjs";
import { isTradingDay as rulesIsTradingDay } from "@/lib/data/pipeline/rules.mjs";
import { planDates } from "@/lib/data/pipeline/rules.mjs";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const row = (d: string, kind: CalendarRow["kind"]): CalendarRow => ({
  d,
  kind,
  close_time: kind === "early_close" ? "14:10" : null,
  confirmed: 1,
});

describe("dayStatus", () => {
  it("a weekday is open only with a session or early_close row", () => {
    expect(dayStatus("2026-11-02", "session")).toBe("open"); // Monday
    expect(dayStatus("2026-12-24", "early_close")).toBe("open");
    expect(dayStatus("2026-12-25", "holiday")).toBe("closed");
  });

  it("a weekday with NO row is missing (fail safe), a weekend is closed with or without one", () => {
    expect(dayStatus("2026-11-02", null)).toBe("missing");
    expect(dayStatus("2026-11-02", undefined)).toBe("missing");
    expect(dayStatus("2026-11-01", null)).toBe("closed"); // Sunday: no row is normal
    expect(dayStatus("2026-11-01", "session")).toBe("closed");
    expect(isTradingDayKind("2026-11-02", null)).toBe(false);
    expect(isTradingDayKind("2026-11-02", "session")).toBe(true);
  });

  it("rows form agrees with the kind form", () => {
    const rows = [row("2026-11-02", "session"), row("2026-11-03", "holiday")];
    expect(dayStatusRows("2026-11-02", rows)).toBe("open");
    expect(dayStatusRows("2026-11-03", rows)).toBe("closed");
    expect(dayStatusRows("2026-11-04", rows)).toBe("missing");
    expect(isTradingDayRows("2026-11-04", rows)).toBe(false);
    expect(calendarDayStatus("2026-11-04", rows)).toBe("missing");
    expect(rulesIsTradingDay("2026-11-04", rows)).toBe(false); // the Actions CLI copy agrees
  });

  it("rejects an impossible date", () => {
    expect(() => isWeekendDate("2026-02-30")).toThrow(RangeError);
    expect(() => dayStatus("nope", null)).toThrow(RangeError);
  });
});

describe("the looser forms (arithmetic and replay) are explicit and bounded", () => {
  it("isTradingDay and isWalkDay stay 'weekday and not a holiday row' (replay goldens)", () => {
    const rows = [row("2026-11-03", "holiday")];
    expect(isTradingDay("2026-11-04", rows)).toBe(true);
    expect(isWalkDay("2026-11-04", rows)).toBe(true);
    expect(isTradingDay("2026-11-03", rows)).toBe(false);
    expect(isTradingDay("2026-11-01", rows)).toBe(false);
  });

  it("gateDayStatus is strict only when the live caller asks, otherwise the looser walk", () => {
    const rows = [row("2026-11-03", "holiday")];
    expect(gateDayStatus("2026-11-04", rows, true)).toBe("missing");
    expect(gateDayStatus("2026-11-04", rows, undefined)).toBe("open");
    expect(gateDayStatus("2026-11-04", rows, false)).toBe("open");
    expect(gateDayStatus("2026-11-03", rows, true)).toBe("closed");
    expect(gateDayStatus("2026-11-03", rows, undefined)).toBe("closed");
    expect(gateDayStatus("2026-11-07", rows, true)).toBe("closed"); // Saturday
  });
});

describe("batch 1 plan", () => {
  const rows = [row("2026-11-02", "session")];
  it("a target weekday with no calendar row is not planned and no non-trading marker is implied", () => {
    const p = planDates({
      target: "2026-11-04",
      markers: new Set(),
      firstMarker: null,
      rows,
      strictCalendar: true,
    });
    expect(p.dates).toEqual([]);
    expect(p.calendarMissing).toBe(true);
  });

  it("a target with a row is planned as before", () => {
    const p = planDates({
      target: "2026-11-02",
      markers: new Set(),
      firstMarker: null,
      rows,
      strictCalendar: true,
    });
    expect(p.dates).toEqual([{ d: "2026-11-02", trading: true }]);
    expect(p.calendarMissing).toBe(false);
  });

  it("without strictCalendar (unit tests, replays) a weekday with no row is still planned", () => {
    const p = planDates({ target: "2026-11-04", markers: new Set(), firstMarker: null, rows });
    expect(p.dates).toEqual([{ d: "2026-11-04", trading: true }]);
    expect(p.calendarMissing).toBe(false);
  });

  it("a holiday target still gets its non-trading marker", () => {
    const p = planDates({
      target: "2026-11-03",
      markers: new Set(),
      firstMarker: null,
      rows: [row("2026-11-03", "holiday")],
      strictCalendar: true,
    });
    expect(p.dates).toEqual([{ d: "2026-11-03", trading: false }]);
    expect(p.calendarMissing).toBe(false);
  });
});

describe("horizon alarm", () => {
  it("fires when the calendar ends within 60 days, is past, or has no rows", () => {
    expect(CALENDAR_HORIZON_ALARM_DAYS).toBe(60);
    expect(horizonDaysLeft("2027-12-31", "2027-11-01")).toBe(60);
    expect(horizonAlarm("2027-12-31", "2027-11-01")).toBe(false); // exactly 60 days left
    expect(horizonAlarm("2027-12-31", "2027-11-02")).toBe(true);
    expect(horizonAlarm("2027-12-31", "2028-01-03")).toBe(true);
    expect(horizonAlarm(null, "2026-11-01")).toBe(true);
    expect(horizonAlarm("2027-12-31", "2026-11-01")).toBe(false); // today: 14 months left
  });
});

describe("the seed covers every weekday (so a missing row is a real gap, never a session)", () => {
  it("every weekday 2019-01-01..2027-12-31 has a row in the migrated calendar; nothing after", async () => {
    const db = await freshDb("main");
    const r = await db.execute("SELECT d FROM trading_calendar WHERE market = 'AU'");
    const have = new Set(r.rows.map((x) => String(x.d)));
    const gaps: string[] = [];
    for (let d = "2019-01-01"; d <= "2027-12-31"; d = addDays(d, 1)) {
      if (!isWeekendDate(d) && !have.has(d)) gaps.push(d);
    }
    expect(gaps).toEqual([]);
    expect(Math.max(...[...have].map((d) => Date.parse(d)))).toBe(Date.parse("2027-12-31"));
  });
});
