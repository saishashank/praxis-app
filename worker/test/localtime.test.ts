import { describe, expect, it } from "vitest";
import {
  hhmm,
  isHomeRule,
  isSydneyDst,
  isUsEasternDst,
  isWeekend,
  localFor,
  sydneyLocal,
  zoneSupported,
} from "../src/localtime";

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Sydney",
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function viaIntl(ms: number) {
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minute: +p.hour * 60 + +p.minute,
    dow: new Date(wall).getUTCDay(),
  };
}
const mine = (ms: number) => {
  const { date, minute, dow } = sydneyLocal(ms);
  return { date, minute, dow };
};

function firstSunday(y: number, month0: number): number {
  const dow = new Date(Date.UTC(y, month0, 1)).getUTCDay();
  return 1 + ((7 - dow) % 7);
}
// Both transitions happen at 16:00 UTC on the Saturday before the first Sunday.
const aprilEnd = (y: number) => Date.UTC(y, 3, firstSunday(y, 3) - 1, 16);
const octStart = (y: number) => Date.UTC(y, 9, firstSunday(y, 9) - 1, 16);

describe("Sydney local time (TST-103, PLT-019, D-059)", () => {
  it("first Sundays are the known dates", () => {
    expect(firstSunday(2026, 9)).toBe(4);
    expect(firstSunday(2026, 3)).toBe(5);
    expect(firstSunday(2027, 3)).toBe(4);
    expect(firstSunday(2027, 9)).toBe(3);
  });

  it("literal instants: spring forward and fall back", () => {
    // 2026-10-04 02:00 AEST -> 03:00 AEDT at 2026-10-03 16:00 UTC.
    expect(sydneyLocal(Date.UTC(2026, 9, 3, 15, 59))).toMatchObject({
      date: "2026-10-04",
      minute: 119,
      dst: false,
    });
    expect(sydneyLocal(Date.UTC(2026, 9, 3, 16, 0))).toMatchObject({
      date: "2026-10-04",
      minute: 180,
      dst: true,
    });
    // 2026-04-05 03:00 AEDT -> 02:00 AEST at 2026-04-04 16:00 UTC (02:00..02:59 happens twice).
    expect(sydneyLocal(Date.UTC(2026, 3, 4, 15, 59))).toMatchObject({
      date: "2026-04-05",
      minute: 179,
      dst: true,
    });
    expect(sydneyLocal(Date.UTC(2026, 3, 4, 16, 0))).toMatchObject({
      date: "2026-04-05",
      minute: 120,
      dst: false,
    });
  });

  it("matches Intl every minute within 6 h of every 2025..2030 transition", () => {
    for (let y = 2025; y <= 2030; y++) {
      for (const t of [aprilEnd(y), octStart(y)]) {
        for (let m = -360; m <= 360; m++) {
          const ms = t + m * 60_000;
          expect(mine(ms), new Date(ms).toISOString()).toEqual(viaIntl(ms));
        }
      }
    }
  });

  it("matches Intl every 30 minutes within 3 days of every transition", () => {
    for (let y = 2025; y <= 2030; y++) {
      for (const t of [aprilEnd(y), octStart(y)]) {
        for (let m = -4320; m <= 4320; m += 30) {
          const ms = t + m * 60_000;
          expect(mine(ms)).toEqual(viaIntl(ms));
        }
      }
    }
  });

  it("matches Intl every hour from 2025 through 2030, including year boundaries", () => {
    for (let ms = Date.UTC(2024, 11, 31); ms < Date.UTC(2031, 0, 2); ms += 3_600_000) {
      const a = mine(ms);
      const b = viaIntl(ms);
      if (a.date !== b.date || a.minute !== b.minute || a.dow !== b.dow) {
        throw new Error(`${new Date(ms).toISOString()} ${JSON.stringify(a)} ${JSON.stringify(b)}`);
      }
    }
  });

  it("isSydneyDst flips exactly at the transition instants", () => {
    for (let y = 2025; y <= 2030; y++) {
      expect(isSydneyDst(octStart(y) - 1)).toBe(false);
      expect(isSydneyDst(octStart(y))).toBe(true);
      expect(isSydneyDst(aprilEnd(y) - 1)).toBe(true);
      expect(isSydneyDst(aprilEnd(y))).toBe(false);
    }
  });

  it("weekend and time parsing", () => {
    expect(isWeekend(sydneyLocal(Date.UTC(2026, 5, 13, 12)))).toBe(true); // Sat 22:00 local
    expect(isWeekend(sydneyLocal(Date.UTC(2026, 5, 15, 12)))).toBe(false);
    expect(hhmm("23:59")).toBe(1439);
    expect(() => hhmm("24:00")).toThrow(RangeError);
    expect(() => hhmm("7:00")).toThrow(RangeError);
  });
});

