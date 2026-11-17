// @vitest-environment node
// M20 integration (migration 0040, D-1147; closes D-1189): the FRED observations reach `macro_series` with source `fred`.
// The fetch step puts them in the feeds file (`feeds.macro`, integer strings), the day's `macro` stage stores them
// through the shared writer (guard first), a re-run changes nothing, a revised value changes one row, and under the
// production seed (US off) the writer refuses before any statement and the 0040 trigger refuses a planted row.
import { afterEach, describe, expect, it } from "vitest";
import {
  feedMacroEntry,
  feedMacroRows,
  FRED_SERIES,
  MACRO_SOURCE,
} from "@/lib/data/sources/us/macro.mjs";
import { writeMacroSeries } from "@/lib/data/sources/macroStore.mjs";
import { isMarketNotEnabled } from "@/lib/market/guard.mjs";
import { buildFeeds } from "../../../scripts/ingest/us/feeds.mjs";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { DAYS, runNight, sessionFiles, usDevDb } from "./usDev";

afterEach(cleanupTempDbs);

const obs = (d: string, v: bigint) => ({ d, valueMicro: v });
const MACRO = [
  feedMacroEntry("FEDFUNDS", [obs("2026-10-01", 4_330_000n), obs("2026-11-01", 4_080_000n)]),
  feedMacroEntry("CPIAUCSL", [obs("2026-10-01", 325_123_000n)]),
];
const count = async (db: Awaited<ReturnType<typeof usDevDb>>, where = "1 = 1") =>
  Number((await db.execute(`SELECT COUNT(*) AS n FROM macro_series WHERE ${where}`)).rows[0]!.n);

describe("feeds.macro", () => {
  it("entries are JSON-safe (integer strings) and come back as fred rows; the rest is counted", () => {
    expect(MACRO[0]!.observations).toEqual([
      { d: "2026-10-01", valueMicro: "4330000" },
      { d: "2026-11-01", valueMicro: "4080000" },
    ]);
    expect(FRED_SERIES).toEqual(["FEDFUNDS", "DGS10", "CPIAUCSL"]);
    const r = feedMacroRows([
      ...MACRO,
      { seriesId: "NOTALISTED", observations: [{ d: "2026-10-01", valueMicro: "1" }] },
      {
        seriesId: "DGS10",
        observations: [
          { d: "bad", valueMicro: "1" },
          { d: "2026-10-01", valueMicro: "x" },
        ],
      },
    ]);
    expect(r.rows).toEqual([
      { source: "fred", seriesId: "FEDFUNDS", d: "2026-10-01", valueMicro: 4_330_000n },
      { source: "fred", seriesId: "FEDFUNDS", d: "2026-11-01", valueMicro: 4_080_000n },
      { source: "fred", seriesId: "CPIAUCSL", d: "2026-10-01", valueMicro: 325_123_000n },
    ]);
    expect(r.skipped).toBe(3);
    expect(feedMacroRows(undefined)).toEqual({ rows: [], skipped: 0 });
    expect(buildFeeds({}).macro).toEqual([]);
    expect(buildFeeds({ macro: MACRO }).macro).toBe(MACRO);
    expect(MACRO_SOURCE).toBe("fred");
  });
});

describe("the macro stage of the US night", () => {
  it("stores the feed's observations, a re-run adds nothing, a revision changes one row; no feed is a word", async () => {
    const db = await usDevDb();
    const d = DAYS[0]!;
    const { barsText, feeds } = sessionFiles(d);
    const first = await runNight(db, d, { barsText, feeds: { ...feeds, macro: MACRO } });
    expect(first.status).toBe("ok");
    expect(await count(db, "source = 'fred'")).toBe(3);
    const stages = (
      await db.execute(
        "SELECT details_json FROM run_record WHERE market = 'US' ORDER BY id DESC LIMIT 1",
      )
    ).rows[0]!;
    expect(JSON.parse(String(stages.details_json)).stages.macro).toEqual({
      series: 2,
      parsed: 3,
      inserted: 3,
      skipped: 0,
    });
    // the next night with the same observations: nothing changes; a revised print: one row
    const d2 = DAYS[1]!;
    const s2 = sessionFiles(d2);
    await runNight(db, d2, { barsText: s2.barsText, feeds: { ...s2.feeds, macro: MACRO } });
    expect(await count(db)).toBe(3);
    const d3 = DAYS[2]!;
    const s3 = sessionFiles(d3);
    const revised = [MACRO[0]!, feedMacroEntry("CPIAUCSL", [obs("2026-10-01", 325_200_000n)])];
    await runNight(db, d3, { barsText: s3.barsText, feeds: { ...s3.feeds, macro: revised } });
    expect(await count(db)).toBe(3);
    expect(await count(db, "series_id = 'CPIAUCSL' AND value_micro = 325200000")).toBe(1);
    const d4 = DAYS[3]!;
    const s4 = sessionFiles(d4);
    await runNight(db, d4, { barsText: s4.barsText, feeds: s4.feeds }); // the recorded fixtures carry no macro feed
    const last = (
      await db.execute(
        "SELECT details_json FROM run_record WHERE market = 'US' ORDER BY id DESC LIMIT 1",
      )
    ).rows[0]!;
    expect(JSON.parse(String(last.details_json)).stages.macro).toBe("no_feed");
  });

  it("under the production seed the writer refuses before any statement and the 0040 trigger refuses a planted row", async () => {
    const db = await freshDb("main");
    const rows = feedMacroRows(MACRO).rows;
    const err = await writeMacroSeries(db, "US", rows, "2026-11-13T00:00:00.000Z").then(
      () => null,
      (e: unknown) => e,
    );
    expect(isMarketNotEnabled(err)).toBe(true);
    await expect(
      db.execute(
        "INSERT INTO macro_series (source, series_id, d, value_micro, fetched_at) VALUES ('fred', 'FEDFUNDS', '2026-10-01', 1, 'x')",
      ),
    ).rejects.toThrow(/MarketNotEnabled macro_series/);
    expect(await count(db)).toBe(0);
  });
});
