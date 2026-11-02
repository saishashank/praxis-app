// @vitest-environment node
// History backfill engine against a real local libSQL file and synthetic data (M2 T9; DAT-125,
// DAT-125a, DAT-140, DAT-142, DAT-001, AT-09, decisions 7 and 13 of D-057). No network.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitAsxDay,
  commitHistoryMonth,
  ensureJobs,
  exportAsxMonths,
  getJob,
  initialCursor,
  monthUsage,
  planAsic,
  readState,
} from "@/lib/data/backfill/engine.mjs";
import {
  ADMIN_WRITES,
  JOB_ASIC,
  JOB_ASX,
  announcementWrites,
  parseAsicCsv,
  visibleAt,
} from "@/lib/data/backfill/rules.mjs";
import { cleanupTempDbs } from "../db/helpers";
import {
  NOW,
  SHA,
  addBatch1Usage,
  annId,
  asicCsv,
  backfillDb,
  count,
  fakeStore,
  item,
  items,
  jobRow,
  killOnBatch,
  rowsOf,
  type Row,
  runs,
  stateOf,
  sydneyIso,
} from "./helpers";

afterEach(cleanupTempDbs);

const MON = "2026-10-12";
const FRI = "2026-10-09";
const ASX_KEY = "history-asx_announcements-2026/asx_announcements-2026-09.jsonl.gz";
const ASIC_SEP = "history-asic_short_interest-2026/asic_short_interest-2026-09.jsonl.gz";

const asicRows = (dates: string[]) =>
  dates.flatMap((d) => {
    const p = parseAsicCsv(asicCsv(), d);
    if ("error" in p) throw new Error("fixture");
    return p.rows;
  });

const day = (db: Client, date: string, n: number, o: Record<string, unknown> = {}) =>
  commitAsxDay(db, { date, items: items(date, n), nowMs: NOW, commitSha: SHA, ...o });

