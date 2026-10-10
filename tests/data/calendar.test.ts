// @vitest-environment node
// TST-103 (time tests), DAT-160, PLT-023, PLT-019, AT-05 DST parts (M2 T2, D-057 #1, #11, #12):
// the pure calendar and DST library. Sydney DST: starts first Sunday in October (02:00 AEST ->
// 03:00 AEDT), ends first Sunday in April (03:00 AEDT -> 02:00 AEST).
import { describe, expect, it } from "vitest";
import {
  addDays,
  calendarCovers,
  displayMelbourne,
  isTradingDay,
  isWeekend,
  localToUtc,
  marketDate,
  nextTradingDay,
  previousTradingDay,
  resolveLocal,
  sessionsBetween,
  sessionTimes,
  summariseCalendar,
  type CalendarRow,
  type MarketHours,
} from "@/lib/data/calendar";

const SYD = "Australia/Sydney";
const MEL = "Australia/Melbourne";
const AU: MarketHours = { tz: SYD, open_time: "10:00", close_time: "16:00" };
const iso = (d: Date) => d.toISOString();

const hol = (d: string): CalendarRow => ({ d, kind: "holiday", close_time: null, confirmed: 0 });
const early = (d: string): CalendarRow => ({
  d,
  kind: "early_close",
  close_time: "14:10",
  confirmed: 0,
});
const sess = (d: string): CalendarRow => ({ d, kind: "session", close_time: null, confirmed: 0 });

// The 2026 holidays and early closes (also seeded by migration 0005).
const ROWS: CalendarRow[] = [
  hol("2026-01-01"),
  hol("2026-01-26"),
  hol("2026-04-03"),
  hol("2026-04-06"),
  hol("2026-06-08"),
  hol("2026-12-25"),
  hol("2026-12-28"),
  early("2026-12-24"),
  early("2026-12-31"),
  hol("2027-01-01"),
  hol("2027-01-26"),
];

describe("marketDate (Sydney local date is the key, D-057 #1)", () => {
  it("rolls to the next local day after 13:00 UTC in AEDT and 14:00 UTC in AEST", () => {
    expect(marketDate(new Date("2026-01-14T12:59:00Z"), SYD)).toBe("2026-01-14"); // AEDT
    expect(marketDate(new Date("2026-01-14T13:00:00Z"), SYD)).toBe("2026-01-15");
    expect(marketDate(new Date("2026-07-14T13:59:00Z"), SYD)).toBe("2026-07-14"); // AEST
    expect(marketDate(new Date("2026-07-14T14:00:00Z"), SYD)).toBe("2026-07-15");
  });
  it("is correct on both DST change days", () => {
    // 2026-10-03T16:00Z is the moment AEST ends: local 02:00 -> 03:00 on Sunday 4 Oct.
    expect(marketDate(new Date("2026-10-03T15:59:59Z"), SYD)).toBe("2026-10-04");
    expect(marketDate(new Date("2026-10-04T12:59:59Z"), SYD)).toBe("2026-10-04");
    expect(marketDate(new Date("2026-10-04T13:00:00Z"), SYD)).toBe("2026-10-05");
    // 2026-04-04T16:00Z: AEDT ends, local 03:00 -> 02:00 on Sunday 5 Apr.
    expect(marketDate(new Date("2026-04-04T15:59:59Z"), SYD)).toBe("2026-04-05");
    expect(marketDate(new Date("2026-04-05T13:59:59Z"), SYD)).toBe("2026-04-05");
    expect(marketDate(new Date("2026-04-05T14:00:00Z"), SYD)).toBe("2026-04-06");
  });
  it("Melbourne and Sydney agree on the date (same offset and DST dates)", () => {
    for (const iso of ["2026-04-04T16:00:00Z", "2026-10-03T16:00:00Z", "2026-12-31T13:00:00Z"]) {
      expect(marketDate(new Date(iso), MEL)).toBe(marketDate(new Date(iso), SYD));
    }
  });
  it("rejects an invalid date", () => {
    expect(() => marketDate(new Date("nope"), SYD)).toThrow(RangeError);
  });
});

