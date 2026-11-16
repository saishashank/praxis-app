// @vitest-environment node
// M20 IN1 (DAT-243 macro, D-1132, D-1171, D-1173) and integration (0037, D-1147): the macro CSV, its storage through the
// shared macro writer (source by series: RBI_* -> rbi, MOSPI_* -> mospi; refused before any statement while India is
// off), and the manual index CSV. The index parser keeps the profile's index codes only and the bar's known time is
// close + latency.
import { afterEach, describe, expect, it } from "vitest";
import {
  macroSeriesRows,
  parseMacroCsv,
  SERIES,
  SOURCES,
  sourceOfSeries,
} from "@/lib/data/sources/in/macro.mjs";
import { storableMacroRows, writeMacroSeries } from "@/lib/data/sources/macroStore.mjs";
import { indexBarRows, parseIndexCsv } from "@/lib/data/sources/in/index.mjs";
import { isMarketNotEnabled } from "@/lib/market/guard.mjs";
import { allowMarket, cleanupTempDbs, freshDb } from "../../db/helpers";
import { indexFile } from "./dayFixture";

afterEach(cleanupTempDbs);

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

  it("every series maps to one of the market's two source words; an unknown id maps to none", () => {
    expect(SOURCES).toEqual(["rbi", "mospi"]);
    expect(SERIES.map((s) => sourceOfSeries(s))).toEqual(["rbi", "rbi", "mospi"]);
    expect(sourceOfSeries("WHATEVER")).toBeNull();
    const rows = macroSeriesRows([
      { seriesId: "MOSPI_CPI", d: "2026-10-12", valueMicro: 4_250_000n },
      { seriesId: "RBI_REPO", d: "2026-10-01", valueMicro: 5_500_000n },
    ]);
    expect(rows.map((r) => r.source)).toEqual(["mospi", "rbi"]);
    // the writer's own check: a foreign source word or a malformed row is counted, never stored
    const st = storableMacroRows(
      [...rows, { source: "fred", seriesId: "FEDFUNDS", d: "2026-10-01", valueMicro: 1n }],
      SOURCES,
    );
    expect(st).toMatchObject({ skipped: 1 });
    expect(st.rows).toHaveLength(2);
  });

  it("the writer refuses under the production seed before any statement, and stores once India is enabled", async () => {
    const db = await freshDb("main");
    const rows = macroSeriesRows(
      parseMacroCsv("series_id,d,value\nRBI_REPO,2026-10-01,5.50\nMOSPI_CPI,2026-10-12,4.25\n")
        .rows,
    );
    const err = await writeMacroSeries(db, "IN", rows, "2026-11-13T00:00:00.000Z").then(
      () => null,
      (e: unknown) => e,
    );
    expect(isMarketNotEnabled(err)).toBe(true);
    const n = async () =>
      Number((await db.execute("SELECT COUNT(*) AS n FROM macro_series")).rows[0]!.n);
    expect(await n()).toBe(0);
    await allowMarket(db, "IN");
    expect(await writeMacroSeries(db, "IN", rows, "2026-11-13T00:00:00.000Z")).toBe(2);
    expect(await writeMacroSeries(db, "IN", rows, "2026-11-14T00:00:00.000Z")).toBe(0); // same values
    expect(await n()).toBe(2);
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