// ---- M20 A2 (D-1117, TST-103): Kolkata and New York against Intl -----------------------------------------------

const fmtOf = (timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
function intlLocal(f: Intl.DateTimeFormat, ms: number) {
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minute: +p.hour * 60 + +p.minute,
    dow: new Date(wall).getUTCDay(),
  };
}
const plain = (l: { date: string; minute: number; dow: number }) => ({
  date: l.date,
  minute: l.minute,
  dow: l.dow,
});

const nyFmt = fmtOf("America/New_York");
const inFmt = fmtOf("Asia/Kolkata");
// US Eastern: DST starts on the second Sunday of March at 02:00 EST (07:00 UTC) and ends on the first Sunday of
// November at 02:00 EDT (06:00 UTC).
const marchStart = (y: number) => Date.UTC(y, 2, firstSunday(y, 2) + 7, 7);
const novEnd = (y: number) => Date.UTC(y, 10, firstSunday(y, 10), 6);

describe("New York local time (TST-103, D-1117)", () => {
  it("the second Sunday of March and the first Sunday of November are the known dates", () => {
    expect(marchStart(2026)).toBe(Date.UTC(2026, 2, 8, 7)); // 2026-03-08
    expect(novEnd(2026)).toBe(Date.UTC(2026, 10, 1, 6)); // 2026-11-01
    expect(marchStart(2027)).toBe(Date.UTC(2027, 2, 14, 7));
    expect(novEnd(2027)).toBe(Date.UTC(2027, 10, 7, 6));
  });

  it("literal instants: spring forward and fall back", () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT at 07:00 UTC
    expect(localFor("America/New_York", Date.UTC(2026, 2, 8, 6, 59))).toMatchObject({
      date: "2026-03-08",
      minute: 119,
      dst: false,
    });
    expect(localFor("America/New_York", Date.UTC(2026, 2, 8, 7, 0))).toMatchObject({
      date: "2026-03-08",
      minute: 180,
      dst: true,
    });
    // 2026-11-01 02:00 EDT -> 01:00 EST at 06:00 UTC (01:00..01:59 happens twice)
    expect(localFor("America/New_York", Date.UTC(2026, 10, 1, 5, 59))).toMatchObject({
      date: "2026-11-01",
      minute: 119,
      dst: true,
    });
    expect(localFor("America/New_York", Date.UTC(2026, 10, 1, 6, 0))).toMatchObject({
      date: "2026-11-01",
      minute: 60,
      dst: false,
    });
  });

  it("matches Intl every minute within 6 h of every 2025..2030 transition", () => {
    for (let y = 2025; y <= 2030; y++) {
      for (const t of [marchStart(y), novEnd(y)]) {
        for (let m = -360; m <= 360; m++) {
          const ms = t + m * 60_000;
          expect(plain(localFor("America/New_York", ms)), new Date(ms).toISOString()).toEqual(
            intlLocal(nyFmt, ms),
          );
        }
      }
    }
  });

  it("matches Intl every 30 minutes within 3 days of every transition", () => {
    for (let y = 2025; y <= 2030; y++) {
      for (const t of [marchStart(y), novEnd(y)]) {
        for (let m = -4320; m <= 4320; m += 30) {
          const ms = t + m * 60_000;
          expect(plain(localFor("America/New_York", ms))).toEqual(intlLocal(nyFmt, ms));
        }
      }
    }
  });

  it("matches Intl every hour from 2025 through 2030, including year boundaries", () => {
    for (let ms = Date.UTC(2024, 11, 31); ms < Date.UTC(2031, 0, 2); ms += 3_600_000) {
      const a = plain(localFor("America/New_York", ms));
      const b = intlLocal(nyFmt, ms);
      if (a.date !== b.date || a.minute !== b.minute || a.dow !== b.dow) {
        throw new Error(`${new Date(ms).toISOString()} ${JSON.stringify(a)} ${JSON.stringify(b)}`);
      }
    }
  });

  it("isUsEasternDst flips exactly at the transition instants", () => {
    for (let y = 2025; y <= 2030; y++) {
      expect(isUsEasternDst(marchStart(y) - 1)).toBe(false);
      expect(isUsEasternDst(marchStart(y))).toBe(true);
      expect(isUsEasternDst(novEnd(y) - 1)).toBe(true);
      expect(isUsEasternDst(novEnd(y))).toBe(false);
    }
  });

  it("the US close in Sydney is the next calendar day (why a slot carries its own zone)", () => {
    // Monday 2026-06-15 17:00 EDT = 21:00 UTC = Tuesday 07:00 AEST
    const ms = Date.UTC(2026, 5, 15, 21, 0);
    expect(localFor("America/New_York", ms)).toMatchObject({ date: "2026-06-15", minute: 1020 });
    expect(sydneyLocal(ms)).toMatchObject({ date: "2026-06-16", minute: 420 });
  });
});