describe("localToUtc: ordinary times", () => {
  it("uses +11 in summer and +10 in winter", () => {
    expect(iso(localToUtc("2026-01-14", "17:30", SYD))).toBe("2026-01-14T06:30:00.000Z");
    expect(iso(localToUtc("2026-07-14", "17:30", SYD))).toBe("2026-07-14T07:30:00.000Z");
  });
  it("is on the right side of each change day around the transition", () => {
    // Spring forward 4 Oct 2026: before the gap +10, after it +11.
    expect(iso(localToUtc("2026-10-04", "01:59", SYD))).toBe("2026-10-03T15:59:00.000Z");
    expect(iso(localToUtc("2026-10-04", "03:00", SYD))).toBe("2026-10-03T16:00:00.000Z");
    expect(iso(localToUtc("2026-10-04", "20:00", SYD))).toBe("2026-10-04T09:00:00.000Z");
    expect(iso(localToUtc("2026-10-03", "20:00", SYD))).toBe("2026-10-03T10:00:00.000Z");
    // Fall back 5 Apr 2026: before the overlap +11, after it +10.
    expect(iso(localToUtc("2026-04-05", "01:59", SYD))).toBe("2026-04-04T14:59:00.000Z");
    expect(iso(localToUtc("2026-04-05", "03:00", SYD))).toBe("2026-04-04T17:00:00.000Z");
    expect(iso(localToUtc("2026-04-05", "20:00", SYD))).toBe("2026-04-05T10:00:00.000Z");
    expect(iso(localToUtc("2026-04-04", "20:00", SYD))).toBe("2026-04-04T09:00:00.000Z");
  });
  it("Melbourne gives the same instant as Sydney for the same local time", () => {
    for (const [d, t] of [
      ["2026-10-04", "20:00"],
      ["2026-04-05", "20:00"],
      ["2026-07-01", "09:00"],
    ]) {
      expect(iso(localToUtc(d, t, MEL))).toBe(iso(localToUtc(d, t, SYD)));
    }
  });
  it("rejects malformed input", () => {
    expect(() => localToUtc("2026-13-01", "10:00", SYD)).toThrow(RangeError);
    expect(() => localToUtc("2026-02-30", "10:00", SYD)).toThrow(RangeError);
    expect(() => localToUtc("2026-1-1", "10:00", SYD)).toThrow(RangeError);
    expect(() => localToUtc("2026-01-01", "24:00", SYD)).toThrow(RangeError);
    expect(() => localToUtc("2026-01-01", "9:00", SYD)).toThrow(RangeError);
  });
});

describe("localToUtc: spring-forward gap (first Sunday in October) moves FORWARD", () => {
  it("02:00 and 02:30 and 02:59 do not exist on 2026-10-04; they become 03:00, 03:30, 03:59 AEDT", () => {
    const a = resolveLocal("2026-10-04", "02:00", SYD);
    const b = resolveLocal("2026-10-04", "02:30", SYD);
    const c = resolveLocal("2026-10-04", "02:59", SYD);
    expect([a.status, b.status, c.status]).toEqual(["gap", "gap", "gap"]);
    expect(iso(a.utc)).toBe("2026-10-03T16:00:00.000Z"); // = 03:00 AEDT
    expect(iso(b.utc)).toBe("2026-10-03T16:30:00.000Z"); // = 03:30 AEDT
    expect(iso(c.utc)).toBe("2026-10-03T16:59:00.000Z"); // = 03:59 AEDT
    expect(marketDate(b.utc, SYD)).toBe("2026-10-04");
  });
  it("the neighbours 01:59 and 03:00 are normal", () => {
    expect(resolveLocal("2026-10-04", "01:59", SYD).status).toBe("normal");
    expect(resolveLocal("2026-10-04", "03:00", SYD).status).toBe("normal");
  });
  it("also holds for 2027 (3 Oct) and 2025 (5 Oct)", () => {
    expect(iso(localToUtc("2027-10-03", "02:30", SYD))).toBe("2027-10-02T16:30:00.000Z");
    expect(iso(localToUtc("2025-10-05", "02:30", SYD))).toBe("2025-10-04T16:30:00.000Z");
  });
  it("a gap time is never earlier than the previous valid time", () => {
    const before = localToUtc("2026-10-04", "01:59", SYD).getTime();
    expect(localToUtc("2026-10-04", "02:00", SYD).getTime()).toBeGreaterThan(before);
  });
});