async function seedAnn(db: Client, date: string, n: number, publishedAt?: string) {
  for (let i = 0; i < n; i++) {
    const it = item(date, i);
    await db.execute({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type,
              price_sensitive, title, url, source)
            VALUES ('AU', ?, ?, ?, ?, ?, 0, ?, NULL, 'asx_announcements')`,
      args: [
        it.code,
        it.annId,
        publishedAt ?? it.publishedAt,
        "2026-10-13T00:00:00.000Z",
        it.type,
        it.title,
      ],
    });
  }
}

async function setCursor(db: Client, name: string, nextDate: string | null, done = 0) {
  await db.execute({
    sql: "UPDATE backfill_job SET next_date = ?, done = ? WHERE name = ?",
    args: [nextDate, done, name],
  });
}

describe("job setup", () => {
  it("starts ASX at the last weekday and ASIC at the end of the last complete month", async () => {
    expect(initialCursor(JOB_ASX, NOW)).toBe(MON);
    expect(initialCursor(JOB_ASIC, NOW)).toBe("2026-09-30");
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    expect((await jobRow(db, JOB_ASX)).next_date).toBe(MON);
    expect((await jobRow(db, JOB_ASIC)).next_date).toBe("2026-09-30");
    expect(await getJob(db, "missing")).toBeNull();
  });

  it("ensureJobs never moves a cursor that has progressed (idempotent)", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    await setCursor(db, JOB_ASX, "2026-01-02");
    await ensureJobs(db, NOW + 86_400_000 * 40);
    expect((await jobRow(db, JOB_ASX)).next_date).toBe("2026-01-02");
    expect(await count(db, "backfill_job")).toBe(2);
  });

  it("a corrupt stored state reads as new", async () => {
    const db = await backfillDb();
    for (const bad of ["not json", "[1]", "5"]) {
      await db.execute({
        sql: `INSERT INTO ingest_cursor (job, market, source, cursor_json, updated_at)
              VALUES ('backfill:asx_announcements', 'AU', 'asx_announcements', ?, 'x')
              ON CONFLICT (job, market, source) DO UPDATE SET cursor_json = excluded.cursor_json`,
        args: [bad],
      });
      expect(await readState(db, JOB_ASX)).toEqual({ status: "new" });
    }
  });
});

describe("ASX announcements by date (DAT-125)", () => {
  it("writes the day, moves the cursor, records counted writes, in one batch", async () => {
    const db = await backfillDb();
    const r = await day(db, MON, 5);
    expect(r).toMatchObject({
      status: "ok",
      rows: 5,
      counted: announcementWrites(5),
      nextDate: FRI,
    });
    expect(announcementWrites(5)).toBe(13 + ADMIN_WRITES);
    expect(await count(db, "announcement")).toBe(5);
    const job = await jobRow(db, JOB_ASX);
    expect(job).toMatchObject({ next_date: FRI, done: 0, rows_written_month: 17 });
    const [rec] = await runs(db);
    expect(rec).toMatchObject({
      job: "backfill-history",
      market: "AU",
      concurrency_key: `backfill-history:asx_announcements:${MON}`,
      status: "success",
      items_processed: 5,
      rows_written: 17,
      llm_tokens: 0,
      commit_sha: SHA,
    });
    expect(await stateOf(db, JOB_ASX)).toMatchObject({
      status: "active",
      writes_month: "2026-10",
      last_date: MON,
    });
    // announcements are stored with the spec's metadata and the ASX source id
    const a = (await db.execute("SELECT * FROM announcement ORDER BY id LIMIT 1")).rows[0];
    expect(a).toMatchObject({
      market: "AU",
      source: "asx_announcements",
      title: "Synthetic announcement 0",
    });
    expect(a.ann_id).toBe(items(MON, 1)[0].annId);
    // GL-05: a backfilled row stores the time of the backfill, so a replay of its own day drops it
    expect(a.first_ingested_at).toBe(new Date(NOW).toISOString());
    expect(a.first_ingested_at).toBe(a.ingested_at);
  });

  it("counts rejected items by reason and stores nothing for them", async () => {
    const db = await backfillDb();
    const good = items(MON, 2);
    const r = await commitAsxDay(db, {
      date: MON,
      nowMs: NOW,
      items: [
        ...good,
        good[0], // duplicate
        item(MON, 7, { code: "bad!" }),
        item(MON, 8, { publishedAt: sydneyIso("2026-10-13") }), // another day
        "garbage",
      ],
    });
    expect(r).toMatchObject({
      status: "ok",
      rows: 2,
      rejected: { duplicate: 1, bad_code: 1, wrong_date: 1, not_an_object: 1 },
    });
    expect(await count(db, "announcement")).toBe(2);
  });

  it("creates the job rows itself when they are missing", async () => {
    const db = await backfillDb();
    expect(await count(db, "backfill_job")).toBe(0);
    expect((await day(db, MON, 1)).status).toBe("ok");
    expect(await count(db, "backfill_job")).toBe(2);
  });

  it("walks backwards over weekends, one weekday per commit", async () => {
    const db = await backfillDb();
    await day(db, MON, 1);
    expect((await jobRow(db, JOB_ASX)).next_date).toBe(FRI); // not Sunday the 11th
    await day(db, FRI, 1);
    expect((await jobRow(db, JOB_ASX)).next_date).toBe("2026-10-08");
  });

  it("an empty day (holiday) still advances the cursor and writes only bookkeeping", async () => {
    const db = await backfillDb();
    const r = await day(db, MON, 0);
    expect(r).toMatchObject({ status: "ok", rows: 0, counted: ADMIN_WRITES });
    expect((await jobRow(db, JOB_ASX)).next_date).toBe(FRI);
    expect(await count(db, "announcement")).toBe(0);
  });

  it("rejects bad input and oversize days before touching the database", async () => {
    const db = await backfillDb();
    expect(await commitAsxDay(db, { date: "2026-13-01", items: [], nowMs: NOW })).toMatchObject({
      status: "rejected",
      reason: "bad_input",
    });
    expect(
      await commitAsxDay(db, { date: MON, items: "x" as unknown as [], nowMs: NOW }),
    ).toMatchObject({
      status: "rejected",
    });
    expect(
      await commitAsxDay(db, { date: MON, items: new Array(5001).fill(0), nowMs: NOW }),
    ).toMatchObject({ status: "rejected", reason: "too_many_items" });
    expect(await count(db, "backfill_job")).toBe(0);
  });

  it("a date that is not the cursor is not written", async () => {
    const db = await backfillDb();
    await day(db, MON, 1);
    expect(await day(db, MON, 1)).toEqual({ status: "already_done" });
    expect(await day(db, "2026-10-13", 1)).toEqual({ status: "already_done" });
    expect(await day(db, "2026-10-07", 1)).toEqual({ status: "out_of_order", expected: FRI });
    expect(await count(db, "announcement")).toBe(1);
    expect(await count(db, "run_record", "job = 'backfill-history'")).toBe(1);
  });

  it("reaching the floor marks the job done; later commits do nothing", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    await setCursor(db, JOB_ASX, "2020-10-14");
    expect(await day(db, "2020-10-14", 1)).toMatchObject({
      status: "ok",
      done: false,
      nextDate: "2020-10-13",
    });
    expect(await day(db, "2020-10-13", 1)).toMatchObject({
      status: "ok",
      done: true,
      nextDate: null,
    });
    expect(await jobRow(db, JOB_ASX)).toMatchObject({ next_date: null, done: 1 });
    expect(await stateOf(db, JOB_ASX)).toMatchObject({ status: "done", reason: "floor" });
    expect(await day(db, "2020-10-12", 1)).toEqual({ status: "done" });
    // rows older than the news retention are accepted (they live on in history files, DAT-142)
    expect(await count(db, "announcement", "published_at < '2021-01-01'")).toBe(2);
  });

  it("the month counter restarts when the quota month turns", async () => {
    const db = await backfillDb();
    await day(db, MON, 5);
    await day(db, FRI, 5);
    expect((await jobRow(db, JOB_ASX)).rows_written_month).toBe(34);
    await commitAsxDay(db, {
      date: "2026-10-08",
      items: items("2026-10-08", 5),
      nowMs: NOW + 25 * 86_400_000,
    });
    expect((await jobRow(db, JOB_ASX)).rows_written_month).toBe(17);
  });
});

describe("kill mid-chunk and resume (PLT-016, DAT-003)", () => {
  it("killed before the batch commits: nothing is written, the resume writes once", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    const { db: dying } = killOnBatch(db);
    await expect(day(dying, MON, 5)).rejects.toThrow("killed");
    expect(await count(db, "announcement")).toBe(0);
    expect((await jobRow(db, JOB_ASX)).next_date).toBe(MON);
    expect(await count(db, "run_record", "job = 'backfill-history'")).toBe(0);

    expect((await day(db, MON, 5)).status).toBe("ok");
    expect(await count(db, "announcement")).toBe(5);
    expect(await count(db, "run_record", "job = 'backfill-history'")).toBe(1);
  });

  it("killed right after the commit: the resume sees the cursor and adds nothing", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    const { db: dying } = killOnBatch(db, { after: true });
    await expect(day(dying, MON, 5)).rejects.toThrow("killed");
    expect(await count(db, "announcement")).toBe(5);
    expect(await day(db, MON, 5)).toEqual({ status: "already_done" });
    expect(await count(db, "announcement")).toBe(5);
    expect((await jobRow(db, JOB_ASX)).rows_written_month).toBe(17);
  });

  it("two runs racing for the same date: the second finds the unique success record", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    // Make the cursor look unmoved for the loser by pre-inserting the winner's run record only.
    await db.execute({
      sql: `INSERT INTO run_record (job, market, concurrency_key, started_at, status)
            VALUES ('backfill-history', 'AU', ?, ?, 'success')`,
      args: [`backfill-history:asx_announcements:${MON}`, "2026-10-13T00:00:00.000Z"],
    });
    expect(await day(db, MON, 5)).toEqual({ status: "already_done" });
    expect(await count(db, "announcement")).toBe(0); // the loser's batch rolled back as a whole
  });

  it("a database error other than a constraint is not swallowed", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    await db.execute("DROP TABLE announcement");
    await expect(day(db, MON, 1)).rejects.toThrow();
  });
});

describe("write cap (decision 13: 2M writes a month, paused_cap)", () => {
  it("stops cleanly with status paused_cap and writes nothing for the chunk", async () => {
    const db = await backfillDb();
    expect((await day(db, MON, 5, { cap: 20 })).status).toBe("ok"); // 17 of 20
    const r = await day(db, FRI, 5, { cap: 20 });
    expect(r).toEqual({ status: "paused_cap", used: 17, cap: 20, needed: 17 });
    expect(await count(db, "announcement")).toBe(5);
    expect((await jobRow(db, JOB_ASX)).next_date).toBe(FRI);
    expect(await stateOf(db, JOB_ASX)).toMatchObject({ status: "paused_cap", reason: "write_cap" });
    // the status is written once, not on every call
    const before = await db.execute(
      "SELECT updated_at FROM ingest_cursor WHERE job = 'backfill:asx_announcements'",
    );
    await day(db, FRI, 5, { cap: 20, nowMs: NOW + 60_000 });
    const after = await db.execute(
      "SELECT updated_at FROM ingest_cursor WHERE job = 'backfill:asx_announcements'",
    );
    expect(after.rows[0].updated_at).toBe(before.rows[0].updated_at);
  });

  it("uses the same counter as batch 1: its writes in the month count against the 2M", async () => {
    const db = await backfillDb();
    await addBatch1Usage(db, 1_999_990);
    expect(await monthUsage(db, NOW)).toBe(1_999_990);
    expect((await day(db, MON, 5)).status).toBe("paused_cap"); // 17 would pass 2,000,000
    expect((await day(db, MON, 0)).status).toBe("ok"); // 4 fits under the cap
  });

  it("exactly at the cap is allowed, one over is not", async () => {
    const db = await backfillDb();
    await addBatch1Usage(db, 2_000_000 - 17);
    expect((await day(db, MON, 5)).status).toBe("ok");
    expect(await monthUsage(db, NOW)).toBe(2_000_000);
    expect((await day(db, FRI, 0)).status).toBe("paused_cap");
  });

  it("only the current UTC month counts; the job resumes by itself next month", async () => {
    const db = await backfillDb();
    await addBatch1Usage(db, 2_000_000, "2026-09-30T23:00:00.000Z");
    expect(await monthUsage(db, NOW)).toBe(0);
    await addBatch1Usage(db, 2_000_000);
    expect((await day(db, MON, 5)).status).toBe("paused_cap");
    const nextMonth = Date.parse("2026-11-03T06:30:00.000Z");
    expect(await monthUsage(db, nextMonth)).toBe(0);
    expect((await day(db, MON, 5, { nowMs: nextMonth })).status).toBe("ok");
    expect(await stateOf(db, JOB_ASX)).toMatchObject({ status: "active", reason: null });
  });

  it("pauses the other jobs too (one counter for everything)", async () => {
    const db = await backfillDb();
    await addBatch1Usage(db, 2_000_000);
    const store = fakeStore();
    expect(await planAsic(db, { nowMs: NOW })).toEqual({ action: "none", reason: "paused_cap" });
    expect(await stateOf(db, JOB_ASIC)).toMatchObject({ status: "paused_cap" });
    expect(
      await commitHistoryMonth(db, {
        month: "2026-09",
        rows: asicRows(["2026-09-30"]),
        store,
        nowMs: NOW,
      }),
    ).toMatchObject({ status: "paused_cap" });
    expect(store.calls).toHaveLength(0); // no file is written while paused
    await seedAnn(db, "2026-09-10", 1);
    await setCursor(db, JOB_ASX, "2026-07-31");
    expect(await exportAsxMonths(db, { store, nowMs: NOW, maxMonths: 1 })).toMatchObject({
      stopped: "paused_cap",
    });
    expect(store.calls).toHaveLength(0);
  });
});

describe("source switches (DAT-123, DAT-127)", () => {
  it.each(["off", "tripped"])("a source that is %s is not fetched or written", async (mode) => {
    const db = await backfillDb();
    await db.execute({
      sql: "UPDATE source_status SET mode = ? WHERE source = 'asx_announcements'",
      args: [mode],
    });
    expect(await day(db, MON, 5)).toEqual({ status: "source_off" });
    expect(await count(db, "announcement")).toBe(0);
    expect(await stateOf(db, JOB_ASX)).toMatchObject({ status: "source_off", reason: mode });
  });

  it("ASIC off: no plan and no commit", async () => {
    const db = await backfillDb();
    await db.execute("UPDATE source_status SET mode = 'off' WHERE source = 'asic_short'");
    const store = fakeStore();
    expect(await planAsic(db, { nowMs: NOW })).toEqual({ action: "none", reason: "source_off" });
    expect(
      await commitHistoryMonth(db, {
        month: "2026-09",
        rows: asicRows(["2026-09-30"]),
        store,
        nowMs: NOW,
      }),
    ).toEqual({ status: "source_off" });
    expect(store.calls).toHaveLength(0);
  });
});

describe("ASIC short interest into history files (DAT-125a, decision 7)", () => {
  it("writes the month file, moves the cursor, writes nothing else to Turso", async () => {
    const db = await backfillDb();
    const store = fakeStore();
    const rows = asicRows(["2026-09-29", "2026-09-30"]);
    const r = await commitHistoryMonth(db, {
      month: "2026-09",
      rows,
      store,
      nowMs: NOW,
      commitSha: SHA,
    });
    expect(r).toMatchObject({
      status: "ok",
      rows: 4,
      file: "uploaded",
      nextDate: "2026-08-31",
      done: false,
    });
    expect([...store.files.keys()]).toEqual([ASIC_SEP]);
    const back = rowsOf(store.files.get(ASIC_SEP)!);
    expect(back).toHaveLength(4);
    expect(back.map((x) => `${x.as_of}|${x.code}`)).toEqual([
      "2026-09-29|ZZA",
      "2026-09-29|ZZB",
      "2026-09-30|ZZA",
      "2026-09-30|ZZB",
    ]);
    expect(
      back.every((x) => x.assumed_time === true && x.published_at > `${x.as_of}T23:59:59Z`),
    ).toBe(true);
    expect(await jobRow(db, JOB_ASIC)).toMatchObject({
      next_date: "2026-08-31",
      done: 0,
      rows_written_month: ADMIN_WRITES,
    });
    const [rec] = await runs(db);
    expect(rec).toMatchObject({
      concurrency_key: "backfill-history:asic_short_interest:2026-09",
      rows_written: ADMIN_WRITES,
      items_processed: 4,
      commit_sha: SHA,
    });
    expect(JSON.parse(String(rec.details_json)).file.result).toBe("uploaded");
    expect(await count(db, "announcement")).toBe(0); // files only, Turso keeps no ASIC history
  });

  it("the same input always gives the same file (so a re-run can skip it)", async () => {
    const rows = asicRows(["2026-09-30", "2026-09-29"]); // unsorted input
    const a = fakeStore();
    const b = fakeStore();
    await commitHistoryMonth(await backfillDb(), { month: "2026-09", rows, store: a, nowMs: NOW });
    await commitHistoryMonth(await backfillDb(), {
      month: "2026-09",
      rows: [...rows].reverse(),
      store: b,
      nowMs: NOW,
    });
    expect(Buffer.from(a.files.get(ASIC_SEP)!).equals(Buffer.from(b.files.get(ASIC_SEP)!))).toBe(
      true,
    );
  });

  it("killed after the upload, before the cursor: the resume skips the upload and moves on", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    const store = fakeStore();
    const rows = asicRows(["2026-09-30"]);
    const { db: dying } = killOnBatch(db);
    await expect(
      commitHistoryMonth(dying, { month: "2026-09", rows, store, nowMs: NOW }),
    ).rejects.toThrow("killed");
    expect(store.files.size).toBe(1);
    expect((await jobRow(db, JOB_ASIC)).next_date).toBe("2026-09-30");

    const r = await commitHistoryMonth(db, { month: "2026-09", rows, store, nowMs: NOW });
    expect(r).toMatchObject({ status: "ok", file: "skipped", nextDate: "2026-08-31" });
    expect(store.files.size).toBe(1);
    expect(store.calls).toHaveLength(2);
    expect(await count(db, "run_record", "job = 'backfill-history'")).toBe(1);
  });

  it("a month already committed is not written again", async () => {
    const db = await backfillDb();
    const store = fakeStore();
    const rows = asicRows(["2026-09-30"]);
    await commitHistoryMonth(db, { month: "2026-09", rows, store, nowMs: NOW });
    expect(await commitHistoryMonth(db, { month: "2026-09", rows, store, nowMs: NOW })).toEqual({
      status: "already_done",
    });
    expect(await commitHistoryMonth(db, { month: "2026-07", rows, store, nowMs: NOW })).toEqual({
      status: "out_of_order",
      expected: "2026-08",
    });
    expect(store.calls).toHaveLength(1);
  });

  it("a different file already in the data repo is a conflict: not replaced, cursor stays", async () => {
    const db = await backfillDb();
    const old = new Uint8Array([9, 9, 9]);
    const store = fakeStore({ [ASIC_SEP]: old });
    const r = await commitHistoryMonth(db, {
      month: "2026-09",
      rows: asicRows(["2026-09-30"]),
      store,
      nowMs: NOW,
    });
    expect(r).toEqual({ status: "conflict" });
    expect(store.files.get(ASIC_SEP)).toBe(old);
    expect((await jobRow(db, JOB_ASIC)).next_date).toBe("2026-09-30");
    expect(await stateOf(db, JOB_ASIC)).toMatchObject({
      status: "failed",
      reason: "history_conflict",
    });
    expect(await count(db, "run_record", "job = 'backfill-history'")).toBe(0);
  });

  it("any other store error propagates and leaves the cursor alone", async () => {
    const db = await backfillDb();
    const store = {
      put: async () => {
        throw new Error("upload failed");
      },
    };
    await expect(
      commitHistoryMonth(db, {
        month: "2026-09",
        rows: asicRows(["2026-09-30"]),
        store,
        nowMs: NOW,
      }),
    ).rejects.toThrow("upload failed");
    expect((await jobRow(db, JOB_ASIC)).next_date).toBe("2026-09-30");
  });

  it("three empty months in a row mean the archive has no more depth (DAT-125a)", async () => {
    const db = await backfillDb();
    const store = fakeStore();
    const rows = asicRows(["2026-09-30"]);
    await commitHistoryMonth(db, { month: "2026-09", rows, store, nowMs: NOW });
    for (const m of ["2026-08", "2026-07"]) {
      expect(await commitHistoryMonth(db, { month: m, rows: [], store, nowMs: NOW })).toMatchObject(
        {
          status: "ok",
          file: "none",
          done: false,
        },
      );
    }
    const last = await commitHistoryMonth(db, { month: "2026-06", rows: [], store, nowMs: NOW });
    expect(last).toMatchObject({
      status: "ok",
      done: true,
      nextDate: null,
      reason: "archive_depth",
    });
    expect(await jobRow(db, JOB_ASIC)).toMatchObject({ done: 1, next_date: null });
    expect(await stateOf(db, JOB_ASIC)).toMatchObject({
      status: "done",
      reason: "archive_depth",
      oldest_data_month: "2026-09",
      empty_streak: 3,
    });
    expect(store.files.size).toBe(1); // empty months write no file
    expect(await planAsic(db, { nowMs: NOW })).toEqual({ action: "none", reason: "done" });
    expect(await commitHistoryMonth(db, { month: "2026-05", rows: [], store, nowMs: NOW })).toEqual(
      {
        status: "done",
      },
    );
  });

  it("a month with data resets the empty streak", async () => {
    const db = await backfillDb();
    const store = fakeStore();
    await commitHistoryMonth(db, { month: "2026-09", rows: [], store, nowMs: NOW });
    await commitHistoryMonth(db, { month: "2026-08", rows: [], store, nowMs: NOW });
    await commitHistoryMonth(db, {
      month: "2026-07",
      rows: asicRows(["2026-07-31"]),
      store,
      nowMs: NOW,
    });
    expect(await stateOf(db, JOB_ASIC)).toMatchObject({
      empty_streak: 0,
      oldest_data_month: "2026-07",
    });
  });

  it("stops at the six-year floor", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    await setCursor(db, JOB_ASIC, "2020-10-31");
    const store = fakeStore();
    const r = await commitHistoryMonth(db, {
      month: "2020-10",
      rows: asicRows(["2020-10-30"]),
      store,
      nowMs: NOW,
    });
    expect(r).toMatchObject({ status: "ok", done: true, reason: "floor", nextDate: null });
  });

  it("rejects bad input", async () => {
    const db = await backfillDb();
    const store = fakeStore();
    expect(
      await commitHistoryMonth(db, { month: "2026-9", rows: [], store, nowMs: NOW }),
    ).toMatchObject({
      status: "rejected",
    });
    expect(
      await commitHistoryMonth(db, {
        month: "2026-09",
        rows: "x" as unknown as [],
        store,
        nowMs: NOW,
      }),
    ).toMatchObject({ status: "rejected" });
  });
});

describe("plan for the secret-free ASIC fetch step", () => {
  it("lists the next months newest first, capped per run", async () => {
    const db = await backfillDb();
    const p = await planAsic(db, { nowMs: NOW });
    if (p.action !== "fetch") throw new Error("expected fetch");
    expect(p.months.map((m) => m.month)).toEqual(["2026-09", "2026-08", "2026-07"]);
    expect(p.months[0].dates.at(-1)).toBe("2026-09-30");
    const one = await planAsic(db, { nowMs: NOW, maxMonths: 1 });
    expect(one).toMatchObject({ action: "fetch" });
    if (one.action === "fetch") expect(one.months).toHaveLength(1);
  });
});

describe("exporting announcement months to history files (DAT-140, DAT-142)", () => {
  async function seedMonths(db: Client) {
    await ensureJobs(db, NOW);
    await setCursor(db, JOB_ASX, "2026-07-31"); // September and August are complete
    await seedAnn(db, "2026-09-10", 3);
    await seedAnn(db, "2026-08-12", 2);
    // Sydney boundaries: 00:30 on 1 September is still 31 August in UTC.
    const early = item("2026-09-01", 41, { annId: annId("edge-in") });
    const late = item("2026-10-01", 42, { annId: annId("edge-out") });
    for (const [it, at] of [
      [early, "2026-08-31T14:30:00.000Z"],
      [late, "2026-09-30T14:30:00.000Z"],
    ] as const) {
      await db.execute({
        sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type,
                price_sensitive, title, url, source)
              VALUES ('AU', 'ZZA', ?, ?, 'x', 't', 0, 'edge', NULL, 'asx_announcements')`,
        args: [it.annId, at],
      });
    }
  }

  it("writes each complete past month once, with the right rows", async () => {
    const db = await backfillDb();
    await seedMonths(db);
    const store = fakeStore();
    const r = await exportAsxMonths(db, { store, nowMs: NOW, maxMonths: 5, commitSha: SHA });
    expect(r).toEqual({
      exported: ["2026-09", "2026-08"],
      skipped: [],
      conflicts: [],
      stopped: "not_complete",
    });
    const sep = rowsOf(store.files.get(ASX_KEY)!);
    expect(sep).toHaveLength(4); // 3 + the 00:30 Sydney edge row; not the 1 October one
    expect(sep.map((x) => x.ann_id)).toContain(annId("edge-in"));
    expect(sep.map((x) => x.ann_id)).not.toContain(annId("edge-out"));
    expect(sep.every((x) => x.source === "asx_announcements" && x.assumed_time === false)).toBe(
      true,
    );
    const sorted = [...sep].sort((a, b) => (a.published_at < b.published_at ? -1 : 1));
    expect(sep).toEqual(sorted);
    expect(store.files.size).toBe(2);
    expect(await stateOf(db, JOB_ASX)).toMatchObject({ exported_down_to: "2026-08" });
    expect((await runs(db)).map((x) => x.concurrency_key)).toEqual([
      "backfill-history:export:asx_announcements:2026-09",
      "backfill-history:export:asx_announcements:2026-08",
    ]);
  });

  it("a second run writes nothing more (idempotent)", async () => {
    const db = await backfillDb();
    await seedMonths(db);
    const store = fakeStore();
    await exportAsxMonths(db, { store, nowMs: NOW, maxMonths: 5 });
    const calls = store.calls.length;
    const again = await exportAsxMonths(db, { store, nowMs: NOW, maxMonths: 5 });
    expect(again).toMatchObject({ exported: [], stopped: "not_complete" });
    expect(store.calls).toHaveLength(calls);
  });

  it("if the state write was lost, the file is skipped by SHA and the run goes on", async () => {
    const db = await backfillDb();
    await seedMonths(db);
    const store = fakeStore();
    await exportAsxMonths(db, { store, nowMs: NOW, maxMonths: 1 });
    // an earlier run died after the upload and the record, before it could save its state
    await db.execute("DELETE FROM ingest_cursor WHERE job = 'backfill:asx_announcements'");
    const r = await exportAsxMonths(db, { store, nowMs: NOW, maxMonths: 1 });
    expect(r.skipped).toEqual(["2026-09"]);
    expect(await stateOf(db, JOB_ASX)).toMatchObject({ exported_down_to: "2026-09" });
  });

  it("never exports the current month or a month the cursor has not passed", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    await seedAnn(db, "2026-10-05", 2);
    await seedAnn(db, "2026-09-10", 2);
    const store = fakeStore();
    // cursor inside September: September is not complete
    await setCursor(db, JOB_ASX, "2026-09-15");
    expect(await exportAsxMonths(db, { store, nowMs: NOW })).toMatchObject({
      exported: [],
      stopped: "not_complete",
    });
    // job done: September goes, October (the current month) never
    await setCursor(db, JOB_ASX, null, 1);
    const r = await exportAsxMonths(db, { store, nowMs: NOW, maxMonths: 80 });
    expect(r.exported).toEqual(["2026-09"]);
    expect(r.stopped).toBe("all_exported");
    expect([...store.files.keys()].some((k) => k.includes("2026-10"))).toBe(false);
  });

  it("an empty month writes no file but is counted as done", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    await setCursor(db, JOB_ASX, "2026-07-31");
    const store = fakeStore();
    const r = await exportAsxMonths(db, { store, nowMs: NOW, maxMonths: 2 });
    expect(r.exported).toEqual([]);
    expect(store.files.size).toBe(0);
    expect(await stateOf(db, JOB_ASX)).toMatchObject({ exported_down_to: "2026-08" });
  });

  it("an existing different file is a conflict: reported, kept, and the export moves on", async () => {
    const db = await backfillDb();
    await seedMonths(db);
    const old = new Uint8Array([1, 2, 3]);
    const store = fakeStore({ [ASX_KEY]: old });
    const r = await exportAsxMonths(db, { store, nowMs: NOW, maxMonths: 5 });
    expect(r.conflicts).toEqual(["2026-09"]);
    expect(r.exported).toEqual(["2026-08"]);
    expect(store.files.get(ASX_KEY)).toBe(old);
    expect(await stateOf(db, JOB_ASX)).toMatchObject({ conflicts: ["2026-09"] });
  });

  it("reports when there is no job yet", async () => {
    const db = await backfillDb();
    expect((await exportAsxMonths(db, { store: fakeStore(), nowMs: NOW })).stopped).toBe("no_job");
  });

  it("stops after the oldest month inside the six-year window", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    await setCursor(db, JOB_ASX, null, 1);
    const r = await exportAsxMonths(db, { store: fakeStore(), nowMs: NOW, maxMonths: 200 });
    expect(r.stopped).toBe("all_exported");
    expect((await stateOf(db, JOB_ASX)).exported_down_to).toBe("2020-10");
  });
});

