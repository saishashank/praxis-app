// @vitest-environment node
// M4 T3: index bars (^AXJO) and ASIC short positions in Batch 1, against a real local libSQL file
// and synthetic samples (fake index levels, ZZ codes; no real market data).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { carryTiers, noopQualityHook, prepareBatch1, runBatch1 } from "@/lib/data/pipeline/batch1";
import {
  parseIndexText,
  readIndexBars,
  writeIndexBars,
} from "../../src/lib/data/index/indexBars.mjs";
import { inputsStage } from "../../src/lib/data/index/inputsStage.mjs";
import {
  parseShortText,
  planShortDates,
  readShortInterest,
  shortPpm,
  writeShortInterest,
} from "../../src/lib/data/shortInterest.mjs";
import { parseAsicCsv } from "../../src/lib/data/backfill/rules.mjs";
import { cleanupTempDbs } from "../db/helpers";
import { at1730, barsFor, count, pipelineDb, runs, text } from "../pipeline/helpers";

afterEach(cleanupTempDbs);

const TUE = "2026-10-13";
const fx = (f: string) => readFileSync(path.join(__dirname, "../fixtures/data", f), "utf8");
const INDEX_TEXT = fx("index_sample.json");
const ASOF = "2026-10-07"; // a Wednesday: assumed publication 2026-10-14 (+5 weekdays)

function shortFile(stopped: string | null = null) {
  const parsed = parseAsicCsv(fx("asic_short_sample.csv"), ASOF);
  if (!("rows" in parsed)) throw new Error("fixture header");
  return JSON.stringify({
    stopped,
    dates: 1,
    absent: 0,
    skipped: parsed.skipped,
    rows: parsed.rows,
  });
}

const go = (db: Client, o: Record<string, unknown> = {}) =>
  runBatch1(db, {
    nowMs: () => at1730(TUE),
    barsText: text(barsFor(["2026-10-12", TUE])),
    qualityHook: noopQualityHook,
    tiersHook: carryTiers, // tiering (D-189) has its own tests (tests/universe/tiers.test.ts)
    ...o,
  } as never);

const stage6 = async (db: Client) => {
  const r = (await runs(db)).find((x) => x.status === "success");
  return JSON.parse(String(r?.details_json)).stages.macro_and_other;
};

describe("recorded-sample parsing", () => {
  it("index.json: valid rows in micro units, bad rows counted by reason", () => {
    const p = parseIndexText(INDEX_TEXT);
    expect(p.status).toBe("ok");
    expect(p.rows.map((r) => r.d)).toEqual(["2026-10-12", TUE]);
    expect(p.rows[1]).toMatchObject({ o_micro: 1005750000, c_micro: 1012125000 });
    expect(p.rejected).toEqual({ duplicate_key: 1, non_positive: 1, bad_code: 1 });
    expect(parseIndexText(null).status).toBe("no_file");
    expect(parseIndexText("{").status).toBe("invalid");
    expect(parseIndexText("{}").status).toBe("invalid");
  });

  it("short.json: ppm from the share counts, bad rows counted", () => {
    const p = parseShortText(shortFile());
    expect(p.status).toBe("ok");
    expect(p.rows.map((r) => [r.code, r.short_ppm])).toEqual([
      ["ZZA", 15000],
      ["ZZB", 5000],
      ["ZZC", 0],
      ["ZZQ", 10000],
    ]);
    expect(shortPpm(2, 1)).toBe(1_000_000); // clamped
    expect(parseShortText(null).status).toBe("no_file");
    expect(parseShortText(shortFile("blocked")).stopped).toBe("blocked");
  });
});

