import { describe, expect, it } from "vitest";
import { hhmm, isSydneyDst, isWeekend, sydneyLocal } from "../src/localtime";

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
