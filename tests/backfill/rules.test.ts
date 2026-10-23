// @vitest-environment node
// History backfill pure rules (M2 T9; DAT-125, DAT-125a, DAT-140, DAT-001, decision 13).
import { describe, expect, it } from "vitest";
import {
  ADMIN_WRITES,
  ASIC_HOST,
  addMonths,
  addWeekdays,
  announcementLine,
  announcementWrites,
  asicPublishedAt,
  asicUrl,
  capDecision,
  floorDate,
  fromJsonlGz,
  gzipDeterministic,
  historyLocation,
  isMonth,
  lastCompleteMonth,
  monthFirstDay,
  monthLastDay,
  monthOf,
  monthsToDo,
  parseAsicCsv,
  previousWeekday,
  quotaMonth,
  sha256Hex,
  toJsonl,
  validateAnnouncement,
  visibleAt,
  weekdaysOfMonth,
} from "@/lib/data/backfill/rules.mjs";
import { annId, asicCsv, item } from "./helpers";

describe("dates", () => {
  it("month helpers", () => {
    expect(isMonth("2026-10")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-1")).toBe(false);
    expect(isMonth(5)).toBe(false);
    expect(monthOf("2026-10-13")).toBe("2026-10");
    expect(monthFirstDay("2026-02")).toBe("2026-02-01");
    expect(monthLastDay("2024-02")).toBe("2024-02-29");
    expect(monthLastDay("2026-02")).toBe("2026-02-28");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-10", -24)).toBe("2024-10");
    expect(lastCompleteMonth("2026-01-05")).toBe("2025-12");
    expect(() => monthFirstDay("nope")).toThrow();
    expect(() => monthLastDay("nope")).toThrow();
    expect(() => addMonths("nope", 1)).toThrow();
  });

  it("weekdays", () => {
    expect(previousWeekday("2026-10-12")).toBe("2026-10-09"); // Monday -> Friday
    expect(previousWeekday("2026-10-13")).toBe("2026-10-12");
    expect(addWeekdays("2026-10-09", 1)).toBe("2026-10-12");
    expect(addWeekdays("2026-10-08", 5)).toBe("2026-10-15");
    expect(weekdaysOfMonth("2026-10").length).toBe(22);
    expect(weekdaysOfMonth("2026-10", "2026-10-05")).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-05",
    ]);
    expect(weekdaysOfMonth("2026-10", "2030-01-01").length).toBe(22);
  });

  it("the floor is six years back; 29 February becomes 28 February", () => {
    expect(floorDate("2026-10-13")).toBe("2020-10-13");
    expect(floorDate("2028-02-29")).toBe("2022-02-28");
    expect(floorDate("2032-02-29")).toBe("2026-02-28");
    expect(floorDate("2030-02-28")).toBe("2024-02-28");
  });
});

describe("history location, bytes and sha", () => {
  it("one release per source and year, one asset per month", () => {
    expect(historyLocation("asic_short_interest", "2026-09")).toEqual({
      tag: "history-asic_short_interest-2026",
      asset: "asic_short_interest-2026-09.jsonl.gz",
      path: "history/asic_short_interest/2026/09.jsonl.gz",
    });
    expect(() => historyLocation("other", "2026-09")).toThrow();
    expect(() => historyLocation("asx_announcements", "2026-9")).toThrow();
  });

  it("jsonl + gzip are deterministic and round-trip", () => {
    const rows = [
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ];
    expect(toJsonl([])).toBe("");
    expect(toJsonl(rows)).toBe('{"a":1,"b":"x"}\n{"a":2,"b":"y"}\n');
    const one = gzipDeterministic(toJsonl(rows));
    const two = gzipDeterministic(toJsonl(rows));
    expect(sha256Hex(one)).toBe(sha256Hex(two));
    expect([...one.slice(4, 8)]).toEqual([0, 0, 0, 0]); // no mtime
    expect(one[9]).toBe(255); // no OS byte
    expect(fromJsonlGz(one)).toEqual(rows);
    expect(sha256Hex(gzipDeterministic(toJsonl([rows[0]])))).not.toBe(sha256Hex(one));
  });
});

describe("cap arithmetic (decision 13)", () => {
  it("counts announcement rows x 2.5 plus the bookkeeping", () => {
    expect(announcementWrites(0)).toBe(ADMIN_WRITES);
    expect(announcementWrites(4)).toBe(10 + ADMIN_WRITES);
    expect(announcementWrites(3)).toBe(8 + ADMIN_WRITES); // 7.5 rounds up
  });

  it("allows exactly up to the cap", () => {
    expect(capDecision({ used: 90, cap: 100, needed: 10 })).toEqual({ ok: true, remaining: 10 });
    expect(capDecision({ used: 90, cap: 100, needed: 11 })).toEqual({ ok: false, remaining: 10 });
    expect(capDecision({ used: 150, cap: 100, needed: 1 })).toEqual({ ok: false, remaining: 0 });
  });

  it("quota month is the UTC calendar month", () => {
    expect(quotaMonth(Date.parse("2026-10-31T23:59:59Z"))).toEqual({
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-11-01T00:00:00.000Z",
    });
  });
});

