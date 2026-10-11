// @vitest-environment node
// Batch 1 pure rules (M2 T6): the .mjs mirrors of calendar.ts and yahoo.ts must agree with the TS
// originals; catch-up planning; re-fetch compare; hash; throttle bounds; month bounds.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isTradingDay as tsIsTradingDay,
  marketDate,
  previousTradingDay as tsPrevious,
  sessionsBetween,
  type CalendarRow,
} from "@/lib/data/calendar";
import { parseYahooBars, rejectSummary as tsRejectSummary } from "@/lib/data/sources/yahoo";
import {
  addDays,
  BarsFormatError,
  compareBar,
  isRealDate,
  isTradingDay,
  monthBoundsUtc,
  parseBars,
  parseBarsText,
  planDates,
  previousTradingDay,
  refetchHash,
  rejectSummary,
  sydneyDate,
  throttleFrom,
  tradingDaysBetween,
  validateBar,
} from "@/lib/data/pipeline/rules.mjs";
import { cleanupTempDbs, freshDb, ROOT } from "../db/helpers";
import { bar, barsFor } from "./helpers";

afterEach(cleanupTempDbs);

async function seedRows(): Promise<CalendarRow[]> {
  const db = await freshDb("main");
  const r = await db.execute("SELECT d, kind, close_time FROM trading_calendar WHERE market='AU'");
  return r.rows.map((x) => ({
    d: String(x.d),
    kind: String(x.kind) as CalendarRow["kind"],
    close_time: x.close_time === null ? null : String(x.close_time),
  }));
}

describe("dates mirror calendar.ts", () => {
  it("sydneyDate equals marketDate across both DST changes and midnight edges", () => {
    const starts = ["2026-04-04T12:00:00Z", "2026-10-03T12:00:00Z", "2026-12-31T12:00:00Z"];
    for (const s of starts) {
      for (let m = 0; m < 48 * 60; m += 37) {
        const ms = Date.parse(s) + m * 60_000;
        expect(sydneyDate(ms)).toBe(marketDate(new Date(ms), "Australia/Sydney"));
      }
    }
    expect(sydneyDate(Date.parse("2026-10-13T13:00:00Z"))).toBe("2026-10-14"); // 00:00 AEDT
    expect(sydneyDate(Date.parse("2026-10-13T12:59:00Z"))).toBe("2026-10-13");
    expect(() => sydneyDate(Number.NaN)).toThrow(RangeError);
  });

  it("isTradingDay, previousTradingDay and tradingDaysBetween agree over 2026 and 2027", async () => {
    const rows = await seedRows();
    for (let d = "2026-01-01"; d <= "2027-12-31"; d = addDays(d, 1)) {
      expect(isTradingDay(d, rows), d).toBe(tsIsTradingDay(d, rows));
      if (d >= "2026-02-01") expect(previousTradingDay(d, rows), d).toBe(tsPrevious(d, rows));
    }
    expect(tradingDaysBetween("2026-12-20", "2027-01-05", rows)).toEqual(
      sessionsBetween("2026-12-20", "2027-01-05", rows),
    );
  });

  it("addDays and date checks", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
    expect(isRealDate("2026-02-30")).toBe(false);
    expect(isRealDate(5)).toBe(false);
    expect(() => previousTradingDay("2026-10-13", holidaysFor("2026-09-01", "2026-10-12"))).toThrow(
      RangeError,
    );
  });
});

function holidaysFor(from: string, to: string) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ d, kind: "holiday" });
  return out;
}

