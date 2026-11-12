// @vitest-environment node
// M20 IN1 (DAT-243 a, D-1132): the NSE bhavcopy parser on hand-made UDiFF rows: equity series only, exact prices,
// `published_at` = close + latency (known_time_rules.bars), no-trade and foreign-date rows rejected, first series wins.
import { describe, expect, it } from "vitest";
import {
  barPublishedAt,
  EQUITY_SERIES,
  parseBhavcopy,
  priceBarRows,
} from "@/lib/data/sources/in/bhavcopy.mjs";
import { bhavFile, type Bar } from "./dayFixture";

const D = "2026-11-12";
const bar = (code: string, over: Partial<Bar> = {}): Bar => ({
  code,
  open: "100.05",
  high: "101.00",
  low: "99.50",
  close: "100.75",
  prev: "100.00",
  volume: "12345",
  ...over,
});
const body = (text: string) => text.split("\n").slice(1).join("\n");

describe("parseBhavcopy", () => {
  it("keeps the cash segment's equity series and reads prices exactly", () => {
    const text = bhavFile(D, [
      bar("AAA"),
      bar("BBB", { series: "BE" }),
      bar("GOLD", { series: "GB" }), // a bond, not an equity bar
      bar("FUT", { sgmt: "FO" }),
      bar("ETFX", { tp: "ETF" }),
    ]);
    const r = parseBhavcopy(text, { d: D });
    expect(r.rows.map((x) => x.code)).toEqual(["AAA", "BBB"]);
    expect(r.rows[0]).toMatchObject({
      open: 100.05,
      high: 101,
      low: 99.5,
      close: 100.75,
      volume: 12345,
    });
    expect(r.total).toBe(2);
    expect(EQUITY_SERIES).toContain("EQ");
  });

  it("rejects a code that did not trade, another date, an unreadable price and a repeated code", () => {
    const zero = { open: "0.00", high: "0.00", low: "0.00", close: "0.00", volume: "0" };
    const text = [
      bhavFile(D, [bar("AAA", zero)]),
      body(bhavFile("2026-11-11", [bar("BBB")])),
      body(
        bhavFile(D, [
          bar("CCC", { close: "n/a" }),
          bar("DDD"),
          bar("DDD", { series: "BE", close: "5.00" }),
        ]),
      ),
    ].join("\n");
    const r = parseBhavcopy(text, { d: D });
    const why = Object.fromEntries(r.rejected.map((x) => [x.code, x.reason]));
    expect(why).toEqual({
      AAA: "no_trade",
      BBB: "other_date",
      CCC: "unreadable",
      DDD: "duplicate",
    });
    expect(r.rows.map((x) => x.code)).toEqual(["DDD"]);
    expect(r.rows[0]!.close).toBe(100.75); // the first series (EQ) won
  });

  it("refuses a bad session date", () => {
    expect(() => parseBhavcopy("", { d: "12-11-2026" })).toThrow(RangeError);
  });

  it("an empty file parses to nothing (the day module fails the date, nothing is invented)", () => {
    expect(parseBhavcopy("", { d: D })).toEqual({ rows: [], rejected: [], total: 0 });
  });
});

describe("published_at = session close (IST) + latency", () => {
  it("15:30 IST + 60 min is 11:00 UTC", () => {
    expect(barPublishedAt(D, "15:30", 60)).toBe("2026-11-12T11:00:00.000Z");
  });

  it("price_bar rows follow the table's column order", () => {
    const { rows } = parseBhavcopy(bhavFile(D, [bar("AAA")]), { d: D });
    const [row] = priceBarRows(rows, {
      market: "IN",
      d: D,
      publishedAt: "2026-11-12T11:00:00.000Z",
      ingestedAt: "2026-11-12T12:00:00.000Z",
    });
    expect(row).toEqual([
      "IN",
      "AAA",
      D,
      100.05,
      101,
      99.5,
      100.75,
      12345,
      "in_nse_bhavcopy",
      "2026-11-12T11:00:00.000Z",
      "2026-11-12T12:00:00.000Z",
    ]);
  });
});
