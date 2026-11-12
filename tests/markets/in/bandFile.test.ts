// @vitest-environment node
// M20 IN1 (DAT-243 f): the NSE price-band file. A whole-percent band is stored as such, "No Band" (F&O) as NULL, an
// unreadable band is rejected; the file carries no limit prices, so lower and upper stay NULL.
import { describe, expect, it } from "vitest";
import { parseBands, priceBandRows } from "@/lib/data/sources/in/bands.mjs";
import { bandsFile } from "./dayFixture";

describe("parseBands", () => {
  it("reads percent bands and No Band", () => {
    const { rows, rejected } = parseBands(bandsFile());
    expect(rejected).toBe(0);
    expect(rows.find((r) => r.code === "ALFA")!.bandPct).toBeNull();
    expect(rows.find((r) => r.code === "DLTA")!.bandPct).toBe(5);
    expect(rows.find((r) => r.code === "EPSL")!.bandPct).toBe(2);
  });

  it("rejects an unreadable or out-of-range band and keeps the first row of a repeated code", () => {
    const text =
      "Symbol,Series,Security Name,Band,Remarks\nAAA,EQ,A,abc,-\nBBB,EQ,B,150,-\nCCC,EQ,C,5,-\nCCC,BE,C,10,-\n,EQ,D,5,-\n";
    const r = parseBands(text);
    expect(r.rejected).toBe(3);
    expect(r.rows).toEqual([{ code: "CCC", series: "EQ", bandPct: 5 }]);
  });

  it("price_band rows: table order, no limit prices", () => {
    const { rows } = parseBands(bandsFile());
    const out = priceBandRows(rows.slice(0, 1), { market: "IN", d: "2026-11-12" });
    expect(out[0]).toEqual(["IN", "ALFA", "2026-11-12", null, null, null, "in_nse_bands"]);
  });
});
