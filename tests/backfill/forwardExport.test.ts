// @vitest-environment node
// Forward history export (M2 T9 follow-up, D-066): months NEWER than the first export are written
// to their write-once files once settled, with the same run record the prune guard reads.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { ensureJobs, exportAsxMonths } from "@/lib/data/backfill/engine.mjs";
import {
  ADMIN_WRITES,
  EXPORT_SETTLE_DAYS,
  JOB_ASX,
  monthSettled,
} from "@/lib/data/backfill/rules.mjs";
import { pruneAnnouncements } from "@/lib/maintenance/retention";
import { cleanupTempDbs } from "../db/helpers";
import {
  NOW,
  addBatch1Usage,
  annId,
  backfillDb,
  count,
  fakeStore,
  rowsOf,
  runs,
  stateOf,
} from "./helpers";

afterEach(cleanupTempDbs);

// Sydney is AEDT (UTC+11) in the months used here: 17:00 local.
const at = (date: string) => Date.parse(`${date}T06:00:00.000Z`);
const key = (m: string) =>
  `history-asx_announcements-${m.slice(0, 4)}/asx_announcements-${m}.jsonl.gz`;

async function seed(db: Client, iso: string, n: number, tag: string, ingested = iso) {
  for (let i = 0; i < n; i++) {
    await db.execute({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type,
              price_sensitive, title, url, source)
            VALUES ('AU', 'ZZA', ?, ?, ?, 't', 0, 'x', NULL, 'asx_announcements')`,
      args: [annId(`${tag}-${i}`), iso, ingested],
    });
  }
}

/** The first (backward) export at NOW: August and September 2026 are complete. */
async function firstExport(db: Client, store = fakeStore()) {
  await ensureJobs(db, NOW);
  await db.execute(
    "UPDATE backfill_job SET next_date = '2026-07-31' WHERE name = 'asx_announcements'",
  );
  await seed(db, "2026-09-10T01:00:00.000Z", 2, "sep");
  await seed(db, "2026-08-10T01:00:00.000Z", 1, "aug");
  const r = await exportAsxMonths(db, { store, nowMs: NOW, maxMonths: 2 });
  expect(r.exported).toEqual(["2026-09", "2026-08"]);
  return store;
}

describe("settle margin", () => {
  it("a month is settled only after its last day plus the margin", () => {
    expect(EXPORT_SETTLE_DAYS).toBe(7);
    expect(monthSettled("2026-10", "2026-11-07")).toBe(false); // 31 Oct + 7 days: not yet
    expect(monthSettled("2026-10", "2026-11-08")).toBe(true);
    expect(monthSettled("2026-10", "2026-10-31")).toBe(false);
    expect(monthSettled("2026-12", "2027-01-08")).toBe(true);
  });
});

describe("forward export of months newer than the first export", () => {
  it("exports two newer months oldest first, with the per-month run records", async () => {
    const db = await backfillDb();
    const store = await firstExport(db);
    await seed(db, "2026-10-12T01:00:00.000Z", 3, "oct");
    await seed(db, "2026-11-12T01:00:00.000Z", 2, "nov");
    const r = await exportAsxMonths(db, {
      store,
      nowMs: at("2026-12-09"),
      commitSha: "b".repeat(40),
    });
    expect(r).toMatchObject({ exported: ["2026-10", "2026-11"], conflicts: [] });
    expect(rowsOf(store.files.get(key("2026-10"))!)).toHaveLength(3);
    expect(rowsOf(store.files.get(key("2026-11"))!)).toHaveLength(2);
    expect((await runs(db)).map((x) => x.concurrency_key)).toEqual([
      "backfill-history:export:asx_announcements:2026-09",
      "backfill-history:export:asx_announcements:2026-08",
      "backfill-history:export:asx_announcements:2026-10",
      "backfill-history:export:asx_announcements:2026-11",
    ]);
    expect(await stateOf(db, JOB_ASX)).toMatchObject({
      exported_down_to: "2026-08",
      exported_up_to: "2026-11",
    });
  });

  it("skips the current month and a month inside the settle margin; exports it once settled", async () => {
    const db = await backfillDb();
    const store = await firstExport(db);
    await seed(db, "2026-10-12T01:00:00.000Z", 1, "oct");
    const early = await exportAsxMonths(db, { store, nowMs: at("2026-11-07"), maxMonths: 1 });
    expect(early.exported).toEqual([]);
    expect(store.files.has(key("2026-10"))).toBe(false);
    const ok = await exportAsxMonths(db, { store, nowMs: at("2026-11-08"), maxMonths: 1 });
    expect(ok.exported).toEqual(["2026-10"]);
    // The new current month (November) is never exported in November.
    expect(store.files.has(key("2026-11"))).toBe(false);
  });

  it("an empty newer month writes no file but is recorded", async () => {
    const db = await backfillDb();
    const store = await firstExport(db);
    const r = await exportAsxMonths(db, { store, nowMs: at("2026-11-20"), maxMonths: 1 });
    expect(r.exported).toEqual([]);
    expect(await stateOf(db, JOB_ASX)).toMatchObject({ exported_up_to: "2026-10" });
  });

  it("a re-run is idempotent: nothing more is uploaded or recorded", async () => {
    const db = await backfillDb();
    const store = await firstExport(db);
    await seed(db, "2026-10-12T01:00:00.000Z", 1, "oct");
    const now = at("2026-11-20");
    await exportAsxMonths(db, { store, nowMs: now });
    const calls = store.calls.length;
    const records = (await runs(db)).length;
    const again = await exportAsxMonths(db, { store, nowMs: now });
    expect(again.exported).toEqual([]);
    expect(store.calls).toHaveLength(calls);
    expect((await runs(db)).length).toBe(records);
  });

  it("lost state: the run record still proves the month, no second upload, state repaired", async () => {
    const db = await backfillDb();
    const store = await firstExport(db);
    await seed(db, "2026-10-12T01:00:00.000Z", 1, "oct");
    const now = at("2026-11-20");
    await exportAsxMonths(db, { store, nowMs: now });
    await db.execute(
      "UPDATE ingest_cursor SET cursor_json = json_remove(cursor_json, '$.exported_up_to') WHERE job = 'backfill:asx_announcements'",
    );
    const calls = store.calls.length;
    const r = await exportAsxMonths(db, { store, nowMs: now });
    expect(r.exported).toEqual([]);
    expect(store.calls).toHaveLength(calls);
    // state had no exported_up_to; the record of October is the newest, nothing newer is settled
    expect((await stateOf(db, JOB_ASX)).exported_down_to).toBe("2026-08");
  });

  it("a record without a state write is repaired by SHA skip (forward)", async () => {
    const db = await backfillDb();
    const store = await firstExport(db);
    await seed(db, "2026-10-12T01:00:00.000Z", 1, "oct");
    const now = at("2026-11-20");
    await exportAsxMonths(db, { store, nowMs: now });
    // Remove the record only: the next run exports October again and skips the identical file.
    await db.execute(
      "DELETE FROM run_record WHERE concurrency_key = 'backfill-history:export:asx_announcements:2026-10'",
    );
    await db.execute(
      "UPDATE ingest_cursor SET cursor_json = json_set(cursor_json, '$.exported_up_to', '2026-09') WHERE job = 'backfill:asx_announcements'",
    );
    const r = await exportAsxMonths(db, { store, nowMs: now });
    expect(r.skipped).toEqual(["2026-10"]);
    expect(await stateOf(db, JOB_ASX)).toMatchObject({ exported_up_to: "2026-10" });
  });

  it("a record that already exists is kept: only the state advances", async () => {
    const db = await backfillDb();
    const store = await firstExport(db);
    await seed(db, "2026-10-12T01:00:00.000Z", 1, "oct");
    const now = at("2026-11-20");
    await exportAsxMonths(db, { store, nowMs: now });
    await db.execute(
      "UPDATE ingest_cursor SET cursor_json = json_set(cursor_json, '$.exported_up_to', '2026-09') WHERE job = 'backfill:asx_announcements'",
    );
    // The record for October exists, so newest = October: nothing to export, state not rewound.
    const r = await exportAsxMonths(db, { store, nowMs: now });
    expect(r.exported).toEqual([]);
  });

  it("changed data for an already written month is a conflict: reported, file kept", async () => {
    const db = await backfillDb();
    const store = await firstExport(db);
    const old = new Uint8Array([9, 9, 9]);
    store.files.set(key("2026-10"), old);
    await seed(db, "2026-10-12T01:00:00.000Z", 2, "oct");
    const r = await exportAsxMonths(db, { store, nowMs: at("2026-11-20"), maxMonths: 1 });
    expect(r.conflicts).toEqual(["2026-10"]);
    expect(r.exported).toEqual([]);
    expect(store.files.get(key("2026-10"))).toBe(old);
    expect(await stateOf(db, JOB_ASX)).toMatchObject({ conflicts: ["2026-10"] });
  });

  it("starts with the backward run when there is no export yet (nothing forward)", async () => {
    const db = await backfillDb();
    await ensureJobs(db, NOW);
    const store = fakeStore();
    const r = await exportAsxMonths(db, { store, nowMs: at("2026-12-20"), maxMonths: 1 });
    expect(r.exported).toEqual([]); // the first export month is the last complete one: 2026-11
    expect((await runs(db)).map((x) => x.concurrency_key)).toEqual([
      "backfill-history:export:asx_announcements:2026-11",
    ]);
  });

  it("the write cap stops the forward export (the run record is a counted DB write)", async () => {
    const db = await backfillDb();
    const store = await firstExport(db);
    await addBatch1Usage(db, ADMIN_WRITES * 2 - 1, "2026-11-19T00:00:00.000Z");
    const r = await exportAsxMonths(db, {
      store,
      nowMs: at("2026-11-20"),
      cap: ADMIN_WRITES * 2 + 1, // November usage below leaves room for less than one record
    });
    expect(r.stopped).toBe("paused_cap");
    expect(r.exported).toEqual([]);
    expect(await stateOf(db, JOB_ASX)).toMatchObject({ status: "paused_cap" });
  });

  it("a month over the row limit stops the forward export", async () => {
    const db = await backfillDb();
    const store = await firstExport(db);
    const real = db.execute.bind(db);
    const proxy = new Proxy(db, {
      get(t, k) {
        if (k === "execute") {
          return async (q: { sql: string }) => {
            const res = await real(q);
            if (typeof q === "object" && /FROM announcement/.test(q.sql)) {
              return { ...res, rows: new Array(400_001).fill({ published_at: "x" }) };
            }
            return res;
          };
        }
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Client;
    const r = await exportAsxMonths(proxy, { store, nowMs: at("2026-11-20") });
    expect(r.stopped).toBe("too_many_rows");
  });

  it("the backward path is unchanged: older months still follow the first export", async () => {
    const db = await backfillDb();
    const store = await firstExport(db);
    await db.execute(
      "UPDATE backfill_job SET next_date = '2026-05-31' WHERE name = 'asx_announcements'",
    );
    await seed(db, "2026-07-10T01:00:00.000Z", 1, "jul");
    const r = await exportAsxMonths(db, { store, nowMs: NOW, maxMonths: 2 });
    expect(r.exported).toEqual(["2026-07"]);
    expect(await stateOf(db, JOB_ASX)).toMatchObject({
      exported_down_to: "2026-06",
      exported_up_to: "2026-09",
    });
  });
});

describe("pruning a forward-exported month", () => {
  it("removes a forward-exported month older than 400 days, and only that", async () => {
    const db = await backfillDb();
    const store = fakeStore();
    const first = at("2025-03-13");
    await ensureJobs(db, first);
    await db.execute(
      "UPDATE backfill_job SET next_date = '2024-12-31' WHERE name = 'asx_announcements'",
    );
    await seed(db, "2025-02-10T01:00:00.000Z", 1, "feb");
    const r1 = await exportAsxMonths(db, { store, nowMs: first, maxMonths: 1 });
    expect(r1.exported).toEqual(["2025-02"]);
    // March is exported later by the forward run, after the settle margin.
    await seed(db, "2025-03-20T01:00:00.000Z", 2, "mar", "2025-03-20T01:00:00.000Z");
    await seed(db, "2025-04-02T01:00:00.000Z", 1, "apr");
    const r2 = await exportAsxMonths(db, { store, nowMs: at("2025-04-20"), maxMonths: 1 });
    expect(r2.exported).toEqual(["2025-03"]);
    // 400 days after the end of March (the DB trigger uses the real clock: all of this is past).
    const later = "2026-05-10T00:00:00.000Z";
    expect(await pruneAnnouncements(db, later, 400)).toBe(3); // February + March; not April
    expect(await count(db, "announcement")).toBe(1);
  });
});
