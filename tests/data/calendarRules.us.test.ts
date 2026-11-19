// @vitest-environment node
// M20 A3 (D-1097, OPS-103, AT-M2): the NYSE calendar rule module. Known answers for 2025 to 2028, hand-checked against
// the exchange's published holiday and early-close list for 2026 to 2028 (the A3 verification pass).
import { describe, expect, it } from "vitest";
import { CALENDAR_RULE_MODULES } from "@/lib/data/calendarRules.mjs";
import { EARLY_CLOSE_TIME, earlyCloses, holidays, yearRows } from "@/lib/data/calendarRules/us.mjs";

describe("NYSE calendar rules (D-1097)", () => {
  it("2025: ten rule holidays plus the 9 January day of mourning", () => {
    expect(holidays(2025)).toEqual([
      "2025-01-01",
      "2025-01-09", // National Day of Mourning (President Carter), a one-off closure
      "2025-01-20", // Martin Luther King Jr. Day
      "2025-02-17", // Washington Birthday
      "2025-04-18", // Good Friday
      "2025-05-26", // Memorial Day
      "2025-06-19", // Juneteenth (Thu)
      "2025-07-04", // Independence Day (Fri)
      "2025-09-01", // Labor Day
      "2025-11-27", // Thanksgiving
      "2025-12-25",
    ]);
    expect(earlyCloses(2025)).toEqual(["2025-07-03", "2025-11-28", "2025-12-24"]);
  });

  it("2026: Independence Day is observed on Friday 3 July, the only early closes are the day after Thanksgiving and 24 December", () => {
    expect(holidays(2026)).toEqual([
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-04-03", // Good Friday
      "2026-05-25",
      "2026-06-19", // Juneteenth (Fri)
      "2026-07-03", // 4 July is a Saturday
      "2026-09-07",
      "2026-11-26",
      "2026-12-25",
    ]);
    expect(earlyCloses(2026)).toEqual(["2026-11-27", "2026-12-24"]);
  });

  it("2027: Juneteenth observed Friday 18 June, Independence Day Monday 5 July, Christmas Friday 24 December; 24 December is a holiday, not an early close", () => {
    expect(holidays(2027)).toEqual([
      "2027-01-01",
      "2027-01-18",
      "2027-02-15",
      "2027-03-26", // Good Friday
      "2027-05-31",
      "2027-06-18",
      "2027-07-05",
      "2027-09-06",
      "2027-11-25",
      "2027-12-24",
    ]);
    expect(earlyCloses(2027)).toEqual(["2027-11-26"]);
  });

  it("2028: a Saturday New Year Day has no observed day, 3 July and the day after Thanksgiving close early", () => {
    expect(holidays(2028)).not.toContain("2027-12-31");
    expect(holidays(2028)).not.toContain("2028-01-01");
    expect(holidays(2028)[0]).toBe("2028-01-17");
    expect(earlyCloses(2028)).toEqual(["2028-07-03", "2028-11-24"]);
    expect(holidays(2027)).not.toContain("2027-12-31"); // 31 Dec 2027 is an ordinary session
  });

  it("year rows: weekdays only, holidays and 13:00 early closes marked", () => {
    for (const year of [2025, 2026, 2027]) expect(yearRows(year)).toHaveLength(261);
    const r = yearRows(2026);
    expect(r.filter((x) => x[1] === "holiday")).toHaveLength(10);
    expect(r.filter((x) => x[1] === "early_close")).toEqual([
      ["2026-11-27", "early_close", EARLY_CLOSE_TIME],
      ["2026-12-24", "early_close", EARLY_CLOSE_TIME],
    ]);
    expect(EARLY_CLOSE_TIME).toBe("13:00");
    expect(r.find((x) => x[0] === "2026-07-02")).toEqual(["2026-07-02", "session", null]);
    expect(yearRows(2027).find((x) => x[0] === "2027-12-24")).toEqual([
      "2027-12-24",
      "holiday",
      null,
    ]);
  });

  it("Juneteenth is a holiday from 2022 only", () => {
    expect(holidays(2021)).not.toContain("2021-06-18");
    expect(holidays(2022)).toContain("2022-06-20"); // 19 June 2022 is a Sunday
  });

  it("is registered in CALENDAR_RULE_MODULES", () => {
    const m = CALENDAR_RULE_MODULES["US"];
    expect(m.source).toBe("nyse-rules-v1");
    expect(m.yearRows(2026)).toEqual(yearRows(2026));
  });
});
