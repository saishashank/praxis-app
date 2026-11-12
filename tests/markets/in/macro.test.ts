// @vitest-environment node
// M20 IN1 (DAT-243 macro, D-1132, D-1171, D-1173): the macro CSV and the manual index CSV. Macro rows are parsed and
// counted but not stored (macro_series.source is CHECK-limited to rba/abs); the index parser keeps the profile's index
// codes only and the bar's known time is close + latency.
import { describe, expect, it } from "vitest";
import { parseMacroCsv, SERIES } from "@/lib/data/sources/in/macro.mjs";
import { indexBarRows, parseIndexCsv } from "@/lib/data/sources/in/index.mjs";
import { indexFile } from "./dayFixture";

describe("macro CSV", () => {
  it("parses known series and counts the rest as skipped", () => {
    const r = parseMacroCsv(
      "series_id,d,value\nRBI_REPO,2026-10-01,5.50\nMOSPI_CPI,2026-10-12,4.25\nWHATEVER,2026-10-12,1\nRBI_REPO,not-a-date,5\nRBI_REPO,2026-10-02,x\n",
    );
    expect(r.rows).toEqual([
      { seriesId: "RBI_REPO", d: "2026-10-01", valueMicro: 5_500_000n },
      { seriesId: "MOSPI_CPI", d: "2026-10-12", valueMicro: 4_250_000n },
    ]);
    expect(r.skipped).toBe(3);
    expect(SERIES).toHaveLength(3);
  });
});

describe("manual index CSV", () => {
  const o = { market: "IN", codes: ["NSEI", "INDIAVIX"], closeLocal: "15:30", latencyMin: 60 };
  it("keeps the profile's index codes and prices exactly", () => {
    const r = parseIndexCsv(indexFile("2026-11-12"), o);
    expect(r.rows.map((x) => x.indexCode)).toEqual(["NSEI", "INDIAVIX"]);
    expect(r.rows[0]).toMatchObject({
      o: 24_000_100_000n,
      c: 24_050_250_000n,
      publishedAt: "2026-11-12T11:00:00.000Z",
    });
    expect(r.skipped).toBe(1);
  });

  it("index_bar rows follow the table's column order", () => {
    const r = parseIndexCsv(indexFile("2026-11-12"), o);
    const row = indexBarRows(r.rows.slice(0, 1), {
      market: "IN",
      ingestedAt: "2026-11-12T12:00:00.000Z",
    })[0]!;
    expect(row.slice(0, 3)).toEqual(["IN", "NSEI", "2026-11-12"]);
    expect(row[7]).toBe("in_nse_indices_manual");
  });

  it("no file, no rows: nothing is synthesised", () => {
    expect(parseIndexCsv("index_code,d,open,high,low,close\n", o)).toEqual({
      rows: [],
      skipped: 0,
    });
  });
});
