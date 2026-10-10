// @vitest-environment node
// Batch 1 pipeline against a real local libSQL file and synthetic bars (M2 T6; DAT-001, DAT-002,
// DAT-003, DAT-020, DAT-022, DAT-141, PLT-016, PLT-017, PLT-076, BLD-024, D-057 decisions 2, 4, 13).
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  JOB,
  prepareBatch1,
  readThrottle,
  runBatch1,
  STAGE_NAMES,
  StageError,
  noopQualityHook,
  type QualityHookContext,
  type RunOptions,
} from "@/lib/data/pipeline/batch1";
import { cleanupTempDbs } from "../db/helpers";
import { at1730, bar, barsFor, CODES, count, pipelineDb, runs, tableCounts, text } from "./helpers";

afterEach(cleanupTempDbs);

const MON = "2026-10-12";
const TUE = "2026-10-13";
const WED = "2026-10-14";
const THU = "2026-10-15";
const FRI = "2026-10-16";
const SAT = "2026-10-17";

const go = (db: Client, date: string, rows: unknown[] | null, o: Partial<RunOptions> = {}) =>
  runBatch1(db, {
    nowMs: () => at1730(date),
    barsText: rows === null ? null : text(rows),
    commitSha: "a".repeat(40),
    ...o,
  });

const details = (r: Record<string, unknown>) => JSON.parse(String(r.details_json));

describe("happy path", () => {
  it("writes the snapshot, the bars, the marker and one run record with row accounting", async () => {
    const db = await pipelineDb();
    const res = await go(db, TUE, barsFor([MON, TUE]));
    expect(res).toMatchObject({ exit: 0, status: "ok", target: TUE });
    expect(res.dates).toHaveLength(1);

    expect(await count(db, "price_bar", `d='${TUE}'`)).toBe(3);
    expect(await count(db, "price_bar", `d='${MON}'`)).toBe(0); // the previous day is only compared
    expect(await count(db, "universe_snapshot", `d='${TUE}'`)).toBe(3);
    const m = (await db.execute("SELECT * FROM completion_marker")).rows;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ market: "AU", d: TUE, kind: "data", outcome: "complete" });

    const [r] = await runs(db);
    expect(r).toMatchObject({
      job: JOB,
      market: "AU",
      concurrency_key: `batch1:AU:${TUE}`,
      scheduled_for: TUE,
      status: "success",
      items_processed: 3,
      llm_tokens: 0,
      commit_sha: "a".repeat(40),
    });
    expect(r.rows_written).toBe(3 + 3 + 1); // bars + snapshot + marker
    expect(Number(r.rows_read)).toBeGreaterThan(0);
    expect(r.error_summary).toBeNull();
    expect(r.duration_ms).not.toBeNull();
    expect(r.id).toBe(
      Number((await db.execute("SELECT run_id FROM completion_marker")).rows[0].run_id),
    );
    const d = details(r);
    expect(d.outcome).toBe("complete");
    expect(d.stages.corporate_actions).toBe("stub");
    expect(d.stages.quality).toBe("noop");
    expect(d.file).toMatchObject({ total: 6, valid: 6, out_of_plan: 0 });
  });

  it("stores raw bars first-seen with source and times (DAT-001, DAT-002)", async () => {
    const db = await pipelineDb();
    await go(db, TUE, barsFor([TUE]));
    const row = (await db.execute("SELECT * FROM price_bar WHERE code='ZZA'")).rows[0];
    expect(row).toMatchObject({
      market: "AU",
      d: TUE,
      o: 10,
      h: 11,
      l: 9,
      c: 10.5,
      volume: 1000,
      source: "yahoo_eod",
    });
    expect(String(row.ingested_at)).toBe(at1730Iso(TUE));
    expect(row.published_at).toBe(row.ingested_at); // no publication time known: ingested_at
  });

  it("carries tier, market cap and ADV forward in the snapshot; delisted and unlisted codes are out", async () => {
    const db = await pipelineDb();
    await db.execute("UPDATE instrument SET delisted_on = '2026-10-13' WHERE code = 'ZZC'"); // gone on TUE
    await db.execute(
      "INSERT INTO instrument (market, code, name, listed_on) VALUES ('AU','ZZD','Fut','2027-01-01')",
    );
    await db.execute(
      "INSERT INTO universe_snapshot (market,d,code,status,tier,mcap_est,adv,halted) VALUES ('AU','2026-10-09','ZZA','active','U1',5e9,2e6,0)",
    );
    await go(db, TUE, barsFor([TUE], [...CODES, "ZZD"]));
    const snap = (
      await db.execute(
        "SELECT code, tier, mcap_est, adv, status, halted FROM universe_snapshot WHERE d='2026-10-13' ORDER BY code",
      )
    ).rows;
    expect(snap.map((r) => r.code)).toEqual(["ZZA", "ZZB"]);
    expect(snap[0]).toMatchObject({
      tier: "U1",
      mcap_est: 5e9,
      adv: 2e6,
      status: "active",
      halted: 0,
    });
    expect(snap[1]).toMatchObject({ tier: "U3", mcap_est: null, adv: null });
    // bars of codes outside the universe are not written, and the marker says so
    expect(await count(db, "price_bar", "code IN ('ZZC','ZZD')")).toBe(0);
    const [r] = await runs(db);
    expect(details(r).bars.not_in_universe).toBe(2);
  });
});

