// @vitest-environment node
// M20 A3 (D-1097, D-1140, OPS-103, AT-M2): the NSE calendar rule module. Known answers for 2025 to 2027, hand-checked
// against the exchange's published 2026 list (the A3 verification pass) and, for 2025, the exchange circular.
import { describe, expect, it } from "vitest";
import { CALENDAR_RULE_MODULES } from "@/lib/data/calendarRules.mjs";
import {
  HOLIDAY_LISTS,
  SPECIAL_SESSIONS,
  fixedDateHolidays,
  holidays,
  sourceOf,
  yearRows,
} from "@/lib/data/calendarRules/in.mjs";

const HOLIDAYS_2025 = [
  "2025-02-26", // Mahashivratri (Wed)
  "2025-03-14", // Holi (Fri)
  "2025-03-31", // Id-Ul-Fitr (Mon)
  "2025-04-10", // Mahavir Jayanti (Thu)
  "2025-04-14", // Ambedkar Jayanti (Mon)
  "2025-04-18", // Good Friday
  "2025-05-01", // Maharashtra Day (Thu)
  "2025-08-15", // Independence Day (Fri)
  "2025-08-27", // Ganesh Chaturthi (Wed)
  "2025-10-02", // Gandhi Jayanti and Dussehra (Thu)
  "2025-10-21", // Diwali Laxmi Pujan (Tue), Muhurat session in the afternoon
  "2025-10-22", // Diwali-Balipratipada (Wed)
  "2025-11-05", // Guru Nanak (Wed)
  "2025-12-25", // Christmas (Thu)
];
const HOLIDAYS_2026 = [
  "2026-01-15", // Municipal Corporation Election, Maharashtra (Thu)
  "2026-01-26", // Republic Day (Mon)
  "2026-03-03", // Holi (Tue)
  "2026-03-26", // Ram Navami (Thu)
  "2026-03-31", // Mahavir Jayanti (Tue)
  "2026-04-03", // Good Friday
  "2026-04-14", // Ambedkar Jayanti (Tue)
  "2026-05-01", // Maharashtra Day (Fri)
  "2026-05-28", // Bakri Id (Thu)
  "2026-06-26", // Muharram (Fri)
  "2026-09-14", // Ganesh Chaturthi (Mon)
  "2026-10-02", // Gandhi Jayanti (Fri)
  "2026-10-20", // Dussehra (Tue)
  "2026-11-10", // Diwali-Balipratipada (Tue)
  "2026-11-24", // Guru Nanak (Tue)
  "2026-12-25", // Christmas (Fri)
];
// 2026 weekend holidays carry no row: Mahashivratri (Sun 15 Feb), Id-Ul-Fitr (Sat 21 Mar), Independence Day (Sat 15 Aug),
// Diwali Laxmi Pujan (Sun 8 Nov, the Muhurat session is on a Sunday).

describe("NSE calendar rules (D-1097)", () => {
  it("2025: the 14 listed holidays on weekdays", () => {
    expect(holidays(2025)).toEqual(HOLIDAYS_2025);
  });

  it("2026: the 16 weekday holidays of the exchange list, weekend ones dropped", () => {
    expect(holidays(2026)).toEqual(HOLIDAYS_2026);
    expect(HOLIDAY_LISTS[2026]).toHaveLength(20);
    for (const d of ["2026-02-15", "2026-03-21", "2026-08-15", "2026-11-08"]) {
      expect(holidays(2026)).not.toContain(d);
    }
  });

  it("2027: only the fixed-date subset (26 Jan, Good Friday, 14 Apr; 1 May, 15 Aug, 2 Oct, 25 Dec fall on a weekend)", () => {
    expect(holidays(2027)).toEqual(["2027-01-26", "2027-03-26", "2027-04-14"]);
    expect(fixedDateHolidays(2027).map(([d]) => d)).toEqual([
      "2027-01-26",
      "2027-04-14",
      "2027-05-01",
      "2027-08-15",
      "2027-10-02",
      "2027-12-25",
      "2027-03-26",
    ]);
  });

  it("year rows: one row per weekday, holidays as holiday rows, no weekend row", () => {
    for (const year of [2025, 2026, 2027]) {
      const rows = yearRows(year);
      expect(rows).toHaveLength(261);
      const weekend = rows.some(([d]) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()));
      expect(weekend).toBe(false);
    }
    const r2026 = yearRows(2026);
    expect(r2026.filter((r) => r[1] === "holiday").map((r) => r[0])).toEqual(HOLIDAYS_2026);
    expect(r2026.filter((r) => r[1] === "session")).toHaveLength(245);
    expect(r2026.find((r) => r[0] === "2026-01-26")).toEqual(["2026-01-26", "holiday", null]);
    expect(r2026.find((r) => r[0] === "2026-01-27")).toEqual(["2026-01-27", "session", null]);
  });

  it("the Diwali Muhurat session (2025-10-21, 13:45 to 14:45) is an early close; the 2026 one is on a Sunday and has no row (D-1140)", () => {
    expect(SPECIAL_SESSIONS["2025-10-21"]).toMatchObject({ from: "13:45", to: "14:45" });
    const row = yearRows(2025).find((r) => r[0] === "2025-10-21");
    expect(row).toEqual(["2025-10-21", "early_close", "14:45"]);
    expect(yearRows(2025).filter((r) => r[1] === "holiday")).toHaveLength(13);
    expect(yearRows(2026).some((r) => r[0] === "2026-11-08")).toBe(false);
  });

  it("the source of a year: the published lists name their year, any other year is a pending draft (D-1097)", () => {
    expect(sourceOf(2025)).toBe("nse-holiday-list-2025");
    expect(sourceOf(2026)).toBe("nse-holiday-list-2026");
    expect(sourceOf(2027)).toBe("nse-holiday-list-2027-pending");
  });

  it("is registered in CALENDAR_RULE_MODULES with the per-year source", () => {
    const m = CALENDAR_RULE_MODULES["IN"];
    expect(m.source).toBe("nse-holiday-list-v1");
    expect(m.sourceOf?.(2027)).toBe("nse-holiday-list-2027-pending");
    expect(m.yearRows(2026)).toEqual(yearRows(2026));
  });
});