describe("the stage inside a Batch 1 run", () => {
  it("writes the target-date index bar and the short rows, with accounting and the assumed flag", async () => {
    const db = await pipelineDb();
    const res = await go(db, { indexText: INDEX_TEXT, shortText: shortFile() });
    expect(res.exit).toBe(0);
    const bars = (await db.execute("SELECT * FROM index_bar")).rows;
    expect(bars).toHaveLength(1); // the previous day is not stored by this run
    expect(bars[0]).toMatchObject({ index_code: "AXJO", d: TUE, c_micro: 1012125000 });
    expect(bars[0].published_at).toBe(bars[0].ingested_at);

    const si = (await db.execute("SELECT * FROM short_interest ORDER BY code")).rows;
    expect(si.map((r) => r.code)).toEqual(["ZZA", "ZZB", "ZZC"]); // ZZQ is not in the universe
    for (const r of si) {
      expect(r.assumed_time).toBe(1);
      expect(r.published_at).toBe("2026-10-14T23:59:59.000Z");
      expect(r.source).toBe("asic_short");
    }
    const s6 = await stage6(db);
    expect(s6.index).toEqual({ rows: 1, inserted: 1, already_stored: 0 });
    expect(s6.short_interest).toMatchObject({
      inserted: 3,
      not_in_universe: 1,
      assumed_time: true,
    });

    // run-record accounting: rows_written includes the 1 index bar and the 3 short rows
    const rec = (await runs(db)).find((x) => x.status === "success")!;
    const base = await count(db, "price_bar");
    expect(Number(rec.rows_written)).toBeGreaterThanOrEqual(base + 4);
  });

  it("is idempotent: the stage run again writes nothing", async () => {
    const db = await pipelineDb();
    await go(db, { indexText: INDEX_TEXT, shortText: shortFile() });
    const io = { read: 0, written: 0 };
    const inputs = { index: parseIndexText(INDEX_TEXT), short: parseShortText(shortFile()) };
    const out = (await inputsStage({
      db,
      market: "AU",
      d: TUE,
      io,
      now: "2026-10-13T07:00:00.000Z",
      isTarget: true,
      universe: ["ZZA", "ZZB", "ZZC"],
      inputs,
    })) as Record<string, unknown>;
    expect(io.written).toBe(0);
    expect(out.index).toEqual({ rows: 1, inserted: 0, already_stored: 1 });
    expect(out.short_interest).toMatchObject({ inserted: 0, already_stored: 3 });
    expect(await count(db, "index_bar")).toBe(1);
    expect(await count(db, "short_interest")).toBe(3);
    // and the first-seen value survives a changed re-fetch
    await writeIndexBars(db, {
      rows: [{ ...parseIndexText(INDEX_TEXT).rows[1], c_micro: 5 }],
      ingestedAt: "2026-10-14T00:00:00.000Z",
    });
    const kept = await readIndexBars(db, { asOf: TUE, limit: 1 });
    expect(kept[0].c).toBe(1012125000);
  });

  it("no file: the stage records it and writes nothing; a bad file does not fail the bars", async () => {
    const db = await pipelineDb();
    const res = await go(db, { indexText: null, shortText: null });
    expect(res.exit).toBe(0);
    expect(await stage6(db)).toEqual({
      index: "no_file",
      short_interest: "no_file",
      vendor_actions: "no_file",
    });
    expect(await count(db, "index_bar")).toBe(0);

    const db2 = await pipelineDb();
    await go(db2, { indexText: "not json", shortText: "[1]" });
    expect(await stage6(db2)).toEqual({
      index: "file_invalid",
      short_interest: "file_invalid",
      vendor_actions: "no_file",
    });
    expect(await count(db2, "price_bar")).toBe(3);
  });

  it("records a fetch stop reported by the ASIC step", async () => {
    const db = await pipelineDb();
    await go(db, { shortText: shortFile("rate_limited") });
    expect((await stage6(db)).short_interest).toMatchObject({ stopped: "rate_limited" });
  });

  it("source off: Yahoo pending writes no index and the run says why; ASIC off skips only shorts", async () => {
    const pending = await pipelineDb({ accepted: false });
    const r = await go(pending, { indexText: INDEX_TEXT, shortText: shortFile() });
    expect(r).toMatchObject({ exit: 0, status: "skipped", reason: "source_not_accepted" });
    expect(await count(pending, "index_bar")).toBe(0);
    expect(await count(pending, "short_interest")).toBe(0);
    const prep = await prepareBatch1(pending, { nowMs: at1730(TUE) });
    expect(prep).toMatchObject({ action: "skip", reason: "source_not_accepted" });

    const db = await pipelineDb();
    await db.execute("UPDATE source_status SET mode = 'off' WHERE source = 'asic_short'");
    const prep2 = await prepareBatch1(db, { nowMs: at1730(TUE) });
    expect(prep2).toMatchObject({
      action: "fetch",
      request: { indices: ["^AXJO"], short_dates: [] },
    });
    await go(db, { indexText: INDEX_TEXT, shortText: shortFile() });
    expect((await stage6(db)).short_interest).toBe("source_off");
    expect(await count(db, "short_interest")).toBe(0);
    expect(await count(db, "index_bar")).toBe(1);
  });

  it("prepare asks for the missing ASIC weekdays only", async () => {
    const db = await pipelineDb();
    await db.execute({
      sql: `INSERT INTO short_interest (market, code, as_of, short_ppm, published_at, ingested_at, assumed_time, source)
            VALUES ('AU','ZZA','2026-10-09',1,'2026-10-16T23:59:59.000Z','2026-10-13T00:00:00.000Z',1,'asic_short')`,
    });
    const dates = await planShortDates(db, { target: TUE });
    expect(dates).not.toContain("2026-10-09");
    expect(dates).not.toContain("2026-10-10"); // Saturday
    expect(dates.length).toBeLessThanOrEqual(8);
    expect(dates.at(-1)).toBe(TUE);
  });
});

describe("look-ahead bound", () => {
  it("readIndexBars returns only d <= D", async () => {
    const db = await pipelineDb();
    await writeIndexBars(db, {
      rows: parseIndexText(INDEX_TEXT).rows,
      ingestedAt: "2026-10-14T00:00:00.000Z",
    });
    expect((await readIndexBars(db, { asOf: "2026-10-12" })).map((b) => b.d)).toEqual([
      "2026-10-12",
    ]);
    expect((await readIndexBars(db, { asOf: "2026-10-11" })).length).toBe(0);
    expect((await readIndexBars(db, { asOf: "2030-01-01" })).map((b) => b.d)).toEqual([
      "2026-10-12",
      TUE,
    ]);
    await expect(readIndexBars(db, { asOf: "bad" })).rejects.toThrow();
  });

  it("readShortInterest hides a row until its assumed publication time", async () => {
    const db = await pipelineDb();
    await writeShortInterest(db, {
      rows: parseShortText(shortFile()).rows.filter((r) => r.code === "ZZA"),
      ingestedAt: "2026-10-14T00:00:00.000Z",
    });
    expect(await readShortInterest(db, { code: "ZZA", asOf: "2026-10-13" })).toEqual([]);
    expect(await readShortInterest(db, { code: "ZZA", asOf: "2026-10-06" })).toEqual([]);
    expect(await readShortInterest(db, { code: "ZZA", asOf: "2026-10-14" })).toEqual([
      {
        asOf: ASOF,
        shortPpm: 15000,
        publishedAt: "2026-10-14T23:59:59.000Z",
        assumedTime: true,
      },
    ]);
  });
});