/** Every price times k (an OHLC-consistent change), fetched a day later. */
function scaled(rows: ReturnType<typeof barsFor>, k: number) {
  return rows.map((b) => ({
    ...b,
    open: b.open! * k,
    high: b.high! * k,
    low: b.low! * k,
    close: b.close! * k,
    adj_close: b.adj_close! * k,
    fetched_at: "2026-10-14T06:35:00.000Z",
  }));
}

function at1730Iso(date: string) {
  return new Date(at1730(date)).toISOString();
}

describe("idempotency and early exit (PLT-016, PLT-076, DAT-003)", () => {
  it("a second run for the same date is a no-op: no new run record, no writes", async () => {
    const db = await pipelineDb();
    await go(db, TUE, barsFor([MON, TUE]));
    const before = await tableCounts(db);
    const res = await go(db, TUE, barsFor([MON, TUE]));
    expect(res).toMatchObject({ exit: 0, status: "skipped", reason: "already_done", dates: [] });
    expect(await tableCounts(db)).toEqual(before);
  });

  it("a crash after the bars (before the marker) resumes: no duplicates, one marker", async () => {
    const db = await pipelineDb();
    const boom = async () => {
      throw new Error("TOPSECRET driver message libsql://host?authToken=abc");
    };
    const first = await go(db, TUE, barsFor([TUE]), { qualityHook: boom });
    expect(first.exit).toBe(1);
    expect(first.dates[0]).toMatchObject({ status: "failed", error: "quality: unexpected error" });
    expect(await count(db, "price_bar")).toBe(3);
    expect(await count(db, "completion_marker")).toBe(0);
    let [f] = await runs(db);
    expect(f).toMatchObject({ status: "failed", error_summary: "quality: unexpected error" });
    expect(JSON.stringify(f)).not.toContain("TOPSECRET");
    expect(JSON.stringify(f)).not.toContain("authToken");
    // each stage is shown in the failed record: bars done, marker still pending
    expect(details(f).stages.bars.inserted).toBe(3);
    expect(details(f).stages.marker).toBe("pending");

    const second = await go(db, TUE, barsFor([TUE]));
    expect(second).toMatchObject({ exit: 0, status: "ok" });
    expect(await count(db, "price_bar")).toBe(3);
    expect(await count(db, "universe_snapshot")).toBe(3);
    expect(await count(db, "completion_marker")).toBe(1);
    const all = await runs(db);
    expect(all.map((r) => r.status)).toEqual(["failed", "success"]);
    expect(all[1].rows_written).toBe(1); // only the marker is new
    expect(JSON.parse(String(all[1].details_json)).stages.bars.already_stored).toBe(3);
    [f] = all;
  });

  it("a record left 'running' by a killed run is closed by the next run, so the clock can re-dispatch", async () => {
    const db = await pipelineDb();
    await db.execute({
      sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, status)
            VALUES ('ingest-batch1', 'AU', ?, ?, '2026-10-13T06:30:00.000Z', 'running')`,
      args: [`batch1:AU:${TUE}`, TUE],
    });
    expect(await go(db, TUE, barsFor([TUE]))).toMatchObject({ exit: 0, status: "ok" });
    const rs = await runs(db);
    expect(rs.map((r) => r.status)).toEqual(["failed", "success"]);
    expect(rs[0].error_summary).toBe("superseded: the previous run did not finish");
    expect(rs[0].ended_at).not.toBeNull();
  });

  it("says in the run record when the day rests on an unconfirmed or missing calendar row (DAT-160)", async () => {
    const db = await pipelineDb();
    await go(db, TUE, barsFor([TUE]));
    expect(details((await runs(db))[0]).stages.calendar).toEqual({
      trading_day: true,
      covered: true,
      confirmed: false,
    });
    const db2 = await pipelineDb();
    await runBatch1(db2, {
      nowMs: () => Date.parse("2028-03-01T06:30:00Z"),
      barsText: text(barsFor(["2028-03-01"])),
    });
    expect(details((await runs(db2))[0]).stages.calendar).toMatchObject({
      covered: false,
      confirmed: false,
    });
  });

  it("a bar already stored is never overwritten (first-seen immutable)", async () => {
    const db = await pipelineDb();
    await db.execute({
      sql: `INSERT INTO price_bar (market,code,d,o,h,l,c,volume,source,published_at,ingested_at)
            VALUES ('AU','ZZA',?,1,2,1,2,5,'yahoo_eod','x','x')`,
      args: [TUE],
    });
    await go(db, TUE, barsFor([TUE]));
    const row = (await db.execute("SELECT o,c,volume FROM price_bar WHERE code='ZZA'")).rows[0];
    expect(row).toMatchObject({ o: 1, c: 2, volume: 5 });
    expect(await count(db, "price_bar")).toBe(3);
    const [r] = await runs(db);
    expect(details(r).stages.bars).toMatchObject({ valid: 3, inserted: 2, already_stored: 1 });
  });

  it("two racing runs for one date: one success, no duplicate data", async () => {
    const db = await pipelineDb();
    const [a, b] = await Promise.all([go(db, TUE, barsFor([TUE])), go(db, TUE, barsFor([TUE]))]);
    expect(a.exit + b.exit).toBe(0);
    expect(await count(db, "price_bar")).toBe(3);
    expect(await count(db, "completion_marker")).toBe(1);
    const rs = await runs(db);
    expect(rs.filter((r) => r.status === "success")).toHaveLength(1);
    expect(rs.every((r) => ["success", "skipped"].includes(String(r.status)))).toBe(true);
  });
});

describe("re-fetch compare (DAT-002, decision 4)", () => {
  async function twoDays(over: Partial<ReturnType<typeof bar>>, only = "ZZB") {
    const db = await pipelineDb();
    await go(db, TUE, barsFor([TUE])); // the first sighting of TUE
    const refetched = barsFor([TUE]).map((b) =>
      b.code === only ? { ...b, ...over, fetched_at: "2026-10-14T06:35:00.000Z" } : b,
    );
    const res = await go(db, WED, [...refetched, ...barsFor([WED])]);
    return { db, res };
  }

  it("a changed re-fetch gives one bar_refetch row; the original bar is unchanged", async () => {
    const { db, res } = await twoDays({ close: 11.55, high: 12 });
    expect(res.exit).toBe(0);
    const rf = (await db.execute("SELECT * FROM bar_refetch")).rows;
    expect(rf).toHaveLength(1);
    expect(rf[0]).toMatchObject({
      market: "AU",
      code: "ZZB",
      d: TUE,
      fetched_at: "2026-10-14T06:35:00.000Z",
    });
    expect(JSON.parse(String(rf[0].ohlcv_json))).toEqual({
      o: 11,
      h: 12,
      l: 10,
      c: 11.55,
      volume: 1000,
    });
    expect(Number(rf[0].max_diff_pct)).toBeCloseTo(0.434783, 5); // close 11.5 -> 11.55
    const orig = (await db.execute(`SELECT o,h,l,c FROM price_bar WHERE code='ZZB' AND d='${TUE}'`))
      .rows[0];
    expect(orig).toMatchObject({ o: 11, h: 12, l: 10, c: 11.5 });
    expect((await runs(db))[1].rows_written).toBe(3 + 3 + 1 + 1 + 1); // bars, snapshot, marker, refetch, hash
  });

  it("an identical re-fetch stores nothing but the nightly hash, once", async () => {
    const { db } = await twoDays({});
    expect(await count(db, "bar_refetch")).toBe(0);
    const h = (await db.execute("SELECT * FROM ingest_cursor")).rows;
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ job: "refetch_hash", market: "AU", source: `yahoo_eod:${TUE}` });
    expect(JSON.parse(String(h[0].cursor_json))).toMatchObject({ d: TUE, n: 3 });
    expect(JSON.parse(String(h[0].cursor_json)).hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a difference of 0.1 % or less is not stored", async () => {
    const { db } = await twoDays({ close: 11.5 * 1.0009 });
    expect(await count(db, "bar_refetch")).toBe(0);
  });

  it("a differing re-fetch is stored once even if the run is repeated after a crash", async () => {
    const db = await pipelineDb();
    await go(db, TUE, barsFor([TUE]));
    const changed = scaled(barsFor([TUE]), 1.05);
    const boom = async () => {
      throw new Error("x");
    };
    await go(db, WED, [...changed, ...barsFor([WED])], { qualityHook: boom });
    expect(await count(db, "bar_refetch")).toBe(3);
    await go(db, WED, [...changed, ...barsFor([WED])]);
    expect(await count(db, "bar_refetch")).toBe(3);
  });

  it("a stored zero volume against traded volume counts as a difference", async () => {
    const db = await pipelineDb();
    await go(db, TUE, barsFor([TUE], CODES, { volume: 0 }));
    await go(db, WED, [
      ...barsFor([TUE], CODES, { volume: 5, fetched_at: "2026-10-14T06:35:00.000Z" }),
      ...barsFor([WED]),
    ]);
    const rf = (await db.execute("SELECT max_diff_pct FROM bar_refetch")).rows;
    expect(rf).toHaveLength(3);
    expect(Number(rf[0].max_diff_pct)).toBe(100);
  });

  it("the previous session is not compared when it was ingested by the same run", async () => {
    const db2 = await pipelineDb();
    await go(db2, TUE, barsFor([MON, TUE]));
    const res = await go(db2, THU, [...scaled(barsFor([TUE]), 2), ...barsFor([WED, THU])]);
    expect(res.dates.map((d) => d.d)).toEqual([WED, THU]);
    const rs = await runs(db2);
    // WED: the previous session TUE was stored by an earlier run, so it is a real re-fetch (doubled)
    expect(details(rs[1]).refetch).toMatchObject({ compared: 3, differing: 3 });
    // THU: the previous session WED was stored by this very run, so it is not compared again
    expect(details(rs[2]).refetch).toMatchObject({ skipped: "same_run" });
    expect(await count(db2, "bar_refetch")).toBe(3);
  });
});

describe("validation and rejects (DAT-004)", () => {
  it("malformed rows are rejected with counts; valid ones are written; the marker is partial", async () => {
    const db = await pipelineDb();
    const rows = [
      bar("ZZA", TUE),
      bar("ZZB", TUE, { close: 0 }),
      bar("ZZC", TUE, { volume: -3 }),
      bar("ZZA", TUE, { open: 10.2 }), // duplicate key
      { ...bar("ZZB", TUE), date: "2026-02-30" },
      "junk",
    ];
    const res = await go(db, TUE, rows);
    expect(res.exit).toBe(0);
    expect(res.dates[0]).toMatchObject({ bars: 1, rejected: 5, outcome: "partial:1/3" });
    expect(await count(db, "price_bar")).toBe(1);
    const [r] = await runs(db);
    const d = details(r);
    expect(d.bars.rejected).toEqual({
      non_positive_price: 1,
      bad_volume: 1,
      duplicate_key: 1,
      not_an_object: 1,
      bad_date: 1,
    });
    expect(d.file.rejected).toEqual({
      non_positive_price: 1,
      bad_volume: 1,
      duplicate_key: 1,
      bad_date: 1,
      not_an_object: 1,
    });
    expect((await db.execute("SELECT outcome FROM completion_marker")).rows[0].outcome).toBe(
      "partial:1/3",
    );
    // nothing was filled or repaired for the rejected codes
    expect(await count(db, "price_bar", "code IN ('ZZB','ZZC')")).toBe(0);
  });

  it("no valid bar for the date: the run fails visibly and no marker is written", async () => {
    const db = await pipelineDb();
    const res = await go(db, TUE, barsFor([MON])); // bars for another day only
    expect(res.exit).toBe(1);
    expect(res.dates[0]).toMatchObject({
      status: "failed",
      error: "bars: no valid bars for the date",
    });
    expect(await count(db, "completion_marker")).toBe(0);
    expect((await runs(db))[0]).toMatchObject({ status: "failed" });
  });

  it("a missing or malformed bars file fails the date and says so without leaking", async () => {
    for (const [txt, msg] of [
      [null, "validate: bars file missing"],
      ["{ not json", "validate: bars file is not valid JSON"],
      ["{}", "validate: bars file must be a JSON array"],
    ] as const) {
      const db = await pipelineDb();
      const res = await runBatch1(db, { nowMs: () => at1730(TUE), barsText: txt });
      expect(res).toMatchObject({ exit: 1, status: "failed", reason: "validate" });
      const [r] = await runs(db);
      expect(r).toMatchObject({
        status: "failed",
        error_summary: msg,
        concurrency_key: `batch1:AU:${TUE}`,
      });
      expect(await count(db, "price_bar")).toBe(0);
    }
  });
});

describe("gates: market mode, source, universe", () => {
  it("market mode off: skipped with a run record, nothing else", async () => {
    const db = await pipelineDb();
    await db.execute("UPDATE market SET mode = 'off' WHERE code = 'AU'");
    const res = await go(db, TUE, barsFor([TUE]));
    expect(res).toMatchObject({ exit: 0, status: "skipped", reason: "market_off" });
    const [r] = await runs(db);
    expect(r).toMatchObject({ status: "skipped", concurrency_key: `batch1:AU:${TUE}` });
    expect(await count(db, "price_bar")).toBe(0);
    expect(await count(db, "universe_snapshot")).toBe(0);
  });

  it("data_only and full both run", async () => {
    for (const mode of ["data_only", "full"]) {
      const db = await pipelineDb();
      await db.execute({ sql: "UPDATE market SET mode = ? WHERE code = 'AU'", args: [mode] });
      expect((await go(db, TUE, barsFor([TUE]))).status).toBe("ok");
    }
  });

  it("an unknown market row fails visibly", async () => {
    const db = await pipelineDb();
    const res = await runBatch1(db, { nowMs: () => at1730(TUE), barsText: null, market: "ZZ" });
    expect(res).toMatchObject({ exit: 1, status: "failed", reason: "market_missing" });
    expect((await runs(db))[0]).toMatchObject({ error_summary: "config: market_missing" });
  });

  it.each([
    [
      "pending (Owner has not accepted the risk, O-26)",
      "UPDATE source_register SET status='pending' WHERE source='yahoo_eod'",
      "source_not_accepted",
    ],
    [
      "disabled",
      "UPDATE source_register SET status='disabled' WHERE source='yahoo_eod'",
      "source_disabled",
    ],
    [
      "kill switch off (DAT-123)",
      "UPDATE source_status SET mode='off' WHERE source='yahoo_eod'",
      "source_off",
    ],
    [
      "kill switch tripped",
      "UPDATE source_status SET mode='tripped' WHERE source='yahoo_eod'",
      "source_off",
    ],
  ])("source %s: skipped, no data", async (_n, sql, reason) => {
    const db = await pipelineDb();
    await db.execute(sql);
    const res = await go(db, TUE, barsFor([TUE]));
    expect(res).toMatchObject({ exit: 0, status: "skipped", reason });
    expect(await count(db, "price_bar")).toBe(0);
    expect(await count(db, "completion_marker")).toBe(0);
  });

  it("no universe: nothing is written except the 'no universe' run record", async () => {
    const db = await pipelineDb({ codes: [] });
    const before = await tableCounts(db);
    const res = await go(db, TUE, barsFor([TUE]));
    expect(res).toMatchObject({ exit: 0, status: "skipped", reason: "no_universe" });
    const after = await tableCounts(db);
    expect({ ...after, run_record: 0 }).toEqual({ ...before, run_record: 0 });
    const [r] = await runs(db);
    expect(r).toMatchObject({ status: "skipped", rows_written: 0 });
    expect(details(r)).toEqual({ reason: "no_universe" });
  });

  it("an instrument code the fetcher could not accept is left out and counted by prepare", async () => {
    const db = await pipelineDb({ codes: ["ZZA", "bad code!"] });
    const p = await prepareBatch1(db, { nowMs: at1730(TUE) });
    expect(p).toMatchObject({ action: "fetch", codes: 1, excluded: 1 });
  });
});

describe("non-trading days and the calendar (DAT-022, DAT-160)", () => {
  it("a weekend: non-trading marker, skipped run, no bars needed", async () => {
    const db = await pipelineDb();
    const res = await go(db, SAT, null);
    expect(res).toMatchObject({ exit: 0, status: "ok" });
    expect(res.dates[0]).toMatchObject({ d: SAT, status: "non_trading" });
    const m = (await db.execute("SELECT * FROM completion_marker")).rows;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ d: SAT, kind: "non-trading", outcome: "non-trading" });
    const [r] = await runs(db);
    expect(r).toMatchObject({ status: "skipped", rows_written: 1 });
    expect(details(r).reason).toBe("non_trading_day");
    expect(await count(db, "price_bar")).toBe(0);
    // a rerun finds the marker and does nothing
    expect((await go(db, SAT, null)).dates).toEqual([]);
    expect(await count(db, "run_record")).toBe(1);
  });

  it("a seeded holiday is non-trading even on a weekday", async () => {
    const db = await pipelineDb();
    const res = await runBatch1(db, {
      nowMs: () => Date.parse("2026-12-25T06:30:00Z"),
      barsText: null,
    });
    expect(res.dates[0]).toMatchObject({ d: "2026-12-25", status: "non_trading" });
  });

  it("an early-close day is a trading day", async () => {
    const db = await pipelineDb();
    const res = await runBatch1(db, {
      nowMs: () => Date.parse("2026-12-24T06:30:00Z"),
      barsText: text(barsFor(["2026-12-24"])),
    });
    expect(res.dates[0]).toMatchObject({ d: "2026-12-24", status: "ok" });
  });

  it("a non-trading target runs after the missed trading dates before it", async () => {
    const db = await pipelineDb();
    await go(db, FRI, barsFor([THU, FRI]));
    const res = await go(
      db,
      "2026-10-25",
      barsFor(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]),
      { maxDates: 6 },
    );
    expect(res.dates.map((d) => `${d.d}:${d.status}`)).toEqual([
      "2026-10-19:ok",
      "2026-10-20:ok",
      "2026-10-21:ok",
      "2026-10-22:ok",
      "2026-10-23:ok",
      "2026-10-25:non_trading",
    ]);
  });
});

describe("catch-up (PLT-016, decision 13)", () => {
  it("three missed dates are processed oldest first, each with its own record and marker", async () => {
    const db = await pipelineDb();
    await go(db, MON, barsFor([MON]));
    const res = await go(db, FRI, barsFor([MON, TUE, WED, THU, FRI]));
    expect(res.status).toBe("ok");
    expect(res.dates.map((d) => `${d.d}:${d.status}`)).toEqual([
      `${TUE}:ok`,
      `${WED}:ok`,
      `${THU}:ok`,
      `${FRI}:ok`,
    ]);
    const rs = await runs(db);
    expect(rs.map((r) => r.scheduled_for)).toEqual([MON, TUE, WED, THU, FRI]);
    expect(rs.map((r) => r.status)).toEqual(Array(5).fill("success"));
    expect(rs.map((r) => r.concurrency_key)).toEqual(
      [MON, TUE, WED, THU, FRI].map((d) => `batch1:AU:${d}`),
    );
    const markers = (await db.execute("SELECT d FROM completion_marker ORDER BY d")).rows.map(
      (r) => r.d,
    );
    expect(markers).toEqual([MON, TUE, WED, THU, FRI]);
    // a past day's snapshot cannot be recovered, so only the live date has one
    expect(
      (await db.execute("SELECT DISTINCT d FROM universe_snapshot ORDER BY d")).rows.map(
        (r) => r.d,
      ),
    ).toEqual([MON, FRI]);
    expect(details(rs[1]).stages.universe).toBe("snapshot_not_recoverable");
    expect(await count(db, "price_bar")).toBe(15);
    expect(details(rs[1]).file.out_of_plan).toBe(0);
  });

  it("a gap in the middle is recovered; a long backlog is bounded and the target is kept", async () => {
    const db = await pipelineDb();
    await go(db, MON, barsFor([MON]));
    await go(db, WED, barsFor([TUE, WED]), { maxDates: 1 }); // only the target: TUE stays missing
    const gap = (await db.execute("SELECT d FROM completion_marker ORDER BY d")).rows.map(
      (r) => r.d,
    );
    expect(gap).toEqual([MON, WED]);
    const res = await go(db, FRI, barsFor([MON, TUE, WED, THU, FRI]), { maxDates: 2 });
    expect(res.dates.map((d) => d.d)).toEqual([TUE, FRI]);
    expect(res).toMatchObject({ status: "degraded", remaining: 1 }); // THU waits for the next run
    const res2 = await go(db, FRI, barsFor([THU, FRI]), { maxDates: 2 });
    expect(res2).toMatchObject({ status: "skipped", reason: "already_done" }); // FRI is done
  });

  it("the monthly write cap stops catch-up, is recorded, and the live date still runs", async () => {
    const db = await pipelineDb();
    await go(db, MON, barsFor([MON]));
    const res = await go(db, FRI, barsFor([TUE, WED, THU, FRI]), { writeCap: 12 });
    expect(res.status).toBe("degraded");
    expect(res.capStopped).toBe(true);
    expect(res.dates.map((d) => `${d.d}:${d.status}`)).toEqual([
      `${TUE}:ok`,
      `${WED}:cap`,
      `${FRI}:ok`,
    ]);
    const rs = await runs(db);
    const capRec = rs.find((r) => r.scheduled_for === WED)!;
    expect(capRec).toMatchObject({
      status: "skipped",
      error_summary: "backfill write cap reached",
    });
    expect(details(capRec)).toMatchObject({ reason: "write_cap", cap: 12 });
    expect(rs.find((r) => r.scheduled_for === THU)).toBeUndefined(); // stopped, not walked through
    expect(await count(db, "completion_marker", `d IN ('${WED}','${THU}')`)).toBe(0);
    expect(await count(db, "price_bar", `d='${FRI}'`)).toBe(3);
  });

  it("writes from earlier runs this month count against the cap; other months do not", async () => {
    const db = await pipelineDb();
    await go(db, MON, barsFor([MON]));
    // pretend this month's earlier runs already wrote 1,999,996 rows
    await db.execute("UPDATE run_record SET rows_written = 1999996");
    const capped = await go(db, THU, barsFor([TUE, WED, THU]));
    expect(capped.capStopped).toBe(true);
    expect(capped.dates.map((d) => d.status)).toEqual(["cap", "ok"]);

    const db2 = await pipelineDb();
    await go(db2, MON, barsFor([MON]));
    await db2.execute(
      "UPDATE run_record SET rows_written = 1999996, started_at = '2026-09-30T10:00:00.000Z'",
    );
    const fine = await go(db2, THU, barsFor([TUE, WED, THU]));
    expect(fine.capStopped).toBe(false);
    expect(fine.dates.map((d) => d.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("a catch-up date with no universe is skipped (not failed) and gets no marker", async () => {
    const db = await pipelineDb();
    await go(db, MON, barsFor([MON]));
    await db.execute("UPDATE instrument SET listed_on = '2026-10-15'"); // listed from THU
    const res = await go(db, THU, barsFor([TUE, WED, THU]));
    expect(res.dates.map((d) => `${d.d}:${d.status}`)).toEqual([
      `${TUE}:no_universe`,
      `${WED}:no_universe`,
      `${THU}:ok`,
    ]);
    expect(res.exit).toBe(0);
    expect(await count(db, "completion_marker", `d IN ('${TUE}','${WED}')`)).toBe(0);
  });

  it("a failed older date does not stop the later ones and the run exits 1", async () => {
    const db = await pipelineDb();
    await go(db, MON, barsFor([MON]));
    const res = await go(db, WED, barsFor([WED])); // TUE has no bars at all
    expect(res.exit).toBe(1);
    expect(res.dates.map((d) => `${d.d}:${d.status}`)).toEqual([`${TUE}:failed`, `${WED}:ok`]);
    // the next day it is retried (still inside the look-back) and fails visibly again
    const again = await go(db, THU, barsFor([THU]));
    expect(again.dates.map((d) => `${d.d}:${d.status}`)).toEqual([`${TUE}:failed`, `${THU}:ok`]);
  });
});

describe("data-only mode (BLD-024)", () => {
  it("a full run changes only market-data tables and its own run record", async () => {
    const db = await pipelineDb();
    await go(db, MON, barsFor([MON]));
    const before = await tableCounts(db);
    await go(db, WED, barsFor([TUE, WED]));
    const after = await tableCounts(db);
    const changed = Object.keys(after)
      .filter((t) => after[t] !== before[t])
      .sort();
    expect(changed).toEqual(
      [
        "bar_refetch",
        "completion_marker",
        "price_bar",
        "run_record",
        "universe_snapshot",
        "ingest_cursor",
      ]
        .filter((t) => after[t] !== before[t])
        .sort(),
    );
    for (const t of [
      "config_version",
      "app_log",
      "incident",
      "announcement",
      "corporate_action",
      "worker_state",
      "instrument",
      "data_quality_flag",
      "quality_score",
      "source_register",
      "source_status",
      "market",
      "trading_calendar",
      "backfill_job",
      "asx_rate_token",
    ]) {
      expect(after[t], t).toBe(before[t]);
    }
  });

  it("the market, source and instrument rows are not modified", async () => {
    const db = await pipelineDb();
    const snap = async () =>
      JSON.stringify([
        (await db.execute("SELECT * FROM market")).rows,
        (await db.execute("SELECT * FROM source_register")).rows,
        (await db.execute("SELECT * FROM source_status")).rows,
        (await db.execute("SELECT * FROM instrument")).rows,
      ]);
    const before = await snap();
    await go(db, TUE, barsFor([TUE]));
    expect(await snap()).toBe(before);
  });
});

describe("quality hook (T7 plugs in)", () => {
  it("the default hook is a no-op and a custom hook receives counts and the rejects of the date", async () => {
    expect(await noopQualityHook({} as QualityHookContext)).toEqual({ flags: 0 });
    const db = await pipelineDb();
    let seen: Record<string, unknown> | null = null;
    const res = await go(
      db,
      TUE,
      [...barsFor([TUE]), bar("ZZA", TUE, { close: 0 }), bar("ZZB", MON)],
      {
        qualityHook: async (ctx) => {
          seen = {
            d: ctx.d,
            universe: ctx.universe,
            barsValid: ctx.barsValid,
            rejected: ctx.rejected.length,
            diffs: ctx.refetchDiffs.length,
          };
          ctx.io.written += 2;
          return { flags: 2 };
        },
      },
    );
    expect(seen).toEqual({ d: TUE, universe: 3, barsValid: 3, rejected: 1, diffs: 0 });
    const [r] = await runs(db);
    expect(details(r).stages.quality).toEqual({ flags: 2 });
    expect(r.rows_written).toBe(3 + 3 + 1 + 2);
    expect(res.exit).toBe(0);
  });

  it("the nine stages are named in order", () => {
    expect([...STAGE_NAMES]).toEqual([
      "calendar",
      "universe",
      "bars",
      "corporate_actions",
      "announcements",
      "macro_and_other",
      "fundamentals",
      "quality",
      "marker",
    ]);
    expect(new StageError("bars", "x").message).toBe("bars: x");
    expect(new StageError("bars").message).toBe("bars");
  });
});

describe("prepare (read-only plan for the fetch step)", () => {
  it("asks for the universe, one session back (the D-1 re-fetch) through the target", async () => {
    const db = await pipelineDb();
    const before = await tableCounts(db);
    const p = await prepareBatch1(db, { nowMs: at1730(TUE) });
    expect(p).toMatchObject({
      action: "fetch",
      target: TUE,
      dates: 1,
      codes: 3,
      request: { codes: CODES, start: MON, end: TUE },
      throttle: { chunkSize: 100, minGapS: 5 },
    });
    expect(await tableCounts(db)).toEqual(before); // read-only
  });

  it("on Monday the previous session is Friday; across a holiday it skips the holiday", async () => {
    const db = await pipelineDb();
    const mon = await prepareBatch1(db, { nowMs: at1730(MON) });
    expect(mon).toMatchObject({ request: { start: "2026-10-09", end: MON } });
    const boxing = await prepareBatch1(db, { nowMs: Date.parse("2026-12-29T06:30:00Z") });
    expect(boxing).toMatchObject({ request: { start: "2026-12-24", end: "2026-12-29" } }); // 25 and 28 are holidays
  });

  it("catch-up widens the window to the oldest missed session", async () => {
    const db = await pipelineDb();
    await go(db, MON, barsFor([MON]));
    const p = await prepareBatch1(db, { nowMs: at1730(THU) });
    expect(p).toMatchObject({ action: "fetch", dates: 3, request: { start: MON, end: THU } });
  });

  it("skips with the reason when there is nothing to fetch", async () => {
    const db = await pipelineDb({ codes: [] });
    expect(await prepareBatch1(db, { nowMs: at1730(TUE) })).toEqual({
      action: "skip",
      target: TUE,
      reason: "no_universe",
    });
    const db2 = await pipelineDb();
    await go(db2, TUE, barsFor([TUE]));
    expect(await prepareBatch1(db2, { nowMs: at1730(TUE) })).toEqual({
      action: "skip",
      target: TUE,
      reason: "already_done",
    });
    const db3 = await pipelineDb();
    expect(await prepareBatch1(db3, { nowMs: at1730(SAT) })).toEqual({
      action: "nothing_to_fetch",
      target: SAT,
      dates: 1,
    });
    await db3.execute("UPDATE market SET mode='off' WHERE code='AU'");
    expect(await prepareBatch1(db3, { nowMs: at1730(SAT) })).toMatchObject({
      action: "skip",
      reason: "market_off",
    });
    const db5 = await pipelineDb();
    await db5.execute("UPDATE source_status SET mode='off' WHERE source='yahoo_eod'");
    expect(await prepareBatch1(db5, { nowMs: at1730(TUE) })).toMatchObject({
      action: "skip",
      reason: "source_off",
    });
  });

  it("reads the Owner-editable throttle from config, ignoring out-of-range values", async () => {
    const db = await pipelineDb();
    const put = (key: string, v: unknown) =>
      db.execute({
        sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES (?, 'global', ?, '2026-10-01T00:00:00.000Z')",
        args: [key, JSON.stringify(v)],
      });
    await put("yahoo_chunk_size", 50);
    await put("yahoo_min_gap_s", 7);
    expect(await readThrottle(db)).toEqual({ chunkSize: 50, minGapS: 7 });
    await put("yahoo_chunk_size", 5000); // newest wins but is out of bounds
    await db.execute({
      sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('yahoo_min_gap_s','global','not json','2026-10-02T00:00:00.000Z')",
    });
    expect(await readThrottle(db)).toEqual({ chunkSize: 100, minGapS: 5 });
  });
});