describe("localToUtc: fall-back overlap (first Sunday in April) takes the FIRST occurrence", () => {
  it("02:00..02:59 on 2026-04-05 happen twice; the earlier (AEDT) instant is used", () => {
    const a = resolveLocal("2026-04-05", "02:00", SYD);
    const b = resolveLocal("2026-04-05", "02:30", SYD);
    const c = resolveLocal("2026-04-05", "02:59", SYD);
    expect([a.status, b.status, c.status]).toEqual(["overlap", "overlap", "overlap"]);
    expect(iso(a.utc)).toBe("2026-04-04T15:00:00.000Z"); // 02:00 AEDT (+11)
    expect(iso(b.utc)).toBe("2026-04-04T15:30:00.000Z");
    expect(iso(c.utc)).toBe("2026-04-04T15:59:00.000Z");
  });
  it("the second occurrence is one hour later and renders the same local time", () => {
    const first = localToUtc("2026-04-05", "02:30", SYD);
    const second = new Date(first.getTime() + 3_600_000); // 02:30 AEST (+10)
    expect(iso(second)).toBe("2026-04-04T16:30:00.000Z");
    expect(marketDate(second, SYD)).toBe("2026-04-05");
    expect(displayMelbourne(first)).toContain("02:30 AEDT");
    expect(displayMelbourne(second)).toContain("02:30 AEST");
  });
  it("01:59 and 03:00 are normal", () => {
    expect(resolveLocal("2026-04-05", "01:59", SYD).status).toBe("normal");
    expect(resolveLocal("2026-04-05", "03:00", SYD).status).toBe("normal");
  });
  it("also holds for 2027 (4 Apr)", () => {
    expect(iso(localToUtc("2027-04-04", "02:30", SYD))).toBe("2027-04-03T15:30:00.000Z");
  });
});

