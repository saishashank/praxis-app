// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isRealDate,
  parseYahooBars,
  parseYahooBarsText,
  rejectSummary,
  validateBar,
  YahooFormatError,
} from "@/lib/data/sources/yahoo";
import { syntheticDir } from "@/lib/data/sources/fixtures";

const read = (n: string) => JSON.parse(fs.readFileSync(path.join(syntheticDir(), n), "utf8"));

const good = {
  code: "ZZZ",
  date: "2020-01-06",
  open: 10,
  high: 11,
  low: 9,
  close: 10.5,
  volume: 100,
  adj_close: 10.4,
  source: "yahoo",
  published_at: null,
  fetched_at: "2026-01-01T07:30:00.000Z",
};

const reason = (patch: Record<string, unknown>) => {
  const r = validateBar({ ...good, ...patch });
  return "reason" in r ? r.reason : "ok";
};

describe("validateBar", () => {
  it("accepts a good bar and returns typed fields", () => {
    expect(validateBar(good)).toEqual({ row: good });
  });

  it("accepts a flat bar and zero volume", () => {
    expect(reason({ open: 10, high: 10, low: 10, close: 10, volume: 0 })).toBe("ok");
  });

  it.each([[null], [[]], ["x"]])("rejects non-object %j", (raw) => {
    expect(validateBar(raw)).toEqual({ reason: "not_an_object" });
  });

  it.each([
    [{ code: "zzz" }, "bad_code"],
    [{ code: "Z" }, "bad_code"],
    [{ code: "TOOLONG1" }, "bad_code"],
    [{ code: 5 }, "bad_code"],
    [{ date: "2020-02-30" }, "bad_date"],
    [{ date: "2020-1-6" }, "bad_date"],
    [{ date: 20200106 }, "bad_date"],
    [{ open: null }, "bad_number"],
    [{ close: Number.NaN }, "bad_number"],
    [{ high: Infinity }, "bad_number"],
    [{ adj_close: "1" }, "bad_number"],
    [{ volume: undefined }, "bad_number"],
    [{ close: -1 }, "non_positive_price"],
    [{ low: 0, open: 0 }, "non_positive_price"],
    [{ adj_close: 0 }, "non_positive_price"],
    [{ volume: -1 }, "bad_volume"],
    [{ volume: 1.5 }, "bad_volume"],
    [{ high: 9.5 }, "ohlc_inconsistent"],
    [{ low: 10.9 }, "ohlc_inconsistent"],
    [{ source: "other" }, "bad_source"],
    [{ published_at: "2026-01-01T00:00:00Z" }, "bad_published_at"],
    [{ fetched_at: "yesterday" }, "bad_fetched_at"],
    [{ fetched_at: "2026-01-01T07:30:00+10:00" }, "bad_fetched_at"],
    [{ fetched_at: "2026-13-01T07:30:00Z" }, "bad_fetched_at"],
    [{ fetched_at: 5 }, "bad_fetched_at"],
  ])("rejects %j as %s", (patch, why) => {
    expect(reason(patch)).toBe(why);
  });

  it("checks the date range inclusively", () => {
    const opts = { from: "2020-01-06", to: "2020-01-06" };
    expect(validateBar(good, opts)).toEqual({ row: good });
    expect(validateBar({ ...good, date: "2020-01-05" }, opts)).toEqual({
      reason: "date_out_of_range",
    });
    expect(validateBar({ ...good, date: "2020-01-07" }, opts)).toEqual({
      reason: "date_out_of_range",
    });
  });
});

describe("isRealDate", () => {
  it("handles leap days and non-strings", () => {
    expect(isRealDate("2024-02-29")).toBe(true);
    expect(isRealDate("2023-02-29")).toBe(false);
    expect(isRealDate(undefined)).toBe(false);
  });
});

describe("parseYahooBars", () => {
  it("rejects a non-array file", () => {
    expect(() => parseYahooBars({})).toThrow(YahooFormatError);
    expect(() => parseYahooBars(null)).toThrow(/array/);
  });

  it("accepts an empty array", () => {
    expect(parseYahooBars([])).toEqual({ rows: [], rejected: [], total: 0 });
  });

  it("parses the synthetic good file with no rejects", () => {
    const res = parseYahooBars(read("bars-good.json"));
    expect(res.rejected).toEqual([]);
    expect(res.rows).toHaveLength(40);
    expect(res.rows.every((r) => r.source === "yahoo" && r.published_at === null)).toBe(true);
  });

  it("rejects each kind of bad bar in the synthetic bad file and keeps the rest", () => {
    const res = parseYahooBars(read("bars-bad.json"));
    expect(res.total).toBe(11);
    expect(res.rows.map((r) => `${r.code}|${r.date}`)).toEqual([
      "ZZZ|2020-01-06",
      "ZZZ|2020-01-17",
    ]);
    expect(res.rejected.map((r) => r.reason)).toEqual([
      "non_positive_price",
      "bad_number",
      "ohlc_inconsistent",
      "bad_date",
      "bad_volume",
      "duplicate_key",
      "bad_code",
      "bad_fetched_at",
      "bad_source",
    ]);
    expect(res.rows.length + res.rejected.length).toBe(res.total);
    expect(rejectSummary(res.rejected)).toMatchObject({ duplicate_key: 1, bad_number: 1 });
  });

  it("records index, code and date of rejected rows, tolerating non-objects", () => {
    const res = parseYahooBars([good, 7, { ...good, close: -2 }]);
    expect(res.rejected).toEqual([
      { index: 1, code: null, date: null, reason: "not_an_object" },
      { index: 2, code: "ZZZ", date: "2020-01-06", reason: "non_positive_price" },
    ]);
  });

  it("keeps the first of conflicting duplicates", () => {
    const res = parseYahooBars([good, { ...good, close: 10.6 }]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].close).toBe(10.5);
    expect(res.rejected[0].reason).toBe("duplicate_key");
  });

  it("applies the date range to every row", () => {
    const res = parseYahooBars([good, { ...good, date: "2020-02-03" }], { to: "2020-01-31" });
    expect(res.rows).toHaveLength(1);
    expect(res.rejected[0].reason).toBe("date_out_of_range");
  });
});

describe("parseYahooBarsText", () => {
  it("parses text and rejects invalid JSON", () => {
    expect(parseYahooBarsText(JSON.stringify([good])).rows).toHaveLength(1);
    expect(() => parseYahooBarsText("{oops")).toThrow(/not valid JSON/);
  });
});