describe("retention interplay (DAT-142: news 400 days in Turso, older in history files)", () => {
  it("rows beyond 400 days are pruned only after export, and a later partial re-export cannot clobber the file", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    await setCursor(db, JOB_ASX, null, 1);
    await seedAnn(db, "2021-03-10", 4);
    const store = fakeStore();
    await exportAsxMonths(db, { store, nowMs: NOW, maxMonths: 80 });
    const key = "history-asx_announcements-2021/asx_announcements-2021-03.jsonl.gz";
    const full = store.files.get(key)!;
    expect(rowsOf(full)).toHaveLength(4);

    // The maintenance prune may now delete them (the trigger allows it beyond retention) ...
    await db.execute(
      "DELETE FROM announcement WHERE published_at < '2021-03-10T23:59:59Z' AND ann_id = '" +
        items("2021-03-10", 4)[0].annId +
        "'",
    );
    expect(await count(db, "announcement")).toBe(3);
    // ... but never rows inside the 400-day window.
    await seedAnn(db, "2026-09-10", 1);
    await expect(
      db.execute("DELETE FROM announcement WHERE published_at >= '2026-01-01'"),
    ).rejects.toThrow(/append-only/);

    // A re-export of that month from the pruned table would differ: refused, original kept.
    await db.execute({
      sql: "UPDATE ingest_cursor SET cursor_json = json_set(cursor_json, '$.exported_down_to', '2021-04') WHERE job = 'backfill:asx_announcements'",
    });
    const again = await exportAsxMonths(db, { store, nowMs: NOW, maxMonths: 1 });
    expect(again.conflicts).toEqual(["2021-03"]);
    expect(store.files.get(key)).toBe(full);
    expect(rowsOf(store.files.get(key)!)).toHaveLength(4);
  });
});