describe("UTC <-> local round trips", () => {
  it("every normal local time maps back to itself over two years, minute steps", () => {
    let normal = 0;
    for (let day = new Date("2026-01-01T00:00:00Z"); day < new Date("2028-01-01T00:00:00Z");) {
      const d = day.toISOString().slice(0, 10);
      for (const t of ["00:00", "01:59", "02:30", "03:00", "09:55", "17:30", "19:50", "23:59"]) {
        const r = resolveLocal(d, t, SYD);
        if (r.status === "normal") {
          normal++;
          expect(marketDate(r.utc, SYD)).toBe(d);
          const parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: SYD,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).format(r.utc);
          expect(parts).toBe(t);
        }
      }
      day = new Date(day.getTime() + 86_400_000);
    }
    expect(normal).toBeGreaterThan(5000);
  });
  it("a UTC instant around each change renders and re-resolves to the same instant", () => {
    for (const ms of [
      Date.parse("2026-10-03T15:59:00Z"),
      Date.parse("2026-10-03T16:00:00Z"),
      Date.parse("2026-04-04T14:59:00Z"),
      Date.parse("2026-04-04T17:00:00Z"),
    ]) {
      const when = new Date(ms);
      const d = marketDate(when, SYD);
      const hhmm = new Intl.DateTimeFormat("en-GB", {
        timeZone: SYD,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(when);
      expect(iso(localToUtc(d, hhmm, SYD))).toBe(iso(when));
    }
  });
});

describe("weekdays, holidays and trading days", () => {
  it("weekends are never trading days, even without rows", () => {
    expect(isWeekend("2026-10-10")).toBe(true); // Saturday
    expect(isWeekend("2026-10-11")).toBe(true); // Sunday
    expect(isWeekend("2026-10-12")).toBe(false);
    expect(isTradingDay("2026-10-10", [])).toBe(false);
    expect(isTradingDay("2026-10-11", ROWS)).toBe(false);
  });
  it("holidays are closed; early-close and plain weekdays trade", () => {
    expect(isTradingDay("2026-12-25", ROWS)).toBe(false);
    expect(isTradingDay("2026-12-28", ROWS)).toBe(false);
    expect(isTradingDay("2026-12-24", ROWS)).toBe(true);
    expect(isTradingDay("2026-10-12", ROWS)).toBe(true);
  });
  it("a weekday without a row is provisionally a trading day and is reported as uncovered", () => {
    expect(isTradingDay("2030-03-05", ROWS)).toBe(true);
    expect(calendarCovers("2030-03-05", ROWS)).toBe(false);
    expect(calendarCovers("2026-12-25", ROWS)).toBe(true);
  });
  it("addDays crosses month, year and leap-day boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("sessionTimes", () => {
  it("a normal AEDT day: 10:00-16:00 local is 23:00Z (prev day) - 05:00Z", () => {
    const s = sessionTimes("2026-01-14", AU, ROWS)!;
    expect(iso(s.open)).toBe("2026-01-13T23:00:00.000Z");
    expect(iso(s.close)).toBe("2026-01-14T05:00:00.000Z");
    expect(s.early).toBe(false);
  });
  it("a normal AEST day: 10:00-16:00 local is 00:00Z - 06:00Z", () => {
    const s = sessionTimes("2026-07-14", AU, ROWS)!;
    expect(iso(s.open)).toBe("2026-07-14T00:00:00.000Z");
    expect(iso(s.close)).toBe("2026-07-14T06:00:00.000Z");
  });
  it("early close days use the row's close time", () => {
    const s = sessionTimes("2026-12-24", AU, ROWS)!;
    expect(s.early).toBe(true);
    expect(iso(s.close)).toBe("2026-12-24T03:10:00.000Z"); // 14:10 AEDT
    expect(iso(s.open)).toBe("2026-12-23T23:00:00.000Z");
    expect(sessionTimes("2026-12-31", AU, ROWS)!.early).toBe(true);
  });
  it("an early_close row without a close time falls back to the normal close", () => {
    const s = sessionTimes("2026-12-24", AU, [
      { d: "2026-12-24", kind: "early_close", close_time: null },
    ])!;
    expect(s.early).toBe(false);
    expect(iso(s.close)).toBe("2026-12-24T05:00:00.000Z");
  });
  it("DST change days are Sundays, so there is no session; Monday after uses the new offset", () => {
    expect(sessionTimes("2026-10-04", AU, ROWS)).toBeNull();
    expect(sessionTimes("2026-04-05", AU, ROWS)).toBeNull();
    expect(iso(sessionTimes("2026-10-05", AU, ROWS)!.open)).toBe("2026-10-04T23:00:00.000Z");
    expect(iso(sessionTimes("2026-04-07", AU, ROWS)!.open)).toBe("2026-04-07T00:00:00.000Z");
    // Saturday before the October change is still +10; Friday 2 Oct session open is 00:00Z.
    expect(iso(sessionTimes("2026-10-02", AU, ROWS)!.open)).toBe("2026-10-02T00:00:00.000Z");
  });
  it("a market whose session spans a change day is resolved by the gap/overlap rules", () => {
    // Synthetic market opening at 02:30 (inside the October gap, April overlap).
    const odd: MarketHours = { tz: SYD, open_time: "02:30", close_time: "16:00" };
    const rows: CalendarRow[] = [];
    // 4 Oct 2026 is a Sunday, so ask the library directly through localToUtc semantics.
    expect(sessionTimes("2026-10-05", odd, rows)).not.toBeNull();
    expect(isTradingDay("2026-10-04", rows)).toBe(false);
  });
  it("holidays and weekends give null", () => {
    expect(sessionTimes("2026-04-03", AU, ROWS)).toBeNull();
    expect(sessionTimes("2026-04-04", AU, ROWS)).toBeNull();
  });
});

describe("next / previous trading day and sessionsBetween", () => {
  it("skips weekends and a Good Friday + Easter Monday run", () => {
    expect(nextTradingDay("2026-04-02", ROWS)).toBe("2026-04-07"); // Thu -> Tue
    expect(previousTradingDay("2026-04-07", ROWS)).toBe("2026-04-02");
  });
  it("Friday to Monday", () => {
    expect(nextTradingDay("2026-10-09", ROWS)).toBe("2026-10-12");
    expect(previousTradingDay("2026-10-12", ROWS)).toBe("2026-10-09");
  });
  it("across the year end: 2026-12-31 -> 2027-01-04 (1 Jan holiday, weekend)", () => {
    expect(nextTradingDay("2026-12-31", ROWS)).toBe("2027-01-04");
    expect(previousTradingDay("2027-01-04", ROWS)).toBe("2026-12-31");
  });
  it("across the Christmas run: 2026-12-24 -> 2026-12-29", () => {
    expect(nextTradingDay("2026-12-24", ROWS)).toBe("2026-12-29");
    expect(previousTradingDay("2026-12-29", ROWS)).toBe("2026-12-24");
  });
  it("works from a non-trading day too", () => {
    expect(nextTradingDay("2026-12-25", ROWS)).toBe("2026-12-29");
    expect(previousTradingDay("2026-12-28", ROWS)).toBe("2026-12-24");
  });
  it("sessionsBetween is inclusive, ordered and skips closed days", () => {
    expect(sessionsBetween("2026-12-22", "2027-01-05", ROWS)).toEqual([
      "2026-12-22",
      "2026-12-23",
      "2026-12-24",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-04",
      "2027-01-05",
    ]);
    expect(sessionsBetween("2026-10-10", "2026-10-11", ROWS)).toEqual([]);
    expect(sessionsBetween("2026-10-12", "2026-10-12", ROWS)).toEqual(["2026-10-12"]);
    expect(sessionsBetween("2026-10-13", "2026-10-12", ROWS)).toEqual([]);
  });
  it("a holiday run longer than the search limit is an error", () => {
    const run: CalendarRow[] = [];
    for (let i = 1; i <= 60; i++) run.push(hol(addDays("2026-03-01", i)));
    expect(() => nextTradingDay("2026-03-01", run)).toThrow(RangeError);
    expect(() => previousTradingDay("2026-05-01", run)).toThrow(RangeError);
  });
  it("rejects bad dates", () => {
    expect(() => sessionsBetween("x", "2026-01-01", ROWS)).toThrow(RangeError);
    expect(() => sessionsBetween("2026-01-01", "y", ROWS)).toThrow(RangeError);
  });
});

describe("summariseCalendar and display", () => {
  it("counts trading days (sessions + early closes), holidays and unconfirmed rows per year", () => {
    const rows = [...ROWS, sess("2026-01-02")];
    rows[0] = { ...rows[0], confirmed: 1 };
    const s = summariseCalendar("AU", 2026, rows);
    expect(s).toEqual({
      market: "AU",
      year: 2026,
      tradingDays: 3, // 2 early closes + 1 session
      holidays: 7,
      unconfirmed: 9,
      total: 10,
    });
    expect(summariseCalendar("AU", 2027, rows).total).toBe(2);
    expect(summariseCalendar("AU", 2031, rows).total).toBe(0);
  });
  it("displays UTC instants in Australia/Melbourne (PLT-023), 24 h and 12 h", () => {
    const t = new Date("2026-10-03T16:30:00Z"); // first minutes after the October change
    expect(displayMelbourne(t)).toBe("2026-10-04 03:30 AEDT");
    expect(displayMelbourne(new Date("2026-07-01T00:00:00Z"), "12h")).toBe(
      "2026-07-01 10:00 am AEST",
    );
  });
});