describe("monthsToDo", () => {
  it("walks newest first from the cursor, cutting only the first month", () => {
    const m = monthsToDo("2026-10-15", "2020-10-13", 3);
    expect(m.map((x) => x.month)).toEqual(["2026-10", "2026-09", "2026-08"]);
    expect(m[0].complete).toBe(false);
    expect(m[0].dates.at(-1)).toBe("2026-10-15");
    expect(m[1].complete).toBe(true);
    expect(m[1].dates.length).toBe(22);
  });

  it("stops at the floor and keeps only dates on or after it", () => {
    const m = monthsToDo("2020-11-30", "2020-10-13", 5);
    expect(m.map((x) => x.month)).toEqual(["2020-11", "2020-10"]);
    expect(m[1].dates[0]).toBe("2020-10-13");
  });

  it("nothing for a null cursor or a cursor below the floor", () => {
    expect(monthsToDo(null, "2020-10-13")).toEqual([]);
    expect(monthsToDo("2020-10-12", "2020-10-13")).toEqual([]);
  });
});

describe("ASIC short positions", () => {
  it("builds a URL on the fixed host", () => {
    const u = asicUrl("2026-09-30");
    expect(new URL(u).hostname).toBe(ASIC_HOST);
    expect(u).toContain("20260930");
  });

  it("publishes later than as_of (assumed time, DAT-001)", () => {
    expect(asicPublishedAt("2026-09-30")).toBe("2026-10-07T23:59:59.000Z");
    expect(asicPublishedAt("2026-10-09")).toBe("2026-10-16T23:59:59.000Z");
  });

  it("parses a file, sorts by code, flags the assumed time", () => {
    const r = parseAsicCsv(
      asicCsv([
        ["ZZB", 50, 5000],
        ["ZZA", 1000, 100000],
      ]),
      "2026-09-30",
    );
    if ("error" in r) throw new Error("unexpected");
    expect(r.skipped).toBe(0);
    expect(r.rows.map((x) => x.code)).toEqual(["ZZA", "ZZB"]);
    expect(r.rows[0]).toMatchObject({
      as_of: "2026-09-30",
      assumed_time: true,
      short_positions: 1000,
      total_in_issue: 100000,
      pct_short: 1,
      source: "asic_short",
    });
    expect(r.rows[0].published_at > "2026-09-30T23:59:59.000Z").toBe(true);
  });

  it("handles quotes, thousands separators, a BOM; skips bad and duplicate rows", () => {
    const text =
      "﻿Product,Product Code,Reported Short Positions,Total Product in Issue\n" +
      '"Synthetic, Ltd",ZZA,"1,000","100,000"\n' +
      "Dup,ZZA,5,500\n" + // duplicate code
      "Bad,bad!,5,500\n" + // invalid code
      "Neg,ZZB,-1,500\n" +
      "Zero,ZZC,1,0\n" +
      "Nan,ZZD,x,5\n" +
      ",\n";
    const r = parseAsicCsv(text, "2026-09-30");
    if ("error" in r) throw new Error("unexpected");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      code: "ZZA",
      product: "Synthetic, Ltd",
      short_positions: 1000,
      pct_short: 1,
    });
    expect(r.skipped).toBe(6);
  });

  it("reports a missing header and an empty file", () => {
    expect(parseAsicCsv("a,b,c\n1,2,3", "2026-09-30")).toEqual({ error: "no_header" });
    expect(parseAsicCsv("", "2026-09-30")).toEqual({ error: "no_header" });
  });

  it("unescapes doubled quotes inside a quoted field", () => {
    const text =
      "Product,Product Code,Reported Short Positions,Total Product in Issue\n" +
      '"Synthetic ""Q"" Ltd",ZZA,1,100\n';
    const r = parseAsicCsv(text, "2026-09-30");
    if ("error" in r) throw new Error("unexpected");
    expect(r.rows[0].product).toBe('Synthetic "Q" Ltd');
  });
});