describe("AT-09 Part A: point in time (DAT-001, TST-109)", () => {
  const D = "2026-09-30";
  const CUTOFF = "2026-09-30T08:10:00.000Z"; // 18:10 Sydney (AEST) on D
  const decision = (rows: { published_at: string }[]) => JSON.stringify(visibleAt(rows, CUTOFF));

  it("perturbing backfilled ASIC data published after D leaves everything visible at D unchanged", async () => {
    const db = await backfillDb();
    const store = fakeStore();
    const dates = ["2026-09-01", "2026-09-15", "2026-09-28", "2026-09-29", D];
    await commitHistoryMonth(db, { month: "2026-09", rows: asicRows(dates), store, nowMs: NOW });
    const rows = rowsOf(store.files.get(ASIC_SEP)!);
    const baseline = decision(rows);
    // the report as of D itself, and the days just before, are published after D's cut-off
    expect(visibleAt(rows, CUTOFF).every((r) => r.as_of <= "2026-09-23")).toBe(true);
    expect(rows.some((r) => r.as_of === D && r.published_at > CUTOFF)).toBe(true);

    const perturbed = rows.map((r) =>
      r.published_at > CUTOFF
        ? { ...r, short_positions: r.short_positions * 1000, code: "ZZX" }
        : r,
    );
    perturbed.push({
      ...rows[0],
      as_of: "2026-10-05",
      published_at: "2026-10-12T23:59:59.000Z",
      short_positions: 1,
    });
    expect(decision(perturbed)).toBe(baseline);
    // sensitivity control: changing a row that WAS visible does change the decision
    const control = rows.map((r, i) =>
      i === 0 ? { ...r, short_positions: r.short_positions + 1 } : r,
    );
    expect(decision(control)).not.toBe(baseline);
  });

  it("announcement history: rows stamped after D are invisible at D's cut-off, both live and from the file", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    await setCursor(db, JOB_ASX, "2026-07-31");
    await seedAnn(db, "2026-09-10", 3);
    await seedAnn(db, "2026-09-30", 2);
    await seedAnn(db, "2026-09-29", 1);
    const store = fakeStore();
    await exportAsxMonths(db, { store, nowMs: NOW, maxMonths: 1 });
    const file = rowsOf(store.files.get(ASX_KEY)!);
    const live = (
      await db.execute("SELECT * FROM announcement ORDER BY published_at, ann_id")
    ).rows.map((r) => ({ ...r }) as unknown as Row);
    const cut = sydneyIso(D, "12:00"); // before the 12:30+ announcements of D
    expect(file.length).toBe(live.length);
    expect(visibleAt(file, cut).map((r) => r.ann_id)).toEqual(
      visibleAt(live, cut).map((r) => r.ann_id),
    );
    const changed = file.map((r) =>
      r.published_at > cut ? { ...r, title: "changed", code: "ZZX" } : r,
    );
    expect(JSON.stringify(visibleAt(changed, cut))).toBe(JSON.stringify(visibleAt(file, cut)));
  });
});