describe("Kolkata local time (TST-103, D-1117)", () => {
  it("is UTC+5:30 all year, with no daylight time", () => {
    expect(localFor("Asia/Kolkata", Date.UTC(2026, 0, 1, 0, 0))).toMatchObject({
      date: "2026-01-01",
      minute: 330,
      dst: false,
    });
    expect(localFor("Asia/Kolkata", Date.UTC(2026, 6, 1, 18, 30))).toMatchObject({
      date: "2026-07-02",
      minute: 0,
      dst: false,
    });
  });

  it("matches Intl every 30 minutes from 2025 through 2030, and every minute across the four transitions of a year", () => {
    for (let ms = Date.UTC(2024, 11, 31); ms < Date.UTC(2031, 0, 2); ms += 30 * 60_000) {
      const a = plain(localFor("Asia/Kolkata", ms));
      const b = intlLocal(inFmt, ms);
      if (a.date !== b.date || a.minute !== b.minute || a.dow !== b.dow) {
        throw new Error(`${new Date(ms).toISOString()} ${JSON.stringify(a)} ${JSON.stringify(b)}`);
      }
    }
    for (let y = 2025; y <= 2030; y++) {
      for (const t of [aprilEnd(y), octStart(y), marchStart(y), novEnd(y)]) {
        for (let m = -120; m <= 120; m++) {
          const ms = t + m * 60_000;
          expect(plain(localFor("Asia/Kolkata", ms))).toEqual(intlLocal(inFmt, ms));
        }
      }
    }
  });
});

describe("zones and rules (D-1004, D-1117)", () => {
  it("supported zones are exactly those of ZONE_RULES; any other throws unsupported zone", () => {
    for (const tz of [
      "Australia/Sydney",
      "Australia/Melbourne",
      "Asia/Kolkata",
      "America/New_York",
    ]) {
      expect(zoneSupported(tz), tz).toBe(true);
      expect(() => localFor(tz, 0)).not.toThrow();
    }
    expect(zoneSupported("Asia/Tokyo")).toBe(false);
    expect(() => localFor("Asia/Tokyo", 0)).toThrow("unsupported zone");
    expect(isHomeRule("Australia/Sydney")).toBe(true);
    expect(isHomeRule("Australia/Melbourne")).toBe(true);
    expect(isHomeRule("Asia/Kolkata")).toBe(false);
    expect(isHomeRule("America/New_York")).toBe(false);
  });
});