describe("bar validation mirrors yahoo.ts", () => {
  const good = JSON.parse(
    readFileSync(path.join(ROOT, "tests/fixtures/synthetic/bars-good.json"), "utf8"),
  );
  const bad = JSON.parse(
    readFileSync(path.join(ROOT, "tests/fixtures/synthetic/bars-bad.json"), "utf8"),
  );

  it("same rows, same rejections on the synthetic good and bad files", () => {
    for (const json of [good, bad]) {
      const a = parseBars(json);
      const b = parseYahooBars(json);
      expect(a.rows).toEqual(b.rows);
      expect(a.rejected).toEqual(b.rejected);
      expect(a.total).toBe(b.total);
      expect(rejectSummary(a.rejected)).toEqual(tsRejectSummary(b.rejected));
    }
    expect(parseBars(bad).rejected.length).toBeGreaterThan(0);
  });

  it("same verdict on one mutation per field", () => {
    const base = bar("ZZA", "2026-10-13");
    const mutations: unknown[] = [
      null,
      [],
      "x",
      { ...base, code: "zz" },
      { ...base, code: "TOOLONG1" },
      { ...base, date: "2026-02-30" },
      { ...base, date: "13/10/2026" },
      { ...base, open: null },
      { ...base, open: Number.NaN },
      { ...base, open: "10" },
      { ...base, close: 0 },
      { ...base, low: -1 },
      { ...base, volume: -1 },
      { ...base, volume: 1.5 },
      { ...base, volume: null },
      { ...base, high: 5 },
      { ...base, low: 99 },
      { ...base, source: "other" },
      { ...base, published_at: "2026-10-13T00:00:00Z" },
      { ...base, fetched_at: "yesterday" },
      { ...base, fetched_at: "2026-13-45T25:00:00Z" },
      { ...base, fetched_at: 5 },
      base,
    ];
    for (const m of mutations) {
      const a = validateBar(m, { from: "2026-10-01", to: "2026-10-31" });
      const b = parseYahooBars([m], { from: "2026-10-01", to: "2026-10-31" });
      if ("row" in a) expect(b.rows[0]).toEqual(a.row);
      else expect(b.rejected[0].reason).toBe(a.reason);
    }
    expect(validateBar(base, { from: "2026-10-14" })).toEqual({ reason: "date_out_of_range" });
    expect(validateBar(base, { to: "2026-10-12" })).toEqual({ reason: "date_out_of_range" });
  });

  it("the first row of a key wins; later ones are duplicate_key", () => {
    const r = parseBars([bar("ZZA", "2026-10-13"), bar("ZZA", "2026-10-13", { open: 10.1 })]);
    expect(r.rows).toHaveLength(1);
    expect(r.rejected).toEqual([
      { index: 1, code: "ZZA", date: "2026-10-13", reason: "duplicate_key" },
    ]);
  });

  it("a non-array and invalid JSON are format errors", () => {
    expect(() => parseBars({})).toThrow(BarsFormatError);
    expect(() => parseBarsText("{nope")).toThrow(BarsFormatError);
    expect(parseBarsText(JSON.stringify(barsFor(["2026-10-13"]))).rows).toHaveLength(3);
  });
});

describe("planDates (catch-up)", () => {
  const rows: { d: string; kind: string }[] = [{ d: "2026-10-14", kind: "holiday" }];
  const mk = (markers: string[], first: string | null, target: string, extra = {}) =>
    planDates({ target, markers: new Set(markers), firstMarker: first, rows, ...extra });

  it("no marker ever: only the target", () => {
    expect(mk([], null, "2026-10-16")).toEqual({
      dates: [{ d: "2026-10-16", trading: true }],
      remaining: 0,
    });
  });

  it("missed trading dates come oldest first, holidays and weekends are not missed", () => {
    const p = mk(["2026-10-12"], "2026-10-12", "2026-10-20");
    expect(p.dates.map((x) => x.d)).toEqual([
      "2026-10-13",
      "2026-10-15",
      "2026-10-16",
      "2026-10-19",
      "2026-10-20",
    ]);
    expect(p.remaining).toBe(0);
  });

  it("a gap in the middle is found, not only the tail after the last marker", () => {
    const p = mk(["2026-10-12", "2026-10-15"], "2026-10-12", "2026-10-16");
    expect(p.dates.map((x) => x.d)).toEqual(["2026-10-13", "2026-10-16"]);
  });

  it("bounded: at most maxDates including the target, the target is always kept", () => {
    const p = mk(["2026-10-12"], "2026-10-12", "2026-10-30", { maxDates: 3 });
    expect(p.dates.map((x) => x.d)).toEqual(["2026-10-13", "2026-10-15", "2026-10-30"]);
    expect(p.remaining).toBe(10); // 12 missed older sessions, 2 fit beside the target
  });

  it("look-back window limits how far back it goes", () => {
    const p = mk(["2026-09-01"], "2026-09-01", "2026-10-16", { lookbackDays: 3, maxDates: 9 });
    expect(p.dates.map((x) => x.d)).toEqual(["2026-10-13", "2026-10-15", "2026-10-16"]);
  });

  it("the target with a marker is not planned; a non-trading target is planned as such", () => {
    expect(mk(["2026-10-13"], "2026-10-13", "2026-10-13").dates).toEqual([]);
    expect(mk(["2026-10-16"], "2026-10-16", "2026-10-17").dates).toEqual([
      { d: "2026-10-17", trading: false },
    ]);
    expect(mk([], null, "2026-10-14").dates).toEqual([{ d: "2026-10-14", trading: false }]);
  });
});