describe("AT-09 Part B: daily universe snapshots belong to the daily pipeline", () => {
  it("the backfill neither writes nor needs snapshots, bars or the calendar", async () => {
    const db = await backfillDb();
    await db.execute(
      "INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES ('AU', '2026-10-12', 'ZZA', 'active', 'U1')",
    );
    const watched = [
      "universe_snapshot",
      "price_bar",
      "bar_refetch",
      "completion_marker",
      "instrument",
      "trading_calendar",
    ];
    const before = await Promise.all(watched.map((t) => count(db, t)));
    const store = fakeStore();
    await day(db, MON, 3);
    await commitHistoryMonth(db, {
      month: "2026-09",
      rows: asicRows(["2026-09-30"]),
      store,
      nowMs: NOW,
    });
    await exportAsxMonths(db, { store, nowMs: NOW });
    expect(await Promise.all(watched.map((t) => count(db, t)))).toEqual(before);
    expect(await count(db, "universe_snapshot", "d = '2026-10-12'")).toBe(1);
  });

  it("snapshot history cannot be backfilled: no snapshot job exists", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    const names = (await db.execute("SELECT name FROM backfill_job ORDER BY name")).rows.map(
      (r) => r.name,
    );
    expect(names).toEqual([JOB_ASIC, JOB_ASX]);
  });
});