describe("announcement metadata (DAT-125)", () => {
  const date = "2026-10-12";
  it("accepts a valid item and normalises it", () => {
    const v = validateAnnouncement(item(date, 1), date);
    if (!("row" in v)) throw new Error(v.reason);
    expect(v.row).toMatchObject({
      code: "ZZB",
      priceSensitive: 0,
      url: "https://example.invalid/pdf/1.pdf",
    });
    expect(v.row.publishedAt.endsWith("Z")).toBe(true);
  });

  it("drops a non-https link but keeps the metadata", () => {
    for (const pdfUrl of ["http://example.invalid/a.pdf", "not a url", null]) {
      const v = validateAnnouncement(item(date, 2, { pdfUrl }), date);
      if (!("row" in v)) throw new Error(v.reason);
      expect(v.row.url).toBeNull();
    }
  });

  it.each([
    ["not_an_object", null],
    ["not_an_object", []],
    ["bad_code", item(date, 3, { code: "bad!" })],
    ["bad_id", item(date, 3, { annId: "XYZ" })],
    ["bad_time", item(date, 3, { publishedAt: "2026-10-12 10:00" })],
    ["bad_time", item(date, 3, { publishedAt: "2026-13-45T10:00:00Z" })],
    ["wrong_date", item(date, 3, { publishedAt: "2026-10-13T10:00:00.000Z" })],
    ["bad_title", item(date, 3, { title: "  " })],
    ["bad_title", item(date, 3, { title: "x".repeat(1001) })],
    ["bad_type", item(date, 3, { type: "x".repeat(101) })],
    ["bad_flag", { ...item(date, 3), priceSensitive: "yes" }],
  ])("rejects %s", (reason, raw) => {
    expect(validateAnnouncement(raw, date)).toEqual({ reason });
  });

  it("the Sydney date decides, not the UTC date", () => {
    // 00:30 Sydney (AEDT) on the 13th is 13:30 UTC on the 12th.
    const t = "2026-10-12T13:30:00.000Z";
    expect(validateAnnouncement(item(date, 4, { publishedAt: t }), "2026-10-13")).toHaveProperty(
      "row",
    );
    expect(validateAnnouncement(item(date, 4, { publishedAt: t }), "2026-10-12")).toEqual({
      reason: "wrong_date",
    });
  });

  it("file lines have a fixed key order and null handling", () => {
    const line = announcementLine({
      source: "asx_announcements",
      ann_id: annId(1),
      code: "ZZA",
      published_at: "2026-10-12T00:00:00.000Z",
      type: null,
      price_sensitive: 1,
      title: "t",
      url: null,
    });
    expect(Object.keys(line)).toEqual([
      "source",
      "ann_id",
      "code",
      "published_at",
      "type",
      "price_sensitive",
      "title",
      "url",
      "assumed_time",
    ]);
    expect(line).toMatchObject({ type: null, url: null, assumed_time: false });
    expect(
      announcementLine({
        source: "s",
        ann_id: "a",
        code: "ZZA",
        published_at: "p",
        type: "T",
        price_sensitive: 0,
        title: "t",
        url: "https://example.invalid/x",
      }),
    ).toMatchObject({ type: "T", url: "https://example.invalid/x" });
  });
});

describe("point in time view (AT-09 Part A, TST-109)", () => {
  it("shows only rows published at or before the cut-off", () => {
    const rows = [
      { published_at: "2026-10-01T00:00:00.000Z" },
      { published_at: "2026-10-02T00:00:00.000Z" },
    ];
    expect(visibleAt(rows, "2026-10-01T23:59:59.000Z")).toEqual([rows[0]]);
    expect(visibleAt(rows, "2026-10-02T00:00:00.000Z")).toEqual(rows);
    expect(visibleAt(rows, "2000-01-01T00:00:00.000Z")).toEqual([]);
  });
});

describe("ASIC files before mid-2022: UTF-16LE with a BOM, tab-separated", () => {
  const header =
    "Product\tProduct Code\tReported Short Positions\tTotal Product in Issue\t% of Total Product in Issue Reported as Short Positions";
  const body = `${header}\r\nACME LTD\tACM\t1000\t100000\t1.00\r\nBETA GROUP\tBTA\t500\t50000\t1.00\r\n`;

  it("decodeText turns a UTF-16LE file with a BOM into text, and leaves UTF-8 alone", async () => {
    const { decodeText } = await import("@/lib/data/backfill/asicFetch.mjs");
    const le = new Uint8Array([0xff, 0xfe, ...new Uint8Array(Buffer.from(body, "utf16le"))]);
    expect(decodeText(le)).toBe(body);
    expect(decodeText(new TextEncoder().encode(body))).toBe(body);
  });

  it("parseAsicCsv reads the tab-separated layout like the comma one", () => {
    const r = parseAsicCsv(body, "2022-05-16");
    if ("error" in r) throw new Error(r.error);
    expect(r.skipped).toBe(0);
    expect(r.rows.map((x) => [x.code, x.short_positions, x.total_in_issue])).toEqual([
      ["ACM", 1000, 100000],
      ["BTA", 500, 50000],
    ]);
  });
});