describe("re-fetch compare and hash", () => {
  const stored = { o: 10, h: 11, l: 9, c: 10.5, volume: 1000 };
  const same = { open: 10, high: 11, low: 9, close: 10.5, volume: 1000 };

  it("identical is zero and does not differ", () => {
    expect(compareBar(stored, same)).toEqual({ differs: false, maxDiffPct: 0 });
  });

  it("the threshold is strictly above 0.1 % on any field", () => {
    expect(compareBar(stored, { ...same, close: 10.5104 }).differs).toBe(false); // just under 0.1 %
    expect(compareBar(stored, { ...same, volume: 1001 }).differs).toBe(false); // exactly 0.1 %
    expect(compareBar(stored, { ...same, volume: 1002 })).toEqual({
      differs: true,
      maxDiffPct: 0.2,
    });
    expect(compareBar(stored, { ...same, low: 8.9 }).differs).toBe(true);
    expect(compareBar(stored, { ...same, volume: 1050 }, 10).differs).toBe(false);
  });

  it("a stored zero against a non-zero is a 100 % difference", () => {
    expect(compareBar({ ...stored, volume: 0 }, { ...same, volume: 5 }).maxDiffPct).toBe(100);
    expect(compareBar({ ...stored, volume: 0 }, { ...same, volume: 0 }).maxDiffPct).toBe(0);
  });

  it("the hash ignores input order and changes with any value", () => {
    const a = { code: "ZZA", open: 1, high: 2, low: 1, close: 2, volume: 3 };
    const b = { code: "ZZB", open: 1, high: 2, low: 1, close: 2, volume: 3 };
    expect(refetchHash([a, b])).toBe(refetchHash([b, a]));
    expect(refetchHash([a, b])).not.toBe(refetchHash([a, { ...b, volume: 4 }]));
    expect(refetchHash([a])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("throttle and month bounds", () => {
  it("config values inside the bounds are used, others fall back to the defaults", () => {
    expect(throttleFrom(250, 10)).toEqual({ chunkSize: 250, minGapS: 10 });
    expect(throttleFrom(undefined, undefined)).toEqual({ chunkSize: 100, minGapS: 5 });
    expect(throttleFrom(9, 61)).toEqual({ chunkSize: 100, minGapS: 5 });
    expect(throttleFrom(501, 0)).toEqual({ chunkSize: 100, minGapS: 5 });
    expect(throttleFrom("20", 1.5)).toEqual({ chunkSize: 20, minGapS: 5 });
    expect(throttleFrom("abc", null)).toEqual({ chunkSize: 100, minGapS: 5 });
  });

  it("UTC month bounds, including December", () => {
    expect(monthBoundsUtc(Date.parse("2026-10-13T06:30:00Z"))).toEqual({
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-11-01T00:00:00.000Z",
    });
    expect(monthBoundsUtc(Date.parse("2026-12-31T23:59:59Z")).end).toBe("2027-01-01T00:00:00.000Z");
  });
});
