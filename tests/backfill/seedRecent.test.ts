// @vitest-environment node
// D-199: the recent price window is copied from the history month files into the database, before
// the oldest stored bar, never replacing one, within the backfill write cap. Synthetic codes only.
import { describe, expect, it } from "vitest";
import { gzipDeterministic, toJsonl } from "@/lib/data/backfill/rules.mjs";
import { seedRecentBars } from "@/lib/data/backfill/seedRecent.mjs";
import { backfillDb, NOW } from "./helpers";

const bar = (code: string, d: string, c = 1.5) => ({ code, d, o: c, h: c, l: c, c, volume: 1000 });
const file = (rows: object[]) => gzipDeterministic(toJsonl(rows));

// September and August 2026 files, three weekdays each, plus rows that must be skipped
const MONTHS: Record<string, Uint8Array> = {
  "2026-09": file([
    bar("ZZA", "2026-09-28"),
    bar("ZZB", "2026-09-28"),
    bar("ZZA", "2026-09-29"),
    bar("ZZA", "2026-09-30"),
    bar("bad code", "2026-09-30"),
    { ...bar("ZZC", "2026-09-30"), c: 0 },
  ]),
  "2026-08": file([bar("ZZA", "2026-08-27"), bar("ZZA", "2026-08-28"), bar("ZZA", "2026-08-31")]),
};
const readMonth = (m: string) => MONTHS[m] ?? null;

async function withNightly(dates: string[]) {
  const db = await backfillDb();
  for (const d of dates) {
    await db.execute({
      sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES ('AU', 'ZZA', ?, 9, 9, 9, 9, 5, 'yahoo_eod', 'x', 'x')`,
      args: [d],
    });
  }
  return db;
}

const count = async (db: Awaited<ReturnType<typeof backfillDb>>, sql: string) =>
  Number((await db.execute(sql)).rows[0]!.n);

describe("seedRecentBars (D-199)", () => {
  it("copies the newest sessions before the oldest stored bar, newest month first", async () => {
    const db = await withNightly(["2026-10-01", "2026-10-02"]);
    const r = await seedRecentBars(db, { readMonth, nowMs: NOW, sessions: 6 });
    expect(r).toMatchObject({ status: "ok", sessions: 4, rows: 5, written: 5 });
    expect(r.from).toBe("2026-08-31");
    expect(r.to).toBe("2026-09-30");
    expect(await count(db, "SELECT COUNT(DISTINCT d) AS n FROM price_bar")).toBe(6);
    // the nightly bar is untouched and skipped rows are not stored
    expect(
      (await db.execute("SELECT c FROM price_bar WHERE code = 'ZZA' AND d = '2026-10-01'")).rows[0]!
        .c,
    ).toBe(9);
    expect(await count(db, "SELECT COUNT(*) AS n FROM price_bar WHERE code = 'ZZC'")).toBe(0);
    // the writes count against the backfill cap
    const run = (
      await db.execute(
        "SELECT job, rows_written FROM run_record WHERE concurrency_key LIKE 'seed-recent:%'",
      )
    ).rows[0]!;
    expect(run.job).toBe("backfill-history");
    expect(Number(run.rows_written)).toBeGreaterThan(5);
  });

  it("a repeat writes nothing once the window is full", async () => {
    const db = await withNightly(["2026-10-01"]);
    await seedRecentBars(db, { readMonth, nowMs: NOW, sessions: 7 });
    const again = await seedRecentBars(db, { readMonth, nowMs: NOW, sessions: 7 });
    expect(again).toEqual({ status: "nothing", sessions: 0, rows: 0, written: 0 });
  });

  it("stops before writing when the month's write cap would be passed", async () => {
    const db = await withNightly(["2026-10-01"]);
    const r = await seedRecentBars(db, { readMonth, nowMs: NOW, sessions: 6, cap: 10 });
    expect(r.status).toBe("paused_cap");
    expect(r.written).toBe(0);
    expect(await count(db, "SELECT COUNT(*) AS n FROM price_bar")).toBe(1);
  });

  it("says so when no history file exists, and seeds an empty database up to now", async () => {
    const db = await backfillDb();
    expect((await seedRecentBars(db, { readMonth: () => null, nowMs: NOW })).status).toBe(
      "no_files",
    );
    const r = await seedRecentBars(db, { readMonth, nowMs: NOW, sessions: 2 });
    expect(r).toMatchObject({ status: "ok", sessions: 2, from: "2026-09-29", to: "2026-09-30" });
  });
});
